# Agent Control Center v0.1 — Claude Code + Codex Unified Orchestrator

一個在瀏覽器裡開啟的控制台，同時指揮 Claude Code 和 Codex 寫程式碼：哪個 AI 在幹活、卡在哪、要不要你批准、用了多少額度，一眼就能看清。

## 快速開始（中文）

**需要準備：**

- Node.js 24 或更新版本（在終端輸入 `node -v`，看到 `v24.x` 或更高就可以）。
- 想讓真正的 AI 幹活時，還需要本機已經登入好的 Claude Code（終端裡能執行 `claude`）和 Codex（能執行 `codex`，用 ChatGPT 帳號登入）。只是先看看介面的話不需要。

**第一次使用：**

1. 在本專案資料夾裡開啟終端（PowerShell 也可以），安裝依賴（只需要做一次）：

   ```bash
   npm install
   ```

2. 啟動，二選一：

   ```bash
   npm start           # 體驗模式：不呼叫任何 AI、不花錢，用來熟悉介面
   npm run start:real  # 真真實模式：Claude、Codex 和你填的測試命令會真的執行
   ```

3. 啟動後瀏覽器會**自動開啟**控制台。沒有自動開啟的話，在終端裡找到“訪問連結”下面那一行（形如 `http://127.0.0.1:8788/?token=……`），整行復制到瀏覽器位址列開啟。
4. 點「新任務」，填工作目錄（專案資料夾的完整路徑，例如 `D:\projects\my-app`），寫下要 AI 做的事，開始。
5. 用完在終端裡按 `Ctrl+C` 關閉。下次啟動時，沒做完的任務會自動接著做。

**你可能想知道：**

- **訪問連結裡的令牌相當於密碼**：只在自己電腦上用，不要發給別人。瀏覽器用它開啟一次後會記住登入（30 天），之後直接開啟 `http://127.0.0.1:8788` 就行。換了瀏覽器、清了 Cookie，或者看到“需要登入”的說明頁時，重新用終端裡的訪問連結開啟即可——令牌重啟後不變，儲存在資料目錄的 `access-token` 檔案裡。
- **資料放在哪**：任務記錄、審批和日誌都存在 `%LOCALAPPDATA%\agent-control-center`（把這串字複製到檔案資源管理器的位址列就能開啟；macOS 是 `~/Library/Application Support/agent-control-center`，Linux 是 `~/.local/share/agent-control-center`）。它不在你的專案資料夾裡，AI 讀不到也改不了。啟動時終端會列印實際位置。
- **同時只能開一個**：同一份資料同一時間只能有一個控制台在執行。重複啟動時第二個會直接退出，並告訴你已經在執行的那個的地址，開啟那個地址就行。上次被強制關閉或斷電也沒關係，下次啟動會自動接管。
- **從舊版本升級**：什麼都不用做。舊版本放在啟動目錄裡的 `agent-control.db` 會在第一次啟動時自動搬到上面的資料目錄，舊檔案備份在資料目錄的 `legacy-backups` 裡；搬遷失敗時不會啟動，也不會新建空庫，終端會說明原因。
- **不想自動開啟瀏覽器**：啟動前設定 `ACC_NO_OPEN=1`（見下面的“常用設定”）。

### 常用設定（環境變數，都是可選的）

目前**不會自動讀取 `.env` 檔案**，請在啟動前、在同一個終端裡設定。例如 PowerShell：

```powershell
$env:ACC_NO_OPEN = "1"; npm start
```

| 變數 | 作用 |
|---|---|
| `ACC_NO_OPEN=1` | 啟動後不自動開啟瀏覽器 |
| `ACC_WORKSPACE` | 新任務預設的工作目錄（預設是執行啟動命令的那個目錄） |
| `ACC_ALLOWED_ROOTS` | 只允許在這些目錄下建立任務（Windows 用 `;` 分隔多個目錄；預設不限制） |
| `ACC_DATA_DIR` | 把資料目錄改到別處（不能放進工作目錄裡） |
| `ACC_RETENTION_DAYS` | 已經結束超過這麼多天的任務自動刪除（預設 `0` = 永久保留） |
| `ACC_DAILY_MAX_COST_USD` | 今天所有任務加起來的估算花費上限（美元；留空不限），達到後明天自動恢復 |
| `ACC_MAX_COST_USD` | 每個新任務的估算花費上限（美元，例如 `5`；留空不限）。只有 Claude 上報美元，按官方價格估算；超過就停下等你決定 |
| `ACC_IDLE_SESSION_MS` | AI 答完話後閒置多久就關掉它背後的程序釋放記憶體（毫秒，預設 `600000` = 10 分鐘，`0` 表示關閉）；下次發訊息自動接回原來的對話 |
| `ACC_STEP_INACTIVITY_MS` | 自動流程裡某一步多久沒有任何動靜算“卡住”（毫秒，預設 `900000` = 15 分鐘，`0` 表示關閉） |
| `ACC_TEST_ENV_ALLOW` | 測試命令額外需要的環境變數名（例如 `DATABASE_URL`，逗號分隔；像密碼、令牌的名字不會放行） |
| `ACC_PORT` | 控制台埠（預設 `8788`） |

