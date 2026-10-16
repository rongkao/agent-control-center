# Implementation Tasks

The order matters. Do not skip durable state and jump straight to provider integrations.

## P0 — Make the control plane trustworthy

- [x] **P0.1 Durable SQLite store**
  - Persist tasks, run snapshots, event log, approvals, sessions, usage.
  - Atomic update API for `append event + update snapshot`.
  - Acceptance: restart process and recover all non-terminal runs.
  - Done: `SqliteControlPlaneStore` (built-in `node:sqlite`, WAL, `PRAGMA user_version` DB migrations),
    `ControlPlaneStore.commit()` transaction, `Orchestrator.recover()`; tests in `tests/store-contract.test.ts`
    (memory + sqlite share one contract) and `tests/recovery.test.ts`.

- [x] **P0.2 Versioned RunSnapshot**
  - Add `schemaVersion`, migration boundary, `lastEventId`.
  - Unknown newer schema must fail closed with explicit incident.
  - Acceptance: JSON round-trip tests preserve pending approval identity.
  - Done: `packages/core/src/snapshot.ts` (schema v2, v1→v2 migration, `SnapshotLoadError`, `RunLoadResult`);
    unknown schema → critical `runtime.error SNAPSHOT_SCHEMA_UNSUPPORTED`, task BLOCKED, snapshot never overwritten.

- [x] **P0.3 Approval pause/resume**
  - Orchestrator enters `WAITING_APPROVAL`.
  - Approval resolution resumes the same logical step.
  - Acceptance: completed tool work before the approval is not repeated.
  - Done: `resumeCursor` + `completedSideEffects` ledger in snapshot; live session → `adapter.approve`,
    after restart → `adapter.resume(AgentResumeInput)` with `completedSideEffectIds`; adapter without resume fails closed.
  - Restart during `WAITING_INPUT` (review gate) is covered in `tests/workflow.test.ts`.

- [x] **P0.4 Budget + stall enforcement**
  - max turns, calls, review rounds, stall count, duration.
  - Acceptance: deterministic terminal/block events for each limit.
  - Done: runtime limits (turns, stall, duration via `checkBudgets()`, estimated tokens) → `budget.exceeded` /
    `budget.stalled` + BLOCKED + cancel live session; `maxAgentCalls` pre-checked before each start.
    `maxReviewRounds` exposed as `canStartReviewRound()`; wired into review flow in P2.3.
  - Revised by P4 hardening (report P0-7): duration counts only time an agent is actually working, limits mean "at most N",
    chat tasks have their own per-instruction budget, `POST /api/tasks/:taskId/budget` raises / relaxes limits.

## P1 — Real runtime integration

- [x] **P1.1 Codex App Server adapter**
  - Spawn/connect App Server.
  - Track native thread ID.
  - Map thread/turn/item/approval/error into `UnifiedEvent`.
  - Implement cancel/resume/approve.
  - Acceptance: adapter contract test + manual smoke test with existing ChatGPT auth.
  - Done: `CodexAppServerAdapter` + `CodexRpcClient` against codex-cli 0.156.1 protocol (`codex app-server generate-ts`);
    contract tests `tests/codex-adapter.contract.test.ts` (incl. SQLite restart); smoke test `npx tsx scripts/smoke-codex.ts`
    passed 2026-09-23 with ChatGPT auth (command approval → tool.completed → usage → file on disk).

- [x] **P1.2 Claude Agent SDK adapter**
  - Streaming run/session integration.
  - Map message/tool/permission/error lifecycle.
  - Implement cancel/resume/approve when supported by runtime contract.
  - Acceptance: adapter contract test + manual smoke test.
  - Progress: `ClaudeAgentSdkAdapter` implemented against `@anthropic-ai/claude-agent-sdk` 0.3.x (streaming-input `query()`,
    `canUseTool` → `approval.required`, `interrupt()` cancel, `options.resume` native resume with pre-approved replay).
    Contract tests with fake runtime pass (`tests/claude-adapter.contract.test.ts`, incl. SQLite restart).
    Server: `ACC_RUNTIME_MODE=real`.
  - Manual smoke test passed 2026-09-23 (`npx tsx scripts/smoke-claude.ts`: Write approval → tool.completed → usage → file on disk).

- [x] **P1.3 Session ownership registry**
  - Exactly one adapter/runtime owner per session.
  - Acceptance: conflicting attach is rejected and logged.
  - Done: `SessionRegistry` (slot reserve/attach/release) + store lookup `findSessionsByProviderId`; conflicts emit
    `runtime.error SESSION_OWNERSHIP_CONFLICT`; restart emits `SESSION_OWNER_TRANSFERRED`. Tests: `tests/session-ownership.test.ts`.

## P2 — Workflow quality

- [x] **P2.1 V1 deterministic workflow engine**
  - Implement → test → one retry → optional rescue → manual review → final test.
  - Acceptance: workflow integration tests.
  - Done: pure `decide()` in `packages/core/src/workflow.ts`, persisted `WorkflowState` (RunSnapshot v3),
    `LocalTestRunnerAdapter` for real test commands, post-phase EventBus listeners keep subscriber order by sequence.
    Tests: `tests/workflow.test.ts`; real end-to-end smoke `npx tsx scripts/smoke-workflow.ts` passed 2026-09-23.

