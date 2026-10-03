# Threat model (P1-13)

Agent Control Center (ACC) is a local, single-user control plane that drives coding agents (Claude, Codex) which can run commands
and edit files. This document lists the trust boundaries, what can go wrong across each one, the controls that exist today, and
the roadmap items (`docs/ANALYSIS_REPORT.md` §7) that would strengthen them.

Assets worth protecting: the operator's source code and machine; credentials (Claude / Codex login, API keys, the ACC access
token); the control-plane database (events, snapshots, approvals — the audit trail and the basis of every approval decision).

## 1. Browser ↔ ACC server

| Threat | Controls | Remaining / roadmap |
|---|---|---|
| Any web page the operator visits reads prompts and outputs over the WebSocket, or drives the REST API (CSRF, DNS rebinding). | Host allow-list (127.0.0.1 / localhost / [::1] / configured host), Origin check on REST and WS upgrade, access token exchanged for an `HttpOnly; SameSite=Strict` cookie, JSON-only non-GET requests, `frame-ancestors 'none'` + `X-Frame-Options: DENY`, WS payload and connection caps, refusal to listen on a non-loopback address without an explicit token (P0-1). | The token URL is a secret; it is printed in the terminal and opened automatically. A later desktop shell can inject the cookie directly (no URL). |
| Click-jacking the approval dialog. | Framing forbidden; the dialog's initial focus is 「稍後處理」, Enter never approves, focus trap (P0-5). | — |

## 2. Other local processes ↔ ACC

| Threat | Controls | Remaining / roadmap |
|---|---|---|
| Another OS user reads the token or calls the API. | Token file in the per-user data dir, ACL restricted to the current user on Windows (checked at startup), `chmod 600` on POSIX (P0-1). | Processes of the *same* OS user (including the agents) can read the token file — full isolation needs a sandbox (P2-8). |
| A second ACC instance takes over the same data. | Single-instance lease with heartbeat, listen before recover, stale-lease takeover rules (P0-3). | — |

## 3. Supervised agents ↔ ACC

| Threat | Controls | Remaining / roadmap |
|---|---|---|
| An agent edits the control-plane database (grants itself approvals, raises budgets). | Data dir outside every workspace, startup refuses data inside the workspace, task cwd may not contain the data dir (P0-10). | Same-user file access is still possible in principle (P2-8). |
| An agent forges orchestrator events (`run.status COMPLETED`, `approval.resolved`, budget events). | Adapter sinks fix identity fields, strip ids / sequences and reject orchestrator-only event types (P0-9 / L-1). | — |
| Agent settings / hooks / MCP servers bypass approvals; "allow for session" writes persistent rules. | Claude `settingSources: []` (user settings forwarded read-only for auth / model / deny rules), `strictMcpConfig`, handoff tool must come from ACC's in-process MCP, session approvals only as session-scoped `addRules`; Codex `approvalsReviewer: user`, multi-agent off (P0-8). | — |
| Writes to `.git/hooks`, `.git/config`, `.claude/**`, `.mcp.json`, `.codex/**`. | Denied for Claude edit tools and Codex file changes; shell commands touching them are marked high risk (P0-8). | Shell writes are detected by text only. |
| Test command / scripts changed by an agent run on the host with credentials. | Test runner gets an environment allow-list (no keys, no ACC token); changed test configuration requires operator confirmation before the test step (P0-8 / H-15). | Tests still run outside a sandbox (P2-8). |
| Runaway loops waste quota. | Budgets on turns, calls, working time, tokens and estimated USD (P0-7, P1-7); loop detection for repeated calls / errors and handoff ping-pong / chain limit (P1-8); inactivity watchdog (P0-6). | Global daily cap (P1-7 remainder). |

## 4. Repository and web content ↔ agents (prompt injection)

| Threat | Controls | Remaining / roadmap |
|---|---|---|
| Content in the repo, a web page or test output instructs agent A, whose output then drives writable agent B. | Forwarded content is fenced in data blocks with a random boundary and a notice that it is data; orchestrator instructions appear once, outside; auto handoffs only for structured (confirmed) requests, never for text-inferred ones, never from a read-only source to a writable target, never for ping-pong (P0-9, P1-8). | Injection can still steer a single agent; the real limits are approvals, read-only modes and protected paths. Typed handoffs / Codex `dynamicTools` (P2-5). |

## 5. Third-party ACP agents (future)

Not integrated yet (P2-1). Before adding them: pin versions of npx-distributed agents, run them through the same adapter contract
tests, treat their event streams as untrusted (sink whitelist applies), and give them no credentials of other providers.

## Data at rest

Prompts, file contents and tool output are stored in SQLite and `events.log` in the per-user data dir, and broadcast to the
authenticated UI. There is no redaction yet (P2-9). Operators can export (JSON Lines), abandon and delete tasks, and set
`ACC_RETENTION_DAYS` to delete finished tasks automatically (P1-12).