全部變數和說明見 `.env.example`。

### 使用說明

- 新建任務填寫的工作目錄必須是已存在的完整路徑（例如 `D:\projects\my-app`），不能是 Agent Control Center 自己的資料目錄；需要限制範圍時設定 `ACC_ALLOWED_ROOTS`。
- 在「新任務」裡寫任務描述；填寫測試命令（如 `npm test`）後，系統會自動：實現 → 跑測試 → 失敗自動重試一次 → 仍失敗交 Codex 唯讀診斷 → Claude 按診斷修復 → 再測試。
- 勾選「完成前等我確認」：測試通過後停下來，由你「接受結果」或發起一輪「Review」（最多 1 輪，不會自動迴圈）。
- 勾選「使用獨立 worktree」：在倉庫的 `.acc-worktrees/` 下為任務建獨立分支 `acc/<task>`，多個任務可並行互不干擾；同一目錄同一時間只允許一個會寫檔案的任務。
- Agent 要執行命令或改檔案時會彈出審批；拒絕後任務停下由你決定，不會自動重試被拒的操作。審批彈窗開啟時焦點在「稍後處理」上，按 Enter 不會批准（要用滑鼠點「批准」）；同一個審批只會生效一次，連點兩下或兩個分頁同時點，第二次會提示“已經處理過了”。
- 「停止」會停下這個任務裡所有正在工作的 AI（例如「同時問兩個」時兩個都停），正在啟動中的 AI 啟動完成後也會立刻被停下；任務結束後，還沒處理的審批自動作廢，不會再執行。
- 服務重啟後任務會自動恢復：等待中的審批/確認原樣保留，已完成的操作不會重放；無法確認執行時狀態的任務會停下並提示你處理。
- 不會卡死：AI 這一輪出錯（例如服務繁忙 529、限流 429）、Claude / Codex 程式意外退出或斷線時，任務會自動重新接上原來的對話再試一次；自動流程裡某一步長時間沒有任何動靜（預設 15 分鐘，可用 `ACC_STEP_INACTIVITY_MS` 調整，`0` 為關閉；等你審批的時間不算），會先重新接上、再請另一個 AI 診斷，仍然不行才停下。停下時橫幅會用中文說明原因（例如登入失效、額度用完），並直接提供「重試」「換 X 接手」「停止」按鈕。AI 請求把工作交給另一個 AI 時，無論你批准還是拒絕，流程都會繼續。
- 預算：時長只算 AI 真正在幹活的時間（等你、對話空閒、服務停機都不算）；對話任務按每條指令單獨計算。因為預算停下時，橫幅會說明是哪一項用完了，點「放寬預算並繼續」即可接著做。

### 安全說明（不需要任何配置）