- [x] **P2.2 Context Manager**
  - Task summary, selected files/results, recent events, handoff envelope.
  - Do not forward full conversation/repo by default.
  - Done: `buildContextEnvelope()` (task + step goal + clipped test output + counterpart's last output + constraints);
    handoffs persisted in `WorkflowState.handoffs` and emitted as `handoff.requested/completed`.

- [x] **P2.3 Review Manager**
  - `autoReview=false` default.
  - `maxReviewRounds=1` default.
  - Manual review button is first-class.
  - Done: optional review gate (`reviewGate`), `POST /api/tasks/:id/gate` (accept / review / retry), verdict parsed as
    `inferred`, SUGGEST_CHANGES → one follow-up → final test, round limit enforced (409). Review/rescue run read-only
    (Claude `plan` mode, Codex `read-only` sandbox).

- [x] **P2.4 Error classifier**
  - Structured native → runtime → text inference.
  - Expose confidence `confirmed|inferred`.
  - Done: `classifyError()`; adapter exceptions become `runtime.error` with inferred confidence; retryable transient
    failures get one bounded retry in the workflow, everything else goes to the human gate.

## P3 — UI + operations

- [x] **P3.1 Real task dashboard**
  - Connect existing UI to REST + WS.
  - Agent cards, current action, events, incident center, approval dialog.
  - Done: `apps/web/src` (task list, detail with stepper / facts / next orchestrator action, agent cards, incident center
    separating confirmed vs inferred, approval dialog, handoffs, test output, event stream), WS incremental projection +
    REST reconciliation. Verified in the browser against mock and real runtimes.

- [x] **P3.2 Recovery UX**
  - Show “recovered after restart”, pending approval, disconnected runtime.
  - Done: recovery banner + badges, pending approval banner, disconnected-runtime banner with operator options,
    snapshot-unreadable banner; recovered sessions shown as waiting. Verified with a real Claude task across two restarts.

- [x] **P3.3 Usage dashboard**
  - Calls, duration, estimated/reported tokens, review rounds, failures, stalls.
  - Done: `summarizeUsage()` + `GET /api/usage` + 用量 view; per-task budget bars in the task detail.

- [x] **P3.4 Worktree isolation**
  - Optional task worktree binding.
  - Never allow two write-capable agents to share a worktree concurrently without explicit policy.
  - Done: `createTaskWorktree()` (`.acc-worktrees/<task>`, branch `acc/<task>`, local exclude only), workspace
    exclusivity check (`sharedWorkspace` explicit policy), tests in `tests/p3-operations.test.ts`.

## P3.5 — Multi-agent collaboration (from ARCHITECTURE / UI_SPEC)

- [x] **Agent-requested handoff**: agents may only *request*; the Orchestrator decides.
  - Claude: structured in-process tool `mcp__acc__request_handoff` (confirmed); Codex: `HANDOFF@<agent>: ...` line (inferred).
  - Policy per task: `ask` (operator approval card, default) or `auto` (max 4 per task, then back to ask); workflow tasks always ask.
  - Declining a handoff does not block the task. Tests: `tests/collaboration.test.ts`.
- [x] **Ask Both**: one message dispatched to every chat agent; the primary may write, others answer read-only
  (never two write-capable agents in one workspace concurrently).
- [x] **Reassign**: cancels the busy agent, voids its pending approvals, hands the task over with context; workflow tasks
  switch implementer (the previous one becomes reviewer).
- [x] Operator-initiated forward ("轉給 Codex / Claude"), session-scoped approvals, chat UI with streaming.
- RunSnapshot schema v4 (`settings`).
- Hardened by P4 (report P0-9): `auto` only executes structured (`confirmed`) requests; the Codex marker only counts on the last
  non-empty line and always needs operator approval; forwarded content is quoted in data blocks; Ask Both advisors are always
  read-only for that turn.

## P4 — Hardening / P4 加固 (source: `docs/ANALYSIS_REPORT.md`)

`docs/ANALYSIS_REPORT.md` is an analysis snapshot taken at `c30c7a2`. Its section 7 roadmap P0 items were implemented in commits
`f8fba78` … `f3901cf` (12 commits, including three review batches: `48a5814`, `1b44da6`, `f3901cf`). The IDs below are the
report's roadmap IDs (`P0-x` / `P1-x` / `P2-x`, issues `H-x` / `M-x` / `L-x`); they are not the `P0.x` items at the top of this file.
Evidence means regression tests in `tests/regression/` (file names below are relative to it); they all run in `npm test`.
Validation at the end of the series: `npm run typecheck`, `npm test` (70 test files, 580 passed, 9 skipped: contract cases that do not apply to an adapter, one POSIX-only case) and
`npm run build` pass.

### Report P0 — must fix now (security and data correctness)

- [x] **P0-0 Turn the probes into regression tests** (every "實測" finding)
  - Status: **done.** The scenarios listed below as "not covered" got their tests with P1-1 / P1-3 / P1-4 (`completion-correlation`,
    `workflow-stale-completion`, `ask-both-advisor-rounds`, `permission-propagation`, `workspace-and-handoff-context`); L-3 is covered
    by `terminal-settings-after-restart.test.ts`. probe6 (unverified §3.5 leads) stays documentation only.
  - Earlier status: partially done. Every probe scenario cited in report §3.2 (probe scenarios 1, 3, 4, 6; probe2, probe3 B / D,
    probe4, probe5, probe7, probe8; plus the two-instance, cross-site WebSocket, stdin EOF and concurrent-approval repros) and
    probe scenarios 10 / 11 have regression tests. The fixes landed together with their tests, so the tests use normal assertions
    instead of `it.fails`; each test file's header describes the reproduction before the fix. Not covered yet — they belong to P1
    items: probe scenario 8 (M-1 → P1-3), probe scenario 9 (M-3 → P1-4), probe9 (M-4 → P1-4, L-3 → P1-1), a dedicated
    `WAITING_APPROVAL` case for probe3 C (the code path is fixed, see P0-5) and probe6 (unverified §3.5 leads).
  - Implemented: 57 regression test files; minimal asynchronous test doubles in `tests/regression/fakes/` (`ControlledAgent`,
    `GatedAgent`, `deferred`, fake Codex / test child processes, fake app-server fixtures). The probe → test mapping is in
    `docs/analysis-probes/README.md`; the probe scripts are kept as evidence.
  - Evidence: `docs/analysis-probes/README.md` (mapping table) and all `tests/regression/*.test.ts`.
  - Known limitations: the full asynchronous double with sync / microtask / delayed delivery modes run through `describe.each`
    is still P1-11.

- [x] **P0-1 Local service access control and input validation** (H-1, L-10, L-12, clickjacking) — `380ca2b`, review `48a5814`
  - Status: done.
  - Implemented: Host allow-list and same-origin check, also on the WebSocket upgrade; access token persisted in the data dir
    (owner-only ACL, checked and repaired at every start, never put in `process.env`); the `?token=` link is exchanged for an
    `HttpOnly; SameSite=Strict` cookie (30 days); every POST must be JSON; a non-loopback `ACC_HOST` without `ACC_TOKEN_FILE`
    refuses to start; WS `maxPayload`, connection cap and backpressure; `frame-ancestors 'none'` + `X-Frame-Options: DENY`;
    `cwd` must be an existing absolute directory outside the data dir (optional `ACC_ALLOWED_ROOTS`), agent capabilities are
    checked, and a worktree is created only after every check passed. `npm start` opens the access link in the browser
    (`ACC_NO_OPEN=1` disables it).
  - Evidence: `access-control.test.ts`, `task-input-validation.test.ts`, `token-acl-alias.test.ts`, `loopback-host.test.ts`.
  - Known limitations: the access link printed in the terminal contains the token (treat it like a password); on POSIX the file
    protection is `chmod 600` only; `.env` is still not loaded automatically (P1-16).

- [x] **P0-2 Orchestrator exceptions no longer crash the process** (H-2, H-14, M-10, L-2) — `f8fba78`, review `48a5814`
  - Status: done.
  - Implemented: EventBus split into persist / observers / reactions; reactions run in a per-run serial queue, detached from the
    adapter's `emit` stack; a failing reaction becomes an orchestrator `runtime.error` `ORCHESTRATOR_REACTION_FAILED` (no `agentId`)
    and fails closed, and the `BLOCKED` state holds until an operator decision; `safeEmit` for fire-and-forget emits (an approval
    request that cannot be delivered is denied); the Claude message pump separates emit failures from SDK iteration failures;
    Codex stdio pipes get error listeners and a 16 MiB backpressure limit (→ `CODEX_TRANSPORT_CLOSED`); Codex notifications are
    chained per thread; a global `unhandledRejection` guard only logs; `drain()` / `idle()` also wait for in-flight publishes.
  - Evidence: `reaction-queue.test.ts` (probe7), `adapter-emit-safety.test.ts`, `codex-transport.test.ts`, `process-guard.test.ts`,
    `event-bus-drain.test.ts`, `blocked-hold.test.ts`.
  - Known limitations: the global guard only logs (an unhandled rejection cannot be attributed to a run); workflow decisions are
    still executed outside a transactional outbox (P1-1).

- [x] **P0-3 Single instance** (H-3) — `889ce44`, review `48a5814`
  - Status: done.
  - Implemented: `<db>.lock` (SQLite exclusive lock + `instance_lease` row with heartbeat) acquired before anything is written;
    a second instance fails with `ACC_ALREADY_RUNNING` (pid and URL of the running one); a lease left by a killed / power-lost
    instance is taken over once the OS lock is gone; a busy lock file fails with `ACC_LOCK_FILE_BUSY` after retries; startup order
    is data-location check → lease → legacy migration → open store → listen → recover (state-changing requests wait for recovery);
    losing the lease stops every runtime and closes the server; `close()` stops all agent runtimes first (`AgentAdapter.dispose()`).
  - Evidence: `single-instance.test.ts`, `shutdown-runtimes.test.ts`.
  - Known limitations: recovery still runs serially right after listen (asynchronous recovery with progress is P1-1); no
    `/api/shutdown` and no SIGBREAK handling yet (P1-5).

- [x] **P0-4 Resume with the persisted cwd and mode** (H-4) — `db05f56`, review `48a5814`
  - Status: done.
  - Implemented: Claude `resume` and Codex `thread/resume` read `cwd` and `mode` from `AgentResumeInput.metadata` (read-only modes
    stay `plan` / `read-only`); missing or unusable values fail closed before any provider call (`RESUME_CWD_MISSING`,
    `RESUME_MODE_MISSING`); Codex compares the reported cwd after normalization (`CODEX_RESUME_CWD_MISMATCH`); the effective mode is
    the stricter of the session's start mode and the current step's mode (online: Claude `setPermissionMode('plan')`, Codex
    `turn/start` `sandboxPolicy`); chat tasks persist their workspace in the snapshot (schema v5); a session that failed a resume
    precondition is marked not resumable (`409 SESSION_RESUME_BLOCKED`, no budget used).
  - Evidence: `resume-workspace.test.ts`, `step-mode.test.ts`, `conversation-workspace.test.ts`, `resume-blocked.test.ts`.
  - Known limitations: a session keeps its start mode for its lifetime, so a session started read-only stays read-only after it
    takes over a writable role (`runtime.warning` `READ_ONLY_TAKEOVER`) until P1-4 (M-3).

- [x] **P0-5 Multi-session stop, state guards, approvals consumed once** (H-5, H-6, H-12, M-5, L-21) — `2578f58`, review `1b44da6`
  - Status: done.
  - Implemented: registry "run → all live sessions"; cancel, budget stop and accept stop every session; recovery checks every
    session (primary first; any that cannot resume → fail closed); `run.primaryAgentId` for chat tasks; dispatch permit checked
    under the run lock plus a dispatch-epoch re-check after `start` / `resume`; cancel is pre-emptive and enters `CANCELLED` first;
    approvals are consumed atomically under the run lock (`409 APPROVAL_ALREADY_RESOLVED`); terminal runs void pending approvals and
    a late `approval.required` is auto-declined; `run.blockedBy`, and only `WAITING_APPROVAL` resumes through an approval; operator
    commands serialized per task, "start or send" serialized per (run, agent); starting a new session never changes the run status
    except on the first start, so the review gate cannot be bypassed (this also fixes M-2 / probe3 A and C); Codex interrupts a turn
    whose `turn/start` reply arrives after the cancel; handoff approvals are checked before they are consumed; the approval dialog
    focuses 「稍後處理」, traps focus, never approves on Enter, and cards submit once.
  - Evidence: `multi-session-stop.test.ts`, `dispatch-guard.test.ts`, `approval-once.test.ts`, `approval-blocked-by.test.ts`,
    `approval-dialog.test.ts`, `command-queue.test.ts`, `review-gate-guard.test.ts`, `codex-cancel-inflight.test.ts`,
    `handoff-approval-blocked.test.ts`, `recovery-handoff-approval.test.ts`.
  - Known limitations: the dialog rules are tested as pure functions (`apps/web/src/approval-ui.ts`), there is no DOM / component
    test environment yet (P1-11); declining an approval does not interrupt the agent's current turn (M-18 → P1-6), only a later
    retry stops it first.

- [x] **P0-6 No more hangs** (H-9, H-10, H-11) — `fbdc97d`, reviews `1b44da6`, `f3901cf`
  - Status: done.
  - Implemented: `AgentAdapter` turn terminal contract (every dispatched turn ends with exactly one `completed` / `failed` /
    `cancelled`, with `turnId`; `sessionClosed` when the runtime is lost; `AdapterSessionClosedError` when a dispatch was not
    delivered), shared by Claude, Codex, the test runner and Mock; Claude error results → `runtime.error` (retryable from
    `api_error_status`) + `failed`, CLI exit → `CLAUDE_RUNTIME_EXITED`; Codex interrupted turn → `CODEX_TURN_INTERRUPTED` + `failed`,
    lost app-server → `failed` only for the open turn; failed / closed sessions leave the live table and later dispatches resume
    (transparent reconnect); completion signals during `WAITING_APPROVAL` are deferred with `stepSeq` and replayed; per-step
    inactivity watchdog (retry → rescue → `BLOCKED` `STEP_INACTIVE`) with heartbeats for activity that is not persisted and cancel
    timeouts (Claude interrupt 5 s, orchestrator 15 s); recovery re-drives the current workflow step; the `BLOCKED` banner shows the
    reason in Chinese with one-click 「重試」「換 X 接手」「停止」 (gate `rerun` when the reviewer / diagnoser failed).
  - Watchdog threshold: `ACC_STEP_INACTIVITY_MS` (server default) / `RunSettings.inactivityTimeoutMs` (per task),
    **default 900000 ms = 15 minutes**, `0` disables it; time spent waiting for the operator does not count.
  - Evidence: `adapter-terminal-contract.test.ts`, `claude-no-hang.test.ts` (probe4, probe5), `codex-no-hang.test.ts` (probe scenario 6),
    `handoff-signal.test.ts` (probe scenario 1), `step-watchdog.test.ts`, `watchdog-liveness.test.ts`, `blocked-banner.test.ts`,
    `blocked-banner-target.test.ts`, `recovery-workflow-step.test.ts`, `workflow-stale-completion.test.ts`, `waiting-state-guards.test.ts`.
  - Known limitations: the watchdog only covers workflow steps (chat tasks have no awaited step); completion signals are not yet
    correlated with a dispatch id — M-1 is mitigated (the old turn is stopped before a gate retry, approved handoffs are merged
    into the next workflow envelope), the real fix is P1-3; recovery re-drive is a mitigation of M-8 before the outbox (P1-1).

- [x] **P0-7 Budget semantics** (H-7, H-8) — `6be2024`, reviews `1b44da6`, `f3901cf`
  - Status: done.
  - Implemented: duration counts only time in which an agent is actually working (`activeMs`; not waiting for the operator, idle
    chats or server downtime; an agent waiting for its own tool approval is not timed); limits mean "at most N"; `accept` completes
    directly, gate `review` / `retry` and reassign renew the window (`budget.extended`); orchestrator transitions never trigger
    budget checks; rejected transitions record `TRANSITION_REJECTED`; chat tasks use `DEFAULT_CONVERSATION_BUDGET` per operator
    instruction; messages to a `BLOCKED` chat need an explicit resume (`409 TASK_BLOCKED` otherwise); `POST /api/tasks/:taskId/budget`
    (raise limits / `relax`, 「放寬預算並繼續」); Ask Both reserves all calls before dispatching; a budget refusal while the task waits
    for the operator refuses only that dispatch; the working-agent set is rebuilt after a restart (`AGENT_WORK_CLEARED`).
  - Evidence: `budget-semantics.test.ts` (probe8, probe2), `budget-working-agents.test.ts`, `handoff-approval-blocked.test.ts`,
    `waiting-state-guards.test.ts`.
  - Known limitations: token counts still use the providers' per-turn numbers (M-17) and there is no USD or subscription-quota
    budget yet (P1-7).

- [x] **P0-8 Minimal security tightening** (H-15, M-13, M-15, M-35) — `58dfccc`, review `f3901cf`
  - Status: **done.** The manual criterion is met: `scripts/smoke-claude.ts` and `scripts/smoke-codex.ts` were run in real mode on
    Windows with logged-in Claude Code and Codex 0.159.2 and passed (including the environment allow-list checks).
  - Earlier status: partially done. Every automated acceptance criterion has tests. The manual criterion "after tightening the
    environment, run `scripts/smoke-claude.ts` / `scripts/smoke-codex.ts` in real mode on Windows" is prepared (both scripts now
    print the P0-8 checks), but no real-mode run is recorded in this repository yet; it needs a machine with logged-in Claude Code
    and Codex.
  - Implemented: child-process environment allow-lists (`packages/adapters/src/env-policy.ts`): the test runner gets base
    variables only (plus non-credential names in `ACC_TEST_ENV_ALLOW`), Claude adds `ANTHROPIC_*` / `CLAUDE_*` auth, Codex adds
    `OPENAI_*` / `CODEX_*` and the names referenced in `~/.codex/config.toml`, `ACC_*` / `npm_*` are never passed; a test
    configuration baseline and diff gate before every test step (`WAITING_INPUT`, `POST /api/tasks/:taskId/test-config/confirm`),
    with the trusted baseline carried across tasks in the same directory; Claude `settingSources: []`, `strictMcpConfig: true`,
    read-only passthrough of user-level auth / model settings and user + project deny / ask rules, `CLAUDE.md` attached as project
    notes, `request_handoff` auto-allowed only from the `sdk` MCP source; 「本會話都允許」 sends session-scoped `addRules` only and
    honours `suppressAlwaysAllowRule`; Codex threads use `approvalsReviewer: 'user'`, `multi_agent` off and
    `shell_environment_policy.inherit = core`; writes to protected paths (any `.git` path segment, the effective hooks directory,
    user git config, `.claude/`, `.mcp.json`, `.codex/`) are denied and commands mentioning them are marked high risk.
  - Evidence: `env-policy.test.ts`, `env-allowlists.test.ts`, `test-config-guard.test.ts`, `test-config-trust.test.ts`,
    `claude-settings-isolation.test.ts`, `claude-user-settings.test.ts`, `approval-session-scope.test.ts`,
    `codex-approvals-reviewer.test.ts`, `protected-git-paths.test.ts`.
  - Known limitations: with environment-variable `ANTHROPIC_API_KEY` auth, Claude's Bash commands can still read the key
    (subscription login is not affected); tests still run on the host without a sandbox and test files themselves are not diffed
    (P2-8); a Codex change applied inside its sandbox without an approval can only be reported afterwards
    (`PROTECTED_PATH_WRITE_DETECTED`).

