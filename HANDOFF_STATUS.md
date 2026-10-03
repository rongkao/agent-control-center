# Handoff Status

## Current status (2026-09-24)

- `TASKS.md` P0–P3 and P3.5 are done: durable SQLite control plane, real Claude / Codex adapters, deterministic workflow,
  multi-agent collaboration, operator console.
- P4 hardening — the P0 roadmap of `docs/ANALYSIS_REPORT.md` (report items P0-0 … P0-10) — is implemented in commits
  `f8fba78` … `f3901cf`. P0-1 … P0-7, P0-9 and P0-10 are done; P0-0 and P0-8 are partially done (see below). Item-by-item
  status, evidence (regression tests) and known limitations: `TASKS.md` → "P4 — Hardening / P4 加固".
- Next: the report's P1 items (`TASKS.md` → "Report P1"), then P2.

## How to start

```bash
npm install
npm start            # mock runtimes: no model is called
npm run start:real   # real Claude / Codex / test commands
```

- `npm start` builds the UI, starts the server on `http://127.0.0.1:8788` and opens the **access link**
  (`http://127.0.0.1:8788/?token=…`) in the default browser; the link is also printed in the terminal. `ACC_NO_OPEN=1` disables
  opening the browser. The token works like a password: the first visit exchanges it for an `HttpOnly; SameSite=Strict` session
  cookie (30 days). The token itself is kept in `<data dir>/access-token` (owner-only ACL, re-checked at every start) and survives
  restarts; it is never put into environment variables.
- Data directory (database, single-instance lock, `logs/events.log`, access token, `legacy-backups/`): Windows
  `%LOCALAPPDATA%\agent-control-center`, macOS `~/Library/Application Support/agent-control-center`, otherwise
  `$XDG_DATA_HOME/agent-control-center` (`~/.local/share/agent-control-center`). Override with `ACC_DATA_DIR`, `ACC_DB_PATH`,
  `ACC_LOG_DIR`. Data inside the default workspace (`ACC_WORKSPACE`, default: the start directory) refuses to start unless
  `ACC_ALLOW_DATA_IN_WORKSPACE=1`.
- Single instance: one server per database. A second start exits with `ACC_ALREADY_RUNNING` (pid and URL of the running one); a
  lease left by a killed or power-lost instance is taken over automatically.
- Upgrade from an older version: a legacy `agent-control.db` in the start directory is migrated once on first start
  (`VACUUM INTO` + verification); the old file and old logs are moved to `<data dir>/legacy-backups/`. If migration fails the
  server does not start and never creates an empty database.
- Development: `npm run dev` (UI with hot reload on port 5174 / `ACC_WEB_PORT`; open the printed access link, no browser is opened).
- Configuration is by environment variables only — `.env` is not loaded automatically yet (report item P1-16). The full list is in
  `.env.example`; the ones added during P4 hardening:

  | Variable | Purpose |
  |---|---|
  | `ACC_DATA_DIR` | Data directory (database + logs + token); `ACC_DB_PATH` / `ACC_LOG_DIR` still override single paths |
  | `ACC_ALLOW_DATA_IN_WORKSPACE` | `1` = only warn when control-plane data lies inside the default workspace |
  | `ACC_NO_OPEN` | `1` = do not open the browser on `npm start` |
  | `ACC_TOKEN_FILE` | Own token file; required when `ACC_HOST` is not a loopback address |
  | `ACC_ALLOWED_HOSTS` | Extra Host names accepted when listening on a non-loopback address |
  | `ACC_WEB_PORT` | Vite dev-server port (default 5174), allowed as Origin in development mode |
  | `ACC_ALLOWED_ROOTS` | Only allow task working directories under these roots (`;` on Windows, `:` elsewhere) |
  | `ACC_WS_MAX_CONNECTIONS` / `ACC_WS_MAX_PAYLOAD` | WebSocket connection cap (32) / message size limit (65536 bytes) |
  | `ACC_STEP_INACTIVITY_MS` | Step inactivity watchdog threshold, default `900000` (15 min), `0` disables |
  | `ACC_TEST_ENV_ALLOW` | Extra non-credential environment variable names passed to test commands |

## What is ready

- Architecture v1 baseline: ready.
- Open-source adoption decisions: ready.
- TypeScript monorepo skeleton: ready.
- Core AgentAdapter contract: ready, with the turn terminal contract shared by all four adapters.
- EventBus: persistence / observers / per-run reaction queue, adapter event entrance with fixed identity and a type allow-list.
- Task state machine, budgets (working-time based), orchestrator: ready.
- Mock adapters: ready for UI/control-plane development.
- REST/WebSocket server: ready, with access control and single-instance lease.
- React/Vite operator console: ready.
- Claude Agent SDK and Codex App Server adapters: ready (mapping in `docs/RUNTIME_ADAPTER_MAPPING.md`).