- 訪問控制：控制台只接受本機地址（127.0.0.1 / localhost）和它自己的頁面發來的請求，其他網頁、DNS rebinding、沒有登入令牌的本機程式都會被拒絕（403 / 401）。令牌檔案只有當前使用者能讀取，每次啟動都會自檢。
- 資料目錄：資料庫、事件日誌（`logs/events.log`）和令牌都不放在工作目錄裡，避免 agent 讀到或改掉任務記錄、審批和預算。可以用 `ACC_DATA_DIR`、`ACC_DB_PATH`、`ACC_LOG_DIR` 改到別處；放進工作目錄會拒絕啟動，除非設定 `ACC_ALLOW_DATA_IN_WORKSPACE=1`（這個開關只容忍資料放在預設工作區裡，任務目錄落在資料目錄之內、或包含工作區以外的資料時仍然拒絕）。已有任務的工作目錄在重啟恢復時也會檢查，不合規的任務不會自動續跑，會停下並說明原因。
- AI 改了測試設定（`package.json` 的 scripts、vitest / jest / pytest 等測試設定、測試命令直接引用的腳本）時，自動流程不會直接跑測試，而是停下來顯示改動的差異，由你一鍵「確認這些改動並執行測試」「讓 AI 改回去」或「不跑測試，直接接受結果」；沒改就照常自動跑。手動「重跑測試」同樣會先檢查（測試正在跑時這個按鈕暫時不能點）。同一個目錄裡，上一個任務沒確認就停止時留下的改動，在下一個任務跑測試前同樣會請你確認；確認過一次之後不再重複詢問。
- 測試命令需要別的環境變數（例如整合測試的 `DATABASE_URL`）時，可以在 `ACC_TEST_ENV_ALLOW` 裡列出名字；測試失敗時結果裡會列出沒有傳給測試的變數名。
- Claude、Codex 和測試命令只拿到必要的環境變數：測試命令拿不到任何 API key、令牌和 Agent Control Center 自己的配置；Claude / Codex 只拿到各自登入需要的變數，互不交叉；Codex 執行的命令只繼承核心變數。
- Claude 不再讀取使用者級和專案級的 `settings.json` 裡的 allow 規則、hooks 和外部 MCP 配置，審批一律經過控制台；工作目錄裡的 `CLAUDE.md` 仍會作為專案說明提供給 Claude。使用者級 `settings.json` 裡的登入設定（`env` 裡的閘道器 / 中轉地址和令牌、Bedrock、`apiKeyHelper`）、`model` / `effortLevel`，以及使用者級和專案級的 deny / ask 規則照常生效，不需要把它們挪進系統環境變數。
- 「本會話都允許」只在本次會話內有效，不會寫進任何設定檔；Claude 表示不適合長期允許的操作（或涉及受保護路徑的命令）不提供這個選項。
- `.git` 裡的任何內容（包括 worktree 的 `.git` 指標檔案）、實際生效的 git hooks 目錄（例如 husky 的 `.husky/`）、使用者級 git 設定（`~/.gitconfig`）、`.claude/`、`.mcp.json`、`.codex/` 一律不允許 AI 寫入（這些檔案會改變 AI 的權限或自動執行命令）；命令裡涉及這些路徑時審批卡會標成「高風險」。
- Codex 的審批一律交給你（不會被 Codex 自己的自動審閱代替），也不能自己派生子 agent。一個 AI 從文字裡“請求”把工作交給另一個 AI 時，一律先問你。
- 已知限制：如果你用環境變數裡的 `ANTHROPIC_API_KEY` 登入 Claude，Claude 執行的命令仍然讀得到這個 key（訂閱登入不受影響）；測試命令仍然直接在本機執行、沒有沙箱。詳見 `docs/RUNTIME_ADAPTER_MAPPING.md` 和 `TASKS.md` 的「P4 — Hardening / P4 加固」一節。

### 開發模式

前端熱更新（埠 5174，可用 `ACC_WEB_PORT` 修改）：`npm run dev`，然後開啟終端裡列印的“訪問連結”（指向 5174 埠；開發模式不會自動開啟瀏覽器）；真真實模式開發：`ACC_RUNTIME_MODE=real npm run dev`。

---

This repository started as an implementation handoff package for building a single-window control plane for Claude Code, Codex and future coding agents.

The product goal is **not** “many terminals in one window”. The core goal is:

> Normalize heterogeneous agent runtimes behind one adapter contract, then coordinate them through a deterministic orchestrator with durable state, event tracing, approval/safety gates and explicit budgets.

## Current state

- Durable control plane: SQLite (`node:sqlite`, WAL) with atomic event + snapshot commits, versioned `RunSnapshot` (schema v5),
  approval pause/resume without replaying completed side effects, crash/restart recovery and a single-instance lease.
- One `AgentAdapter` contract with four implementations — Claude Agent SDK, Codex App Server, local test runner, Mock — that share
  a turn terminal contract (every dispatched turn ends with exactly one terminal status).
- Deterministic `implementation-v1` workflow (implement → test → one retry → optional rescue → optional review gate → final test),
  multi-agent chat (agent handoff requests, Ask Both, reassign), budgets and a per-step inactivity watchdog.
- React/Vite operator console over REST + WebSocket, protected by Host/Origin checks and an access token / session cookie.
- Hardening from `docs/ANALYSIS_REPORT.md` (report roadmap P0-0 … P0-10) is recorded item by item in `TASKS.md` →
  "P4 — Hardening / P4 加固"; the report's P1 items are next.
- `npm test`: 70 test files, 580 tests passing (9 skipped: not applicable to an adapter or POSIX-only), including 57 regression test files in `tests/regression/`.

## Quick start (English)

Requirements: Node.js 24+ (uses the built-in `node:sqlite`). Real mode also needs a logged-in Claude Code (`claude`) and Codex (`codex`).

```bash
npm install
npm start            # mock runtimes: no model is called
npm run start:real   # real Claude / Codex / test commands (ACC_RUNTIME_MODE=real)
```

`npm start` prints an **access link** (`http://127.0.0.1:8788/?token=…`) and opens it in the default browser (`ACC_NO_OPEN=1`
disables that). The token is exchanged for an `HttpOnly; SameSite=Strict` session cookie (30 days) and removed from the address bar;
without it the API answers `401`. The token is stored in `<data dir>/access-token` (owner-only) and survives restarts.