- [x] **P0-9 Cross-agent boundary hardening** (H-13, L-1) — `72cc470`, review `f3901cf`
  - Status: done.
  - Implemented: `createSink` binds the identity (`projectId`, `taskId`, `runId`, `agentId`), strips `id` / `sequence` /
    `timestamp` and allows only adapter event types (orchestrator-only, session-less, forged handoff-approval and "to-agent" events
    are rejected with `ADAPTER_EVENT_REJECTED`); `auto` handoffs execute only structured requests (`confirmed`, `via: tool`), with
    the count check and increment under one lock; inferred requests (Codex `HANDOFF@` on the last non-empty line, target validated)
    and requests from a read-only source to a writable target always need operator approval; forwarded content (operator forward,
    agent requests, auto handoffs, reassign, Ask Both, workflow envelopes, the 「繼續對話」 recap) is quoted in random-boundary data
    blocks and the orchestrator's instruction appears once, outside; Ask Both advisors always get a read-only turn (persisted as
    `roundMode`; a busy writable advisor is skipped); approvals produced by orchestrator policy are never widened to session scope.
  - Evidence: `adapter-sink-guard.test.ts` (probe scenario 11), `cross-agent-handoff.test.ts`, `permission-propagation.test.ts`,
    `handoff-inferred-ui.test.ts`, `continue-fenced.test.ts`, `ask-both-advisor-rounds.test.ts`.
  - Known limitations: Codex handoffs stay text-inferred until Codex `dynamicTools` (P2-5); data blocks reduce but cannot rule out
    prompt injection inside the quoted content.

