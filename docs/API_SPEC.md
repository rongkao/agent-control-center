# API Specification — V1

Base server: `http://127.0.0.1:8788`

## Startup and lifecycle

The server is started programmatically through `startServer(options)` from `@acc/server` (`apps/server/src/server.ts`);
`apps/server/src/index.ts` is only the CLI entry. `startServer` resolves to `{ app, url, accessUrl, accessToken, tokenPath, port, paths, lock, recovery, warnings, closed, close() }`
(`app` is the Fastify instance, usable with `app.inject` in tests; `close()` first stops every agent runtime — Claude queries are aborted,
test-command process trees killed, the Codex app-server closed, injected adapters get `dispose()` or `cancel()` — without writing any event,
then releases the port, the database and the single-instance lease, so a restart in the same process resumes each provider session exactly once;
`accessUrl` is the login link with the token — a desktop shell loads it directly). Options relevant to access control:
`accessToken` (explicit token, not written to disk), `dev` (development mode), `websocket: { maxPayload, maxConnections }`.

The CLI entry (`npm start` / `npm run start:real`) opens `accessUrl` in the default browser unless `ACC_NO_OPEN=1`;
`npm run dev` passes `--dev` and never opens a browser.

Startup order:
0. If `ACC_HOST` is not a loopback address and no explicit token is configured (`ACC_TOKEN_FILE` or the `accessToken` option),
   startup fails with `ACC_INSECURE_HOST` before anything is written.
1. Control-plane data location (default: the per-user data directory, see `.env.example`). If the database, log directory or
   token file lies inside the default workspace, startup fails with `ACC_DATA_IN_WORKSPACE` unless `ACC_ALLOW_DATA_IN_WORKSPACE=1`.
   If instead the default workspace lies inside the data directory, the server starts with a warning (`warnings`), and tasks without
   an explicit `cwd` are rejected with `400` until a project folder is given.