- Data directory: `%LOCALAPPDATA%\agent-control-center` on Windows, `~/Library/Application Support/agent-control-center` on macOS,
  otherwise `$XDG_DATA_HOME/agent-control-center` (`~/.local/share/agent-control-center`). Override with `ACC_DATA_DIR`,
  `ACC_DB_PATH`, `ACC_LOG_DIR`; data inside the default workspace refuses to start.
- One instance per database: a second start exits with `ACC_ALREADY_RUNNING` and names the running instance (pid and URL);
  a lease left by a killed instance is taken over.
- A legacy `agent-control.db` in the start directory is migrated automatically on first start (backup in `<data dir>/legacy-backups`).
- `.env` is not loaded automatically yet (report item P1-16): set variables in the shell. All variables are listed in `.env.example`.

Development mode (hot reload, UI on port 5174 / `ACC_WEB_PORT`): `npm run dev`, then open the printed access link (it points to the
UI port); real runtimes: `ACC_RUNTIME_MODE=real npm run dev`.

The server listens on `http://127.0.0.1:8788` by default. Health check (requires the session cookie or `Authorization: Bearer <token>`):

```text
GET http://127.0.0.1:8788/health
```

Before marking a task complete, run `npm run typecheck`, `npm test` and `npm run build`.

## What's next

The original implementation order (durable storage → Codex adapter → Claude adapter → approval pause/resume and recovery →
dashboard → context transfer → budgets and review limits) is done, followed by the P4 hardening. Next are the report's P1 items
(`TASKS.md` → "Report P1"); only then more agents/providers (report P2-1, ACP).

Do **not** start by adding more UI panels or more AI providers.

## Architecture rule of thumb

```text
React UI
   │ REST + WebSocket
   ▼
API / Session Router
   ▼
Orchestrator
   ├── Router
   ├── Workflow Engine
   ├── Context Manager
   ├── Review Manager
   ├── Retry Manager
   ├── Budget Manager
   ├── Stall Detector
   └── Human Gate
   │
   ▼
Unified Event Bus + Run State
   ├── ClaudeAdapter → Claude Agent SDK
   ├── CodexAdapter  → Codex App Server
   └── TestAdapter   → local processes
   │
   ▼
RunSnapshot + EventLog + Approvals + Usage
```

## Non-negotiable rules

1. Agents never directly own cross-agent scheduling.
2. Every handoff is authorized and recorded by the Orchestrator.
3. The UI only depends on unified contracts, never provider-specific event shapes.
4. One session has exactly one runtime owner for its lifetime.
5. Every pausable run must have a durable, versioned snapshot.
6. Auto-review is off by default. `maxReviewRounds` defaults to `1`.
7. Every run has turn/time/call/stall budgets. Duration counts only the time an agent is actually working (waiting for you, an idle
   chat and server downtime do not count). Chat tasks count their budget per instruction; workflows renew it at the gate. When a task
   is blocked by its budget, the banner says which limit was used up (e.g. 「已經執行超過 30 分鐘」) and 「放寬預算並繼續」 continues it with one
   click (`POST /api/tasks/:taskId/budget`, see `docs/API_SPEC.md`).
8. All approval/safety/block events are persisted.
9. Completed side effects must not be replayed after resume.
10. Provider/runtime errors are normalized before reaching workflow policy.

## Documents

Start here:

- `docs/ARCHITECTURE.md`
- `docs/OPEN_SOURCE_RESEARCH.md`
- `docs/ADOPTION_MATRIX.md`
- `docs/ORCHESTRATOR_SPEC.md`
- `docs/EVENT_CONTRACT.md`
- `docs/STATE_MACHINE.md`
- `docs/SAFETY_APPROVAL.md`
- `docs/API_SPEC.md`
- `docs/DATABASE.md`
- `docs/TEST_PLAN.md`
- `docs/RUNTIME_ADAPTER_MAPPING.md`
- `docs/ROADMAP.md`
- `docs/ANALYSIS_REPORT.md` (analysis snapshot at `c30c7a2`; its P0 roadmap is tracked in `TASKS.md`)
- `docs/analysis-probes/README.md` (archived repro probes and their regression tests)
- `TASKS.md`

Interactive references:

- `docs/architecture-interactive.html`
- `docs/open-source-research-interactive.html`

## Source research direction

This design intentionally borrows ideas, not framework lock-in, from:

- Better Agent Terminal — stable renderer/IPC contract, explicit runtime ownership.
- Hermes — agent tree, activity telemetry, shared state and observability.
- LangGraph — durable checkpoint cursor, interrupt/resume semantics.
- OpenAI Agents SDK — explicit step state machine, guardrail ordering, tracing hierarchy and resumable run state.
- Codex App Server — thread/turn/item protocol, approvals and native resume.
- Claude Agent SDK — Claude runtime integration boundary.
- Microsoft Agent Framework — workflow events, durable human requests and stall/round limits.

See `docs/OPEN_SOURCE_RESEARCH.md` for exact links and decisions.