- [x] **P0-10 Control-plane data and repository hygiene** (H-16, L-31) — `889ce44`, review `48a5814`
  - Status: done.
  - Implemented: database, lock, logs and access token default to the per-user data dir (Windows
    `%LOCALAPPDATA%\agent-control-center`, macOS `~/Library/Application Support/agent-control-center`, otherwise
    `$XDG_DATA_HOME/agent-control-center` or `~/.local/share/agent-control-center`), overridable with `ACC_DATA_DIR` /
    `ACC_DB_PATH` / `ACC_LOG_DIR`; data inside the default workspace refuses to start (`ACC_DATA_IN_WORKSPACE`;
    `ACC_ALLOW_DATA_IN_WORKSPACE=1` downgrades it to a warning); every task / session cwd is checked against the data dir (new
    tasks `400`, existing runs `BLOCKED` `WORKSPACE_REJECTED`); one-time migration of `INIT_CWD/agent-control.db` (`VACUUM INTO` +
    verification; the backup and old logs move to `<data dir>/legacy-backups`; failure → `ACC_MIGRATION_FAILED`, never a silent
    empty database); `.gitignore` covers `references/`, database backups and lock files.
  - Evidence: `control-plane-data.test.ts`, `legacy-artifacts.test.ts`, `task-cwd-guard.test.ts`.
  - Known limitations: `ACC_ALLOW_DATA_IN_WORKSPACE=1` is an explicit risk acceptance; there is no retention / archive policy for the
    data dir yet (P1-12).

### Report P1 — near term (1–2 months), to do

Titles only; scope and acceptance criteria are in `docs/ANALYSIS_REPORT.md` §7 (「P1：近期」). Progress made on some of them while
fixing P0 is noted in the "Known limitations" above.

- [x] P1-1 Outbox, decision events and delivery state (M-8, L-3, L-4)
  - Approval delivery state: an operator's decision on a tool approval goes into `RunSnapshot.undeliveredDecisions` together with
    `approval.resolved` and leaves it with the new orchestrator-only event `approval.delivered` once the adapter received it (live
    approve, resume, or nothing left to deliver). Recovery re-delivers an approved-but-undelivered decision exactly once by resuming
    with that decision (no second question to the operator, the tool runs once); undelivered declines are closed without waking the
    agent. `createTask` rejects an unknown review agent with 400 before anything is written. Workflow directives decided but not
    dispatched are re-driven on recovery (P0 series, `recovery-workflow-step.test.ts`); terminal-task commands return 409 instead of
    colliding on sequence numbers (L-3). The server listens before recovery, so `/health` and reads answer while runs recover.
    Evidence: `approval-outbox.test.ts`.
  - Not done: a generic persisted outbox for every workflow directive and handoff delivery; recovering runs in parallel.