2. Single-instance lease (`<db>.lock`, SQLite exclusive lock + `instance_lease` row), acquired before any data is written.
   A second instance on the same data fails with `ACC_ALREADY_RUNNING` (the message names the running instance's pid and URL);
   a lock file held by another process handle fails with `ACC_LOCK_FILE_BUSY` after a few retries. A lease left behind by a killed
   or power-lost instance is taken over (the OS lock is released with the process).
3. One-time migration of a legacy `INIT_CWD/agent-control.db` into the data directory (`VACUUM INTO`, verified; the old file is renamed
   to `agent-control.db.bak-<timestamp>` in place — which also proves no old instance still holds it — and then moved to
   `<data dir>/legacy-backups/`). Failure aborts startup with `ACC_MIGRATION_FAILED`; an empty database is never created silently.
   `agent-control.db.bak-*` files left in `INIT_CWD` by an earlier migration and the old default event log `INIT_CWD/logs/events.log`
   (only when its content is in this program's format) are moved to `<data dir>/legacy-backups/` as well. Whatever cannot be moved,
   and a legacy database that is not migrated (new database already exists, or `ACC_DB_PATH` is explicit), produces a warning when it
   lies inside the default workspace.
   Then the access token is loaded or created: `ACC_TOKEN_FILE`, else `<data dir>/access-token`. A new file is created empty,
   restricted to the current user (Windows: `icacls /inheritance:r /grant:r *<user SID>:(F)`; elsewhere `chmod 600`) and verified
   before the token is written. Every startup re-checks the ACL (Windows: the SDDL from `icacls /save`; account-domain aliases such as
   `LA` for the built-in Administrator are resolved by asking Windows how it writes the current user's SID), repairs it when it was
   widened, and fails with `ACC_TOKEN_FILE_INSECURE` if it cannot. An invalid token fails with `ACC_TOKEN_INVALID`.
   The token is never put into `process.env` (agents, Codex and test commands inherit it).
4. Listen (`ACC_PORT_IN_USE` if the port is taken — nothing has been recovered yet), then run recovery. Until recovery finishes,
   state-changing `/api/*` requests wait; if startup fails meanwhile they get `503`.

Task working directories (explicit `cwd`, the default workspace for tasks without one, and every persisted task / session `cwd`
of existing runs) are checked with the same rules: an existing absolute directory, inside `ACC_ALLOWED_ROOTS` when set, never
inside the data or log directory, and never containing control-plane data. `ACC_ALLOW_DATA_IN_WORKSPACE=1` only tolerates data that
lies inside the default workspace. A new task that fails the check gets `400`; an existing run that fails it (for example one created
before the upgrade) is not resumed during recovery — it fails closed to `BLOCKED` with a `runtime.error` `WORKSPACE_REJECTED` — and
starting or resuming an agent for it later fails the same way.

If the single-instance lease is lost, the server first aborts every agent runtime synchronously, then closes the database, calls
`onFatal`, and closes itself — also safe when an embedding host only shows a message instead of exiting.

## Access control

Every request, including the WebSocket upgrade, passes these checks in order:

| Check | Rule | Failure |
|---|---|---|
| Host | hostname must be `127.0.0.1`, `localhost` or `[::1]` (any port; plus `ACC_ALLOWED_HOSTS` and the listening address itself when `ACC_HOST` is not a wildcard, e.g. `127.0.0.2`) | `403` `ACC_FORBIDDEN_HOST` |
| Origin | if present, must equal `http://<Host>` (same origin); in development mode also `http://localhost:<ACC_WEB_PORT>` / `http://127.0.0.1:<ACC_WEB_PORT>`; `null` is rejected | `403` `ACC_FORBIDDEN_ORIGIN` |
| Content type | every non-GET/HEAD/OPTIONS request must be `application/json` (so a body-less cross-site `POST /cancel` fails) | `415` `ACC_JSON_REQUIRED` |
| Login | session cookie (`HttpOnly; SameSite=Strict; Path=/`, value derived from the token) or `Authorization: Bearer <token>` | API/WS: `401` `ACC_UNAUTHORIZED`; pages: `401` Chinese explanation page |

- `GET /<any page>?token=<token>` sets the session cookie and redirects (`302`) to the same URL without `token`.
- `POST /api/auth/session` `{ "token": "…" }` sets the session cookie (used by the front end when the page is served by Vite in development).
- `GET /api/auth/status` → `{ ok: true }` when logged in (the front end uses it to tell "server down" from "login expired").
- Every response carries `Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`
  and `Referrer-Policy: no-referrer`.
- WebSocket: messages larger than `ACC_WS_MAX_PAYLOAD` (default 64 KiB) close the connection (`1009`); more than
  `ACC_WS_MAX_CONNECTIONS` (default 32) concurrent connections are refused with `503` `ACC_WS_LIMIT`; a client whose unsent
  backlog exceeds 16 MiB is disconnected.

## REST

### GET /health

Returns server/runtime mode, `instanceId`, `ready` (startup recovery finished) and the recovery report.

### GET /api/agents

Returns registered adapters and runtime readiness.

### GET /api/tasks

Returns current task projections.

### GET /api/tasks/:taskId

Returns task projection, run snapshot, events, approvals and usage.
If the snapshot cannot be loaded (unknown schema / corrupted), `run` is omitted and `runLoadStatus` explains why.

### POST /api/tasks

```json
{
  "title": "Fix login crash",
  "prompt": "Analyze and fix the crash.",
  "agentId": "claude"
}
```

Optional fields: `workflow` (`implementation-v1` default | `manual`), `testCommand` (e.g. `npm test`; empty → no test step),
`reviewGate` (stop for operator acceptance/review after tests pass), `cwd` (task workspace),
`inactivityTimeoutMs` (step inactivity watchdog threshold in milliseconds, integer `0`–`86400000`; `0` disables it; default
`ACC_STEP_INACTIVITY_MS`, which defaults to `900000` = 15 minutes — see "No-hang guarantees" below). It is stored in
`run.settings.inactivityTimeoutMs`. An invalid value (negative, not an integer) returns `400`; an invalid `ACC_STEP_INACTIVITY_MS`
makes startup fail with `ACC_INVALID_CONFIG`.

Validation (all checks run before a worktree is created; on failure `400` and no task, worktree or branch is left behind):
- `cwd` must be an existing absolute directory (on Windows with a drive letter; UNC paths are rejected), must not lie inside the
  control-plane data directory or contain the database, log directory or token file, and — only when `ACC_ALLOWED_ROOTS` is set —
  must lie under one of those roots.
- `agentId` (default `claude`) must be registered and able to chat (`implement` or `analysis`, not the test runner);
  `implementation-v1` requires `implement`; a `testCommand` requires a registered `test` agent with the `test` capability.
- If creating the task fails after the worktree was created and no task was persisted, the worktree and its `acc/*` branch are removed.

Unknown agent ids on `message`, `handoff`, `reassign`, `ask-both` and `continue` also return `400` (not `500`).

### GET /api/config

Runtime mode, store, default workspace, whether it is a git repository, workspace policy and startup recovery report.

### GET /api/dashboard

Task summaries: status, workflow step, pending approvals/inputs, recovery marker and blocker.

### GET /api/usage

Aggregated usage: runs, agent calls, turns, reported vs estimated tokens, duration, failures, test failures, stalls,
budget blocks and review rounds, in total and per agent.

`POST /api/tasks` also accepts `worktree: true` (create an isolated git worktree for the task under the workspace
repository) and `sharedWorkspace: true` (explicitly allow sharing a workspace with another active task).

### Multi-agent collaboration

- `POST /api/tasks/:taskId/handoff` `{ fromAgentId, toAgentId, content, instruction?, resume? }` — operator forwards one agent's output to another.
- `POST /api/tasks/:taskId/ask-both` `{ message, primaryAgentId?, resume? }` — send to all chat agents; non-primary agents answer read-only.
  All agent calls of one Ask Both are checked and reserved together before anything is dispatched: if the budget does not cover all
  of them, nothing is sent (`409` `BUDGET_EXHAUSTED`, see "Budgets").
  An advisor that is in the middle of its own **writable** turn is not asked this time (the read-only step cannot be steered into a
  running writable Codex turn, and a running Claude turn must not be downgraded to `plan` midway): the task keeps running, only the
  other agents are asked and budgeted, and a `runtime.warning` `ASK_BOTH_ADVISOR_BUSY` (Chinese `message`, `agentId` = the skipped
  advisor) explains it. An advisor's read-only turn is persisted in its session metadata (`roundMode`), so relaxing the budget after
  a budget stop, resuming after a restart or an approval continues it read-only (Codex resumes with `sandbox: "read-only"`).
  Without `primaryAgentId` the task's recorded primary agent is used — `run.primaryAgentId` for chat tasks, the workflow implementer
  (`workflowState.agents.implement`) for workflow tasks, never the most recently dispatched agent (after a test step that is the test
  runner); an explicit one becomes the chat task's new primary agent. The test runner can never be the primary agent: `400`
  (`INVALID_AGENT`), nothing is sent.
  Starting a new agent session this way (or with `message`) never changes the run status except for the task's very first start: a
  workflow waiting at the review gate (`WAITING_INPUT`), a run waiting for approval and a `BLOCKED` run stay where they are, so the
  gate / approval can still be decided afterwards.
- `POST /api/tasks/:taskId/reassign` `{ toAgentId, note? }` — hand the task over to another agent. The handover source is the
  workflow implementer or, for chat tasks, `run.primaryAgentId` (not the most recently dispatched agent); afterwards the new agent is the primary one.
- `POST /api/tasks/:taskId/settings` `{ handoffPolicy: "ask" | "auto" }` — how agent-requested handoffs are handled. `auto`
  only executes **structured** requests (Claude's `request_handoff` tool: `confidence: "confirmed"`), at most `maxAutoHandoffs`
  times per task (the count is checked and incremented under one lock). Requests inferred from text (Codex's `HANDOFF@<agent>:`
  marker, which only counts on the **last non-empty line** of a reply) always become an operator approval (P0-9 / H-13), and so does a
  request from an agent whose current turn is read-only (an Ask Both advisor, a reviewer) to an agent that can write
  (`payload.readOnlySource = true`): a read-only agent cannot make another agent modify files without the operator.
- `POST /api/tasks/:taskId/continue` `{ agentId, message }` — continue a finished task in a new chat with a recap. The recap
  (previous goal, workflow history, last test result, each agent's last reply) is quoted as one data block in the first message;
  `message` is the only instruction (under `[Your task]`, after the block). The new task's `prompt` is just `message`, so a later
  reassign never puts the recap into the instruction area.
- `POST /api/approvals/:approvalId/resolve` also accepts `scope: "once" | "session"` and `resume` (see below).
- Agent-requested handoffs appear as approvals with `payload.kind = "handoff"`, plus `payload.inferred` (`true` when the request was
  inferred from text — the UI then says 「這是從文字推斷的請求，需要你確認」), `payload.policy` (`ask` | `auto`), `payload.via`
  (`tool` | `text`) and `payload.autoLimitReached`. Invalid targets (unknown agent, the test runner, the requesting agent itself) are
  rejected with a `runtime.warning` `HANDOFF_REQUEST_REJECTED` (Chinese `message`) and no approval. A handoff approval has no
  session scope (`scope: "session"` is downgraded to `once`).
- Forwarded content (operator handoff, approved / auto handoffs, reassign, the workflow context envelope) is quoted inside a data
  block delimited by a per-message random boundary (`<<<ACC-DATA-… BEGIN …>>>` / `<<<ACC-DATA-… END>>>`, every quoted line prefixed
  with `| `) and preceded by a notice that it is data, not instructions; the orchestrator's own instruction (`[Your task]`,
  `[Orchestrator note]`, the envelope headers) appears only once, outside the block. Ask Both advisors always get a read-only turn.
- Streaming text deltas are pushed over the WebSocket as ephemeral `agent.message` events (`data.ephemeral = true`, not persisted).
- Heartbeats: activity that is not persisted by itself (a Claude sub-agent's messages, thinking / tool-input deltas, tool progress;
  Codex command output / reasoning deltas and other thread notifications) is pushed as an ephemeral `agent.status` event with
  `data.ephemeral = true`, `data.heartbeat = true`, `data.activity` (throttled, at most one every 5 s per session). The step inactivity
  watchdog counts it as activity; the UI ignores it.

### Command ordering and terminal tasks

- Operator commands on one task (`message`, `handoff`, `ask-both`, `reassign`, `settings`, `gate`, approval `resolve`) run one at a
  time in arrival order. `POST /api/tasks` (and `continue`) check workspace exclusivity and persist the task atomically, so two
  concurrent creates on the same workspace cannot both pass.
- "Start a session or send to the existing one" for an agent is serialized per (task, agent): an operator message and an
  orchestrator reaction (for example an auto handoff) targeting the same agent never start two sessions (no `SESSION_OWNERSHIP_CONFLICT`).
- On a terminal task (`CANCELLED` / `COMPLETED` / `FAILED`) these commands return `409` `TASK_TERMINAL` with a Chinese explanation;
  nothing is sent to any agent.
- `run.primaryAgentId` (chat tasks): the writable main agent. `run.blockedBy` (only while `BLOCKED`):
  `{ source: "approval" | "safety" | "budget" | "workflow" | "runtime", code, agentId?, approvalId?, eventId, at }` — why the run
  entered `BLOCKED`; also exposed as `blockedBy` in `/api/dashboard` summaries.

### POST /api/tasks/:taskId/gate

Human gate for runs in `WAITING_INPUT` (review gate) or `BLOCKED`:

```json
{ "action": "accept" }
{ "action": "review" }
{ "action": "retry", "note": "Also handle whitespace-only passwords" }
{ "action": "rerun", "note": "Codex was re-authenticated, please try again" }
```

`review` is limited by `maxReviewRounds` (default 1) → 409 when exhausted. `retry` requires `note` and always goes to the implementer.
`rerun` (only while `BLOCKED` on a step that an agent owns) re-dispatches the blocked step to the agent that owns it — the reviewer
for `rescue` / `review`, the test runner for `test` / `final-test`, the implementer for implementing steps — with the step's own
(read-only for rescue / review) instructions; `note` is optional. It is what the banner's 「重試」 sends when the failed or stalled agent is
not the implementer (for example Codex failed with `CODEX_UNAUTHORIZED` while diagnosing). Re-running a review does not use another
review round. Without such a step (for example at the review gate) it returns `409` `GATE_ACTION_UNAVAILABLE` and nothing is sent.
Manual-mode tasks (`workflow: "manual"`) accept only `accept`, which completes the task.

`accept` completes the task directly from `WAITING_INPUT` or `BLOCKED` (manual tasks: from `RUNNING` or `BLOCKED`): the
`run.completed` event carries `data.acceptedBy = "operator"` and the run never passes through `RUNNING`, so no budget check can
interfere (previously a review gate left open for more than 30 minutes could never be accepted). If the task does not end up
`COMPLETED`, the request fails with `409` `TRANSITION_REJECTED` instead of reporting success. `review` and `retry` first renew the
budget (a `budget.extended` event with `reason: "gate"` and `renew: true`: a new counting window and a reset stall counter), then
move the run to `RUNNING`; budgets are never checked on the gate's own status transition.

A workflow run leaves `BLOCKED` only through this gate, `reassign` or `cancel`. Approving or declining a pending approval while the
run is `BLOCKED` resolves that one operation and leaves the run `BLOCKED`; a message to an agent does not unblock it either.
Only a run paused for approval (`WAITING_APPROVAL`) returns to `RUNNING` when its last approval is resolved; an approval resolved
while the run waits at the review gate (`WAITING_INPUT`) leaves the gate in place.

`accept` stops every live agent session of the task (for example both agents after Ask Both), not only the last dispatched one.
So does a workflow that completes by itself (tests passed without a review gate, review accepted, …): no agent keeps working after
`COMPLETED`.

Before `review`, `retry` or `rerun` (and before a budget relax continues a workflow step) dispatches the step, an agent that is still
in the middle of a turn — for example still wrapping up after the operator declined its command, or answering a question asked at the
review gate — is stopped first, and its pending tool approvals are withdrawn (`approval.resolved` with `resolvedBy: "orchestrator"`,
`withdrawn: true`, `reason: "step-restarted"`; this does not block the run). The new instruction then goes to a resumed session, so
the old turn's completion can never be taken as the completion of the retried step (mitigation of M-1 before P1-3).

In a workflow task, approving an agent's handoff request whose target is the agent the workflow is waiting for, or will dispatch
next (for example Codex diagnosing in `rescue` asks to hand the fix to the implementer), does not deliver it separately: the request
and its content are kept in `workflowState.pendingHandoffs` and quoted (as data) in the next workflow envelope for that agent
(`runtime.warning` `HANDOFF_MERGED_INTO_WORKFLOW`). Otherwise the agent would get two messages and the first turn's completion would
advance the workflow. Handoffs to any other agent are delivered as before.

### Test configuration gate (P0-8 / H-15)

`testCommand` is chosen by the operator, but what it actually runs (the `scripts` of `package.json`, the test framework's config,
scripts referenced by the command) lives in the agent-writable workspace. When a workflow task is created the server records a
fingerprint of that test configuration (`run.workflowState.testConfigBaseline`). Before every `test` / `final-test` step the
configuration is read again:

- unchanged → the tests run automatically, exactly as before;
- changed (or no baseline: tasks created before the upgrade / unreadable) → the tests are **not** run. The run goes to
  `WAITING_INPUT` with `pendingInputs[0].id = "test-config-review"` (a Chinese prompt naming the files) and
  `run.workflowState.testConfigReview`:
  `{ digest, reason: "changed" | "no-baseline" | "unreadable", source: "workflow" | "manual", changes: [{ path, kind: "added" | "removed" | "modified", diff, note? }], … }`.
  `diff` is a unified line diff (`-` removed, `+` added). `.npmrc` / `.yarnrc` lines that may hold credentials are never read.

Checked files (relative to the task's cwd): `package.json` (`scripts`, `jest`, `mocha`, `ava`, `nyc`, `c8` only), `vitest` / `vite` /
`jest` / `mocha` / `ava` / `karma` / `playwright` / `cypress` config files, `pytest.ini`, `tox.ini`, `noxfile.py`, `bunfig.toml`, the
test sections of `pyproject.toml` / `setup.cfg`, `.npmrc` / `.yarnrc(.yml)` (credential lines removed), `Makefile` when the command
starts with `make`, `deno.json(c)` for `deno`, and files referenced directly by the command. Test files themselves are not checked
(long term: run tests in a sandbox, P2-8).

The operator then chooses (one click each in the UI card):

- `POST /api/tasks/:taskId/test-config/confirm` with `{ "digest": "<testConfigReview.digest>" }` — the configuration is read once
  more; if it changed since the diff was shown, the diff is updated and the request fails with `409` `TEST_CONFIG_CHANGED`
  (confirm again with the new digest). Otherwise the confirmed configuration becomes the new baseline, the run goes back to
  `RUNNING` (`step: "workflow:gate-confirm-tests"`) and the tests run. A wrong / stale digest → `409` `TEST_CONFIG_CHANGED`;
  nothing waiting → `409` `GATE_ACTION_UNAVAILABLE`; missing digest → `400`.
- gate `retry` with a note (the UI's 「讓 AI 改回去」 asks the implementer to restore the configuration) — tested again afterwards
  against the old baseline;
- gate `accept` (complete without running tests), `review`, or `cancel`.

Operator-triggered test runs (`POST .../message` to the workflow's test agent, the UI's 「重跑測試」) are checked the same way: when
the configuration differs from the baseline the request fails with `409` `TEST_CONFIG_CHANGED`, the diff is stored in
`testConfigReview` (`source: "manual"`, run status unchanged) and `POST .../test-config/confirm` runs the tests after confirmation.
While the tests are already running (the workflow waits for the test runner, or a manual run has not finished) the request fails with
`409` `GATE_ACTION_UNAVAILABLE` (Chinese message) instead: the running test keeps going and its result is recorded; the UI disables
「重跑測試」 meanwhile.

Baseline across tasks: a new workflow task in a directory that had workflow tasks before does not trust what is on disk at creation.
Its baseline is the most recently trusted configuration of that directory (captured by the first task there, or confirmed by the
operator later: `workflowState.testConfigTrustedAt`); with a different test command only the shared files are reused (files checked
only because of the command — Makefile, `deno.json`, referenced scripts — carry `scope: "command"` and are taken from disk). So an
unconfirmed change left behind by a stopped task is still shown for confirmation before the first test of the next task
(`testConfigReview.preexisting: true` when the change existed when the task started). `.npmrc` / `.yarnrc` / `.yarnrc.yml`
credentials are recognised by key name (`_authToken`, `_password`, `npmAuthToken`, …) and kept only as a hash of the value, so
changing them is detected but the value never enters the snapshot; every other line (for example `node-options`, `script-shell`)
is compared as is.

### POST /api/tasks/:taskId/message

```json
{
  "agentId": "codex",
  "message": "Review the current solution. Read-only analysis."
}
```

`409` `SESSION_RESUME_BLOCKED` when that agent's session was marked as not resumable (see "Resuming a session" below): no budget is
used and nothing is sent; the message tells the operator to reassign, accept or stop the task.

Messages to a `BLOCKED` chat task (P0-7): without `"resume": true` the request is refused with `409` `TASK_BLOCKED` (Chinese message
with the block reason and the way out); nothing is sent and nothing is recorded. With `"resume": true` (the UI asks the user to confirm
「恢復並傳送」) the task is explicitly resumed first — a budget block is relaxed with `budget.extended` (`reason: "resume"`, `renew:
true`), then `run.status` `RUNNING` (`step: "operator:resume"`) — and the message is delivered while the run is `RUNNING` and under
budget control. The same applies to `handoff` and `ask-both`. A `BLOCKED` workflow task still accepts messages to its agents (they
stay budget-controlled, see "Budgets"); it leaves `BLOCKED` only through the gate, `reassign`, `cancel` or `POST .../budget`.

`409` `BUDGET_EXHAUSTED` when the budget does not allow another agent call or turn: nothing is sent, the run records
`budget.exceeded` (`data.needed` = calls requested) and enters `BLOCKED` with the budget reason, so the UI can offer
「放寬預算並繼續」. Exception: when a **workflow** task is waiting for the operator (review gate `WAITING_INPUT`, `WAITING_APPROVAL`)
or is already `BLOCKED`, only this dispatch is refused (`budget.exceeded` with `data.whileWaiting = true`, `data.refusedDispatch =
true`); the run keeps its waiting state, blocker and pending approvals. The UI then offers to relax the budget (`POST .../budget`
`{ relax: true }`) and resend with one click.

A message to an agent that has no session yet starts one without changing the run status (except for the task's first start): asking
Codex while a workflow waits at the review gate keeps the gate, so `accept` still completes the task.

### POST /api/tasks/:taskId/budget

Adjust a task's budget (P0-7). Body (strict — unknown fields are rejected):

```json
{ "maxDurationMs": 3600000 }
{ "relax": true }
{ "maxTurns": 60, "resume": false }
```

- Limits: `maxTurns`, `maxAgentCalls`, `maxStallCount`, `maxEstimatedTokens` (integers ≥ 1), `maxReviewRounds` (integer ≥ 0),
  `maxDurationMs` (integer, 60000 … 30 days). Only the given limits change.
- `relax: true` — "放寬預算": open a new counting window (another full allowance of every limit; stall counter reset). This is what the
  one-click 「放寬預算並繼續」 button on the budget-block banner sends.
- `resume` (default `true`) — if the run is `BLOCKED` because of the budget and, after the change, no limit is exhausted any more, the
  task continues: a workflow re-dispatches the step it was waiting for to the same agent (context purpose `budget-resume`); a chat
  task returns to `RUNNING` and every agent that the budget stop interrupted (`run.blockedBy.interruptedAgentIds`, primary first) gets
  a continuation message. Tasks blocked before this version (only `currentStep = "budget:<limit>"`, no `blockedBy`) are recognized too.
- Emits one `budget.extended` event (`data.reason: "operator"`, `data.changes: { <limit>: { from, to } }`, `data.renew`,
  `data.blockedLimit`) and updates `run.budget` in the same transaction.
- Response `200`: `{ ok: true, changes, renewed, resumed, status, budget, message? }` — `message` (Chinese) explains why a
  budget-blocked task was not resumed (for example the new limit is still exhausted).
- `400` for an empty body, unknown fields, non-integers or out-of-range values; `404` for an unknown task; `409` `TASK_TERMINAL` for a
  completed / cancelled / failed task.

### Budgets

- Limits are "at most N": the N-th turn / call runs normally and its successful completion is accepted (fixes the old `>=` boundary
  that blocked on the last allowed turn and dropped its completion). When a limit is used up, no new turn is dispatched
  (`budget.exceeded` / `budget.stalled` before dispatch); a running turn that goes beyond it (N+1) is stopped. Duration is stopped
  when it is used up. `maxAgentCalls` counts dispatches; the test runner does not consume turns, tokens or stall budget.
- Duration counts only time in which an agent is actually working on a turn (`run.budget.activeMs` + the open interval
  `activeSince`, tracked in `run.budget.workingAgentIds`), whatever the run status: an agent that keeps working while the run waits
  for approval (for example after `request_handoff`, or the other agent of an Ask Both) or at the review gate is counted; an agent
  that is itself waiting for a tool approval (a pending approval that is not `payload.kind = "handoff"`) is not. An idle chat, time
  waiting for the operator and server downtime are not counted (on restart the open interval is closed at the last recorded event,
  `activeCheckedAt`). Snapshots written before this version have no `activeMs` and start at 0.
- After a restart no agent counts as working until its session is actually resumed (the resume's `agent.started` / working status
  registers it again). An agent listed as working that has no session left in the process (not live, not finishing a cancel, not being
  dispatched) is removed with a `runtime.warning` `AGENT_WORK_CLEARED` (`data.workEnded = true`), so it is not timed and cannot make a
  blocked task repeat budget events.
- Claude: the adapter hands one turn at a time to the runtime; a message sent while a turn is running is queued and handed over
  (after switching to that turn's own permission mode) when the running turn's `result` arrives. The finishing turn's terminal
  `agent.status` carries `data.queuedTurns`, and the adapter reports `agent.status` `coding` again (`data.queuedTurns`), so the queued
  turn is timed and budget-controlled.
- Counting windows (`run.budget.window`): turns, calls, tokens and duration are counted since the window start. Workflow tasks open a
  new window at gate `review` / `retry`, `reassign` and `POST .../budget` with `relax`; chat tasks open a new window for every operator
  instruction (message, ask-both, operator handoff), so everyday chatting never runs out. Operator instructions also reset the stall
  counter (several plain Q&A rounds are not a stall). `maxReviewRounds` is not windowed.
- Chat tasks default to their own budget (`DEFAULT_CONVERSATION_BUDGET`, per instruction: 30 turns, 12 agent calls, 3 stall turns,
  60 minutes of working time); workflow tasks keep `DEFAULT_BUDGET` (30 turns, 12 calls, 3 stall turns, 30 minutes).
- While a run is `BLOCKED` but an agent is still finishing a turn (or answering an operator question in a blocked workflow), the same
  runtime limits apply: when one is exceeded the working agents are stopped and `budget.exceeded` is recorded with
  `data.whileBlocked = true`; the block reason (`blockedBy`, `currentAction`) is not changed.
- The same holds while the run waits for the operator (`WAITING_APPROVAL` / `WAITING_INPUT`) and an agent keeps working: when a limit
  is exceeded only the working agents are stopped and `budget.exceeded` / `budget.stalled` is recorded with `data.whileWaiting = true`
  and `data.workingAgentIds`; the run keeps its waiting status and its pending approvals / inputs (sessions waiting for an approval are
  not touched).
- Budget events (`budget.*`) and orchestrator status transitions (`run.*`) never trigger a budget check themselves.

Error responses for business errors are `{ "error": "<Chinese message>", "code": "<CODE>" }`; `code` is present for structured errors
(`TASK_TERMINAL`, `TASK_BLOCKED`, `BUDGET_EXHAUSTED`, `BUDGET_INVALID`, `TRANSITION_REJECTED`, `APPROVAL_ALREADY_RESOLVED`,
`SESSION_RESUME_BLOCKED`, `WORKSPACE_REJECTED`, `INVALID_AGENT`, `GATE_ACTION_UNAVAILABLE`, …).

### POST /api/shutdown

Graceful shutdown (P1-5). Requires login like every `/api/*` route (`401` without it) and a JSON body (`{}`). Replies `{ ok: true }`,
then the host's `onShutdownRequest` runs (the CLI entry stops every agent runtime, closes the database, releases the single-instance
lease and exits with code `0`; a later desktop shell can quit the app). Without `onShutdownRequest` the server only closes itself.
The CLI entry also shuts down gracefully on `SIGINT`, `SIGTERM`, `SIGHUP` and `SIGBREAK` (Ctrl+Break on Windows), with a 10-second
forced-exit fallback.

### Idle session release (P1-5 / M-6)

A live session whose agent has finished its turn, has no pending approval, is not the step a workflow is waiting for and has had no
event (persisted or streamed) for `ACC_IDLE_SESSION_MS` (default `600000` = 10 minutes, `0` disables) has its runtime released
silently: no event is written and the task status does not change. The next message resumes the provider session by its native id,
so the conversation context is kept. Only adapters implementing `AgentAdapter.release` take part (Claude, test runner, mock; the
shared Codex app-server keeps its threads). When a task ends, its sessions are cancelled and then released from the adapters.

### POST /api/tasks/:taskId/interrupt

Body `{ agentId }`. Stops only that agent's current turn (P1-10 / M-27): its session is cancelled (the pane shows 「已停止」), the task
and the other agents keep running, and the next message to that agent resumes the provider session by its native id. `409
INTERRUPT_UNAVAILABLE` when the agent has no turn in progress, or when it is the step an automatic workflow is waiting for (use
cancel or the gate's retry instead); `409 TASK_TERMINAL` on ended tasks.

### POST /api/tasks/:taskId/cancel

Transitions the task to `CANCELLED` first, then stops **every** live agent session of the task (Ask Both: both agents). Cancel is
not queued behind other commands, so it takes effect immediately even while an agent is still starting; a session whose start,
resume or send returns after the cancel is cancelled once more (even if the stop already cancelled it — that cancel may have happened
while the dispatch request was in flight, e.g. before Codex's `turn/start` returned a turn id) and never registered as live. Adapters'
`cancel` is idempotent (one `cancelled` terminal per session); Codex also interrupts a turn whose `turn/start` reply arrives after the
cancel. The same applies to a budget stop and to `accept`. The orchestrator waits at most `cancelTimeoutMs` (default 15 s) for an
adapter's `cancel`; a cancel that did not finish is recorded as `runtime.warning` `ADAPTER_CANCEL_TIMEOUT` and repeated (forcefully)
by the next stop — so cancelling an already cancelled task is otherwise a no-op (`200`); cancelling a completed / failed task returns
`409`. Claude's cancel waits at most 5 s for the runtime to acknowledge the interrupt, then kills the CLI process.
Like every POST it needs a JSON body (send `{}`); without one it is rejected (`415` / `400`).

### POST /api/approvals/:approvalId/resolve

`taskId` is optional; the server resolves it from the persisted approval record.

```json
{
  "decision": "approve"
}
```

or

```json
{
  "decision": "decline"
}
```

`scope: "session"` (the UI's 「本會話都允許」, P0-8 / M-15) is only honoured when the request allows it: `approval.required` carries
`data.allowSessionScope` (`false` when Claude sets `suppressAlwaysAllowRule`, when Claude offers no session-level `addRules`, or when a
command touches a protected path — see below); the UI hides the option then, and a `session` scope sent anyway is downgraded to
`once` (`approval.resolved` records `scope: "once"`, `scopeDowngraded: true`). For Claude a session-level approval only ever sends
`addRules` with `destination: "session"` back to the SDK — no settings file is written and no `setMode` / `addDirectories` is applied.

`approval.required` may also carry `data.risk = "high"` with a Chinese `data.riskReason`: the command mentions a protected path
(any `.git` path segment including `.git/hooks` and `.git/config`, `git config` / `core.hooksPath` / `core.fsmonitor`, the effective
git hooks directory such as `.husky/`, user-level git config `~/.gitconfig` / `~/.config/git/`, `.claude`, `.mcp.json`, `.codex`;
full rules in `docs/RUNTIME_ADAPTER_MAPPING.md`). Writes to those paths through Claude's
Edit / Write / MultiEdit / NotebookEdit or Codex file-change / permission requests are denied automatically (no approval is asked;
a `runtime.warning` `PROTECTED_PATH_WRITE_DENIED` with a Chinese `message` is recorded). A Codex change applied inside its sandbox
without an approval that touched such a path is reported afterwards as `runtime.warning` `PROTECTED_PATH_WRITE_DETECTED`.

An approval is consumed exactly once: checking that it is still pending and persisting `approval.resolved` happen atomically under
the run lock, and only the call that wins performs the side effect (tool approval to the adapter, resume after a restart, or the
requested handoff). Concurrent or repeated submissions get `409` `APPROVAL_ALREADY_RESOLVED` (the message states the first
decision); the task is not blocked by them.

Approving an agent's handoff request (`payload.kind = "handoff"`) first checks that the handoff can run, **before** the approval is
consumed:

- chat task `BLOCKED`: without `"resume": true` → `409` `TASK_BLOCKED` (Chinese reason and way out); the approval stays pending and
  nothing is executed. With `"resume": true` (the UI asks the user to confirm 「恢復並轉交」) the task is resumed first (a budget block is
  relaxed with `budget.extended`), then the approval is consumed and the handoff delivered;
- the budget does not allow the call → `409` `BUDGET_EXHAUSTED`, the run records `budget.exceeded` and enters `BLOCKED` (one-click
  「放寬預算並繼續」); the approval stays pending and can be approved again after relaxing.

An agent-requested handoff under the `auto` policy that the budget refuses only records `budget.exceeded`; it is not an
`ORCHESTRATOR_REACTION_FAILED`.

On restart, an agent whose only pending approval is its own handoff request is still working (the request does not pause it) and is
resumed like any other working agent (or fails closed naming it).

When a run becomes terminal, all its pending approvals are marked `voided` in the same projection (approval records get
`status: "voided"`); resolving one returns `409` `TASK_TERMINAL` and nothing is executed. An `approval.required` that arrives after
the run became terminal is recorded as declined and answered with an `approval.resolved` (`resolvedBy: "orchestrator"`,
`reason: "run-terminal"`); it never becomes a pending approval.

## WebSocket

Endpoint:

```text
/ws/events
```

Server sends `UnifiedEvent` JSON objects.

Delivery semantics:

- An event is pushed only after it has been persisted (event log + run snapshot in one transaction).
- Orchestrator reactions (budget checks, workflow advance, agent handoff requests) run afterwards in a per-run serial queue, so an event is always pushed before the events it causes. Reactions of different runs never block each other.
- If an orchestrator reaction itself fails, the run receives a `runtime.error` **without `agentId`**, with `data.code = "ORCHESTRATOR_REACTION_FAILED"`, `data.source = "orchestrator"`, `data.reaction` (`budget` | `workflow` | `handoff-request` | `late-approval` | `session-ownership`) and `data.triggerEventId` / `triggerEventType` / `triggerSequence`. The run then fails closed (`BLOCKED`) and stays there until the operator decides (gate, reassign or cancel) — approvals granted meanwhile do not unblock it. The agent sessions stay alive (the current turn may still finish; the operator stops it with cancel) and this is not counted as a provider error.
- While a run is `BLOCKED`, the task's `currentAction` keeps the block reason: only `runtime.error`, `safety.blocked`, `budget.*` and `run.status` events may change it, so routine agent events of a turn that is still finishing cannot overwrite it. The `run.status` event that enters `BLOCKED` carries the reason in `data.action`.
- `EventBus.drain()` / `Orchestrator.idle()` also wait for publishes that are still being persisted or delivered to observers: when they resolve, the reactions of every event published before the call have run.
- A status transition of the orchestrator (`run.status`, `run.completed`, `run.failed`) that the state machine rejects is still stored, and is followed by a `runtime.warning` with `data.code = "TRANSITION_REJECTED"`, `from`, `to`, `eventId`, `eventType` and a Chinese `message` — a rejected transition is never silent.
- Adapter event entrance (P0-9 / L-1): events emitted by an adapter always carry the identity the orchestrator bound to it
  (`projectId`, `taskId`, `runId`, `agentId`); adapter-supplied `id` / `sequence` / `timestamp` are ignored. Adapters may only emit
  `agent.*`, `model.turn.*`, `tool.*`, `handoff.requested`, `approval.required`, `safety.blocked`, `runtime.warning` and
  `runtime.error`, always with a `sessionId`. Anything else (`run.*`, `approval.resolved`, `budget.*`, `handoff.completed`, a
  session-less event, an `approval.required` with `kind: "handoff"`, an `agent.message` with `direction: "to-agent"`) is dropped —
  the run state is unchanged — and recorded once per sink as a `runtime.warning` without `sessionId`: `data.code =
  "ADAPTER_EVENT_REJECTED"`, `eventType`, `reason`, `attemptedSessionId`, Chinese `message`. A mismatched identity is corrected and
  recorded as `ADAPTER_EVENT_IDENTITY_FIXED` (`data.fields`).
- `budget.extended` (P0-7): the budget was changed or renewed by the orchestrator (`data.reason`: `gate` | `operator` | `resume` | `reassign`; `data.changes`, `data.renew`, `data.blockedLimit`). It is only accepted from the orchestrator (events carrying an `agentId` / `sessionId` are ignored), so an agent cannot raise its own budget.

Resuming a session after a restart, an approval or a new operator message (`adapter.resume`):

- The session keeps the working directory and mode it was started with. Both are persisted in the run snapshot (`agentSessions[agentId].metadata.cwd` / `.mode`) and passed to the adapter in `AgentResumeInput.metadata`. Claude resumes with that `cwd` and, for read-only modes (`review` / `rescue` / `analysis`), `permissionMode: 'plan'`. Codex sends them in `thread/resume` (`cwd`, `sandbox: 'read-only'` for read-only modes). Adapters never fall back to their default workspace.
- If the persisted `cwd` or `mode` is missing or unusable, or Codex reports a different `cwd` after `thread/resume` (compared after normalization; case-insensitive with unified separators on Windows), the resume fails closed. No provider turn is started. The run receives a `runtime.error` with `data.code = "ADAPTER_RESUME_FAILED"`, `confidence = "confirmed"`, `data.category = "runtime"`, `data.retryable = false` and `data.classifiedAs` = `RESUME_CWD_MISSING` | `RESUME_MODE_MISSING` | `CODEX_RESUME_CWD_MISMATCH`, and then enters `BLOCKED` with that reason.
- Such a precondition failure also marks the session as not resumable (`agentSessions[agentId].metadata.resumeBlocked`). Later operator messages to it get `409` without using budget; orchestrator dispatches to it fail closed with `runtime.error` `SESSION_RESUME_BLOCKED` (same `classifiedAs`) without using budget. Reassigning the task to another agent still works.
- The mode actually used is the stricter of the session's start mode and the current workflow step's mode, never wider: when the same agent implements and then reviews or diagnoses (for example Codex doing both), the review / rescue turn runs read-only — online Claude switches to `plan` (`query.setPermissionMode`) and Codex passes `sandboxPolicy: { type: "readOnly" }` on `turn/start`; a resume during such a step uses `plan` / `sandbox: 'read-only'`. Returning to an implementation step restores the session's own mode.
- Conversation tasks persist their working directory (for example an isolated worktree) in the run snapshot at creation (`workspace`, snapshot schema v5), so an agent started later — even after the first start failed and the server restarted — works in the same directory instead of the default workspace.

No-hang guarantees (P0-6):

- Adapter turn contract (`AgentAdapter` in `packages/core/src/types.ts`, shared test `tests/regression/adapter-terminal-contract.test.ts`):
  every dispatched turn (the first turn of `start`, each `send`, each turn caused by `resume`) ends with exactly one terminal
  `agent.status` — `completed`, `failed` or `cancelled` — carrying `data.turnId` where the provider has one (Codex turn id, Claude
  result `uuid`, the test runner's run id, Mock `<session>#<n>`). Provider errors are a normalized `runtime.error` followed by `failed`;
  a cancelled turn never produces a second terminal. A dispatch call that throws (`start` / `send` / `resume`) was not delivered and gets
  no terminal event.
- Claude: a `result` with `error_*` or `is_error` emits one `runtime.error` (`code` from the turn's assistant error, e.g.
  `CLAUDE_OVERLOADED`, else `CLAUDE_API_ERROR` / `CLAUDE_ERROR_<SUBTYPE>`; `data.apiErrorStatus`) and `failed`. `retryable` follows
  `api_error_status`: `408`, `429`, `5xx` (including `529`) and `null` (connection error without an HTTP response) are retryable;
  `401`/`403` are `category: "permission"`, `429` is `category: "usage"`. Errors reported inside a turn (assistant `error`, e.g.
  `max_output_tokens`, which Claude Code recovers from) are `runtime.warning`. If the Claude Code process ends without being cancelled,
  the adapter emits `CLAUDE_RUNTIME_EXITED` (message stream ended, e.g. exit code 0) or `CLAUDE_RUNTIME_ERROR` (stream threw) with
  `data.sessionClosed = true`, plus `failed` when a turn was in progress (as `runtime.error`); when the session was idle only the
  closure is reported (`runtime.warning` for a clean exit) and no extra terminal is added.
- Codex: an interrupted turn that the orchestrator did not cancel emits `runtime.error` `CODEX_TURN_INTERRUPTED` (`retryable: true`)
  and `failed` (`data.interrupted = true`) instead of `waiting`. A lost app-server connection emits `CODEX_TRANSPORT_CLOSED`
  (`retryable: true`, `sessionClosed: true`) and `failed` only for a turn still in progress; messages that arrive on the dead
  connection afterwards are dropped.
- Session retirement and transparent reconnect (H-11): when the orchestrator receives `failed`, `cancelled` or an event with
  `data.sessionClosed = true`, the session leaves the live-session table. Later dispatches to it (workflow retry, gate retry, operator
  message) go through `adapter.resume`: an adapter whose session is still usable continues on it (Claude pushes the prompt into the
  same query; Codex starts a new turn on the same thread); a closed one reconnects to the native session (`options.resume` /
  `thread/resume` on a new app-server when needed). If a `send` fails because the runtime connection closed mid-dispatch, the adapter
  throws `AdapterSessionClosedError` (`code: "ADAPTER_SESSION_CLOSED"`) and the orchestrator resumes instead of failing the task with
  `ADAPTER_SEND_FAILED`; no extra agent-call budget is used. Retired sessions are still stopped on cancel / accept / budget stop / shutdown.
- Recovery re-drives a workflow's current step (M-8 mitigation before the P1-1 outbox): when the run is `RUNNING` and no agent was
  working before the restart, the step the workflow was waiting for is dispatched again to `awaitingAgentId` (for example tests that
  were decided but never started because the server was shutting down); a review gate / test-configuration gate that was decided but
  not yet recorded as `WAITING_INPUT` is recorded now, and a workflow already at `done` is completed. It no longer "resumes" the
  agent that just finished the previous step.
- The step inactivity watchdog ignores an awaited agent that has a pending tool approval (it is waiting for the operator), the same
  rule the duration budget uses.
- A non-retryable `runtime.error` from the current session of the agent the workflow is waiting for is treated as that agent's failure
  (retry, rescue or `BLOCKED` with the reason) even if the adapter never sends a terminal; errors recorded by the orchestrator itself
  (no `sessionId`) or from an older session are ignored for this purpose.
- Handoff approvals during a workflow (H-9): while the run is `WAITING_APPROVAL`, a completion / failure signal from the agent the
  workflow is waiting for is stored with its `stepSeq` in `workflowState.deferredSignal` (persisted, survives a restart) and replayed
  when the run returns to `RUNNING`; it is dropped if the step has changed meanwhile (for example after `reassign`). The workflow
  therefore continues whether the handoff is approved (the target agent also gets the forwarded content, read-only in a workflow) or declined.
- Step inactivity watchdog: every `ACC_BUDGET_CHECK_MS` the server calls `orchestrator.checkInactivity()`. When a `RUNNING` workflow
  run's awaited agent has produced no event (persisted events, streaming deltas, status changes and dispatches all count; time spent in
  `WAITING_APPROVAL` / `WAITING_INPUT` / `BLOCKED` and server downtime do not) for `run.settings.inactivityTimeoutMs`, the orchestrator
  cancels that agent's session, records `runtime.error` `STEP_INACTIVITY_TIMEOUT` (`data.source: "watchdog"`, `step`, `idleMs`,
  `thresholdMs`, `next: "retry" | "rescue" | "blocked"`) and then: first resumes the same agent on the same step (shares the single
  transient-retry allowance, reset by a successful turn); if it stalls again in an implementation step, asks the review agent for a
  read-only diagnosis (`rescue`, then the implementer applies it as `fix`); otherwise the run enters `BLOCKED` with
  `blockedBy = { source: "workflow", code: "STEP_INACTIVE" }` and the reason in `currentAction`.
- The UI banner for a `BLOCKED` run shows the real reason in Chinese (login expired, quota used up, service busy, runtime exited,
  step inactive, …) and one-click actions: 「重試」 (`gate retry` with a default note; not offered when the session cannot be resumed),
  「換 X 接手」 (`reassign`) and 「停止」 (`cancel`).

Client reconnect behavior:

- V1 may fetch task state after reconnect and then continue live events.
- Later add `?afterSequence=` or event replay endpoint.