## Completed after handoff (P0)

- SQLite durable store (`node:sqlite`, no native deps) with atomic event + snapshot commit.
- Versioned RunSnapshot (now schema v5) with migration boundary and fail-closed loading.
- Approval pause/resume across restart without replaying completed side effects.
- Budget + stall enforcement with deterministic `budget.exceeded` / `budget.stalled` events.
- Server uses SQLite by default (`ACC_STORE=memory` to opt out); it listens first and then runs `recover()` (state-changing requests
  wait for recovery).

## Completed after handoff (P1–P3.5)

- Claude Agent SDK adapter and Codex App Server adapter (real smoke tests passed), session ownership registry.
- Deterministic implementation-v1 workflow, context handoffs, bounded manual review, error classifier, local test runner.
- Operator console (task dashboard, approvals, incident center, recovery UX, usage), task worktrees, `npm start`.
- Multi-agent collaboration: agent-requested handoffs, Ask Both, reassign, operator forwarding, session-scoped approvals.

## Completed after handoff (P4 hardening, `docs/ANALYSIS_REPORT.md` P0 roadmap)

- P0-1 local access control (Host / Origin, access token + cookie, JSON-only POST, WS limits, anti-framing, input validation).
- P0-2 orchestrator failures no longer crash the process (per-run reaction queue, `safeEmit`, Codex pipe errors, global guard).
- P0-3 single-instance lease, listen-then-recover, runtimes stopped on shutdown.
- P0-4 resume with the persisted cwd and mode; read-only steps stay read-only online and after restart.
- P0-5 stop every session of a run, dispatch guards, approvals consumed exactly once, `blockedBy`, safer approval dialog.
- P0-6 turn terminal contract, transparent reconnect, deferred signals during handoff approvals, step inactivity watchdog.
- P0-7 working-time budgets, "at most N" limits, chat budgets per instruction, budget API.
- P0-8 environment allow-lists, test-configuration gate, Claude settings isolation, session-only "allow for session",
  Codex `approvalsReviewer: user` / no `multi_agent`, protected paths — **partially done**: the real-mode smoke run on Windows
  (`scripts/smoke-claude.ts`, `scripts/smoke-codex.ts`, both now print P0-8 checks) is not yet recorded.
- P0-9 adapter event entrance, structured-only auto handoffs, data blocks for forwarded content, permission propagation contract.
- P0-10 control-plane data outside the workspace, legacy migration, `.gitignore` hygiene.
- P0-0 **partially done**: every probe scenario cited in report §3.2 has a regression test; scenarios that belong to P1 items do not
  yet (mapping in `docs/analysis-probes/README.md`).

## Known limitations

- With environment-variable `ANTHROPIC_API_KEY` auth, commands run by Claude can still read the key (subscription login is not
  affected). Test commands run on the host without a sandbox (report P2-8).
- A session keeps the permission mode it was started with; a session started read-only stays read-only when it later takes over a
  writable role (report P1-4 / M-3).
- Completion signals are not yet correlated with a dispatch id (report P1-3 / M-1; mitigated), and workflow decisions still have no
  transactional outbox (report P1-1 / M-8; recovery re-drives the current step as a mitigation).
- Declining an approval does not interrupt the agent's current turn (report P1-6 / M-18); a later retry stops it first.
- After a restart, an approved-but-unexecuted action is re-asked if the model regenerates it with different arguments
  (only identical calls are auto-approved; approvals are never widened).
- Token usage uses the providers' per-turn numbers; there is no USD / subscription-quota budget yet (report P1-7).
- Claude sub-agent (`parent_tool_use_id`) messages are not shown; they only count as activity for the watchdog.
- `.env` is not loaded; `ACC_CODEX_BIN` paths with spaces may not start (report P1-5 / P1-16).
- Under the Vite dev proxy, occasional loopback connect timeouts were observed on Windows; the UI reconciles every 4s.
  `npm start` serves UI and API from one origin and does not use the proxy.

## What is intentionally not finished

- Report P1 / P2 roadmap (see `TASKS.md`), and the original P4 "Later" list: Gemini/OpenCode adapters, intelligent router, DAG
  workflows, pluggable policy engine, desktop wrapper, remote workers.

These are implementation milestones, not missing architecture decisions.

## Validation

At the end of the P4 hardening series (2026-09-24, Windows, Node.js 24):

- `npm run typecheck` — passes.
- `npm test` — 70 test files, 580 tests passed, 9 skipped (8 terminal-contract cases that do not apply to a given adapter, 1 POSIX-only
  token-file permission case).
- `npm run build` — passes.

The original handoff environment could not install dependencies, so it only parsed the sources; everything above was run on a normal
development machine. If the upstream SDK versions move, adjust the adapters behind the existing local contracts rather than changing
UI/core contracts first.