- [x] P1-2 In-flight side-effect ledger (M-9)
  - `RunSnapshot.inFlightSideEffects` records tool calls between `tool.started` and their result (bounded to 50; cleared when the
    agent's turn reaches a terminal status; calls still waiting for approval do not count). Recovery does not resume an agent with
    uncertain calls: the task is blocked with `SIDE_EFFECT_UNCERTAIN` listing them in Chinese. Resume prompts name only that agent's
    uncertain calls (also appended to an operator message as a control-plane note) and at most its 10 most recent completed calls —
    no longer every raw id of the task. Test-runner call ids carry a per-process nonce, so a run after restart never collides with one
    before it. Evidence: `inflight-side-effects.test.ts`.
- [x] P1-3 Correlate completion signals with dispatches (M-1, L-9)
  - M-1: a Claude completion that still has queued turns (`queuedTurns > 0`, operator interjected mid-step) is not a workflow
    signal; together with the stale-completion guard from the P0 series the test step only starts after the last queued turn.
    L-9: a `turn/steer` rejected by the app-server (stale `expectedTurnId`) falls back to `turn/start` instead of blocking the task.
    Evidence: `completion-correlation.test.ts`.
  - Not done: a full dispatch id echoed by the providers (Claude `user_message_uuids`) — the queued-turn check covers the observed case.
- [x] P1-4 Session permissions and handoff context (M-2, M-3, M-4)
  - M-2 was fixed in the P0 series (sending a message never changes the run state). M-3: reassigning a chat task to an agent whose
    session started read-only (an Ask Both advisor) ends that session and starts a new writable one — the read-only session itself is
    never relaxed; `READ_ONLY_TAKEOVER` explains it. M-4: chat tasks take part in workspace exclusivity — creating a chat task or
    sending an operator / handoff message to a writable agent is refused with `409 WORKSPACE_BUSY` while an agent of another
    unfinished task is working in the same or a nested folder (idle chats do not block; `.acc-worktrees` are separate); workflow
    exclusivity also treats parent / child folders as conflicts. Handoffs carry an activity summary generated deterministically from
    the event log (commands and exit codes, files written, test results) inside the fenced data block.
    Evidence: `workspace-and-handoff-context.test.ts`, updated `ask-both-advisor-rounds.test.ts`, `permission-propagation.test.ts`.
- [x] P1-5 Resource cleanup and process management (M-6, M-21, L-8, L-32)
  - Implemented: `AgentAdapter.release` (Claude, test runner, mock) and `Orchestrator.releaseIdleSessions()` on the budget timer —
    idle sessions (no working turn, no pending approval, not the awaited workflow agent) release their runtime after
    `ACC_IDLE_SESSION_MS` (default 10 min, `0` off) and resume by native session id on the next message; sessions of ended tasks are
    released from the adapters after cancellation. `POST /api/shutdown` plus `SIGBREAK` handling and a 10 s forced-exit fallback.
    Test runner: completion keyed on `exit` with a 2 s output grace (grandchildren holding the pipe no longer hang a run), re-check
    of cancellation right before spawn, POSIX process groups, `windowsHide`, non-blocking `taskkill` (sync only while shutting down),
    output collected as bytes and decoded once (UTF-8, GBK fallback on Windows). Codex: `ACC_CODEX_BIN` paths with spaces are quoted,
    `windowsHide`, non-blocking tree kill (`packages/adapters/src/process-tree.ts`).
  - Evidence: `idle-session-release.test.ts`, `process-tree.test.ts` (the L-8 case times out on the previous runner); `/api/shutdown`
    checked end to end in mock mode (401 without login, exit code 0, port and lease released).
  - Not done: launching the native `codex.exe` directly instead of the npm `.cmd` shim; Windows Job Object so a hard-killed server
    cannot orphan children (a later Electron shell will own the process tree).
- [x] P1-6 Approval integrity (M-16, M-18, M-19)
  - M-16: approvals withdrawn by the runtime (Claude permission request aborted, Codex `serverRequest/resolved`) are reported as
    `runtime.warning APPROVAL_WITHDRAWN`; the orchestrator closes the card with `approval.resolved` (`withdrawn`, no BLOCKED).
    M-18: declining a tool approval stops that agent's current turn (task BLOCKED, next message resumes the conversation).
    M-19: Claude approvals carry `fullInput` (strings up to 50,000 chars); the dialog and a 「展開完整內容」 section in the chat card
    show it; pre-approval after restart matches the full input, so long `Write` calls are not asked twice.
    Evidence: `approval-integrity.test.ts`.
  - Not done: Codex file-change diffs inside the approval card.
- [x] P1-7 Usage and cost (M-17)
  - Done: one token convention (input includes cache reads and writes, OTel GenAI style). Claude: `total_cost_usd` / `modelUsage`
    are cumulative per query and include sub-agents, so the adapter forwards them as `usage.cumulative` and the projection keeps a
    per-session cursor (`RunSnapshot.usageCursors`) and records only the delta — no double counting after resume, resets and
    zeroed crash results handled. Codex: per-turn usage = thread `total` minus the total before the turn (not just the last model
    call). Usage rows store `cost_usd` and `cache_write_tokens` (SQLite schema v3). New budget limit `maxCostUsd` (fractional USD,
    runtime-enforced, blocks dispatch when used up, relaxable) with a default from `ACC_MAX_COST_USD`; the usage page shows
    estimated spend total / today / per agent. Evidence: `usage-accounting.test.ts`; migration checked on a copy of a real v2 DB.
  - Done later: global daily cap `ACC_DAILY_MAX_COST_USD` — once today's estimated spend across all tasks reaches it, new tasks and
    operator messages get `409 DAILY_BUDGET_EXHAUSTED` (nothing written) and orchestrator dispatches block the task with a Chinese
    reason; resets the next day. Evidence: `usage-accounting.test.ts`.
  - Done later: the remaining USD of the budget window is passed to Claude as `maxBudgetUsd` (start and resume); Codex plan quota
    (`account/rateLimits/read` → `QuotaStatus`, `GET /api/quota`, 「方案額度」 card on the usage page); a wind-down note is appended
    to messages dispatched within a window once any limit reaches 80% (`nearlyExhausted`). Evidence: `budget-wind-down.test.ts`.
- [x] P1-8 Loop detection and multi-agent loop safety
  - Implemented (`packages/core/src/stuck-detector.ts`): the same tool with the same input 3 times in a row, or the same tool
    failing 3 times with the same (normalised) output, stops that agent's turn and blocks the task with `LOOP_DETECTED` and a
    Chinese explanation; counters reset on every new instruction; the test runner and declined approvals are ignored. Agent-initiated
    handoffs: A→B→A between the same pair is never auto-executed (approval with `pingPong`); more than
    `RunSettings.maxHandoffChain` (default 6 → 5 allowed) handoffs after one operator instruction are rejected with
    `HANDOFF_CHAIN_LIMIT`, under every policy. Read-only tool completions (Read / Grep / Glob / WebFetch …) no longer reset the stall
    counter. Evidence: `loop-guard.test.ts`.
  - Not done: stall-count decay with one automatic recovery before the gate; rate-limit waits are not modelled separately.
- [x] P1-9 Performance (M-11, M-22, M-23, L-13)
  - M-22: `GET /api/tasks/:id?after=N` returns only events after sequence N (`incrementalAfter` in the response); the UI keeps the
    events it has and merges by id — the 4-second reconciliation no longer re-downloads the whole log. M-11: `/api/usage` caches the
    summary keyed on every run's last sequence (and the day); the UI only fetches it while the usage page is open. M-23: streaming
    deltas are buffered and flushed at most once per animation frame. L-13: the per-second clock lives in the two detail cards that
    show durations, so the chat panes no longer re-render every second. Evidence: `performance.test.ts`.
  - Not done: list virtualisation; a formal 10k-event benchmark.
- [x] P1-10 UI state correctness (M-7, M-24, M-25, M-27, M-28, L-14–L-20)
  - Done: background attention (M-28) — tab title shows `(N) 需要你處理`, opt-in desktop notifications for approvals, handoff
    requests, blocked / waiting-input and completed tasks while the page is hidden (click focuses the task); step codes such as
    `operator:budget-resume` / `budget:maxDurationMs` / `agent:claude` shown in Chinese; streaming buffers cleared on reconnect (L-16);
    `TaskDetail` keyed by task id so drafts do not leak across tasks (L-17). Evidence: `attention-ui.test.ts`, checked in the browser.
  - Done (M-27): per-agent single-turn interrupt — `POST /api/tasks/:taskId/interrupt { agentId }` → `Orchestrator.interruptAgent`
    cancels only that agent's current turn (task keeps running, next message resumes the provider session); `409
    INTERRUPT_UNAVAILABLE` when the agent has no turn in progress or is the step an automatic workflow is waiting for. Pane header
    shows 「⏹ 停下這一輪」 while the agent works. Evidence: `interrupt-agent.test.ts`, checked in the browser.
  - Done later: cross-task inbox (「需要你處理 N」 in the header lists every task waiting for approval / a decision / blocked and jumps
    to it), `ErrorBoundary` (a render error shows a Chinese explanation and 「重新載入」 instead of a blank page), aria-live
    announcements of approvals / blocks / completions (P1-15).
  - Closed: WS resume by sequence is not needed — every (re)connect reloads the authoritative projection over REST (`onReconnect`
    → `refreshAll`, incremental `?after=N`) and a periodic reconciliation runs while the page is visible; `nextAction` /
    `activeAgents` stay derived from the snapshot (the UI projection may always be rebuilt).
- [x] P1-11 Engineering quality gates (M-30–M-34, L-11, L-23, L-28–L-30)
  - Done: GitHub Actions CI (`.github/workflows/ci.yml`: Windows + Ubuntu × Node 24 — typecheck, lint, test, build); ESLint with
    typescript-eslint `no-floating-promises`, `no-misused-promises`, `await-thenable` on the core, adapters, storage and server
    (`npm run lint`, zero findings, part of `npm run check`); `npm run check:codex-protocol` regenerates the Codex app-server types
    with the local CLI and fails when a method / notification / field the adapter uses disappears (passes on 0.159.2); tests run with
    an isolated empty git config (`tests/setup/isolate-git.ts`). Earlier work already covers the shared adapter terminal contract
    (`adapter-terminal-contract.test.ts`), async fakes (`gated-agent`, `pace`), HTTP tests through `app.inject`, and pure-function UI
    tests; flaky Windows temp-dir cleanups now retry or are non-fatal.
  - DOM component tests: happy-dom + Testing Library (`apps/web/src/components/components.test.tsx`: question form, in-page text
    prompt, approval dialog keyboard safety and question mode, changes view without checkpoints).
  - Kept on purpose: the web keeps its own view types (`apps/web/src/types.ts`) instead of importing core's, so the bundle never
    depends on server-side modules.
- [x] P1-12 Data retention and durability (L-6, L-7)
  - SQLite `synchronous=FULL`, `journal_size_limit` (64 MiB default) and an hourly `wal_checkpoint(TRUNCATE)`; before upgrading an
    existing database the store writes a `VACUUM INTO` backup (`<db>.before-vN-<time>.bak`, path printed at startup) and a failed
    migration reports the original error plus the backup path (ROLLBACK errors no longer mask it). New operator actions:
    `POST /api/tasks/:id/abandon` (any unfinished task → FAILED, never recovered again; 「放棄」 on blocked tasks),
    `DELETE /api/tasks/:id` (finished tasks only, removes events / snapshot / approvals / usage / sessions; 「刪除任務」),
    `GET /api/tasks/:id/export` (JSON Lines: task + snapshot, then every event; 「匯出記錄」). Optional `ACC_RETENTION_DAYS`
    (default `0` = keep forever) deletes finished tasks older than N days at startup and hourly. `events.log` rotates at 20 MiB
    (keeps 3). Also: a timed-out test run always ends within 5 s after the tree kill even if the process does not exit.
    Evidence: `retention.test.ts`.
- [x] P1-13 Documentation sync (L-24)
  - `docs/THREAT_MODEL.md` (browser, other local processes, supervised agents, repository / web content, future ACP agents — threat,
    controls, roadmap per boundary); `docs/使用說明.md` (end-user guide in Chinese: first run, daily use, approvals, what to do when a
    task stops, settings, where data lives, troubleshooting); the task-status transition table in `docs/STATE_MACHINE.md` is generated
    by `renderTransitionTable()` and guarded by `docs-sync.test.ts`. TASKS.md stays the single status source.
- [x] P1-14 Recovery and version robustness
  - `RunSnapshot.recovery.streak` counts restarts since the last completed turn; when a run that would be resumed exceeds
    `maxRecoveryStreak` (default 3) it is blocked with `RECOVERY_ATTEMPTS_EXCEEDED` instead of being resumed again. New runs record
    `createdBy { behavior: BEHAVIOR_VERSION, appVersion }`; an unfinished run from a different behaviour version is not auto-resumed
    (`RECOVERY_VERSION_MISMATCH`, message names the creating version). In real mode the server checks `codex --version` against the
    tested range (0.156.x) and prints a Chinese notice when it differs (this machine now has 0.157.1). Concurrent resumes of the same
    (run, agent) are already single-flight through the per-(run, agent) dispatch lock from the P0 series.
    Evidence: `recovery-robustness.test.ts`.
- [x] P1-15 UI experience and accessibility (M-26, M-29, L-22)
  - Done (M-26): replies and streaming output render as Markdown (`react-markdown` + `remark-gfm`: headings, lists, tables, code
    blocks with a copy button). Raw HTML is never rendered, images are shown as links instead of being loaded, links open in a new
    window without a Referer. Checked in the browser.
  - Done (M-29): when side-by-side panes would be narrower than 360 px the chat area switches to tabs automatically (red dot on a
    tab whose agent waits for approval); below 800 px the sidebar collapses into a top bar that keeps 工作台 / 用量 reachable.
  - Done (L-22): 「換人接手」 is a button per target with a confirmation prompt instead of a select that arrow keys could trigger.
  - Done later: aria-live announcements; the rescue step label no longer names Codex (「另一個 AI 診斷」).
- [x] P1-16 Onboarding and operations (L-25, L-26, L-27)
  - `.env` at the repository root is loaded automatically (`node --env-file-if-exists`, dev and start); environment values keep
    their existing validation (invalid numbers refuse to start with the variable name). `npm run doctor` rewritten (fixes the Windows
    "all MISS" bug via `fileURLToPath`, checks Node ≥ 24, dependencies, Claude / Codex login and Codex version, in Chinese);
    `first-run.ps1` stops at the first failing step. Real mode checks Claude / Codex login at startup (`claudeReadiness`,
    `codexReadiness` — existence only) and marks an agent 「未就緒」 with the reason as a tooltip. `engines.node >= 24`; `tsx` and
    `cross-env` are runtime dependencies so `npm start` works without dev dependencies; `npm run dev:real`; `npm run dump-run`
    prints recent tasks or one task's snapshot essentials and events. Evidence: `onboarding.test.ts`, doctor run on this machine.
- [x] P1-17 Remove provider IDs from the core (L-33; prerequisite of P2-1)
  - Default implementer = first registered non-test agent declaring `implement`; default reviewer = another agent declaring
    `review` (else the first other agent, else the implementer); default test agent = first adapter of kind `test`; Ask Both
    primary falls back to the default implementer; an agent's default mode comes from its role in the task (test runner → test,
    workflow reviewer → review, otherwise implement) instead of its id. `initWorkflow` requires the implementer explicitly.
    Evidence: `provider-neutral-core.test.ts` (agents named alpha / beta run the workflow, Ask Both and handoffs; a guard fails if
    `orchestrator.ts` / `workflow.ts` contain a `'claude'` / `'codex'` literal outside comments).

### Report P2 — mid term (2–4 months), to do

Titles only; see `docs/ANALYSIS_REPORT.md` §7 (「P2：中期」).

- [x] P2-1 ACP adapter layer (depends on P1-11, P1-17)
  - `packages/adapters/src/acp-adapter.ts` on the official `@agentclientprotocol/sdk` (`ClientSideConnection`): one agent process,
    many sessions; `session/new` / `session/prompt` / `session/cancel`; `session/update` → streamed + final `agent.message`,
    `tool.started` / `tool.completed` / `tool.failed` (failed edits / commands marked `executed`); `session/request_permission` →
    ACC approvals (approve / 本會話都允許 / decline map to allow_once / allow_always / reject_once); read-only rounds switch to a
    plan-like mode when offered and auto-reject edit / delete / move / execute permissions; resume prefers `session/resume` and
    falls back to `session/load` with every replayed update dropped (no events, no side-effect ledger entries); auth-required →
    one `authenticate` (API-key method when a key is set, else the first / cached login) and retry.
  - Startup: argument probe via `--help` (`--acp`, falling back to `--experimental-acp`); `npx` launches must pin an exact version
    (otherwise not ready, with the reason); env whitelist per preset (`acpRuntimeEnv`). Presets: Gemini CLI, OpenCode;
    `ACC_ACP_AGENTS=gemini,opencode`, custom agents via `ACC_ACP_AGENTS_JSON`; missing commands show as not ready.
  - Evidence: `acp-adapter.test.ts` (end-to-end with an in-memory ACP agent: approval, decline, read-only, cancel, resume vs load
    replay, auth, probe, npx pinning) and the shared `adapter-terminal-contract.test.ts` now also runs against the ACP adapter.
    Real handshakes on this machine: OpenCode (initialize + session/new, resume capability) and Gemini CLI 0.24 (probe picked
    `--experimental-acp`; session/new asks for authentication). No real prompt was run (to save quota).
- [x] P2-2 OpenTelemetry traces projected from the event log
  - `packages/core/src/tracing.ts`: pure `eventsToSpans` (run → workflow step → `invoke_agent <id>` turn → `execute_tool <name>` /
    `acc.approval.wait`; handoffs, checkpoints, merges, budget / safety stops and errors as span events), GenAI semantic attributes
    (`gen_ai.agent.name`, `gen_ai.system`, `gen_ai.tool.name`, token usage per turn with cumulative → delta), deterministic IDs from
    the run ID (`traceIdFor`, `spanIdFor`, `traceparentFor`), metadata only unless `includeContent`. `spansToOtlp` → OTLP/HTTP JSON.
  - `GET /api/tasks/:id/trace[?content=1]` (UI: 「下載追蹤」); `ACC_OTLP_ENDPOINT` (+ `ACC_OTLP_HEADERS`, `ACC_OTLP_CONTENT=1`) exports
    each run once when it ends (e.g. to a local Phoenix). The Claude child gets `TRACEPARENT` + `acc.*` resource attributes, and
    `OTEL_*` is passed through when `CLAUDE_CODE_ENABLE_TELEMETRY` is on, so its native spans join the same trace.
  - Evidence: `tracing.test.ts` (rebuilt twice → identical IDs; hierarchy; no content by default; export once).
- [x] P2-3 Checkpoints and rollback (designed together with P2-4)
  - Done: `GitCheckpointer` (`packages/adapters/src/checkpoints.ts`, injected through `OrchestratorOptions.checkpointer`; core does not
    call git) snapshots the whole repository with a temporary index into hidden refs `refs/acc/checkpoints/<task>/<n>` — no branch
    switch, no commit on any branch, the user's index untouched, `.gitignore` respected, byte-exact (no EOL conversion). A baseline is
    taken when a task starts and one after every agent turn that changed files (`checkpoint.created`, `RunSnapshot.checkpoints`).
    `GET /api/tasks/:id/diff[?seq=N]` shows one turn's changes or everything since the task started; `POST /api/tasks/:id/undo`
    restores the workspace to the previous checkpoint (new files removed, changed files restored with `git restore --worktree`),
    appends `checkpoint.restored` plus a new checkpoint (history is never deleted), refuses while an agent is working; repeated undo
    walks back one turn at a time. UI: 「改動」 tab (checkpoint list, per-turn / total diff, 「↶ 撤銷最後一輪」).
    `ACC_CHECKPOINTS=0` turns it off. Evidence: `checkpoints.test.ts`, checked in the browser.
  - Fork: `POST /api/tasks/:id/fork {seq, prompt}` (UI: 「分叉」 next to each checkpoint) starts a new task in a new worktree whose
    contents equal that checkpoint — the branch starts at the commit the checkpoint is based on and the checkpoint's changes are
    uncommitted, so no checkpoint commits enter the branch history; the original task is untouched. Evidence: `checkpoints.test.ts`.
  - Not done: Claude `rewindFiles`.
- [x] P2-4 Worktree lifecycle
  - Setup: new task worktrees link the main repo's `node_modules` (junction on Windows, only when the repo ignores it) and run
    `.acc/setup.ps1` / `.acc/setup.sh` when present (`setupTaskWorktree`).
  - Merge gate: `GET /api/tasks/:id/merge-preview` (files, `git merge-tree` conflict precheck without touching any worktree,
    main-repo dirty check, the exact commands); `POST /api/tasks/:id/merge {mode: merge|apply}` commits the worktree to its
    `acc/*` branch, then `merge --no-ff` or `merge --squash` (staged only); refuses while an agent works, when the main repo
    has uncommitted changes, or on conflict (merge aborted, main repo untouched). Recorded as `workspace.merged`.
  - Cleanup: `POST /api/tasks/:id/worktree/cleanup` removes the worktree and branch (retries for Windows file locks, Chinese
    reason on failure); only after merge or when the task has ended (`workspace.cleaned`). Startup notice lists orphan
    `.acc-worktrees/*` no task references (never auto-deleted).
  - UI: 「合入主倉庫」 card on the 「改動」 tab. Evidence: `worktree-lifecycle.test.ts`, merge + cleanup checked in the browser.
- [ ] P2-5 Collaboration semantics upgrade (consult / transfer, Codex `dynamicTools`) — consult / transfer and edge allow-list done
  - Done: handoff requests carry `kind: consult | transfer` (Claude `request_handoff` tool parameter; Codex `ASK@<agent>:` marker next
    to `HANDOFF@`). A consult is dispatched read-only (`mode: analysis`) with a note that the answer goes back automatically; the
    pending consult is projected from the orchestrator's `handoff.requested` (`RunSnapshot.pendingConsults`, survives restart); when
    the consulted agent's turn completes, its last reply is returned to the requester inside a data block and `consult.answered`
    is recorded (failed / cancelled: recorded, nothing dispatched). A consult never escalates write access and never merges into a
    workflow step. `ACC_HANDOFF_EDGES` (e.g. `claude>codex,codex>*`) rejects agent handoff requests outside the allow-list.
    Evidence: `consult-handoff.test.ts`.
  - Structured completion (review): `REVIEW_RESULT_SCHEMA` (verdict, summary, issues with severity / file / line); Codex review
    turns send it as `turn/start.outputSchema`, the reply is rendered as readable text (first line still `VERDICT:`) and carries
    `structured`; the projection keeps `structuredReviews` (cleared when a reply has none) and the workflow uses it with
    `confidence: confirmed`, falling back to the text verdict (`inferred`). Real Codex 0.159 accepted the schema (one smoke turn).
    Evidence: `structured-review.test.ts`.
  - Not done: Codex `dynamicTools` (still an experimental app-server API); Claude `outputFormat` (it is per query, not per turn);
    structured results for implement / rescue; handoff hook pipeline.
- [x] P2-6 Unified interrupts and elicitation
  - Done: Claude `AskUserQuestion` and Codex `item/tool/requestUserInput` are normalized into approvals with `kind: 'question'` and
    `questions: ApprovalQuestion[]` (id, header, question, options, multiSelect, allowOther, secret). The operator answers in the chat
    card or the approval dialog (`QuestionForm`: options, free text, «跳過»); `POST /api/approvals/:id/resolve {answers}` →
    `ApprovalDecision.answers`. Claude gets `updatedInput.answers` (question text → answer, multi-select comma-joined), Codex gets
    `{answers: {id: {answers}}}`. Unknown question IDs are dropped; secret answers are never written to the event log.
    `check:codex-protocol` now also guards `item/tool/requestUserInput`. Evidence: `elicitation.test.ts`.
  - Follow-up done: answers survive a crash (the approval outbox keeps the recorded non-secret answers; recovery re-delivers them and
    the resumed Claude `AskUserQuestion` gets them via the pre-approval); `ACC_QUESTION_TIMEOUT_MIN` skips unanswered questions
    (empty answers, `resolvedBy: timeout`, the AI decides on its own).
  - Not done: `responseSchema` on interrupts; MCP elicitation; Codex re-asking after a restart.
- [x] P2-7 Policy engine
  - `packages/core/src/policy.ts` (pure, deterministic): `analyzeApprovalRisk` (delete / force-push / hard reset / download-and-run /
    publish / sudo / registry / extra permissions / adapter-flagged risk → high; read-only tools → low), `PolicyRule` matching by tool +
    command prefix (prefix + space; compound commands with pipes / chaining / redirection / substitution only match exactly) or path
    prefix, `ruleFromApproval` (never for high risk, handoffs or questions), `evaluateApprovalPolicy`.
  - Autonomy presets: `ask` (never auto), `rules` (default), `unattended` (all non-high-risk). Handoffs and questions always go to the
    operator. Consecutive auto-approval counter (`RunSnapshot.autoApprovals`, projected from `approval.resolved` with
    `resolvedBy: 'policy'`) stops at `ACC_MAX_AUTO_APPROVALS` (default 25) and resets on any operator decision.
  - Auto approval uses the same single-consumption path as the operator (a concurrent click cannot double-resolve); the event records
    `policy {ruleId, reason, risk}`. Rules and mode persist in `<dataDir>/policy.json` (`FilePolicyStore`, atomic write);
    `GET /api/policy`, `PUT /api/policy/mode`, `POST /api/policy/rules {approvalId}`, `DELETE /api/policy/rules/:id`.
  - UI: 「以後都允許」 on approval cards, 「🛡 自動放行」 page (autonomy, rules, revoke), auto-approved cards say why.
  - Evidence: `approval-policy.test.ts`; page checked in the browser.
- [x] P2-8 Execution isolation (sandboxed test runner, Codex Windows sandbox readiness)
  - Task-level `ExecutionPolicy` (writable roots = the task's cwd / worktree + temp dir; allowed domains = `DEFAULT_TEST_DOMAINS` or
    `ACC_TEST_ALLOWED_DOMAINS`). `LocalTestRunnerAdapter` runs the command through a `CommandSandbox`; `SrtCommandSandbox` wraps
    `@anthropic-ai/sandbox-runtime` (optional dependency) — per-run `initialize` with that task's paths (the only mode native Windows
    supports), `reset` afterwards, serialized; on Windows it passes the bundled `srt-win.exe` and skips straight to degraded mode
    until `windows-install` has provisioned the `srt-sandbox` account. Every test result records `isolation: sandbox | degraded`.
    `ACC_TEST_SANDBOX=0` disables it.
  - Degraded mode is explicit: 「環境變數白名單 + 逾時」, reported by `isolation()` with how to enable it (ACC never runs the elevated
    install itself).
  - Codex: `isolation()` asks the app-server `windowsSandbox/readiness` on Windows; `notConfigured` / `updateRequired` offer a
    「設定沙箱」 button → `windowsSandbox/setupStart {mode: unelevated}` → waits for `windowsSandbox/setupCompleted`.
  - Provider-neutral `AgentAdapter.isolation?()` / `setupIsolation?()`, `GET /api/isolation`, `POST /api/agents/:id/isolation/setup`;
    UI: 「🛡 安全」 page → 「執行隔離」. `check:codex-protocol` guards the `windowsSandbox/*` names.
  - Evidence: `execution-isolation.test.ts`; on this machine the real Codex reports ready and the test runner reports degraded with
    the install hint (browser-checked).
- [x] P2-9 Redaction and pre-merge secret scanning
  - `packages/core/src/redaction.ts`: `createRedactor` (exact replacement of secret-named env var values and the access token;
    path-like / short values skipped) plus curated rules (Anthropic, OpenAI, GitHub, AWS, Slack, Google, Stripe, private keys).
    Applied once in `EventBus.createSink`, so adapter events are redacted before persistence, WS broadcast, logs and streaming
    deltas; unchanged objects are returned as-is. `ACC_REDACT=0` turns it off.
  - Merge gate scans only the added lines of the task's diff (`scanDiffForSecrets`); the preview lists file:line, the merge is
    refused by default and the operator can override («我確認這些是誤報»), recorded as `secretsOverridden` on `workspace.merged`.
  - Evidence: `redaction.test.ts`. Not done: metadata-only export by default; external secretlint integration.
- [x] P2-10 Bounded snapshots and a separate side-effect ledger table (L-5)
  - The snapshot keeps only the latest `MAX_SNAPSHOT_SIDE_EFFECTS` (200) completed side effects plus `sideEffectCount`; the full
    ledger is rebuilt from the durable event log (`completedSideEffectIdsFromEvents`, same rules as the projection) and handed to
    the adapter on every resume, so completed calls are still never replayed. Other snapshot arrays were already bounded.
  - Measured with `npm run bench:events` (SQLite, 6000 tool calls): last 500 events 34.8 ms → 5.6 ms each, snapshot 756 KB → 27 KB.
  - Evidence: `bounded-snapshot.test.ts` (bounded ledger, count, full ledger after a crash-restart resume).
  - Not done: snapshot write every N events / in-memory snapshot cache (not needed to meet the target).
- [x] P2-11 Data-defined workflows (`WorkflowDefinition`)
  - Done: `packages/core/src/workflow-definition.ts` — `WorkflowDefinition` (start step, retry limits, per-step role / mode /
    implementing / recordsTest / recordsReview, ordered `onComplete` rules with guards `hasTestCommand | testPassed | testFailed |
    retriesLeft | rescueAvailable | {verdict}` and outcomes `dispatch | complete | block | gate | afterPass`), `IMPLEMENTATION_V1`,
    registry + `validateWorkflowDefinition`. `decide` interprets the definition; failures, transport retries, the inactivity watchdog
    and gates stay generic engine behavior. `stepAgent` / `stepMode` read roles and modes from the definition.
  - Behavior unchanged: `workflow-definition.test.ts` replays 2000 random signal sequences (>10,000 decisions, every step visited)
    against the pre-refactor implementation kept as a fixture — identical state and directive at every step; the full suite passes.
  - Best-of-N: `POST /api/groups {prompt, agentIds[2..4], workflow?, testCommand?}` creates one worktree task per agent
    (`RunSnapshot.group`); `GET /api/groups/:id` compares status, tests, review verdict, files / lines changed and cost and
    recommends one by a deterministic rule (tests passed > review ACCEPT > completed > fewer changes > lower cost);
    `POST /api/groups/:id/pick {taskId, mode}` merges the chosen worktree and abandons + cleans up the others. UI: 「多個 AI 各做一份，
    再選一份」 in the composer, 「比較」 card on the 「改動」 tab. Evidence: `best-of-n.test.ts` (end-to-end through the server).
  - Not done: plan sign-off step (evaluated: not needed for V1).

## P4 — Later

- [x] Gemini/OpenCode adapters — through the generic ACP adapter (P2-1).
- [ ] Intelligent router based on task complexity.
- [ ] DAG workflows.
- [x] Pluggable policy engine — P2-7 (`ApprovalPolicySource`, rules, autonomy presets).
- [x] Desktop wrapper (Electron instead of Tauri: the server needs Node 24 and `node:sqlite`, which Electron 44 ships).
  - `apps/desktop`: the server runs in an Electron `utilityProcess` (`src/server-entry.ts`, same `startServer` as the CLI, port 8788 with
    a random-port fallback); the window loads the tokened access URL (same cookie login as the web version). Shares the CLI data
    directory and single-instance lock; `.env` in the data directory; default workspace chosen on first run and changeable from the
    menu; graceful shutdown on close; crash dialog with restart; the access token is masked in the desktop log; external links open
    in the system browser; `window.prompt` replaced by an in-page dialog (Electron does not implement it).
  - Build: `npm run desktop:dist` (esbuild bundles our TypeScript, third-party packages installed into `apps/desktop/stage`,
    electron-builder NSIS installer, Traditional Chinese UI, per-user install, unsigned). `@anthropic-ai/**` is unpacked from asar and
    `ACC_CLAUDE_EXECUTABLE` points the SDK at the unpacked `claude.exe`. `npm run desktop` runs the staged app without installing.
  - Evidence: `ACC_DESKTOP_SMOKE=1` smoke run of the packaged `win-unpacked` exe — mock mode (page, API, graceful exit), real mode
    (Claude / Codex / test runner ready, isolation status) and one real Claude turn (`ACC_DESKTOP_SMOKE_PROMPT`, replied "OK").
  - System tray: closing the window hides it to the tray (AI work continues, one-time balloon hint), tray menu 開啟控制台 / 結束;
    toggle in 「檔案 → 關閉視窗時縮到系統匣」.
  - Auto-update: `electron-updater` against GitHub Releases (`publish` config; `npm run desktop:release` uploads with `GH_TOKEN`);
    background download, prompt to restart (graceful server stop first) or install on next quit; 「說明 → 檢查更新」;
    `ACC_AUTO_UPDATE=0` disables. Verified with a local feed (`ACC_UPDATE_FEED`): the packaged 0.1.0 detected and downloaded 0.1.1;
    smoke mode never installs.
  - Not done: code signing, macOS / Linux packages.
- [ ] Remote multi-machine workers.
