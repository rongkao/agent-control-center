> **狀態說明（2026-09-24）：** 本報告是 `c30c7a2` 時的分析快照，以下正文未改動。第 7 節的 P0 路線圖（P0-0～P0-10）已在提交 `f8fba78`～`f3901cf`（`f8fba78`、`889ce44`、`380ca2b`、`db05f56`、`48a5814`、`2578f58`、`fbdc97d`、`6be2024`、`1b44da6`、`58dfccc`、`72cc470`、`f3901cf`）中修復，其中 P0-0、P0-8 為部分完成；逐項狀態、驗收證據和已知限制詳見 `TASKS.md` 的「P4 — Hardening / P4 加固」一節。

# Agent Control Center 全面分析報告

> 本報告是隻讀分析，沒有修改任何專案檔案。行號以 commit `c30c7a2` 為準。問題清單做過對抗式核實，駁回 1 條，已剔除。開源調研部分只保留事實核查確認準確的內容，以及已按核查意見更正過的內容。
>
> **證據標註：**
> - **實測**：用隔離資料庫或探針腳本復現過。探針腳本已歸檔在 `docs/analysis-probes/`。路線圖 P0-0 要求先把它們改寫成 `tests/` 下的迴歸測試。
> - **程式碼已核**：在 `c30c7a2` 上讀過對應程式碼，沒有執行復現。
> - **推斷**：根據程式碼或文件推出的結論，沒有復現。
> - **輸入線索**：審查輸入裡沒經過對抗核實的線索。
> - 輸入裡標成“自報”或“未實測”的資料，本報告沿用原標註。

**報告中幾個常用詞：**
- **fail closed**：系統拿不準當前狀態時，寧可停下等人處理，也不繼續執行。
- **outbox（發件箱）**：把“要做的事”和狀態放進同一個資料庫事務裡先寫下來，之後再投遞。這樣即使中途崩潰，這件事既不會丟，也不會被做兩次。
- **副作用台賬**：記錄 agent 已經實際執行過的工具呼叫，恢復執行時據此跳過，不重複執行。
- **終態**：任務的三種結束狀態，即 COMPLETED、FAILED、CANCELLED。

---

## 1. 一句話結論與總體評分

**結論：** 底層設計方向正確，已經接近成熟開源專案的水平。投影和決策都是純函式，事件和快照在同一個事務裡提交，快照帶版本號、讀不懂時 fail closed，還有副作用台賬。問題集中在兩類地方：一是“多 agent 非同步併發”“崩潰視窗”“終態訊號”這三類執行場景，二是本地服務和跨 agent 的安全邊界。這兩處有一批高危缺陷，大部分已經實測復現。現階段適合當作有人盯著用的 V1 原型，還不適合無人值守地長期執行。

**如果只能先做三件事：**
1. 給本地服務加 Host/Origin 校驗和訪問令牌，同時把控制面資料庫移出 agent 能寫的工作區。
2. 編排器內部出錯時，不能再把整個服務程序帶崩。
3. 修好多 agent 場景下取消、恢復、預算、重試幾條會卡死的路徑，並保證每個審批只能被消費一次。

| 維度 | 評分 | 理由 |
|---|---|---|
| 架構 | 7 / 10 | 分層和原則都對：adapter 負責歸一化，編排器負責裁決交接，狀態變化一律經過事件，思路與 t3code、Temporal 一致。扣分項：工作流決策只寫進快照，而且在鎖外執行，沒有 outbox；只跟蹤一個 `currentAgentId`，與 Ask Both 和對話模式下多個 agent 並行衝突；編排反應直接跑在 adapter 的 emit 呼叫棧裡；adapter 能發出只有編排器才該發的事件；NextAction 不是快照裡的正式欄位；核心程式碼裡寫死了 provider ID。 |
| 可靠性 | 4 / 10 | 已實測至少 6 條會讓任務永久卡住的路徑，2 條會讓整個程序崩潰的路徑（H-2、H-14），還實測到同一交接審批併發提交兩次時交接會被投遞兩次（H-12）。沒有單實例保護。預算一旦觸發就一直生效。重啟續跑時會丟掉工作目錄（cwd）。測試替身在函式內部同步跑完整輪，把這些競態都蓋住了。 |
| 安全 | 3 / 10 | 服務不認證呼叫方，也不校驗 Host/Origin，任意網頁都能讀取全部 agent 輸出（實測）。推斷 DNS rebinding 可以建立帶 `testCommand` 的任務，從而在本機執行命令（沒有端到端實測）。測試在沙箱外執行、繼承全部環境變數，而被執行的測試腳本 agent 可以不經審批改寫。交接內容不加圍欄就拼進對方的提示詞，auto 策略還會自動執行靠文字推斷出來的交接請求。Claude 預設載入使用者和專案的設定、hooks、MCP，可以繞過審批；Codex 沒有固定 approvalsReviewer。“本會話都允許”可能把規則寫進磁碟。資料庫放在 agent 可寫的目錄裡。日誌不脫敏。加分項：預設只監聽 127.0.0.1，請求體用 zod 校驗，git 呼叫走 execFile，唯讀步驟強制使用唯讀模式。 |
| 體驗 | 6 / 10 | 聊天窗格逐字流式輸出，審批可以直接在對話裡完成，對中文輸入法友好，有恢復橫幅，“轉給對方 / 同時問兩個 / 換人接手”三個入口都有。扣分項：歷史越多越慢；“為什麼阻塞”“下一步”“誰在工作”的顯示會滯後，甚至顯示錯；不渲染 Markdown 和 diff；沒有後台提醒；不能單獨停掉某個 agent 的當前一輪；窄屏佈局會擠壓；介面語言混雜；審批彈窗的預設焦點在“批准”上。 |
| 可維護性 | 5 / 10 | 109 個測試 2.4 秒跑完，恢復測試用真實 SQLite 和全新程序，儲存層有一套共享合約測試。扣分項：沒有 CI，沒有 lint；前端測試為零；沒有共享的 adapter 合約測試；測試替身是同步的；文件漂移嚴重；`npm start` 依賴開發依賴；`orchestrator.ts` 約 1300 行。 |
| **綜合** | **約 5 / 10** | 地基紮實，主要問題出在非同步競態和安全加固上。大部分修復是 S 或 M 級工作量，不需要推倒重來。 |

---

## 2. 專案現狀：各子系統做得好的地方

| 子系統 | 做得好的地方 |
|---|---|
| 核心編排 | `projectEvent` 和 `decide()` 都是純函式。所有 `locks.run` 臨界區裡既不 publish 事件，也不呼叫 adapter，避開了死鎖。工作流有明確上限：最多 1 次重試、1 次 rescue、1 次傳輸重試，評審輪數受 maxReviewRounds 限制。錯誤分類先看結構化欄位，文字推斷只作兜底，並標註“已證實 / 推斷”。agent 只能“請求”交接，由編排器裁決。 |
| 儲存與恢復 | 一個 `BEGIN IMMEDIATE` 事務同時寫入事件、任務、快照、會話、審批和用量。快照 v1→v4 只向前遷移，遇到未知版本或損壞時 fail closed，並拒絕降級寫回。有 `UNIQUE(run_id, sequence)` 兜底。審批 ID 由 provider 原生 ID 派生，重啟後保持不變。副作用台賬也記錄“執行過但失敗”的工具呼叫。恢復預設 fail closed。 |
| 介面卡 | 直接引用真實 SDK 0.3.280 的型別，SDK 欄位漂移能在編譯期發現。Codex 走結構化的 app-server v2 協議，不解析文字。用序列 chain 保證 `tool.started` 一定先於 `approval.required`。不支援的請求明確返回 -32601。Windows 上用 `taskkill /T` 結束整個程序樹。worktree 用 execFile 加名稱白名單。唯讀步驟強制 Claude 用 plan 模式、Codex 用 read-only 沙箱。 |
| 服務端 | 預設監聽 127.0.0.1。沒有註冊 CORS 外掛，瀏覽器跨域發不出 JSON POST。所有請求體都經 zod 校驗並有長度上限。流式片段只推給介面，不落庫。事件日誌寫失敗不影響任務執行。 |
| 前端 | 介面只依賴統一的事件契約，不瞭解各 provider 的內部結構。WS 斷線後按指數退避重連，並從 REST 全量對賬；頁面可見時另有 4 秒輪詢兜底。回車傳送前檢查 `isComposing`，不會打斷中文輸入。“已證實”和“推斷”分開標註。恢復和阻塞都有橫幅。審批可以直接在對話裡處理。 |
| 測試與文件 | TEST_PLAN 要求的場景（工具 A 已完成、審批 B 掛起、重啟、批准後 A 不重放）在腳本化、Claude、Codex 三種執行時上都用真實 SQLite 跑過。儲存合約測試用 `describe.each` 同時覆蓋記憶體和 SQLite 兩種實現。時鐘可以注入。TASKS.md 記錄了驗收證據。執行時對映表寫死了已核實的上游版本。 |

---

## 3. 已核實的問題清單

沒有問題被評為 critical。但 H-1 和 H-15 疊加時（服務監聽非迴環地址，或 DNS rebinding 成立），可能構成本機任意命令執行，實際危害接近 critical。這是推斷，沒有端到端實測。多個審查方向報告的同一問題已經合併。每條問題最後一列給出對應的路線圖編號（見第 7 節）。

**編號說明：** 編號與初稿保持一致。原 M-12、M-14、M-20 已升級為高危，分別改為 H-15、H-14、H-16。新增 H-12、H-13、M-35、L-31～L-33。

### 3.1 高危（high）總表

| 編號 | 模組 | 檔案:行 | 問題 | 後果 | 修復要點 | 路線圖 |
|---|---|---|---|---|---|---|
| H-1 | 服務端安全 | `apps/server/src/index.ts:15`、`:331` | 不認證呼叫方，不校驗 Host/Origin，`/ws/events` 把事件廣播給任意來源（實測） | 任意網頁都能讀取全部提示詞和輸出（實測）；推斷 DNS rebinding 可以建立帶 testCommand 的任務，在本機執行命令；本機任何程序都能呼叫審批端點 | 加 onRequest 鉤子，按白名單校驗 Host 和 Origin，WS 升級請求也要覆蓋；啟動時生成隨機令牌，換成 HttpOnly Cookie；監聽非迴環地址且沒有令牌時拒絕啟動 | P0-1 |
| H-2 | 核心可靠性 | `packages/core/src/orchestrator.ts:137` | 編排反應裡的異常沿呼叫棧回到 adapter 的 emit；多處發事件後不等結果（fire-and-forget）（實測） | 整個服務程序退出（exit 1）；編排器的 bug 會連帶殺掉正常的 Claude 會話；Codex 這邊的異常被靜默吞掉 | 反應放進按 run 序列的佇列並做異常隔離；加 `safeEmit`；註冊全域性 unhandledRejection 處理器 | P0-2 |
| H-3 | 儲存 / 運維 | `apps/server/src/index.ts:77` | 啟動時先 `recover()` 再 listen；沒有單實例鎖（實測） | 重複啟動時，第二個實例會接手第一個實例的會話並執行新工具，隨後第一個實例報 UNIQUE 衝突，操作員訊息丟失 | 用鎖檔案或租約表；先繫結埠，再執行 recover | P0-3 |
| H-4 | 介面卡 / 恢復 | `packages/adapters/src/claude-agent-sdk-adapter.ts:170`、`codex-app-server-adapter.ts:222` | 續跑時不使用已持久化的 cwd 和 mode | 重啟後 agent 跑出 worktree，改的是主倉庫；唯讀的評審會話變成可寫 | resume 從 metadata 讀取 cwd 和 mode，讀不到就 fail closed；補合約測試 | P0-4 |
| H-5 | 核心併發 | `packages/core/src/orchestrator.ts:1154` | 只跟蹤一個 `currentAgentId`，與多 agent 並行衝突（實測） | 取消後，持有寫權限的 Claude 仍在改檔案；恢復時漏掉仍在執行的 agent；已取消任務上的舊審批仍能被批准並執行 | 終止類操作遍歷全部線上會話；任務進入終態時作廢所有待審批 | P0-5 |
| H-6 | 核心併發 | `packages/core/src/orchestrator.ts:836` | 派發和審批路徑都不在鎖內複核 run 狀態（實測） | 啟動期間取消、取消後再批准舊審批，都會讓 agent 在已取消或已阻塞的任務上繼續執行 | 在鎖內檢查狀態；adapter.start 返回後再複核一次；引入 dispatch epoch | P0-5 |
| H-7 | 核心正確性 | `packages/core/src/orchestrator.ts:522` | 預算一旦觸發就一直生效，等待人工的時間也算進時長（實測） | 評審閘門停留超過 30 分鐘後點 accept，任務永遠無法完成；stall 阻塞後執行 gate retry，完成訊號會被丟棄 | 時長只統計 agent 實際工作的時間；閘門動作顯式續額，並跳過預算檢查；開放預算 API | P0-7 |
| H-8 | 核心 / 體驗 | `packages/core/src/budget.ts:3` | 對話任務沿用實現型任務的預算（實測） | 空閒 30 分鐘、連續 3 輪純問答、或發滿 12 條訊息後被阻塞；阻塞後 agent 仍在工作，而且不再受任何限額約束 | 對話任務使用獨立的預算配置；向 BLOCKED 任務發訊息時，先顯式恢復，否則直接拒絕 | P0-7 |
| H-9 | 核心正確性 | `packages/core/src/orchestrator.ts:1042` | 工作流中 agent 請求交接後進入 WAITING_APPROVAL，這期間 agent 發出的完成訊號被丟棄（實測） | 無論批准還是拒絕，工作流都卡在 RUNNING 不動 | 交接審批不再改變 run 狀態；或者把完成訊號快取下來，審批結束後重放 | P0-6 |
| H-10 | 核心 / 介面卡 | `packages/core/src/orchestrator.ts:1034`、`claude-agent-sdk-adapter.ts:486` | Claude 以錯誤結束一輪時不發終態狀態，Codex 回合被中斷時只發 waiting；也沒有看門狗（實測） | Claude 一輪以 API 錯誤結束時（例如 429/529 重試耗盡、認證失敗），工作流靜默掛起，一直等到 30 分鐘時長預算觸發 | 規定每個回合必須以且只以一個終態結束；增加按步驟計算的不活動看門狗 | P0-6 |
| H-11 | 核心 / 恢復 | `packages/core/src/orchestrator.ts:932`、`codex-app-server-adapter.ts:175` | agent 失敗或 provider 程序崩潰後，線上會話表不清理，重試仍發往已關閉的會話（實測） | Codex 任務直接進入 BLOCKED；Claude 任務靜默掛起；provider 崩潰後只能重啟整個控制面才能恢復 | 收到 failed 或傳輸關閉時，把會話移出線上表，重試改走 resume；adapter 內部實現透明重連 | P0-6 |
| H-12 | 核心併發 | `packages/core/src/orchestrator.ts:543` | resolveApproval 在鎖外依次“檢查 pending → 釋出 approval.resolved → 執行副作用”，執行副作用前不確認本次呼叫確實完成了狀態遷移 | 同一交接審批併發提交兩次，交接被投遞兩次（服務端審查實測）；普通審批的第二次呼叫可能讓 adapter 報錯，任務被 fail closed 為 BLOCKED（推斷） | 在 run 鎖內原子消費審批（CAS），只有搶到的那次呼叫執行副作用；前端在提交中禁用按鈕 | P0-5 |
| H-13 | 跨 agent 安全 | `orchestrator.ts:264`、`:411`；`codex-app-server-adapter.ts:55` | 交接內容不加圍欄就直接拼進對方的提示詞；auto 策略不檢查 confidence，會自動執行由 Codex 文字標記推斷出的交接；自動次數上限在鎖外檢查（程式碼已核） | 倉庫或網頁裡的注入內容可以借 agent A 的輸出偽造 `[Your task]` 段，驅動可能持有寫權限的 agent B；對話任務在 auto 策略下，推斷出的交接最多會被自動執行 4 次，全程沒有操作員參與（推斷，沒有做注入實測） | auto 只執行 confirmed 的請求；轉發內容放進帶邊界的資料區塊；在鎖內複查次數；Codex 標記只認最後一行，並校驗目標 | P0-9 |
| H-14 | 介面卡 | `packages/adapters/src/codex-rpc.ts:44` | codex 程序的 stdin 沒有 error 監聽（原 M-14） | 整個服務程序崩潰（實測，只在 Node v24.15.0 上測過） | 監聽 error 並轉成傳輸關閉事件；處理背壓 | P0-2 |
| H-15 | 介面卡 / 安全 | `packages/adapters/src/test-runner-adapter.ts:108` | 測試在沙箱外以 `shell:true` 執行，繼承完整的 `process.env`，而被執行的測試腳本 agent 可以改（原 M-12；程式碼已核） | 推斷：Codex 在 workspace-write 下可以不經審批改寫 `package.json` 裡的 test 腳本，下一個測試步驟就會在宿主機上無審批執行，並可能外洩 API key | 環境變數改白名單；測試配置被 agent 改過時要求操作員確認；長期放進沙箱執行 | P0-8（沙箱見 P2-8） |
| H-16 | 服務端 / 安全 | `apps/server/src/index.ts:24` | 資料庫和日誌預設放在 INIT_CWD，也就是 agent 的預設工作區（原 M-20） | 推斷：agent 可以讀到全部歷史，也能改快照、審批和預算；編排器處理每個事件都會重讀快照，改動立即生效，審批和審計模型等於失效 | 預設放到 `%LOCALAPPDATA%`；落在工作區內時拒絕啟動 | P0-10 |

### 3.2 高危逐條展開

**H-1 本地服務沒有訪問控制（安全）**
- **現象：** REST（建立任務、發訊息、審批、取消）和 `/ws/events` 都不校驗身份，也不看 Host 和 Origin。實測：Host 為任意域名時照常返回 200；帶外域 Origin 的 WS 連線能收到其他任務的提示詞、工具命令和測試輸出；不帶 body 的 `POST /cancel` 可以被跨站請求觸發。
- **後果：** 瀏覽器對 WebSocket 不做跨源限制，所以使用者開啟過的任何網頁都能旁聽（實測）。推斷（未端到端實測）：DNS rebinding 頁面可以用同源身份 POST `/api/tasks`，帶上任意 `testCommand`，由測試執行器在沙箱外執行（見 H-15）。審批是主要的安全閘門，可它的結果由一個本機任何程序都能呼叫的端點決定，審計記錄裡的 `resolvedBy` 又固定寫成 operator。服務端依賴裡也沒有安全響應頭元件（程式碼已核），審批介面可能被嵌入他人頁面、遭遇點選劫持（輸入線索）。
- **成熟做法：** 同類工具都公開修復過這類漏洞：Jupyter（token + local_hostnames + check_origin）、MCP Inspector CVE-2025-49596、Ollama CVE-2024-28224、Vite CVE-2025-24010、Claude Code IDE 擴充套件 CVE-2025-52882。同目錄的 Codex 版本已經有現成的 onRequest 鉤子。
- **修復（S～M）：**
  - Host 必須是 127.0.0.1 或 localhost 加埠；請求帶 Origin 頭時，只放行同源和開發埠。
  - 啟動時生成隨機令牌，首次訪問時換成 `HttpOnly; SameSite=Strict` Cookie。令牌存放在使用者私有目錄，Windows 上限制 ACL 只給當前使用者；不透過環境變數傳給 agent 和測試程序。
  - 所有 POST 都要求 `application/json`。
  - `ACC_HOST` 為非迴環地址且沒有令牌時拒絕啟動。
  - WS 設定 `maxPayload` 和連線數上限。
  - 響應加 `frame-ancestors 'none'`。

**H-2 編排器異常把整個程序帶崩（可靠性）**
- **復現（probe7）：** 交接策略設為 auto，Claude 在同一輪裡並行呼叫兩次 `request_handoff`→codex。第二次 reserve 丟擲 “Session slot … already pending”。`claude-agent-sdk-adapter.ts:263` 用 `void this.emitFor(...)` 發事件、不等結果，這個 Promise 拒絕沒人處理，Node 24 把它當作致命錯誤，程序以 exit 1 退出。
- **同類問題：**
  - Claude 的訊息泵把編排器丟擲的異常當成 `CLAUDE_RUNTIME_ERROR`，隨即關閉會話。
  - Codex 的 `.catch(() => undefined)`（`codex-app-server-adapter.ts:295`）把異常吞掉：工作流步驟已經提交，卻沒有派發，也沒有任何告警。
  - 測試執行器的 `void this.run()` 也會產生未處理的 Promise 拒絕。
  - `codex-rpc.ts:44` 的 stdin 沒有 error 監聽，見 H-14。
  - `event-bus.ts:73` 的 publish 分不清“事件沒落盤”和“後續反應失敗”（M-10）。
  - 所有 Codex 會話共用一條通知 chain，跨任務隊頭阻塞（L-2）。
- **修復（M）：** 反應放進按 run 序列的執行佇列，與 adapter 的呼叫棧脫鉤，異常統一轉成 `runtime.error` 並 fail closed。publish 只在持久化失敗時 reject。所有 fire-and-forget 呼叫改用 `safeEmit`。Claude 訊息泵要區分“emit 丟擲的異常”和“SDK 迭代丟擲的異常”，前者只記日誌，不中斷會話。Codex 通知按 threadId 分 chain。全域性 unhandledRejection 只記錄，不退出程序。補一個併發交接的迴歸測試。

**H-3 沒有單實例保護（資料正確性）**
- **復現：** 兩個實例共用同一個資料庫。第二個實例在因 EADDRINUSE 退出之前，已經 `recover` 報告 resumed=1，執行了新工具 Z，並寫入序號 9、10 的事件。第一個實例之後的兩條操作員訊息都返回 500：“UNIQUE constraint failed: events.run_id, events.sequence”（實測）。
- **後果：** 在 IDE 和終端裡各啟動一次，或者誤敲兩次 `npm start`，就會破壞兩條核心不變數：“一個會話只有一個執行時所有者”和“不重放副作用”。
- **修復（S）：** 在資料庫旁放鎖檔案，或者建 `instance_lease(instance_id, heartbeat_at)` 表並用 `BEGIN IMMEDIATE` 搶佔（DBOS 的 executor_id 和 Temporal 的租約都是這個思路）。先 listen 成功，再執行 recover。只有確認原所有者的租約已經失效，才轉移會話歸屬。強殺或斷電後殘留的鎖或租約要能被接管。補一個“兩個編排器共用一個庫”的測試。

**H-4 重啟續跑丟失 cwd 和 mode（安全與正確性）**
- **現象：** 編排器已經把 cwd 和 mode 放進了 `resumeInput`，但 Claude 的 `resume` 固定使用 `defaultCwd`，也不傳 mode；Codex 的 `thread/resume` 同樣固定使用 `defaultCwd`。測試執行器的 resume 正確使用了 `metadata.cwd`，可見另外兩處是遺漏。
- **後果：** 用 worktree 建立的任務重啟之後，或者操作員再發一條訊息之後（commit `8814cfa` 以後這條路徑很常見），Codex 會在主倉庫裡寫程式碼。工作區獨佔檢查仍然按 worktree 路徑登記，因此可能有另一個任務在併發寫主倉庫。Claude 的評審和分析會話會從 plan 模式變回 default，唯讀保證失效。
- **修復（S）：** 兩個 adapter 都從 `input.metadata` 讀取 cwd 和 mode，讀不到就 fail closed，不再回退到預設目錄。Codex 在 resume 之後比對服務端返回的 cwd（用規範化路徑比較），不一致就 fail closed。補一個“非預設 cwd + review 模式 + 重啟續接”的合約測試。

**H-5 多 agent 場景下只停、只恢復一個 agent**
- **復現：**
  - Ask Both 時 `currentAgentId` 變成 codex，取消任務只停掉了 codex，持有寫權限的 Claude 繼續改檔案（probe 場景 4：`claudeCancelled=false`）。
  - 重啟恢復時只檢查 currentAgentId，於是正在工作的 Claude 既沒有被續跑，也沒有 fail closed（probe3 場景 B）。
  - 在已取消的任務上批准遺留的審批，工具照樣執行（執行序列為 `['A','C','B']`，實測）。
- **其他受影響的操作：** 預算停止、手動 accept、換人接手時取的交接來源，都依賴這個單一欄位。
- **修復（M）：** 維護“run → 全部線上會話”的對映，取消、預算停止、accept 都遍歷全部會話。進入終態時，在同一次投影裡把所有待審批標為作廢。終態之後收到的 `approval.required` 自動拒絕。對話任務顯式記錄主 agent（primaryAgentId）。

**H-6 派發與審批路徑不復核 run 狀態**
- **復現：**
  - 在 Claude 等待初始化期間取消：任務變成 CANCELLED，但 `cancelCalls=0`，會話隨後被登記為線上（probe 場景 3）。
  - 取消後批准舊的審批對話方塊：adapter 走 `resume(approval)`，agent 被重新拉起並執行工具（probe3 場景 D）。
  - `consumeAgentCall` 在鎖內只檢查預算、不檢查狀態，所以 `sendToSession` 在 BLOCKED 或 CANCELLED 狀態下也照常派發。
- **修復（S～M）：** 在鎖內要求 run 處於允許派發的狀態。`adapter.start` 返回後在鎖內再複核一次，發現已進入終態就立即取消並釋放槽位。`resolveApproval` 對終態 run 直接拒絕。審批的原子消費見 H-12。

**H-7 預算一旦觸發就不解除，還把人工等待算進時長**
- **復現（probe8）：** 一個帶評審閘門的任務，測試通過後停在 WAITING_INPUT，操作員 31 分鐘後點 accept。閘門自己發出的 `run.status RUNNING` 先觸發了 `budget.exceeded(maxDurationMs)`，run 進入 BLOCKED。接著狀態機拒絕了 BLOCKED→COMPLETED 這次遷移，被拒的遷移沒有留下任何事件，介面卻照樣返回成功。再點一次，結果完全一樣，任務永遠無法完成。
- **復現（probe2）：** stall 阻塞後執行 gate retry，Claude 被派發出去，但它的完成訊號被丟棄，因為 `onAgentSignal` 要求狀態為 RUNNING。
- **另外兩個邊界問題：**
  - 限額用 `>=` 判斷，恰好用滿最後一輪時，這一輪的成功完成會被丟掉。
  - 服務停機的時間也算進 maxDurationMs，恢復後剛續上的會話可能立刻被阻塞（輸入線索）。
- **修復（S～M）：** 時長只統計 agent 實際工作的時間，不含等待人工和停機時間。閘門動作顯式續額（發一個 `budget.extended` 事件），或者重置計數視窗。accept 直接完成，不經過 RUNNING。不在閘門自己的遷移事件上檢查預算。狀態遷移被拒絕時要顯式報錯，或者追加 `TRANSITION_REJECTED` 警告。開放預算 API。

**H-8 對話任務沿用實現型任務的預算**
- **復現：**
  - 空閒 30 分鐘後被 `budget:maxDurationMs` 阻塞。
  - 連續 3 輪純問答（沒有 tool.completed）被判為停滯。
  - 每條訊息消耗 1 次呼叫額度，Ask Both 一次消耗 2 次。
  - 阻塞後再發訊息，走的是 resume，任務仍是 BLOCKED，agent 卻在工作（實測）。此後 `enforceBudget` 跳過非 RUNNING 的 run，不再有任何限額。
- **修復（S～M）：** 對話任務單獨一套預算：時長按實際工作時間計，操作員訊息算作進展，呼叫額度按會話視窗計算。向 BLOCKED 任務發訊息時，必須先顯式恢復，否則拒絕。

**H-9 交接審批期間丟失完成訊號**
- **復現（probe 場景 1）：** `request_handoff` 立即返回，agent 把這一輪做完。編排器對工作流任務一律生成審批，run 進入 WAITING_APPROVAL，這時到達的 `agent.status completed` 被直接丟棄，沒有任何快取。
  - 如果批准：codex 以 review 模式啟動，它的完成訊號因為 awaiting 對不上而被忽略。
  - 如果拒絕：狀態回到 RUNNING，但沒有任何東西去推進工作流。
  - 兩種結果都是 `status=RUNNING, step=implement`，測試呼叫次數為 0。
- **修復（S）：** 交接審批本身並不阻塞 agent，應放進獨立的 pendingRequests，不改變 run 狀態。另一種做法是在 WAITING_* 期間把完成訊號連同 stepSeq 快取下來，審批結束後重放。補一個測試：工作流中批准或拒絕交接後，流程都能繼續推進。

**H-10 失敗時不發終態，也沒有看門狗**
- **現象：** Claude 的 result 為 `error_*` 或 `is_error` 時，只發 `runtime.error(retryable=false)`，不發 `agent.status failed`。它還忽略了 `api_error_status`，例如 529 本應可以重試。Codex 回合被中斷時只發 waiting。probe5 復現：run 保持 RUNNING，Claude 顯示“coding”，之後再沒有任何事件。現有測試不斷言終態，所以沒抓到。
- **修復（S～M）：** 在 AgentAdapter 契約裡規定，每個回合必須以且只以一個終態結束，並帶上 dispatch/turn ID。核心側把“正在等待的那個 agent”發出的不可重試 `runtime.error` 當作失敗處理。增加按步驟計算的不活動看門狗。

**H-11 重試發到已關閉的會話**
- **復現：**
  - Codex：`handleClose` 已經把會話標為關閉，send 拋錯，結果是 `ADAPTER_SEND_FAILED` 加 BLOCKED（probe 場景 6）。本該自動重試 1 次的傳輸重試形同虛設。
  - Claude：failed 事件是在訊息泵的 catch 塊裡發出的，這時 finally 還沒來得及把會話置為關閉，於是 “continue” 被塞進一個已經結束的 query，任務靜默掛起（probe4：`promptsConsumed=[]`）。
  - Claude CLI 以退出碼 0 正常結束時，不發任何事件，介面仍顯示“coding”。
- **修復（S）：** 收到 failed、cancelled 或傳輸類錯誤時，把會話移出 liveSessions，重試改走 resume。adapter 內部對“已關閉但沒被取消”的會話做透明重連。訊息泵正常結束時，補發 `CLAUDE_RUNTIME_EXITED` 和 failed。

**H-12 同一審批併發時可以被消費兩次**
- **現象：** 服務端審查在隔離資料庫上實測：同一個交接審批併發提交兩次，交接被投遞兩次。原因在 `resolveApproval`（orchestrator.ts:543）：它在鎖外讀取 run、檢查 `status==='pending'`，然後釋出 `approval.resolved`，之後無條件執行副作用。投影對重複決定是冪等的（只記事件、不改狀態），但執行副作用之前並不確認本次呼叫確實完成了狀態遷移。
- **同類路徑（按程式碼推斷，未實測）：**
  - 普通工具審批：第二次呼叫時 `adapter.approve` 丟擲 “No pending …”，經 `callAdapter` → `failClosed` 把任務誤置為 BLOCKED。
  - 重啟後的審批：第二次 `adapter.resume` 因 “already live” 失敗，同樣進入 BLOCKED。
  - 現有測試（recovery.test.ts:75）只覆蓋了順序重複提交。
- **後果：** 違反“副作用不重複執行”這條核心不變數。雙擊、瀏覽器重試、兩個標籤頁都能觸發。前端審批卡處理完後按鈕仍在、沒有“提交中”狀態（L-14），更容易觸發。
- **成熟做法：** OpenAI Agents SDK 的 RunState 在反序列化之前先原子地消費待決請求；Restate 的 awakeable 只能完成一次，先到者生效；Temporal 的 Update 按 ID 去重。
- **修復（S）：** 在 `locks.run(runId)` 內一次完成“檢查 pending → 提交 approval.resolved”，返回一個 won 標誌，只有 won 的呼叫執行副作用；輸掉的呼叫返回第一次的結果或 409。補一個 `Promise.all` 併發測試。前端在提交中禁用按鈕。

**H-13 跨 agent 的提示注入與自動交接**
- **現象（程式碼已核）：**
  - `orchestrator.ts:264` 把轉交內容直接拼成 `[Forwarded from …]\n${content}\n\n[Your task]\n${ask}`。`content` 是 agent A 的輸出，沒有圍欄，也沒有轉義。只要裡面出現一行 `[Your task]`，接收方就分不清哪一段是編排器的指令。
  - `orchestrator.ts:411` 的 auto 判定只看三件事：`handoffPolicy`、是否為工作流任務、已用次數；不看請求的 `confidence`。Codex 的交接來自 `HANDOFF@` 文字約定（`codex-app-server-adapter.ts:55`；輸入線索稱它匹配任意一行），屬於推斷訊號。在對話任務的 auto 策略下，這類請求會被自動執行，最多 `maxAutoHandoffs` 次（`DEFAULT_MAX_AUTO_HANDOFFS = 4`，程式碼已核）。
  - 同一處的次數檢查用的是鎖外讀到的舊值，進鎖後只自增、不復查（TOCTOU）。
- **後果（推斷，沒有做端到端注入實測）：** 形成一條鏈：倉庫檔案、網頁或測試輸出裡的注入內容 → agent A 的回覆 → 交接訊息 → 可能持有寫權限的 agent B。在 auto 策略下，全程沒有操作員參與。這違反了“結構化訊號優先、文字推斷只作兜底”的原則。
- **修復（S～M）：**
  - auto 只執行 `confidence='confirmed'` 的請求，推斷出的請求一律轉人工審批。
  - 轉發內容放進帶唯一邊界的資料區塊，並在系統說明裡宣告區塊內是資料、不是指令。
  - 在鎖內複查次數。
  - Codex 標記只認最後一行，目標必須在允許列表內。
  - 長期用 Codex dynamicTools 替代文字標記（P2-5）。

**H-14 codex stdin 沒有 error 監聽（原 M-14）**
- **現象：** `write()` 只檢查 `closed || !child.stdin?.writable`，而 `closed` 要等 cmd.exe 的 exit 事件才會置位。用 `shell:true` 啟動時，真正讀 stdin 的是孫程序 codex.exe。存在一個視窗：它已經崩潰或正在退出、管道已關，但 cmd.exe 還沒退出。這個視窗裡寫入，socket 會非同步發出 error；沒有監聽時，整個服務程序退出，所有 run 一起受影響。
- **實測：** 在 Node v24.15.0 上，子程序關閉 stdin 但仍存活時，父程序寫入得到 `Error: write EOF`，程序終止。其他 Node 版本沒有測。
- **修復（S）：** 建立子程序後立即給 stdin、stdout、stderr 掛 error 監聽，統一轉成傳輸關閉。write 檢查返回值，緩衝超過上限就斷開（處理背壓）。補一個 fake transport 測試。

**H-15 測試在沙箱外執行 agent 可改寫的腳本（原 M-12）**
- **現象（程式碼已核）：** `spawn(session.command, { shell: true, cwd, env: process.env })`。testCommand 本身由操作員提供，但它實際執行的內容（`package.json` 的 test 腳本、測試檔案、vitest/jest 配置）都在 agent 可寫的工作區裡。Codex 在 workspace-write 沙箱下改檔案不需要審批。
- **後果（推斷）：** agent（或被注入的提示）把 test 腳本改成外發請求或惡意測試，implementation-v1 的 test 步驟會自動執行它：不需要審批，在宿主機上，沒有沙箱，能聯網，並繼承控制面的全部環境變數（包括 API key）。再疊加 H-1 的 DNS rebinding 路徑（推斷），就可能構成本機命令執行。
- **修復：**
  - S：環境變數改白名單（PATH、SystemRoot、TEMP、USERPROFILE 等）。檢測到本輪 agent 修改過 `package.json` 的 scripts 或測試配置檔案時，test 步驟前要求操作員確認。
  - M～L：長期把測試放進沙箱執行（P2-8，注意 srt 在原生 Windows 上的限制）。

**H-16 控制面資料放在 agent 可寫的工作區（原 M-20）**
- **現象：** dbPath 預設是 `${INIT_CWD}/agent-control.db`，日誌目錄同樣在 INIT_CWD 下，而預設工作區也是 INIT_CWD。Codex 在 workspace-write 下可以不經審批在這裡執行命令；Claude 的 Bash/Write 經批准後也能寫。
- **後果（推斷）：** agent 能讀到全部歷史，也能改預算、把審批標成 approved、改 completedSideEffects。編排器處理每個事件都會從庫裡重讀快照，篡改立即生效。ACC 自己的 `.gitignore` 忽略了 `agent-control.db` 和 `logs/`（程式碼已核），但這隻在 INIT_CWD 恰好是 ACC 倉庫時有效。INIT_CWD 是別的倉庫時，自動執行的 `git add .` 可能把資料庫和日誌提交出去。
- **修復（S）：** 預設放到 `%LOCALAPPDATA%\agent-control-center`（其他平台用對應的使用者資料目錄）。資料庫路徑落在工作區或任何任務 cwd 之內時拒絕啟動。檢測到舊位置已有資料庫時提示遷移，不要靜默新建一個空庫。

### 3.3 中危（medium）

原 M-12、M-14、M-20 已升級為 H-15、H-14、H-16，其餘編號不變，新增 M-35。

| 編號 | 模組 | 檔案:行 | 問題 | 後果 | 修復建議 | 路線圖 |
|---|---|---|---|---|---|---|
| M-1 | 核心 / 介面卡 | `packages/core/src/workflow.ts:80`、`claude-agent-sdk-adapter.ts:480` | 完成訊號沒有和具體的派發關聯（文件說 `stepSeq` 用於去重，實際沒用上）；Claude 每個 result 都發 completed，不看 `queued_turn_count` | 操作員插話後，第一輪的 completed 就把流程推進到測試，測試跑在半成品上（probe 場景 8）；retry 被錯誤地計為完成 | 派發時帶 dispatchId，Codex 用 turnId、Claude 用 `user_message_uuids` 回傳；`queued_turn_count>0` 時不發 completed | P1-3 |
| M-2 | 核心 | `packages/core/src/orchestrator.ts:775` | 給還沒有會話的 agent 發訊息，會把 WAITING_* 直接改成 RUNNING | 評審閘門無法再處理，只能取消（probe3 A）；RUNNING 狀態下還殘留著待審批 | 規定發訊息不改變 run 狀態；新會話和已有會話的處理保持一致 | P1-4 |
| M-3 | 核心 / 安全 | `packages/core/src/orchestrator.ts:953` | 會話的權限模式在建立時就固定，之後的派發會忽略傳入的 mode | 換人接手後，新實現者仍在唯讀沙箱裡，改不了檔案（probe 場景 9）；Ask Both 的“唯讀顧問”只受提示詞約束 | 在快照裡記錄會話的寫權限，不一致時新建會話，否則 fail closed | P1-4 |
| M-4 | 核心 / 服務端 | `packages/core/src/orchestrator.ts:171`（及 `:859-871`） | 工作區獨佔只檢查工作流任務，而且只比較完全相同的路徑 | 對話任務（主介面）可以在同一目錄裡無限併發寫入（probe9） | 所有 run 都持久化 workspace；判斷父子目錄重疊；放進全域性鎖裡序列執行 | P1-4 |
| M-5 | 核心 / 安全 | `packages/core/src/projection.ts:198` | 最後一條審批一旦批准，就無條件把 BLOCKED 改回 RUNNING | 安全攔截、會話歸屬衝突等 fail-closed 阻塞會被繞過（probe 場景 10） | 記錄阻塞原因（blockedBy），只有“因審批而暫停”時才允許審批恢復執行 | P0-5 |
| M-6 | 核心 / 介面卡 | `packages/core/src/orchestrator.ts:1019`、`claude-agent-sdk-adapter.ts:99` | 任務結束時不關閉 provider 會話，各種 Map 也不清理 | 每個完成的任務都留下一個常駐的 Claude CLI 程序（每個幾百 MB），記憶體持續增長 | 給 adapter 加 `close()`；run 進入終態時關閉全部會話並釋放槽位 | P1-5 |
| M-7 | 核心 / 前端 | `packages/core/src/types.ts:380`、`apps/web/src/components/TaskDetail.tsx:46` | NextAction 不是快照裡的正式欄位；對話模式完全沒有 NextAction；FAILED 狀態實際上不可達 | 任務已經 BLOCKED，介面仍顯示“繼續由 claude 處理”，回答不了“下一步做什麼” | 由 projection 在每次狀態變化時維護 `run.nextAction`，介面只渲染這個欄位 | P1-10 |
| M-8 | 儲存 / 恢復 | `packages/core/src/orchestrator.ts:707`（及 `:1048`）、`apps/server/src/index.ts:77`、`orchestrator.ts:163` | 工作流決策先提交、後在鎖外執行，沒有 outbox；恢復時看 currentAgentId，不看 awaitingAgentId；recover 在 listen 之前序列執行，每個 Claude resume 最多等 60 秒初始化；createTask 不校驗 reviewAgentId，提交之後才由 mustAdapter 拋錯 | 在提交和派發之間崩潰，恢復時會續跑錯誤的 agent，測試步驟永遠不會啟動（已構造復現）；可恢復的 run 多時，啟動被長時間阻塞；reviewAgentId 寫錯時，工作流停在“已提交但未派發”的狀態 | 引入 outbox（pendingDirective，以 stepSeq 為冪等鍵），恢復時按 outbox 重新驅動；recover 改為 listen 之後非同步並行執行；createTask 校驗 reviewAgentId | P1-1 |
| M-9 | 儲存 / 恢復 | `packages/core/src/projection.ts:207` | 執行到一半的工具呼叫（有 started、沒有 completed）不被記錄；測試執行器的 toolCallId 重啟後會重複 | 崩潰後無法識別“可能已經執行過”的副作用，可能被重複執行 | 維護 inFlightSideEffects，不為空時恢復要求人工確認；副作用 ID 全域性唯一 | P1-2 |
| M-10 | 儲存 | `packages/core/src/event-bus.ts:73` | publish 丟擲的異常分不清是“沒落盤”還是“後續反應失敗” | 正常會話被判為失敗；持久化真正失敗時，事件永久丟失 | 把持久化和反應解耦，見 H-2 | P0-2 |
| M-11 | 儲存 / 服務端 / 前端 | `apps/server/src/index.ts:131`、`apps/web/src/App.tsx:61` | `/api/usage` 每次都掃描全部任務的全部事件，而每批事件都會觸發一次重新整理 | 歷史一多，同步 SQLite 呼叫會阻塞事件迴圈，連帶拖慢審批和 WS | 改用 SQL 聚合或增量彙總表；只在開啟用量頁時拉取 | P1-9 |
| M-13 | 介面卡 / 安全 | `packages/adapters/src/claude-agent-sdk-adapter.ts:206` | 沒有設定 `settingSources`，也沒有 `strictMcpConfig` | 使用者和專案設定裡的 allow 規則、hooks、外部 MCP 都繞過編排器的審批；Codex 可以寫 `.claude/settings.json`，實現跨 agent 提權 | 預設 `settingSources: []`、`strictMcpConfig: true`；handoff 工具額外校驗 `mcpServer.source==='sdk'` | P0-8 |
| M-15 | 介面卡 / 安全 | `packages/adapters/src/claude-agent-sdk-adapter.ts:145` | “本會話都允許”把 SDK 給出的建議原樣回傳 | 可能寫進 `localSettings` 永久生效，或把整個會話切換成 acceptEdits | 只保留 addRules，強制 `destination='session'`，丟棄 setMode；遵守 `suppressAlwaysAllowRule` | P0-8 |
| M-16 | 介面卡 | `packages/adapters/src/claude-agent-sdk-adapter.ts:297` | 執行時自己撤回的審批不上報；Codex 沒有處理 `serverRequest/resolved` | 審批卡一直掛著；之後點批准會失敗並導致 BLOCKED | 發 `approval.resolved(withdrawn)` 事件；pending 的 key 加上 rpcId | P1-6 |
| M-17 | 介面卡 | `packages/adapters/src/codex-app-server-adapter.ts:385` | 用量口徑錯誤：Codex 只取 `last`，Claude 的 input 不含快取和子 agent | token 預算基本失效，兩家的數字沒法比較 | Codex 用本輪 total 的差值；Claude 的 input 加上 cache_read 和 cache_creation | P1-7 |
| M-18 | 介面卡 | `packages/adapters/src/claude-agent-sdk-adapter.ts:147` | 拒絕審批後 run 進入 BLOCKED，但 agent 的當前一輪還在繼續 | 介面顯示“已阻塞”，實際上 agent 還在改程式碼 | 統一語義：如果拒絕就要停，Claude 用 `interrupt:true`，Codex 用 `cancel`；或者提供 `onDecline` 選項 | P1-6 |
| M-19 | 介面卡 / 前端 | `packages/adapters/src/claude-agent-sdk-adapter.ts:312`、`apps/web/src/components/ChatPanes.tsx:38` | 審批時看不到完整輸入：字串截斷到 500 字；Codex 檔案改動沒有 diff；對話內審批卡只顯示路徑 | 操作員等於在盲批；重啟後的預批准永遠匹配不上 | 另存完整輸入及其雜湊，可以展開檢視；Codex 附帶 diff；預批准按雜湊匹配 | P1-6 |
| M-21 | 服務端 / 運維 | `apps/server/src/index.ts:89` | 沒有優雅關停，`onClose` 永遠不會執行 | Windows 上留下孤兒程序；`--watch` 每次重啟都觸發 recover，把測試重跑一遍 | 用 close-with-grace；處理 SIGINT/SIGTERM；增加 `/api/shutdown` | P1-5 |
| M-22 | 前端 | `apps/web/src/App.tsx:36` | 每 4 秒以及每批事件之後，都重新拉取整份事件日誌並整體替換 | 3000 個事件約 3～5MB，打字時明顯示卡頓 | 提供 `afterSequence` 增量介面，前端按 id 合併 | P1-9 |
| M-23 | 前端 | `apps/web/src/App.tsx:72` | 流式輸出每來一個 token，就在根元件 setState 一次 | “同時問兩個”時明顯掉幀 | 用 requestAnimationFrame 節流；外部 store 配合 `useSyncExternalStore`；元件加 memo | P1-9 |
| M-24 | 前端 | `apps/web/src/components/TaskDetail.tsx:51` | “為什麼阻塞”取的是歷史上的斷連錯誤 | 預算阻塞被解釋成“執行時已斷開”，操作員被引向錯誤的處理方式 | 服務端在快照裡寫入 blocker 欄位 | P1-10 |
| M-25 | 前端 | `apps/web/src/App.tsx:108` | “誰在工作”只看 currentAgentId | 併發工作的 agent 被顯示成空閒 | 暴露 activeAgents；統一使用 `isAgentWorking()` | P1-10 |
| M-26 | 前端 | `apps/web/src/components/ChatPanes.tsx:38` | 不渲染 Markdown、程式碼塊和表格，也沒有複製按鈕 | 長回覆基本不可讀 | react-markdown + rehype-sanitize + 程式碼高亮 | P1-15 |
| M-27 | 前端 | `apps/web/src/components/TaskDetail.tsx:312` | 只能停止整個任務，不能只停某個 agent 的當前一輪 | agent 跑偏時只能結束整個任務，會話的連續性丟失 | 新增 interrupt 介面（Codex `turn/interrupt`、Claude `query.interrupt()`） | P1-10 |
| M-28 | 前端 | `apps/web/src/App.tsx:112` | 需要審批時沒有後台提醒 | 視窗在後台時完全察覺不到，最後被時長預算阻塞 | 頁面標題顯示計數、favicon 加角標、可選桌面通知 | P1-10 |
| M-29 | 前端 | `apps/web/src/components/ChatPanes.tsx:153` | 對話列數寫死在內聯樣式裡；800px 以下側欄整個消失；高度用魔數計算 | 1200px 寬時每個窗格只有約 186px；頁面出現兩層捲軸 | 用 `auto-fit` 網格，窄屏改用標籤頁；整體改為 flex 佈局 | P1-15 |
| M-30 | 測試 | `apps/web/src/components/ChatPanes.tsx:54`、`vitest.config.ts:5` | 前端測試為零，TEST_PLAN 裡的 4 項 UI 測試都沒實現；新建的 `*.test.tsx` 會被靜默忽略 | 審批 ID、推斷/已證實分開顯示、重連後重新拉取等與安全相關的介面沒有保護 | 把派生邏輯抽成純函式寫單測；加 happy-dom 專案和 Playwright 冒煙測試 | P1-11 |
| M-31 | 測試 | `docs/TEST_PLAN.md:3` | 覆蓋不均：HTTP API、資料庫遷移、真實崩潰、`spawnCodexTransport`、`decide()` 都沒有測試 | 迴歸問題發現不了 | 在 TEST_PLAN 裡維護狀態表，缺口寫進 TASKS | P1-11 |
| M-32 | 測試 | `docs/RUNTIME_ADAPTER_MAPPING.md:172` | 文件要求的“共享 adapter 合約測試”並不存在 | 兩家 adapter 的語義差異（例如 H-10）發現不了 | 仿照儲存合約測試，寫 `describeAdapterContract()` | P1-11 |
| M-33 | 測試 | `tests/fakes/workflow-agent.ts:38` | 測試替身在 start/send 內部同步跑完整輪 | 上述非同步競態全部被掩蓋 | 給替身加 sync / microtask / delayed 三種投遞模式，用 `describe.each` 覆蓋 | P0-0（最小版本）、P1-11 |
| M-34 | 工程 | `package.json:12` | 沒有 lint 和格式化工具 | 漏掉 await 的 promise 會直接導致程序退出 | 用 typescript-eslint 開啟 `no-floating-promises` 等規則；加 `.gitattributes` | P1-11 |
| M-35 | 介面卡 / 安全 | `packages/adapters/src/codex-app-server-adapter.ts:153`、`:223` | thread/start 和 thread/resume 只設定了 approvalPolicy 和 sandbox，沒有固定 `approvalsReviewer:'user'`，也沒有關閉 `multi_agent`（程式碼已核） | 推斷：使用者在 `~/.codex/config.toml` 裡配置了自動審閱時，審批可能不再送到操作員手裡；Codex 也能自行派生子 agent，繞開編排器排程 | 顯式傳 `approvalsReviewer:'user'` 和 `config {'features.multi_agent': false}`，並補進 codex-protocol.ts | P0-8 |

### 3.4 低危（low）

| 編號 | 模組 | 檔案:行 | 問題（後果） | 修復建議 | 路線圖 |
|---|---|---|---|---|---|
| L-1 | 核心 | `packages/core/src/event-bus.ts:34` | adapter 的事件入口沒有型別白名單，可以直接發 `run.status COMPLETED`（實測），也能發 `approval.resolved` 給自己放行，還能自帶 sequence | `createSink` 固定身份欄位，剝離 sequence 和 id，只允許白名單內的事件型別 | P0-9 |
| L-2 | 核心 / 介面卡 | `event-bus.ts:73`、`codex-app-server-adapter.ts:295` | 編排反應在 emit 呼叫棧裡執行；所有 Codex 會話共用一條 chain，形成跨任務的隊頭阻塞（最長 60 秒） | 按 threadId 分 chain；反應非同步執行 | P0-2 |
| L-3 | 儲存 | `packages/core/src/orchestrator.ts:621` | 重啟後只為非終態 run 初始化序號。對 COMPLETED 任務呼叫 `setHandoffPolicy` 會撞 UNIQUE（HTTP 500），而快照已經被改了（實測） | 在事務內用 `MAX(sequence)+1` 分配序號；禁止“先改快照、後發事件” | P1-1 |
| L-4 | 儲存 | `packages/core/src/orchestrator.ts:550` | 審批決定、交接、操作員訊息都是先持久化意圖、後投遞，但沒有記錄投遞狀態；崩潰後會靜默丟失 | 用 outbox 的 `pendingDeliveries` 加 `approval.delivered` 事件 | P1-1 |
| L-5 | 儲存 | `packages/core/src/orchestrator.ts:1096` | 每個事件都整份重寫快照，快照裡的陣列又沒有上限；連續 6000 次工具呼叫後，單事件耗時從 4ms 升到 34ms，快照達到 901KB | 副作用台賬拆成獨立表；快照每 N 個事件寫一次；在記憶體中快取快照 | P2-10 |
| L-6 | 儲存 | `packages/storage/src/sqlite-store.ts:76` | 沒有任何保留、歸檔或日誌輪轉策略；BLOCKED 任務每次重啟都會被重新處理一遍 | 制定保留策略；提供“放棄/歸檔”操作；設定 `journal_size_limit` | P1-12 |
| L-7 | 儲存 | `packages/storage/src/sqlite-store.ts:143` | WAL 模式加 `synchronous=NORMAL`，斷電時可能回滾“副作用之前的柵欄提交”，導致命令被執行兩次 | 改為 `synchronous=FULL`（持久化事件頻率很低，代價可以接受） | P1-12 |
| L-8 | 介面卡 | `packages/adapters/src/test-runner-adapter.ts:127` | 孫程序佔著管道時，超時 kill 無效（實測）；POSIX 下只殺掉了 sh；取消與啟動之間有競態 | 以 exit 事件為主訊號；POSIX 用程序組；啟動前再查一次是否已取消 | P1-5 |
| L-9 | 介面卡 | `packages/adapters/src/codex-app-server-adapter.ts:177` | `turn/steer` 帶著過時的 turnId，失敗後任務進入 BLOCKED | 捕獲錯誤後回退到 `turn/start` | P1-3 |
| L-10 | 服務端 | `apps/server/src/index.ts:308` | 不帶 body 的 `POST /cancel` 可以被跨站請求觸發（實測） | 強制 JSON 請求體，並校驗 Origin | P0-1 |
| L-11 | 服務端 / 測試 | `apps/server/src/index.ts:65` | 錯誤處理器忽略 statusCode，只用正則匹配訊息文字，400/413/415 都變成 500；mock 模式重啟後發訊息得到 500；HTTP 層沒有任何測試 | 用型別化錯誤類，抽出 `buildServer()`，用 `app.inject()` 測試 | P1-11 |
| L-12 | 服務端 | `apps/server/src/index.ts:163` | cwd 可以是任意字串；不校驗 agentId 是否具備實現能力；worktree 在校驗之前就已建立 | 要求絕對路徑，並限定在白名單根目錄下；所有校驗通過後再建 worktree | P0-1 |
| L-13 | 前端 | `apps/web/src/components/TaskDetail.tsx:22` | `useNow` 放在根元件，每秒重渲染整個對話；列表沒有虛擬化 | 下沉到只顯示時長的葉子元件；用 react-virtuoso | P1-9 |
| L-14 | 前端 | `apps/web/src/components/ChatPanes.tsx:186` | 新審批先顯示成“已處理”；處理後按鈕還在，可以重複提交 | 由事件推導審批狀態；加“提交中”狀態和樂觀更新 | P1-10 |
| L-15 | 前端 | `apps/web/src/App.tsx:40` | REST 響應亂序時會用舊資料覆蓋新狀態；防抖沒有最大等待時間 | 比較 lastSequence；用 AbortController；防抖改成節流 | P1-10 |
| L-16 | 前端 | `apps/web/src/App.tsx:91` | 重連後不清理流式緩衝，殘留帶游標的半截氣泡 | 重連時 `setStreams({})` | P1-10 |
| L-17 | 前端 | `apps/web/src/App.tsx:180` | TaskDetail 沒有按任務設定 key，草稿會帶到別的任務上，可能把指令發給錯誤的任務 | `key={task.id}` | P1-10 |
| L-18 | 前端 | `apps/web/src/App.tsx:132` | “執行時就緒”是寫死的常量；WS 連不上時 agents 列表永遠不會載入 | 做健康探測；元件掛載時就拉取 agents | P1-10、P1-16 |
| L-19 | 前端 | `apps/web/src/components/TaskDetail.tsx:388` | 事件中心只增不減，還漏掉了權限拒絕類訊號 | 區分“當前”和“歷史” | P1-10 |
| L-20 | 前端 | `apps/web/src/components/TaskDetail.tsx:84` | 預設的對話檢視裡看不到預算消耗 | 對話頭部加迷你預算條 | P1-10 |
| L-21 | 前端 | `apps/web/src/components/ApprovalDialog.tsx:52` | 彈窗預設焦點在“批准”按鈕上（`autoFocus`，程式碼已核），按一下回車就批准；也沒有焦點陷阱 | 初始焦點放在“稍後處理”；改用 Radix Dialog | P0-5 |
| L-22 | 前端 | `apps/web/src/components/TaskDetail.tsx:284` | “換人接手”用 select 的 onChange 觸發，按方向鍵就會誤觸 | 改成選單按鈕加確認 | P1-15 |
| L-23 | 工程 | `package.json:12` | 沒有 CI，POSIX 平台的程式碼分支從來沒有執行過 | GitHub Actions 跑 Windows 和 Ubuntu × Node 24 | P1-11 |
| L-24 | 文件 | `AGENTS.md:45`、`docs/STATE_MACHINE.md:5` | 給 agent 看的入門文件還指向早已完成的任務；狀態機和快照的描述已經過時 | 以 TASKS.md 作為唯一狀態來源；狀態遷移表從程式碼生成 | P1-13 |
| L-25 | 運維 | `scripts/doctor.mjs:4` | 在 Windows 上把所有檔案都報成 MISS；`first-run.ps1` 出錯後照樣繼續；Node 版本要求前後不一致 | 用 `fileURLToPath`；檢查 `$LASTEXITCODE`；在 package.json 寫 `engines >=24` | P1-16 |
| L-26 | 運維 | `.env.example:1` | `.env` 從來沒被載入；環境變數不做校驗（例如填 `5s` 會變成 NaN，定時器退化為每 1ms 掃描一次） | `--env-file-if-exists` 加 zod 校驗 | P1-16 |
| L-27 | 運維 | `package.json:18` | `npm start` 依賴開發依賴；`tsc -b` 編譯出的產物無法執行 | 二選一：改為 JIT 內部包，或打包成可執行的產物 | P1-16 |
| L-28 | 測試 | `packages/adapters/src/codex-protocol.ts:4` | Codex 協議型別是手抄的，上游變化檢測不到 | 用 `codex app-server generate-ts` 生成型別，並做 diff 檢查 | P1-11 |
| L-29 | 可維護性 | `apps/web/src/types.ts:1` | 前端型別是 core 型別的手抄副本 | 改為用 `import type` 引用 `@acc/core` | P1-11 |
| L-30 | 測試 | `tests/p3-operations.test.ts:64` | git 相關測試會繼承開發者的全域性 git 配置（簽名、hooks） | 設 `GIT_CONFIG_GLOBAL` 為空，`GIT_CONFIG_NOSYSTEM=1` | P1-11 |
| L-31 | 工程 | `.gitignore`、`scripts/clone-references.ps1:2` | 腳本把 7 個參考倉庫淺克隆到倉庫根目錄的 `references/`，而 `.gitignore` 沒有忽略它（程式碼已核）；配合自動 `git add .` 備份，這些目錄會以嵌入倉庫（gitlink）形式進入索引 | 把 `references/` 加進 `.gitignore`，或克隆到倉庫之外 | P0-10 |
| L-32 | 介面卡 / Windows | `packages/adapters/src/test-runner-adapter.ts:116` 附近 | 測試輸出按資料塊呼叫 `data.toString()` 解碼（程式碼已核）：多位元組字元跨塊時會被切斷；輸出使用原生代碼頁（中文 Windows 預設 cp936）的程式會顯示亂碼，測試失敗時這些亂碼會作為上下文交給 retry/rescue 的 agent | 用 StringDecoder 或 `setEncoding`；Windows 下按內碼表解碼，或統一成 UTF-8 輸出 | P1-5 |
| L-33 | 核心 | `packages/core/src/orchestrator.ts:156`、`:163`、`:282` | 核心程式碼按字串寫死 provider ID：預設實現者 'claude'、預設評審者 'codex'、Ask Both 主 agent 'claude'（程式碼已核）；`AgentInfo.capabilities` 不參與路由（輸入線索） | 與“adapter 歸一化、編排器不感知 provider”的原則衝突；接入 ACP agent 時要改核心程式碼 | 按 capabilities 或角色配置選擇 agent | P1-17（P2-1 的前置） |

### 3.5 附：尚未經過對抗核實的低危線索（建議順手排查）

輸入裡還有 57 條低危線索沒有經過對抗核實，其中一部分與上文已核實的問題重疊。下面按模組列出值得排查的部分，並不是全部。沒列出的主要是文件漂移、測試寫法和介面細節。Windows 和資料保留相關的線索見 3.6 節。

**核心**
- 交接因預算被拒或啟動失敗時，仍然發出 `handoff.completed(progress:true)`。handoff.completed 屬於“有進展”事件，會把停滯計數清零。
- 被拒絕的狀態遷移只被靜默丟棄，不留事件，事件日誌與快照因此不一致。H-7 裡“介面返回成功、任務卻停在 BLOCKED”就是這個行為的一個實例，修復已放進 P0-7。
- 帶 code 的 Node 系統錯誤（errno）被當作“結構化、已證實、不可重試”，本該重試的網路錯誤不會重試；策略類正則存在誤報。
- 評審結論取的是文字中最後一個 `VERDICT:`，引用一段文字就能改變結果。
- 判斷“有進展”的標準過寬：任何唯讀工具完成都會把停滯計數清零。

**儲存與恢復**
- approvals 表按全域性 id 做 upsert，已裁決的審批可能被改回 pending。
- v1→v2 快照遷移生成的副作用台賬是空的。
- 資料庫遷移前沒有備份，ROLLBACK 可能掩蓋原始錯誤，版本號也是在事務外讀取的。
- agent_sessions 派生表會與快照漂移，記憶體和 SQLite 兩種儲存對會話歸屬的處理不一致，而合約測試沒有覆蓋。
- 損壞快照的 fail-closed 不完整：工作區獨佔檢查會放行，每次重啟都重複告警。

**介面卡**
- Codex 重連競態：舊連線的 handleClose 可能清掉新的 client。
- Claude 的 cancel 在 abort 之前無超時地等待 `interrupt()`，CLI 卡住時取消會一直掛著。
- Claude 啟動失敗時不標記 cancelled，遲到的 init 可能產生幽靈會話；CLI 的 stderr 被丟棄，啟動錯誤難以診斷。
- 在唯讀的 plan 會話裡批准 ExitPlanMode 或 setMode，會把評審會話升級為可寫。
- Claude 子 agent（parent_tool_use_id）的訊息全部被丟棄，它們的工具副作用不進台賬。
- 恢復提示詞列出所有 agent 的原始 provider ID，數量沒有上限（已納入 P1-2）。
- Mock adapter 不理會 cancel，取消後仍會發 completed。
- worktree 不清理，createTask 失敗時也不回滾。

**服務端與前端**
- 沒有安全響應頭（依賴中沒有 helmet 一類元件，程式碼已核），審批介面可能被點選劫持（已納入 P0-1）。
- WS 廣播沒有背壓、心跳和連線上限（已納入 P0-1）。
- 評審和診斷相關的標籤寫死成“Codex”，換人接手後顯示錯誤。
- `api.ts` 先解析 JSON 再判斷狀態碼；後台重新整理靜默吞掉錯誤；沒有 ErrorBoundary。
- 沒有 aria-live 區域；部分狀態只靠顏色表達。

### 3.6 按視角補充的風險與缺口

本節標註“程式碼已核”的條目，已在 `c30c7a2` 上讀過對應程式碼。每條末尾給出對應的路線圖項。

**安全**
- 沒有威脅模型文件。`docs/` 下沒有描述信任邊界的文件（程式碼已核）。需要寫清五類邊界：瀏覽器、本機其他程序、被管控的 agent、倉庫內容（可能含提示注入）、第三方 ACP agent。→ P1-13
- 提示注入鏈：倉庫或網頁內容 → agent A 的輸出 → 交接 → 可寫的 agent B（H-13）。→ P0-9
- 供應鏈：
  - `@anthropic-ai/claude-agent-sdk` 使用 `^0.3.280` 版本範圍（程式碼已核），`npm update` 可以在 0.3.x 範圍內漂移。
  - codex CLI 是全域性安裝的，不受 lockfile 約束（輸入）。
  - 將來透過 ACP 登錄檔用 npx 拉取 agent 時，需要固定版本號。
  - → P1-11、P1-14、P2-1
- 令牌存放：P0-1 引入的啟動令牌如果寫入檔案，在 Windows 上要限制 ACL，只允許當前使用者讀取。→ P0-1
- 沒有安全迴歸測試集。H-1、H-12、H-13、H-15、M-13、M-15 的修復都需要各配一個迴歸用例。→ P1-11

**Windows**
- 測試輸出按塊解碼導致亂碼（L-32，程式碼已核）。→ P1-5
- `.acc-worktrees` 在倉庫內部，裡面 node_modules 的路徑較深，可能超過 MAX_PATH（推斷）。→ P2-4 移出倉庫
- CLI、防毒軟體或索引器佔用檔案時，worktree 可能刪不掉（推斷，參考 vibe-kanban 等專案的經驗）。→ P2-4 刪除前確認程序已退出，並做重試
- `shell:true` 下 `ACC_CODEX_BIN` 含空格（例如路徑在 Program Files 下）時啟動失敗；同步呼叫 taskkill 會阻塞事件迴圈（輸入線索）。→ P1-5
- 沒有 Job Object，服務被強殺時子程序可能變成孤兒（輸入）。→ P1-5
- P0-3 的鎖檔案在強殺或斷電後會殘留，需要能被新實例接管。→ P0-3 驗收
- Vite 代理寫死了 8788 埠；README 裡 real 模式的 dev 命令只能在 POSIX 下用（輸入線索）。→ P1-16
- 測試臨時目錄在 Windows 上清理時會報 EBUSY（輸入線索）。→ P1-11

**成本**
- 使用訂閱認證（Claude Max、ChatGPT 套餐）時，美元成本意義不大。Codex app-server 只提供套餐額度百分比（`account/rateLimits`），沒有按輪次的 USD。介面應把 token、USD（標明來源）和套餐額度分開顯示。→ P1-7
- Claude SDK 的 `rate_limit_event` 等待期間，可能被誤判為停滯（調研結論）。→ P1-8
- Ask Both 一次消耗兩次呼叫額度（H-8，實測），花費大約翻倍。→ P1-7 扇出前預留額度
- 沒有跨任務的每日或全域性花費上限，現有預算都是按任務計算的（程式碼已核：`budget.ts` 只有任務級的 TaskBudget）。→ P1-7
- 如果為 Codex 引入本地價格表，需要明確由誰維護、怎麼更新。→ P1-7

**資料保留與隱私**
- 沒有刪除、清理或匯出任務資料的 API（程式碼已核：`apps/server/src/index.ts` 裡沒有刪除類路由）。→ P1-12
- 提示詞、檔案內容和工具輸出的原文永久儲存在 SQLite 和 `logs/events.log` 裡，並透過 WS 廣播（輸入）。→ P2-9；任何匯出預設只匯出後設資料
- `acc/*` 分支和 worktree 只增不減（輸入）。→ P2-4
- 資料庫預設放在 INIT_CWD，只有當它恰好是 ACC 倉庫時，才受 ACC 的 `.gitignore` 保護（見 H-16）。→ P0-10
- 遷移前不備份（輸入線索）。→ P1-12

**多 agent 迴圈安全**
- ask 策略下每次交接都要人工批准，但沒有交接鏈深度或總成本上限；auto 策略只有 `maxAutoHandoffs`（預設 4，程式碼已核）。→ P1-8
- auto 次數的檢查在鎖外進行，存在 TOCTOU（程式碼已核，見 H-13）。→ P0-9
- A↔B 來回往返檢測原先排在 P2-5，現提前到 P1-8。
- P0 和 P1 原先都沒有迴圈迴歸測試。→ P1-8 驗收
- 由於 M-3，Ask Both 的顧問會話可能實際上是可寫的。→ P1-4

**新手上手**
- 首次執行時，不檢查 claude/codex 是否已登入（“執行時就緒”是寫死的常量，見 L-18）；不提示 Codex Windows 沙箱需要一次性配置（僅 elevated/unelevated 實現需要）；也不提示本機的 gemini 0.24.0 需要升級才能用 `--acp`。→ P1-16
- 只有 README 裡的快速開始，沒有 [X] 那樣面向終端使用者的使用說明。→ P1-13
- 預設是 mock 模式，而且 `.env` 不會被載入（L-26），使用者不容易發現真實模式。→ P1-16

**升級相容**
- 跨 ACC 版本的在途 run：快照只做了資料遷移，沒有記錄行為版本（應用版本戳）。→ P1-14
- 上游變化：Codex 已移除 `thread/rollback`（ACC 目前沒有呼叫，程式碼已核）；協議型別是手抄的（L-28）；Claude SDK 0.3.x 迭代很快。→ P1-11、P1-14

---

## 4. 與成熟開源方案對照

### 4.1 按類別列出代表專案

**A. 並行編碼 Agent 管理器（worktree 或容器隔離，多 agent 看板或控制台）**

| 專案 | 一句話 | 狀態 / 許可 |
|---|---|---|
| [vibe-kanban](https://github.com/BloopAI/vibe-kanban) | 看板上每張任務卡對應一個獨立的 worktree；各 agent 的日誌歸一成統一的條目型別；審批分兩步（先建請求，再等待），並有超時狀態；在 diff 上寫的行內評論會發回給 agent | Apache-2.0；公司於 2026-04 停止運營，轉為社群維護 |
| [T3 Code](https://github.com/pingdotgg/t3code) | 純函式 decider；命令回執與事件在同一事務裡提交；reactor 事後執行副作用；用隱藏的 git ref 給每輪做檢查點；即時流有界緩衝，溢位時按序號續傳 | MIT；非常早期，活躍 |
| [Claude Squad](https://github.com/smtg-ai/claude-squad) | tmux 加 worktree；暫停時把改動提交到分支，並刪除 worktree | AGPL-3.0；不支援原生 Windows |
| [Emdash](https://github.com/generalaction/emdash) | Electron 桌面應用。PR #1145 用 hooks 替換了很少觸發的 PTY 退出碼判斷；當前實現把 hooks 寫進 agent 的使用者級配置；另有 ACP 執行時；按視窗焦點決定是否彈通知 | Apache-2.0；支援 Windows |
| [CCManager](https://github.com/kbwo/ccmanager) | 狀態切換時執行 hooks；用 `.worktreeinclude` 把被 git 忽略的 .env 等檔案複製進新 worktree | MIT；基於 Bun 內建 PTY |
| [Happy](https://github.com/slopus/happy) | 手機和 Web 遠端控制。v1.2.5 做到了“併發 resume 共享同一次嘗試，準備階段取消就不啟動”；#1820 是排隊訊息把權限模式合併錯的反面案例 | MIT；活躍 |
| [Crystal → Nimbalyst](https://github.com/stravu/crystal) | 每次執行都記錄 diff；執行 git 操作前先預覽命令 | MIT；Crystal 已棄用 |
| [container-use](https://github.com/dagger/container-use) | 容器加分支；操作審計寫進 git notes；合入分 merge（保留提交）和 apply（只暫存）兩種方式 | Apache-2.0；實驗階段，低頻維護 |
| [Sculptor](https://github.com/imbue-ai/sculptor) | worktree 隔離，可以按倉庫配置 setup 命令 | MIT；沒有原生 Windows 版 |
| [Gas Town](https://github.com/gastownhall/gastown) | 倉庫已從 steveyegge/gastown 遷到這裡。由 AI 協調者排程；停滯訊號分“零進展”和“進展變慢”兩級；二分式合併佇列 | MIT；主幹近兩個月沒有提交 |
| [Kandev](https://github.com/kdlbs/kandev) | 看板的每一列是一個工作流步驟，每步可指定不同的 agent，步驟之間有交接提示；透過 ACP 接入 agent | AGPL-3.0；支援原生 Windows |

**B. 多智慧體編排框架（交接與協調語義）**

| 專案 | 一句話 |
|---|---|
| [OpenAI Agents SDK](https://github.com/openai/openai-agents-python) | handoff 支援 `input_type`（結構化交接引數）、`input_filter`、`is_enabled`（按上下文開關）；工具審批會中斷執行，RunState 可以序列化後再續跑（MIT，0.x） |
| [Microsoft Agent Framework](https://github.com/microsoft/agent-framework) | Magentic 編排每輪產出一份進度賬本；停滯計數“有進展減 1、無進展加 1”（AutoGen 的 Magentic-One 原型就是這樣做的，MAF 沿用），超限時先重新規劃。文件示例用 10/3/2 作為輪數、停滯、重置的上限，但程式碼預設只設停滯上限 3，另外兩項不設上限。Handoff 用有向邊定義。checkpoint 加 RequestInfo 實現人機請求（MIT，2026-07 達到 1.0） |
| [AutoGen](https://github.com/microsoft/autogen) | 11 種可以用與、或組合的終止條件；Magentic-One 原型已採用遞減式停滯計數（已進入維護模式，程式碼 MIT） |
| [LangGraph](https://github.com/langchain-ai/langgraph) | `Command(update + goto)` 一次返回同時完成狀態更新和路由；interrupt 做人工介入；pending writes 保證恢復時不重跑已成功的節點（MIT） |
| [CrewAI](https://github.com/crewAIInc/crewAI) | Flows 作為確定性骨架；任務級 guardrail 失敗後帶著反饋重試，預設上限 3 次（MIT） |
| [Google ADK](https://github.com/google/adk-python) | 子 agent 分三種模式：chat（轉交控制權）、task、single_turn（委派後自動交回）；`RequestInput` 是帶 schema 的人機中斷原語（Apache-2.0） |
| [Mastra](https://github.com/mastra-ai/mastra) | TypeScript 框架；supervisor 透過委派鉤子攔截、改寫或否決每一次委派；由 LLM 路由的 agent networks 已棄用（Apache-2.0，ee 目錄另有許可） |
| [smolagents](https://github.com/huggingface/smolagents) | 委派結果交回時附帶一份執行摘要；用 `final_answer_checks` 校驗最終答案（Apache-2.0） |
| [Pydantic AI](https://github.com/pydantic/pydantic-ai) | 用 deferred tools 做審批；UsageLimits 覆蓋整條委派鏈；harness 的 StepPersistence 能把崩潰後狀態不明的工具呼叫標為 `unknown_after_crash`（MIT） |

**C. 持久執行與人工介入**

| 專案 | 一句話 |
|---|---|
| [Temporal](https://github.com/temporalio/temporal) | 透過回放歷史重建確定性的 Workflow；Activity 至少執行一次，但結果只被觀察一次；Update 按 ID 去重；用 `patched()` 管理程式碼版本（MIT） |
| [Restate](https://github.com/restatedev/restate) | `ctx.run` 把步驟結果寫進執行日誌；awakeable 只能完成一次，先到者生效（伺服器 BSL 1.1，SDK MIT） |
| [DBOS Transact](https://github.com/dbos-inc/dbos-transact-ts) | 步驟輸出表；用 executor_id 區分程序；按 application_version 只恢復同版本的工作流；開源版自帶 `forkWorkflow`（MIT） |
| [Vercel Workflow](https://github.com/vercel/workflow) | 用 TS 指令把普通函式編譯成事件溯源的工作流；儲存和佇列由可替換的 World 介面提供（Apache-2.0） |
| [Absurd](https://github.com/earendil-works/absurd) | 只依賴 Postgres 的檢查點式持久執行，不回放；把步驟拆成 `beginStep()` 和 `completeStep()` 兩步（Apache-2.0） |
| [OpenAI Agents JS 的 RunState](https://github.com/openai/openai-agents-js) | 先原子消費待決請求，再反序列化，防止重放；審批繫結到具體呼叫及其輸入指紋；恢復時重新評估策略（schema 1.21） |
| [Claude SDK 檔案檢查點](https://code.claude.com/docs/en/agent-sdk/file-checkpointing) | `rewindFiles` 回滾檔案，本機的 0.3.280 已經提供；只覆蓋 Write/Edit，不覆蓋 Bash |
| [Inngest AgentKit](https://github.com/inngest/agent-kit) | `waitForEvent` 用關聯鍵 match 加超時，超時返回 null（活躍度明顯下降） |

**D. 協議與介面事件流**

| 專案 | 一句話 |
|---|---|
| [ACP（Agent Client Protocol）](https://github.com/agentclientprotocol/agent-client-protocol) | 編輯器或客戶端與編碼 agent 之間的 JSON-RPC 協議；登錄檔目前有 41 個 agent；v1 已穩定，v2 仍是草案（Apache-2.0） |
| [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) / [codex-acp](https://github.com/agentclientprotocol/codex-acp) | 官方的 Claude / Codex ACP 包裝器，與 ACC 用的是同一個 SDK 版本、同一個 app-server，可作為事件對映的參考實現 |
| [Gemini CLI ACP 模式](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md) | 原生 ACP 模式（`--acp`）。本機的 gemini 0.24.0 太舊，需要升級（最新 0.60.0）；OpenCode 對應的命令是 `opencode acp` |
| [acpx](https://github.com/openclaw/acpx) | 無頭 ACP 客戶端，flows 由確定性節點和檢查點組成，run 結束後生成不可變的記錄包（MIT，pre-1.0） |
| [Codeg](https://github.com/xintaofei/codeg) | 多 ACP agent 工作台；agent 撤回的權限卡片會自動關閉（Apache-2.0） |
| [AG-UI](https://github.com/ag-ui-protocol/ag-ui) | agent 後端到前端的事件詞表：訊息的 start/content/end、Interrupt、狀態快照與增量（MIT，1.0） |
| [MCP 2026-07-28](https://github.com/modelcontextprotocol/modelcontextprotocol) | 無狀態核心；elicitation 改為“需要輸入時先返回，再帶著答案重試”（MRTR）；Tasks 移入擴充套件（許可正從 MIT 過渡到 Apache-2.0） |
| [A2A](https://github.com/a2aproject/A2A) | 跨組織遠端 agent 之間的任務協議，不適合作為本地編碼 agent 的接入層 |
| [Codex app-server](https://github.com/openai/codex/tree/main/codex-rs/app-server) | 提供 dynamicTools（實驗性）、`serverRequest/resolved`、`generate-ts` 生成型別、Windows 沙箱就緒狀態等介面；上游已移除 `thread/rollback`（ACC 目前沒有呼叫） |
| [Open Responses](https://www.openresponses.org/specification) | 每個流式事件都必須帶 `sequence_number`；廠商擴充套件必須加前綴 |

**E. 可觀測、成本、沙箱與金鑰**

| 專案 | 一句話 |
|---|---|
| [OTel GenAI 語義約定](https://github.com/open-telemetry/semantic-conventions-genai) | 定義 `invoke_workflow` / `invoke_agent` / `execute_tool` 等 span，以及“input 含快取”的 token 口徑；內容類欄位預設不採集 |
| [Claude Code 遙測](https://code.claude.com/docs/en/monitoring-usage) | 支援 OTel 匯出（trace 為 beta）；SDK 會話會讀取入站的 TRACEPARENT；有 `tool.blocked_on_user` 子 span |
| [sandbox-runtime（srt）](https://github.com/anthropic-experimental/sandbox-runtime) | 程序級沙箱，加上宿主側代理做域名白名單；Windows 支援仍是 alpha（Apache-2.0） |
| [Codex Windows 沙箱](https://github.com/openai/codex) | 有 elevated / unelevated / MXC 三種實現。app-server 提供就緒狀態查詢和配置介面，但 MXC 實現下就緒狀態恆為 ready，`setupStart` 只適用於 elevated/unelevated。網路審批帶結構化的主機資訊 |
| [Langfuse](https://github.com/langfuse/langfuse) | 成本分為“provider 上報”和“本地推斷”兩類，按互斥的桶統計；價格表用正則匹配加分段計價（MIT，自託管需要 6 個元件） |
| [Arize Phoenix](https://github.com/Arize-ai/phoenix) | 單程序、預設用 SQLite 的本地 trace 檢視器（ELv2，只適合當外部工具用） |
| [secretlint](https://github.com/secretlint/secretlint) / [gitleaks](https://github.com/gitleaks/gitleaks) | 金鑰檢測規則庫；secretlint 基於 Node，自帶 Anthropic、OpenAI 規則（MIT） |
| [E2B](https://github.com/e2b-dev/E2B) | Firecracker microVM；出網規則同時支援 IP、CIDR、域名（只適合以後的“不可信倉庫模式”） |
| [OpenLLMetry](https://github.com/traceloop/openllmetry) / [Helicone](https://github.com/Helicone/helicone) / [AgentOps](https://github.com/AgentOps-AI/agentops) | 只借鑑概念：業務鍵掛在 trace 上、按 Session-Path 分層歸因、會話回放。Helicone 已進入維護模式，AgentOps 維護很少 |

**F. 編碼 Agent 平台**

| 專案 | 一句話 |
|---|---|
| [OpenHands](https://github.com/OpenHands/OpenHands) | 事件溯源。StuckDetector 實際實現了 4 種卡死模式（第 5 種“上下文視窗迴圈”是空實現，直接返回 False）。非破壞式的 Condensation 壓縮事件；`get_unmatched_actions` 找出執行到一半的動作；風險分析器和確認策略分兩層（MIT） |
| [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) / [SWE-agent](https://github.com/SWE-agent/SWE-agent) | 每次呼叫模型前檢查 USD 成本上限（預設 3.0）；標準化的退出狀態；遇到致命錯誤時先把已有改動存成補丁（MIT） |
| [Cline](https://github.com/cline/cline) | 用影子 git 做檢查點，恢復分“只恢復檔案 / 只恢復對話 / 兩者都恢復”；自動批准按類別劃分；Focus Chain 待辦清單（Apache-2.0） |
| [Cline Kanban](https://github.com/cline/kanban) | 與 ACC 定位最接近：卡片加 worktree、依賴鏈自動啟動、diff 行內評論、提交或開 PR（研究預覽版） |
| [Kilo Code](https://github.com/Kilo-Org/kilocode) | Agent Manager 管理 worktree；支援 `.kilo/setup-script.ps1`；Apply to local；Multi-Version 並行對比（MIT） |
| [goose](https://github.com/aaif-goose/goose) | Recipe 裡可以寫 shell 成功檢查和重試；子代理不能再派生子代理；上下文用到 80% 時自動壓縮（Apache-2.0，歸屬 Linux Foundation） |
| [OpenCode](https://github.com/anomalyco/opencode) | doom_loop（同一呼叫重複 3 次就詢問）；每一步都做快照，支援 undo/redo；mutation-epoch 檢查點提案（MIT） |
| [Aider](https://github.com/Aider-AI/aider) | 每次編輯自動提交，`/undo` 撤銷；測試失敗後反思修復，最多 3 次（低活躍） |
| [Continue](https://github.com/continuedev/continue) | 權限語法 `Tool(glob)`，結果分 allow/ask/exclude 三種；#13289 是“子代理被改成全放行”的反面案例，目前仍未修復 |
| [Roo Code](https://github.com/RooCodeInc/Roo-Code) / [Plandex](https://github.com/plandex-ai/plandex) | 前者已歸檔，後者已停滯，只借鑑設計：Roo 的連續自動批准計數器、子任務只回傳摘要；Plandex 的自主度階梯 |

### 4.2 對照表：它們怎麼做 vs 我們現在怎麼做 vs 差距

| 主題 | 成熟方案怎麼做（代表專案） | ACC 現在怎麼做 | 差距 |
|---|---|---|---|
| 決策與副作用的持久化 | 決策和歷史一起提交，副作用由 reactor 或 outbox 事後執行（Temporal、t3code、Vercel Workflow 的 World） | `decide()` 是純函式，但決策只寫進快照，並且在鎖外執行 | 沒有 outbox，崩潰視窗裡會卡死，或者派發給錯誤的 agent（M-8、L-4） |
| 單寫者 | 恢復之前先拿到排他租約（DBOS executor_id、Temporal） | 沒有任何保護，先 recover 後 listen | H-3 |
| 審批只被消費一次 | 原子消費待決請求（OpenAI RunState）；只能完成一次、先到者生效（Restate）；Update 去重（Temporal） | 在鎖外先檢查，再執行副作用 | 併發重複提交時，交接被投遞兩次（實測，H-12）；普通審批可能被打成 BLOCKED（推斷） |
| 執行到一半的副作用 | 記錄 started，崩潰後標為 `unknown_after_crash`（Pydantic harness）；把步驟拆成開始和完成兩步（Absurd） | 只記錄已完成的副作用 | M-9 |
| 交接語義 | 交接引數有型別、目標可按上下文開關、交接時過濾上下文（OpenAI）；區分轉交與諮詢（ADK）；用有向邊做白名單（MAF） | 交接內容是自由文字，有 ask/auto 兩種策略，全域性一個 `maxAutoHandoffs`；auto 不區分“已證實”和“推斷” | 不區分“諮詢”和“轉交”；沒有邊白名單和來回往返檢測；轉發內容沒有圍欄（H-13） |
| 停滯與迴圈 | 語義層面的卡死檢測（OpenHands，已實現 4 種模式）；精確重複 3 次就詢問（OpenCode doom_loop）；停滯計數遞減（AutoGen 已採用，MAF 沿用），超限先自動恢復一次 | 一輪裡只要有工具完成，就把計數清零；超限直接 BLOCKED | 反覆跑同一個失敗命令的“忙碌迴圈”完全檢測不到 |
| 成本 | 每次呼叫前檢查 USD 上限（mini-swe-agent）；把剩餘額度傳給 Claude 原生的 `maxBudgetUsd`；成本區分上報值和推斷值（Langfuse） | 只有 token 預算；Claude 上報的 `costUsd` 在投影裡被丟掉；token 口徑也有錯 | 沒有美元預算，數字也不準（M-17） |
| 檢查點與回滾 | 每次工具呼叫後用影子 git 拍快照（Cline）、每步前後都拍快照（OpenCode）、隱藏 ref（t3code）、每次編輯一個提交（Aider）、`rewindFiles`（Claude SDK） | 只有 `createTaskWorktree` | 沒有 diff 檢視，不能撤銷，不能合併回基線 |
| worktree 生命週期 | setup 腳本、依賴目錄連結、Apply/PR、孤兒回收、放在倉庫之外（Kilo、Kanban、vibe-kanban、container-use） | 只會建立，而且放在倉庫內的 `.acc-worktrees/` | 新 worktree 裡沒裝依賴，測試失敗會被誤判為程式碼問題，白白觸發重試和 rescue |
| agent 主動提問 | Interrupt 帶 schema（AG-UI）、RequestInput（ADK）、elicitation（ACP、MCP） | Codex 的 `requestUserInput` 直接回 -32601；Claude 的提問也沒有對映 | 回答不了“agent 為什麼卡住” |
| 接入新 agent | 實現一個通用的 ACP 客戶端，就能覆蓋登錄檔裡的 41 個 agent | 每個 provider 寫一個私有 adapter；核心程式碼裡寫死了 provider ID（L-33） | TASKS P4 裡的 Gemini、OpenCode 可以一次解決，前提是核心先去掉 provider 硬編碼 |
| 追蹤 | OTel GenAI span 樹，內容預設不採集 | ADOPTION_MATRIX 寫著“Trace hierarchy：採納”，程式碼裡卻沒有任何實現 | 文件與實現不一致 |
| 本地服務安全 | token 加 Host 與 Origin 白名單（Jupyter、MCP Inspector、Ollama、Vite 修復 CVE 後的做法；同目錄的 Codex 版本也已實現） | 什麼都沒有 | H-1 |
| 執行隔離 | 程序級沙箱（srt）；Codex Windows 沙箱先檢查就緒狀態（MXC 實現下恆為 ready）；網路審批帶結構化的主機資訊 | 測試在沙箱外執行，並繼承全部環境變數 | H-15 |
| 金鑰脫敏 | secretlint、gitleaks 規則；OTel 內容預設不採集 | 什麼都沒有：SQLite、WS、日誌、審批表裡全是原文 | 缺少統一的脫敏入口 |
| 流式訊息標識 | messageId（ACP、AG-UI）、`sequence_number`（Open Responses） | 按“任務 + agent”緩衝，臨時事件的序號固定為 0 | 重連、併發訊息時會錯位（L-16） |
| 權限策略 | allow/ask/deny 加 glob，選“總是允許”後持久化（Continue、OpenCode）；連續自動批准計數，人工批准一次就清零（Roo、Cline、Kilo） | 只有單次批准和會話級批准，外加 `maxAutoHandoffs` | 沒有持久化的規則，也沒有兜底護欄 |

**結論：** 業界正在從“由 LLM 做路由”回到“確定性骨架 + 步驟內部讓 agent 自治”：Mastra 棄用了 networks，langgraph-supervisor 已歸檔，Kilo 棄用了 Orchestrator 模式。一篇 2026 年分析 11 個編碼 agent 原始碼的研究論文也發現，沒有一個執行時引入了通用的 agent 框架。ACC 選的方向是對的。它真正的差異化能力是可恢復、可審計、確定性的跨 agent 協作，這在上面這些開源專案裡很少見。現在要補的是可靠性細節和生產級的外圍功能。

---

## 5. 值得借鑑的具體做法

工作量：S 為 1～2 天，M 約 1 周，L 超過 2 周。價值分高、中、低。

本節的做法本身不附帶驗收標準。已經排期的，在“路線圖”列標出對應的 P 項，驗收標準以第 7 節為準；標“儲備”的暫不排期，排期時再補驗收標準。

**A. 可靠性與恢復**

| 做法 | 借鑑自 | 落到哪個模組 | 工作量 | 價值 | 路線圖 |
|---|---|---|---|---|---|
| 審批原子消費：在鎖內完成“檢查 pending → 提交 resolved”，只有搶到的那次呼叫才執行副作用 | OpenAI RunState、Restate、Temporal Update | `packages/core/src/orchestrator.ts`（resolveApproval） | S | 高 | P0-5 |
| 單實例租約，先 listen 再 recover | DBOS executor_id、同目錄 Codex 版本 | `apps/server/src/index.ts`、`packages/storage/src/sqlite-store.ts` | S | 高 | P0-3 |
| 決策寫成事件，加 outbox；恢復時按 outbox 和 awaitingAgentId 重新驅動 | Temporal command→event、t3code reactor、Vercel World | `orchestrator.ts`（onAgentSignal、executeDirective、recover）、儲存層 | M | 高 | P1-1 |
| 審批投遞狀態：先標 inflight，送達後發 `approval.delivered`，狀態不明時阻塞 | MAF 的 entry checkpoint、同目錄 Codex 版本 | `orchestrator.ts`、`projection.ts`、`snapshot.ts`（v5） | M | 高 | P1-1 |
| 記錄執行到一半的副作用，崩潰後要求人工確認；恢復提示詞改為只列出“狀態不明”的呼叫 | Pydantic StepPersistence、Absurd、OpenHands unmatched actions | `projection.ts`、`snapshot.ts`、`packages/adapters/src/shared.ts` | M | 高 | P1-2 |
| 崩潰注入測試、replay 測試、子程序 SIGKILL 測試 | LangGraph #8039 的教訓、Temporal replay、同目錄 Codex 版本 | `tests/` | M | 高 | P1-1、P1-11 |
| 改用 `synchronous=FULL`，寫快照前先回讀校驗一遍 | SQLite 官方文件、MAF #8181 | `sqlite-store.ts`、`snapshot.ts` | S | 中 | P1-12 |
| 恢復次數上限，快照裡記錄建立時的應用版本 | DBOS 的 MAX_RECOVERY_ATTEMPTS 和 application_version | `orchestrator.recover`、`snapshot.ts` | S | 中 | P1-14 |
| 快照有界化，副作用台賬拆成獨立表 | EventStoreDB/Marten 的“每 N 個事件一個快照”、Pydantic 的 tool_effects 表 | `orchestrator.ts`、`sqlite-store.ts` | M | 中 | P2-10 |
| resume 單飛：同一 (run, agent) 的併發 resume 共享一次嘗試，準備階段取消就不啟動 | Happy v1.2.5 | `session-registry.ts` | S | 中 | P1-14 |

**B. 安全**

| 做法 | 借鑑自 | 落到哪個模組 | 工作量 | 價值 | 路線圖 |
|---|---|---|---|---|---|
| Host/Origin 守衛加啟動令牌 | Jupyter、MCP Inspector、同目錄 Codex 版本 | `apps/server/src/index.ts` | S | 高 | P0-1 |
| 子程序環境變數白名單；Codex 配置 `shell_environment_policy.inherit=core`，並把 `ignore_default_excludes` 設為 false | Claude SDK 的 `env` 選項、Codex 配置、Emdash 的 terminal-env | 新建 `packages/adapters/src/env-policy.ts` | S | 高 | P0-8 |
| Claude 設 `settingSources: []`、`strictMcpConfig`，禁用 Agent、Task 等子 agent 工具；Codex 設 `approvalsReviewer:'user'`、`multi_agent:false` | 同目錄 Codex 版本、Claude SDK | `claude-agent-sdk-adapter.ts`、`codex-app-server-adapter.ts` | S | 高 | P0-8 |
| 由編排器產生的批准一律按“單次”處理，只有人工顯式選擇時才給會話級；做一套權限傳遞的契約測試 | OpenCode（once 語義）、Continue #13289 的教訓 | `orchestrator.ts`、`tests/` | S | 高 | P0-9 |
| 在唯一的事件入口 `createSink` 統一脫敏：已知環境變數的值做精確替換，再加一組精選正則 | secretlint、gitleaks | 新建 `packages/core/src/redaction.ts` | M | 高 | P2-9 |
| 合入基線之前用 secretlint 掃描 diff | secretlint（有 Anthropic、OpenAI 規則） | `worktree.ts` | S | 高 | P2-9 |
| 測試執行器放進 srt 沙箱。注意：原生 Windows 上只能在 initialize 裡做會話級配置，按命令傳入檔案系統規則會直接報錯 | sandbox-runtime | `test-runner-adapter.ts` | M | 高 | P2-8 |
| 連線 Codex 後查詢 Windows 沙箱就緒狀態（MXC 實現下恆為 ready，只有 elevated/unelevated 需要用 setupStart 配置）；網路審批帶主機資訊，可以選“允許該主機” | Codex app-server | `codex-app-server-adapter.ts`、`ApprovalDialog.tsx` | M | 高 | P1-16（提示）、P2-8 |
| 在 worktree 裡強制禁止寫 `.git/hooks`、`.git/config`、`.claude/**`、`.mcp.json`、`.codex/**` 等路徑 | srt 的強制拒寫清單 | `makeCanUseTool`、Codex 審批處理 | S | 高 | P0-8 |

**C. 協作語義**

| 做法 | 借鑑自 | 落到哪個模組 | 工作量 | 價值 | 路線圖 |
|---|---|---|---|---|---|
| 交接請求改成強型別，並區分 `kind: consult \| transfer`（諮詢的答覆自動交回請求方） | OpenAI input_type、ADK 的三種模式 | `claude-agent-sdk-adapter.ts` 的 handoffServer、`types.ts`、`orchestrator.ts` | S～M | 高 | P2-5 |
| 交接有向邊白名單、按邊計數、出現來回往返時強制轉人工 | MAF `add_handoff`、`turn_limits` | `orchestrator.ts` onAgentHandoffRequest | S | 高 | P1-8（往返檢測）、P2-5（白名單） |
| 把交接決策重構成一條鉤子管線（beforeHandoff / afterHandoff），出錯時 fail closed | Mastra 委派鉤子 | 新建 `packages/core/src/handoff-policy.ts` | M | 高 | P2-5 |
| 按步驟規定結構化的完成契約：review 必須給出結論和問題列表，rescue 給根因，implement 給狀態和改動檔案；Claude 用 `outputFormat`，Codex 用 `outputSchema` | ADK finish_task；本機 SDK 0.3.280 和 codex 0.156.1 都支援 | `context-manager.ts`、`workflow.ts`、兩個 adapter | M | 高 | P2-5 |
| Codex 用 dynamicTools（實驗介面）替代 `HANDOFF@` 文字標記，文字方式保留作兜底 | Codex app-server | `codex-app-server-adapter.ts` | S | 高 | P2-5 |
| 統一的中斷請求模型（審批加提問，帶 responseSchema 和過期時間） | AG-UI Interrupt、ADK RequestInput、codex-acp | `types.ts`、`orchestrator.ts`、`ChatPanes.tsx` | M | 高 | P2-6 |
| 交接時附帶一份由編排器從事件日誌確定性生成的活動摘要，不經過 LLM | smolagents 的執行摘要、Cline 的交接筆記 | `insights.ts`、`context-manager.ts` | S | 高 | P1-4 |
| 任務依賴：前置任務完成後自動啟動後續任務 | Cline Kanban | `orchestrator.ts`、`sqlite-store.ts`、`TaskList.tsx` | M | 高 | P2-4 |
| 可選的“計劃籤核”步驟，回應只有“批准”和“修訂”兩種 | MAF 的 RequirePlanSignoff | `workflow.ts` | M | 中 | 儲備（P2-11 時評估） |

**D. 預算、迴圈與成本**

| 做法 | 借鑑自 | 落到哪個模組 | 工作量 | 價值 | 路線圖 |
|---|---|---|---|---|---|
| doom_loop：同一 agent、同一工具、同一輸入連續 3 次就詢問操作員 | OpenCode | `projection.ts`、`orchestrator.ts` | S | 高 | P1-8 |
| 語義層面的卡死檢測：重複動作加相同結果、重複報錯、只說不做、A/B 交替；重複報錯達到閾值時先提醒一次，再次出現才判定卡死 | OpenHands StuckDetector（已實現的 4 種模式） | 新建 `packages/core/src/stuck-detector.ts` | M | 高 | P1-8 |
| 停滯計數改為遞減，超限先自動恢復一次，再進入人工閘門 | AutoGen Magentic-One（MAF 沿用） | `projection.ts`、`budget.ts`、`workflow.ts` | M | 高 | P1-8 |
| 增加 `maxCostUsd`，並把剩餘額度傳給 Claude 的 `maxBudgetUsd`；Claude 的成本取增量（它上報的是累計值） | mini-swe-agent、Claude SDK | `budget.ts`、`claude-agent-sdk-adapter.ts` | S | 高 | P1-7 |
| 統一 token 口徑：Codex 取本輪 total 的差值；Claude 的 input 加上快取讀寫 | OTel GenAI、Langfuse | 兩個 adapter、`projection.ts` | S | 高 | P1-7 |
| 連續自動批准計數器，人工批准一次就清零 | Roo、Cline、Kilo | `RunSettings`、`orchestrator.ts` | S | 高 | P2-7 |
| 扇出之前一次性預留呼叫額度 | OpenHands PR #3845 的教訓 | `budget.ts`（askBoth、handoff） | S | 中 | P1-7 |
| 預算快用完時發出收尾指令，要求 agent 總結已完成和剩餘的工作 | OpenCode steps、LangGraph RemainingSteps | `orchestrator.ts`、`context-manager.ts` | S | 中 | P1-7 |

**E. 工作區與回滾**

| 做法 | 借鑑自 | 落到哪個模組 | 工作量 | 價值 | 路線圖 |
|---|---|---|---|---|---|
| worktree 任務每輪寫入後自動提交到任務分支，支援“撤銷上一輪” | Aider | `worktree.ts` | S | 高 | P2-3 |
| worktree setup 腳本（Windows 用 `.ps1`），node_modules 用 junction 連結進去 | Kilo、Cline Kanban | `worktree.ts` | S | 高 | P2-4 |
| diff 審查面板，行內評論發回給 agent | Cline Kanban、vibe-kanban | `apps/server`、`TaskDetail.tsx` | M | 高 | P2-4 |
| 合入回基線的人工閘門，分 merge 和 apply 兩種，執行前預覽命令 | container-use、Crystal | `worktree.ts`、`workflow.ts` | M | 高 | P2-4 |
| worktree 對賬（回收孤兒、重建丟失的），並移到倉庫之外 | vibe-kanban、container-use | `worktree.ts` | M | 中 | P2-4 |
| 每個步驟邊界用隱藏的 git ref 記錄快照，之後可從任意一步分叉重跑 | t3code、DBOS forkWorkflow、CrewAI | `worktree.ts`、`orchestrator.ts` | L | 中 | P2-3 |
| 開啟 Claude 檔案檢查點，提供“撤銷這一輪的檔案改動” | Claude SDK 的 `rewindFiles` | `claude-agent-sdk-adapter.ts` | M | 中 | P2-3 |

**F. 接入與協議**

| 做法 | 借鑑自 | 落到哪個模組 | 工作量 | 價值 | 路線圖 |
|---|---|---|---|---|---|
| 通用 AcpAdapter，首批接入 Gemini CLI（需升級到 0.60）和 OpenCode | ACP、acp-to-agui 的對映 | 新建 `packages/adapters/src/acp-adapter.ts` | M | 高 | P2-1 |
| 用 `codex app-server generate-ts` 生成協議型別，並加漂移檢查 | Codex | `codex-protocol.ts`、scripts | S | 高 | P1-11 |
| 處理 `serverRequest/resolved`，被撤回的審批卡自動結案 | Codex app-server、Codeg | `codex-app-server-adapter.ts` | S | 高 | P1-6 |
| 用 Claude 的 `session_state_changed` 事件作為已證實的狀態 | Claude SDK | `claude-agent-sdk-adapter.ts` | S | 高 | P1-10 |
| 流式訊息帶 messageId 和 streamSeq | ACP、AG-UI、Open Responses | adapters、`App.tsx` | S | 高 | P1-10 |
| 共享的 adapter 合約測試 | 本專案儲存合約測試的寫法 | `tests/contract/` | M | 高 | P1-11 |

**G. 可觀測性**

| 做法 | 借鑑自 | 落到哪個模組 | 工作量 | 價值 | 路線圖 |
|---|---|---|---|---|---|
| 純函式 `eventsToSpans`，trace/span ID 由 runId 和事件 ID 雜湊得到（可重複生成）；審批等待單獨做成一個 span | OTel GenAI 語義約定 | 新建 `packages/core/src/tracing.ts` | M | 中 | P2-2 |
| 可選的 OTLP 匯出，預設只匯出後設資料；本地可以接 Phoenix 檢視 | Phoenix、Langfuse | `apps/server` | M | 中 | P2-2 |
| 給 Claude 子程序注入 TRACEPARENT 和 `acc.*` 資源屬性，把它原生的 span 掛到 ACC 的 trace 下 | Claude Code 遙測、OpenLLMetry | `claude-agent-sdk-adapter.ts` | S | 中 | P2-2 |
| `dump-run` 除錯命令，快速檢視卡住的 run | Absurd 的 `absurdctl dump-task` | 新建 CLI 腳本 | S | 中 | P1-16 |

**H. 介面與體驗**

| 做法 | 借鑑自 | 落到哪個模組 | 工作量 | 價值 | 路線圖 |
|---|---|---|---|---|---|
| 跨任務的審批收件箱，加上頁面標題、favicon 和桌面通知 | Emdash、octomux | `App.tsx`、新增 Inbox 元件 | S | 高 | P1-10 |
| 快照裡正式記錄 blocker、nextAction、activeAgents 三個欄位 | ORCHESTRATOR_SPEC、AG-UI 的 StepStarted | `projection.ts`、`TaskDetail.tsx` | M | 高 | P1-10 |
| 單個 agent 的單輪中斷按鈕 | Open WebUI、Claude.ai 的做法 | `apps/server`、`ChatPanes.tsx` | S | 中 | P1-10 |
| WS 支援按序號續傳，並給每個訂閱設背壓上限 | t3code 的 LiveStreamBudget | `apps/server/src/index.ts` | S | 中 | P1-10 |
| 自主度預設（3～5 檔命名組合） | Plandex、goose | `NewTask.tsx`、`RunSettings` | S | 中 | 儲備（P2-7 時評估） |

---

## 6. 與同目錄 Codex 版本（`agent-control-center-codex`，下稱 [X]）的對照

[X] 和本專案出自同一份交接包，架構相同，但體量小得多：原始碼約 3.2k 行，自報有 102 個測試。它的取向是“範圍窄、規則嚴”。注意 [X] 不是 git 倉庫，預設埠是 8789。

**[X] 做得更好的地方（按價值排序）：**
1. **本機訪問守衛**：onRequest 鉤子要求 Host 必須是 127.0.0.1 或 localhost；請求帶 Origin 頭時只放行本機來源，其餘一律返回 403。本專案對應的問題是 H-1。
2. **審批投遞狀態**：有 `inflight` 和 `delivered` 兩種狀態，投遞結果不明時直接阻塞，不重新投遞。
3. **命令序列化**：所有公共命令按任務排隊；建立任務用一個全域性鍵，保證“工作區檢查 + 提交”是原子操作；EventBus 拒絕不遞增的序號。對照本專案：[C] 的 resolveApproval、cancelTask、sendMessage 沒有按任務序列（按程式碼推斷）。其中“同一審批併發提交兩次，交接被投遞兩次”已經由服務端審查實測（H-12）；“普通審批被誤置為 BLOCKED”仍然只是按程式碼推斷，沒有實測。
4. **儲存層不變數**：寫事件時要求序號正好等於快照遊標加一；已解決的審批不能被覆蓋；events 表有觸發器，只允許追加；使用 `synchronous=FULL`；表之間有外來鍵。
5. **壞快照隔離**：在一個事務裡記錄事故，並把任務置為 BLOCKED；此後對這個任務的操作統一返回結構化的 409；重複啟動不會重複告警。
6. **預算前置檢查**：在 `model.turn.started` 和 `tool.started` 之前就檢查預算；每個 run 一個精確的定時器，不靠每 5 秒掃一遍全表；把剩餘的 maxTurns 傳給 SDK。
7. **Claude 用量口徑正確**：快取讀寫都計入輸入 token。
8. **排程權收回到編排器**：Claude 禁用 Agent、Task 等子 agent 工具；Codex 設定 `multi_agent: false` 和 `approvalsReviewer: 'user'`。本專案沒有固定 approvalsReviewer（M-35）。
9. **工作區互斥更完整**：判斷父子目錄重疊（Windows 下統一轉小寫），所有寫模式任務都參與互斥；唯讀任務不佔用工作區。
10. **Windows 程序管理**：直接啟動原生的 `codex.exe`，不經過 shell，並設定 `windowsHide:true`。
11. **恢復測試更真實**：子程序寫庫後被 SIGKILL，再做恢復；兩次真實啟動 server 程序，驗證 409 行為。
12. **運維**：有啟動/停止腳本、`/api/shutdown`、訊號處理、engines 宣告，以及給終端使用者看的使用說明.md。
13. **介面可訪問性**：彈窗有焦點陷阱和焦點歸還，支援 reduced-motion，有四檔斷點，任務列表可以篩選和搜尋。
14. **測試執行需要審批**，重啟後不會自動重跑（這是一個取捨，不一定更好）。

**本專案做得更好的地方：**
- 多 AI 協作功能完整：agent 可以主動請求交接（Claude 用 MCP 工具，Codex 用文字約定）；有 ask/auto 兩種策略並設了上限；同一任務內可以 Ask Both；可以換人接手。[X] 只在系統提示裡提了一句，沒有任何實現。
- 每個 agent 一個聊天窗格，逐字流式輸出，審批直接在對話裡處理。[X] 沒有流式輸出。
- agent 工作時可以插話（Codex 用 `turn/steer`，Claude 用流式輸入）。[X] 在 agent 工作時發訊息會直接報錯。
- 有會話級審批；重啟後能接上掛起的審批（審批 ID 穩定，同一呼叫只放行一次）。
- 工作流內聚：review 和 review-fix 在同一個 run 裡完成，受評審輪數限制。[X] 要為此新建多個任務，上下文和預算都被分散。
- 上下文信封按用途只帶必要內容；快照 v1→v4 有真實的遷移鏈；事件對映更全面；worktree 帶分支；測試執行器有超時。
- 有可讀的事件日誌、儀表盤和用量彙總，測試數量也更多（109 個）。

**值得從 [X] 移植的點：**

| 移植項 | 本專案落點 | 工作量 |
|---|---|---|
| Host/Origin 鉤子，覆蓋 WS 升級請求（開發埠放行 5174） | `apps/server/src/index.ts` | S |
| Claude 用量口徑修正；把剩餘 maxTurns 傳給 SDK | `claude-agent-sdk-adapter.ts`、`projection.ts` | S |
| 排程權收回：disallowedTools、`multi_agent:false`、`approvalsReviewer:'user'` | 兩個 adapter、`codex-protocol.ts` | S |
| 公共命令按任務加鎖；建立任務用全域性工作區鎖 | `orchestrator.ts` | S |
| 工作區父子目錄重疊判斷（本專案的 worktree 在倉庫內的 `.acc-worktrees/`，需要豁免，或者把 worktree 移到倉庫之外） | `orchestrator.ts`、`worktree.ts` | S |
| Windows 下直接啟動原生 `codex.exe`，並設 `windowsHide` | `codex-rpc.ts`、`test-runner-adapter.ts` | S |
| 優雅關停、啟動/停止腳本、`engines` 欄位 | `apps/server`、`scripts/` | S |
| 測試執行審批改為可選；重啟後結果不明時 fail closed | `test-runner-adapter.ts` | S |
| 審批 inflight/delivered 兩態（快照遷移到 v5） | `orchestrator.ts`、`projection.ts`、`snapshot.ts` | M |
| 重啟續跑能感知執行到一半的工具，需要時先由操作員確認再重連 | `orchestrator.ts`、`TaskDetail.tsx` | M |
| 預算前置檢查；時長預算改為每個 run 一個定時器 | `orchestrator.ts`、`apps/server` | M |
| 儲存層不變數、只追加觸發器、`synchronous=FULL` | `sqlite-store.ts`、`in-memory-store.ts` | M |
| 壞快照持久隔離，加結構化 409 | `orchestrator.ts`、`index.ts` | M |
| 快照完整欄位校驗 | `snapshot.ts` | M |
| 程序級恢復測試（SIGKILL 和真實 server 啟動） | `tests/` | M |
| 介面：篩選/搜尋、焦點陷阱、手機佈局；用量只在開啟用量頁時拉取 | `apps/web` | M |
| 協議核對與驗證記錄文件；終端使用者使用說明 | `docs/` | S |

**不建議照搬 [X] 的地方：**
- 不要把 review、rescue 做成各開一個新任務。
- 不要把“重啟後一律必須人工重連”作為預設行為。建議取折中：只有存在執行到一半的工具，或審批投遞狀態不明時，才強制人工確認；其餘情況沿用現在的自動續跑。

---

## 7. 建議路線圖

**完成定義（適用於每一項）：**
1. 按 CLAUDE.md 的要求，`npm run typecheck`、`npm test`、`npm run build` 全部通過。
2. 驗收用例以測試的形式提交到 `tests/` 下，並且在修復前能復現失敗；不再依賴會話臨時目錄裡的探針腳本。
3. 同步更新 `TASKS.md` 中對應條目的驗收標準。

**依賴順序：**
- P0-0 最先做，後面各項的迴歸測試都以它為基礎。
- P1-1（outbox）要建立在 P0-2 的按 run 序列佇列和 P0-3 的單實例租約之上。
- P1-11 的共享 adapter 合約測試，以及 P1-17（核心去掉寫死的 provider ID），都是 P2-1（ACP 介面卡）的前置。
- P2-3（檢查點）和 P2-4（worktree 生命週期）都要改 `worktree.ts`，還要共同決定 worktree 放在哪、什麼時候清理。兩者應一起設計，先做 P2-4 中位置與清理的部分。
- P1-8 的來回往返檢測，應該在推廣 auto 交接策略之前完成。

**工作量：** S 為 1～2 天，S～M 為 2～5 天，M 約 1 周（5 個工作日），L 超過 2 周。按這個標準把 P0 的 11 項加起來，約 25～46 個工作日，單人大約 5～9 周。這只是按標註求和的粗估，沒有做正式排期。

### P0：必須馬上修（安全與資料正確性）

**P0-0 把探針固化為迴歸測試**（全部“實測”問題；S～M）
- 做什麼：把 `probe*.mjs` 的各個場景改寫成 vitest 用例，放進 `tests/regression/`。非同步場景需要的“延遲投遞”測試替身，在本項提供一個最小實現，完整版見 P1-11。
- 驗收：
  - 3.2 節引用的每個探針場景（probe、probe2～probe9 及其場景編號），都有對應的用例。
  - 在當前程式碼上，這些用例按預期失敗（用 `it.fails` 或等價方式標註）；修復後改成正常斷言。

**P0-1 本地服務訪問控制與輸入校驗**（H-1、L-10、L-12，加上點選劫持線索；S～M）
- 做什麼：按白名單校驗 Host/Origin（覆蓋 WS 升級）；啟動令牌加 HttpOnly Cookie；所有 POST 強制 JSON；非迴環地址且沒有令牌時拒絕啟動；WS 設定 maxPayload 和連線數上限；加 `frame-ancestors 'none'`；校驗 cwd 和 agentId，所有校驗通過後才建立 worktree。
- 驗收：
  - 外域 Origin 的 REST 請求和 WS 升級都返回 403；Host 為任意域名時返回 403；不帶令牌返回 401；不帶 body 的跨站 `/cancel` 失敗。
  - 令牌不出現在 agent 子程序和測試程序的環境變數裡（用一個列印環境變數的假執行時來斷言）。
  - 令牌存放在使用者私有目錄；Windows 上該檔案的 ACL 只授權給當前使用者（啟動時自檢，並有測試）。
  - 超過 maxPayload 或連線數上限的連線被拒絕，有測試。
  - `ACC_HOST` 為非迴環地址且沒有令牌時啟動失敗，有測試。
  - 響應頭帶 `frame-ancestors 'none'`（或等價的 X-Frame-Options）。
  - cwd 不是已存在的絕對路徑，或者不在允許的根目錄下時，返回 400；校驗失敗後不留下 worktree 和分支。

**P0-2 編排器異常不再帶崩程序**（H-2、H-14、M-10、L-2；M）
- 做什麼：
  - 反應放進按 run 序列的佇列，與 adapter 呼叫棧脫鉤。
  - publish 只在持久化失敗時 reject；fire-and-forget 呼叫一律改用 `safeEmit`。
  - Claude 訊息泵區分 emit 異常和 SDK 迭代異常。
  - stdin/stdout/stderr 的 error 轉成傳輸關閉。
  - Codex 通知按 threadId 分 chain。
  - 全域性 unhandledRejection 只記錄日誌、不退出，並給相關 run 發 `runtime.error`。
- 驗收：
  - probe7 迴歸：程序不退出，任務正常推進，或進入帶原因的 BLOCKED。
  - 注入一個會拋異常的編排器反應：Claude 會話保持存活並繼續消費訊息；錯誤記為編排器的 `runtime.error`，不算到 provider 頭上。
  - fake transport 非同步丟擲 stdin error：轉成 `CODEX_TRANSPORT_CLOSED`，程序存活。
  - 故意製造一個未處理的 Promise 拒絕：程序存活，日誌裡有這條錯誤。
  - 任務 A 的反應被阻塞時，任務 B 的 Codex 審批請求仍能到達編排器（L-2）。

**P0-3 單實例**（H-3；S）
- 做什麼：用鎖檔案或 `instance_lease` 表加心跳；先 listen，再 recover；只有確認原租約已經失效，才轉移會話歸屬。
- 驗收：
  - 兩個編排器共用一個庫時，第二個在寫入任何資料之前就拒絕啟動，不再出現 UNIQUE 衝突。
  - 模擬強殺或斷電後殘留的鎖或租約（心跳過期，或持有者程序已不存在），能被新實例接管。
  - Windows 上鎖檔案仍被舊程序控制代碼佔用時，有明確的報錯和處理，並有測試覆蓋。

**P0-4 續跑時使用持久化的 cwd 和 mode**（H-4；S）
- 驗收：
  - 合約測試：worktree cwd 加 review 模式，重啟續接後，`thread/resume` 和 query options 裡的 cwd 都正確，並且 `permissionMode === 'plan'`。
  - metadata 裡沒有 cwd 時，resume fail closed（進入帶原因的 BLOCKED），不回退到 defaultCwd。
  - Codex 返回的 cwd 在規範化後與期望不一致時，fail closed。

**P0-5 多會話終止、狀態守衛、審批只消費一次**（H-5、H-6、H-12、M-5、L-21；M）
- 做什麼：
  - 取消、預算停止、accept 都遍歷全部線上會話。
  - 派發前在鎖內複核狀態，start 返回後再複核一次。
  - 審批在鎖內用 CAS 消費；進入終態時作廢全部待審批。
  - 記錄 blockedBy，只有“因審批而暫停”時，審批才能把狀態恢復為 RUNNING。
  - 審批彈窗的預設焦點移到“稍後處理”，並加焦點陷阱。
- 驗收：
  - probe 場景 3、4、D，probe3 B，以及場景 10，迴歸全部通過。
  - 兩個併發 approve（`Promise.all`）只執行一次副作用，交接只投遞一次；另一個呼叫返回 409 或第一次的結果；任務不會被誤置為 BLOCKED。
  - 已取消任務上的審批返回 409，工具不執行。
  - 彈窗開啟時按 Enter 不會批准（元件測試）。

**P0-6 不再卡死**（H-9、H-10、H-11；S～M）
- 做什麼：
  - Claude 返回錯誤結果時補發 failed，並按 `api_error_status` 判斷是否可重試。
  - 失敗或傳輸關閉時，把會話移出線上表，重試改走 resume。
  - 訊息泵正常結束時，補發 `CLAUDE_RUNTIME_EXITED` 和 failed。
  - 交接審批不改變 run 狀態（或者快取完成訊號，審批後重放）。
  - 增加按步驟計算的不活動看門狗。
- 驗收：
  - 共享合約斷言在 Claude、Codex、測試執行器、Mock 四種實現上都通過：每個派發出去的回合，以且只以一個終態結束。
  - probe4、probe5 和 probe 場景 1、6 迴歸：在注入時鐘下，超過配置的步驟不活動閾值後，任務進入 retry、rescue 或帶原因的 BLOCKED，不再依賴 30 分鐘時長預算兜底。閾值作為配置項，預設值在實現時確定，並寫進 TASKS.md。
  - Claude CLI 以退出碼 0 意外結束時，發出 `CLAUDE_RUNTIME_EXITED` 和 failed，介面不再顯示 coding。

**P0-7 預算修正**（H-7、H-8；S～M）
- 做什麼：
  - 時長只統計 agent 實際工作的時間，不含等待人工和停機的時間。
  - 閘門動作顯式續額（`budget.extended`）；accept 直接完成。
  - 對話任務使用獨立的預算。
  - 狀態遷移被拒絕時，顯式報錯，或者追加 `TRANSITION_REJECTED`。
  - 開放預算 API。
- 驗收：
  - probe8：31 分鐘後點 accept，得到 COMPLETED。
  - probe2：stall 阻塞後執行 gate retry，完成訊號被處理，流程繼續往下走。
  - 限額恰好用滿最後一輪時，這一輪的成功完成被接受（`>=` 邊界用例）。
  - 服務停機 40 分鐘後重啟，停機時間不計入時長預算，續接的會話不會被立即阻塞。
  - 對話任務空閒 60 分鐘不被阻塞；3 輪純問答不被判為停滯；向 BLOCKED 任務發訊息，要麼被明確拒絕，要麼先顯式恢復。
  - 預算 API：調高某項限額後，`budget.extended` 事件落庫、快照更新，因預算被 BLOCKED 的任務可以恢復；非法引數返回 400；對終態任務返回 409。

**P0-8 最小安全收緊**（H-15、M-13、M-15、M-35；S～M）
- 做什麼：
  - 子程序環境變數改白名單，覆蓋 Claude 的 `env` 選項、Codex app-server 的啟動環境和 `shell_environment_policy`、測試執行器。
  - 本輪 agent 改過測試配置（`package.json` 的 scripts、測試配置檔案）時，test 步驟前要求操作員確認。
  - Claude：`settingSources: []`、`strictMcpConfig: true`；handoff 工具校驗 `mcpServer.source==='sdk'`。
  - “本會話都允許”只保留 addRules，強制 `destination='session'`，並遵守 `suppressAlwaysAllowRule`。
  - Codex：固定 `approvalsReviewer:'user'`，關閉 `multi_agent`。
  - 強制拒寫 `.git/hooks/**`、`.git/config`、`.claude/**`、`.mcp.json`、`.codex/**`。
  - 注意：不要用 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` 代替白名單（見第 8 節）。
- 驗收：
  - 測試程序和 agent 執行的命令裡，讀不到 `*_API_KEY` 和 ACC 令牌。
  - agent 改了 `package.json` 的 test 腳本後，test 步驟進入 WAITING_INPUT，並顯示 diff。
  - 工作區 `.claude/settings.json` 裡的 allow 規則和 hooks 不再生效。
  - “本會話都允許”不寫任何檔案；`suppressAlwaysAllowRule=true` 時，介面不提供會話級選項。
  - 用 fake app-server 斷言：thread/start 和 thread/resume 的請求裡都帶有 approvalsReviewer 和 multi_agent 設定。
  - 對上述拒寫路徑發起的 Edit/Write 或 fileChange 被拒絕。
  - 收緊環境變數後，在 Windows 上用 real 模式跑冒煙腳本（`scripts/smoke-*`）：Claude 和 Codex 都能完成認證，並跑完一輪。

**P0-9 跨 agent 邊界加固**（H-13、L-1；S～M）
- 做什麼：
  - auto 策略只執行 confirmed 的交接，推斷出的請求轉人工審批。
  - 轉發內容放進帶唯一邊界的資料區塊。
  - 次數檢查與自增放在同一把鎖內。
  - Codex 標記只認最後一行，並校驗目標。
  - `createSink` 固定身份欄位，剝離 sequence 和 id，只允許白名單內的事件型別。
  - 由編排器策略產生的批准一律按單次處理，不擴大為會話級。
- 驗收：
  - Codex 輸出帶 HANDOFF@ 標記、策略為 auto 時，生成一個需要人工審批的交接，不自動執行。
  - 被轉發的內容裡包含一行 `[Your task]` 時，這一行在接收方訊息中位於資料區塊之內，編排器的任務指令只出現一次（快照斷言）。
  - 同時發起兩個 auto 交接請求時，已用次數不超過上限。
  - adapter 透過 sink 發出 run.status、run.completed、approval.resolved 時被拒絕，並記一條 runtime.warning，run 狀態不變（probe 場景 11 迴歸）。
  - 權限傳遞契約測試：在 handoff、reassign、ask-both、恢復續跑、auto 交接各條路徑下，唯讀模式和 deny 規則都不會被放寬。

**P0-10 控制面資料與倉庫衛生**（H-16、L-31；S）
- 做什麼：
  - 資料庫和日誌預設放到 `%LOCALAPPDATA%\agent-control-center`（其他平台用對應的使用者資料目錄）。
  - 資料庫或日誌路徑落在預設工作區或任何任務 cwd 之內時拒絕啟動（可以用顯式開關降級為告警）。
  - 檢測到舊位置已有資料庫時，提示遷移。
  - 把 `references/` 加進 `.gitignore`，或者克隆到倉庫之外。
- 驗收：
  - 預設配置啟動後，資料庫和日誌都不在 INIT_CWD 下。
  - 把 `ACC_DB_PATH` 指向工作區內時，啟動失敗並給出原因。
  - 舊位置已有資料庫時，不會靜默新建一個空庫。
  - 執行 clone-references 之後，`git status --porcelain` 為空。

### P1：近期（1～2 個月）

**P1-1 Outbox、決策事件與投遞狀態**（M-8、L-3、L-4；M；依賴 P0-2、P0-3）
- 做什麼：
  - 決策寫成事件，與快照同事務提交。
  - 用 pendingDirective / pendingDeliveries 作為 outbox，以 stepSeq 或確定性 ID 作冪等鍵。
  - 增加 `approval.delivered`。
  - recover 按 outbox 和 awaitingAgentId 重新驅動。
  - 序號在事務內分配。
  - recover 改為 listen 之後非同步並行執行，並對外暴露恢復進度。
  - createTask 校驗 reviewAgentId。
- 驗收：
  - 崩潰注入測試：在每個提交點“殺程序”再恢復，副作用不重複，run 不卡死。
  - `approval.resolved` 已提交、還沒 delivered 時重啟：按原決定補投一次，或者轉人工處理，不會靜默丟失。
  - 對終態任務呼叫 `setHandoffPolicy` 不再返回 500，快照和事件保持一致。
  - 有 3 個可恢復的 Claude run 時，recover 完成前服務已能響應 `/health`。
  - reviewAgentId 寫錯時，createTask 返回 400，且不落庫。

**P1-2 執行中副作用台賬**（M-9；M）
- 做什麼：
  - 維護 inFlightSideEffects；恢復時如果不為空，就進入 BLOCKED，並列出“狀態不明”的呼叫。
  - resumePrompt 只列出當前 agent 的狀態不明呼叫（名稱加輸入摘要），不再羅列全部原始 ID。
  - 測試執行器的副作用 ID 全域性唯一。
- 驗收：
  - 在 tool.started 之後殺程序，恢復後任務進入 BLOCKED，並列出這個呼叫。
  - resumePrompt 列出的條目有固定上限，不隨歷史工具呼叫的數量增長。
  - 測試執行器兩次執行的 ID 不同。

**P1-3 完成訊號與派發關聯**（M-1、L-9；S～M）
- 驗收：
  - probe 場景 8：插話後，測試不會提前執行。
  - 用過時 turnId 做的 steer 失敗後，訊息改經 `turn/start` 送達，任務不進入 BLOCKED。

**P1-4 會話權限與交接上下文**（M-2、M-3、M-4；M）
- 做什麼：
  - 快照記錄每個會話的寫權限，請求的權限不一致時新建會話，否則 fail closed。
  - 發訊息不改變 run 狀態。
  - 工作區互斥覆蓋對話任務，並按父子目錄判斷（豁免 `.acc-worktrees`，或隨 P2-4 移出倉庫）。
  - 統一交接信封，由編排器從事件日誌確定性地生成活動摘要（執行過的命令及退出碼、改動的檔案、測試結果），不經過 LLM。
- 驗收：
  - probe 場景 9、probe3 A 和 C、probe9 迴歸通過。
  - Ask Both 的顧問會話在執行時層面就是隻讀的（Claude plan / Codex read-only），不只靠提示詞約束。
  - 交接訊息包含活動摘要；用同一份事件日誌生成的摘要逐字相同。

**P1-5 資源回收與程序管理**（M-6、M-21、L-8、L-32；M）
- 做什麼：
  - adapter 增加 `close()`；run 進入終態時關閉全部會話並清理各個 Map。
  - 優雅關停：處理 SIGINT/SIGTERM/SIGBREAK，提供 `/api/shutdown`。
  - 測試執行器以 exit 事件為主訊號；POSIX 下按程序組結束；spawn 之前再查一次是否已取消。
  - Windows 上改為非同步結束程序樹，設定 `windowsHide`，直接啟動原生 `codex.exe`，避開 shell 和路徑空格問題。
  - 子程序輸出按流解碼。
- 驗收：
  - 完成 10 個任務後，沒有殘留的 claude CLI 程序。
  - Ctrl+C 之後沒有孤兒程序（Windows 上按程序樹檢查）。
  - 孫程序佔著管道時，超時後仍能在寬限期內結束 run。
  - 用固定位元組序列測試：含中文和跨塊多位元組字元的輸出解碼正確。
  - `ACC_CODEX_BIN` 含空格時能正常啟動。

**P1-6 審批完整性**（M-16、M-18、M-19；M）
- 驗收：
  - 被撤回的審批自動消失（`serverRequest/resolved` 和 Claude signal abort 各一個用例）。
  - 選擇“拒絕即停”時，agent 的當前輪次被中斷，之後不再產生工具事件。
  - 重啟後，長的 Write 呼叫按完整輸入的雜湊匹配，不會被要求再審批一次。
  - Codex 檔案改動的審批附帶 diff，超出上限時帶截斷標記。

**P1-7 用量與成本**（M-17；M）
- 做什麼：
  - 統一 token 口徑：Codex 取本輪 total 的差值；Claude 的 input 包含 cache_read 和 cache_creation。
  - `maxCostUsd` 只對上報 USD 的 provider（Claude）生效，並把剩餘額度傳給 `maxBudgetUsd`；Claude 成本取累計值的差值。
  - Codex 顯示 token 和套餐額度百分比（`account/rateLimits`）；USD 只在有估算時顯示，並標明來源。
  - 扇出之前一次性預留呼叫額度；預算快用完時發收尾指令。
  - 可選的全域性每日花費上限。
  - 如果引入價格表，作為配置檔案維護，並註明來源和更新日期。
- 驗收：
  - 同一任務裡，兩家的 token 各自與 provider 上報的累計值一致（Claude 對 modelUsage，Codex 對 thread total）。
  - Claude 超出美元預算時被攔截。
  - 額度只夠一次呼叫時，Ask Both 整體被拒絕，不會只派發一半。
  - 使用訂閱認證時，介面顯示額度百分比，而不是 0 美元。

**P1-8 迴圈檢測與多 agent 迴圈安全**（第 5 節 D 組、3.6 節；M）
- 做什麼：
  - doom_loop：同一 agent、同一工具、同一輸入連續 3 次時詢問操作員。
  - 語義卡死檢測：採用 OpenHands 已實現的 4 種模式，閾值以它的預設值 4/3/3/6 為起點，可以配置。
  - 停滯計數遞減；超限先自動恢復一次，再轉人工閘門。
  - A↔B 來回往返檢測（從 P2-5 提前到這裡）。
  - 所有策略下都設交接鏈深度和次數上限。
  - 限流等待（`rate_limit_event`）不計入停滯。
  - 工具完成不再無條件算作有進展。
- 驗收（每條都有迴歸測試）：
  - 同一個失敗命令重複 3 次時，詢問操作員。
  - “忙碌迴圈”（反覆執行同一個失敗命令，並得到相同輸出）在第 4 次時被識別。
  - A→B→A→B 交替時，自動轉人工。
  - 交接鏈超過上限時被拒絕，並記錄原因。
  - 限流等待期間不觸發 `budget.stalled`。

**P1-9 效能**（M-11、M-22、M-23、L-13；M）
- 驗收：
  - 在有 1 萬個事件的庫上，`/api/usage` 和詳情重新整理單次都低於 50ms（記錄測試機環境）；服務端沒有 event loop blocked 告警。
  - 增量介面 `?after=N` 只返回新事件。
  - 流式輸出期間，只有對應的 Pane 重渲染；其他 Pane 和 TaskList 的渲染次數不隨 delta 數量增長（用渲染計數或 React Profiler 斷言）。

**P1-10 介面狀態正確性**（M-7、M-24、M-25、M-27、M-28、L-14～L-20；M～L）
- 做什麼：
  - 快照正式記錄 blocker、nextAction、activeAgents。
  - 審批狀態由事件推導；TaskDetail 加 key；重連時清理流式緩衝。
  - 流式訊息帶 messageId 和 streamSeq；Claude 的 `session_state_changed` 作為已證實的狀態。
  - WS 支援按序號續傳。
  - 後台提醒和跨任務審批收件箱；單 agent 單輪中斷。
  - 事件中心區分當前與歷史；對話檢視顯示迷你預算條；加 ErrorBoundary。
- 驗收：
  - TEST_PLAN 的 4 項 UI 測試，以及上述場景的單測，全部通過。
  - Playwright 冒煙測試覆蓋審批、流式和重連。
  - 因預算阻塞時，橫幅顯示的是預算原因，而不是歷史斷連錯誤。
  - 斷線重連後，沒有殘留的半截氣泡。

**P1-11 工程品質閘門**（M-30～M-34、L-11、L-23、L-28、L-29、L-30；M～L）
- 做什麼：
  - CI（Windows 和 Ubuntu × Node 24）。
  - typescript-eslint 開啟 `no-floating-promises` 等規則。
  - 共享 adapter 合約測試；完整的非同步測試替身；HTTP 層 inject 測試；前端測試。
  - `generate-ts` 漂移檢查；前端型別改用 `import type`；git 測試隔離全域性配置。
  - 建立安全迴歸測試集。
  - Windows 臨時目錄清理加重試，應對 EBUSY。
- 驗收：
  - CI 通過才能合併；lint 零告警。
  - 合約測試在 Claude、Codex、測試執行器、Mock 四種實現上都跑。
  - 測試替身在同步、微任務、延遲三種模式下，測試都通過。
  - 協議子集與生成的型別不一致時，`check:codex-protocol` 失敗。
  - H-1、H-12、H-13、H-15、M-13、M-15 各有一個安全迴歸用例。

**P1-12 資料保留與永續性**（L-6、L-7；M）
- 做什麼：
  - 使用 `synchronous=FULL`，寫快照前先回讀校驗。
  - 制定保留策略，保留天數作為配置項，預設值在實現時確定並寫進文件。
  - 提供“放棄/歸檔”操作：BLOCKED 轉為 FAILED，recover 不再處理。
  - 提供任務刪除和匯出 API。
  - 把 `journal_size_limit` 設為配置值，並定期 checkpoint。
  - 遷移前用 `VACUUM INTO` 備份，ROLLBACK 時保留原始錯誤。
  - 日誌按大小輪轉。
- 驗收：
  - 歸檔後的任務在重啟後不再被 recover。
  - 刪除 API 清除該任務的事件、快照、審批和用量記錄。
  - 匯出結果為 JSONL。
  - `PRAGMA journal_size_limit` 讀回的值等於配置值。
  - 遷移失敗時丟擲原始錯誤，並且備份檔案存在。

**P1-13 文件同步**（L-24；S～M）
- 做什麼：
  - 以 TASKS.md 作為唯一狀態來源；狀態遷移表從程式碼生成；ADOPTION_MATRIX 增加實現狀態列。
  - 新增威脅模型文件，寫清信任邊界：瀏覽器、本機其他程序、被管控的 agent、倉庫內容、第三方 ACP agent。
  - 新增面向終端使用者的使用說明。
- 驗收：
  - 狀態遷移表與程式碼一致，並由測試守護。
  - 威脅模型為每條邊界列出控制措施和對應的路線圖項。
  - 使用說明覆蓋 mock/real 切換、登入檢查、Codex Windows 沙箱配置。

**P1-14 恢復與版本健壯性**（S～M）
- 做什麼：
  - 恢復次數設上限，超過後 fail closed，報 `RECOVERY_ATTEMPTS_EXCEEDED`。
  - 快照記錄建立時的應用版本；版本不相容的在途 run 不自動續跑。
  - 同一 (run, agent) 的併發 resume 共享一次嘗試；準備階段取消則不啟動。
  - 記錄並校驗上游版本範圍（Claude SDK、Codex CLI）。
- 驗收：
  - 每次續跑都會讓程序崩潰的 run，在第 N 次後進入 BLOCKED。
  - 舊版本建立的在途 run，升級後顯示“由 vX 建立”，並等待操作員處理。
  - 兩個併發 resume 只啟動一次執行時。
  - Codex 版本不在測試過的範圍內時，啟動時發一條 runtime.warning。

**P1-15 介面體驗與可訪問性**（M-26、M-29、L-22；M）
- 做什麼：
  - Markdown 和程式碼塊渲染（配合 rehype-sanitize）。
  - 網格改用 auto-fit；窄屏改為標籤頁；整體改用 flex 佈局。
  - “換人接手”改成選單按鈕加確認。
  - 用 aria-live 播報完整回覆和新審批。
  - 評審/診斷標籤按實際的 agent 名稱生成。
- 驗收：
  - 1200px 寬時，每個窗格不窄於約 360px，否則切換為標籤頁；800px 以下仍能導航到用量頁。
  - 用鍵盤方向鍵不會誤觸換人。
  - 有 aria-live 區域的元件測試。

**P1-16 上手與運維**（L-25、L-26、L-27；S～M）
- 做什麼：
  - 修復 doctor；first-run 檢查每一步的退出碼；宣告 engines。
  - 載入 `.env`，並用 zod 校驗；`npm start` 不再依賴開發依賴。
  - 啟動時檢查：claude/codex 是否已登入；Codex Windows 沙箱是否需要配置（只對 elevated/unelevated 實現提示，MXC 實現下就緒狀態恆為 ready）；gemini 版本。
  - 在介面和 README 裡讓真實模式可以顯式切換。
  - Vite 代理埠改為讀配置；新增 `dev:real` 腳本；新增 `dump-run` 除錯命令。
- 驗收：
  - Windows 上 doctor 不再誤報。
  - 環境變數非法時啟動失敗，並指出是哪個變數。
  - 未登入時，介面顯示對應 agent 未就緒及原因。
  - `npm ci --omit=dev && npm run start:real` 能啟動。

**P1-17 核心去 provider 化**（L-33；S～M；P2-1 的前置）
- 做什麼：預設實現者、評審者、Ask Both 主 agent 改為按 capabilities 或角色配置來選擇；介面文案不寫死 provider 名稱。
- 驗收：
  - 只註冊兩個 Mock 實例（ID 不是 claude/codex）的配置下，工作流、Ask Both 和交接都能跑通。
  - 核心程式碼裡不再出現 `'claude'`、`'codex'` 字面量，由測試或 lint 規則守護。

### P2：中期（2～4 個月）

| 編號 | 事項 | 驗收標準 |
|---|---|---|
| P2-1 | ACP 通用適配層：優先用 session/resume；回放期間的更新標記為 replayed；啟動前探測版本和引數（依賴 P1-11、P1-17） | Gemini CLI（≥0.60）和 OpenCode 透過共享 adapter 合約測試；啟動前探測到的引數正確（`--acp` 不可用時回退到 `--experimental-acp`）；回放期間的更新不進事件日誌和副作用台賬（測試斷言）；透過 npx 分發的 agent 固定版本號；審批、取消、恢復都能端到端跑通 |
| P2-2 | OTel 追蹤：`eventsToSpans` 純投影、可選的 OTLP 匯出、Claude 的 TRACEPARENT 拼接 | 同一個 run 從 SQLite 重建兩次，得到相同的 trace ID；在 Phoenix 裡能看到 workflow、agent、tool、審批等待的層級；預設不匯出內容 |
| P2-3 | 檢查點與回滾：先做按輪提交和“撤銷上一輪”，再做隱藏 ref 步驟快照和 Claude `rewindFiles`，最後支援從某一步分叉（與 P2-4 一起設計） | 每一輪都能對比和撤銷；撤銷是追加事件，而不是刪除事件；從第 N 步分叉會新建一個 run，原 run 不變 |
| P2-4 | worktree 生命週期：移到倉庫之外、setup 腳本、junction、diff 審查、合入閘門（merge/apply）、對賬回收、`acc/*` 分支清理、任務依賴 | 新 worktree 裡測試一次通過，不因缺依賴失敗；合入前能看到命令預覽和衝突預檢；不再積累孤兒 worktree 和分支；Windows 上檔案被佔用導致刪除失敗時，給出原因並可以重試 |
| P2-5 | 協作語義升級：區分 consult/transfer、handoff-policy 鉤子管線、交接邊白名單、結構化完成契約、Codex dynamicTools | 在固定的評審迴歸集上，能拿到結構化結論時 UNKNOWN 為 0，只有回退到文字解析時才允許出現 UNKNOWN；交接策略有表驅動測試；Codex 經 dynamicTools 發起的交接，confidence 為 confirmed |
| P2-6 | 統一中斷與 elicitation（Codex `requestUserInput`、Claude `onElicitation`、ACP） | agent 提出的問題在對話裡顯示為表單，回答後任務繼續；任務狀態為 WAITING_INPUT，並附原因 |
| P2-7 | 策略引擎：持久化的審批規則表、連續自動批准計數器、確定性風險分析器、無人值守模式、自主度預設 | 規則可以在介面上檢視和撤銷；由策略自動放行的動作，在每次人工確認後計數清零 |
| P2-8 | 執行隔離：測試執行器放進 srt（原生 Windows 上只能做會話級配置）、Codex Windows 沙箱就緒檢查（非 MXC 實現）、任務級執行策略物件（出網域名、可寫根目錄） | 測試程序無法訪問白名單之外的域名，也不能寫 worktree 之外的檔案；Windows 上 srt 不可用時，明確降級為“環境變數白名單 + 超時”，並提示隔離級別；Codex 沙箱沒配置時，介面給出提示和配置按鈕 |
| P2-9 | 脫敏入口，加上合入前的金鑰掃描 | 構造的 `sk-ant-…`、`AKIA…` 在 SQLite、WS、日誌裡都顯示為 `[REDACTED:…]`；diff 中含金鑰時禁止合入 |
| P2-10 | 快照有界化、副作用台賬獨立成表、歸檔策略（L-5） | 連續 6000 次工具呼叫後，單事件耗時仍低於 10ms |
| P2-11 | 工作流定義資料化（WorkflowDefinition），可選 best-of-N 或 Multi-Version；評估計劃籤核步驟 | implementation-v1 改由資料定義，行為不變；可以並行跑兩個實現，並按確定性規則或由人選出一個 |

---

## 8. 不建議做的事

| 不建議 | 理由 |
|---|---|
| 把 Temporal、Restate、DBOS、Inngest、LangGraph、MAF 引入為執行時依賴 | 這些方案要麼需要獨立服務或 Postgres，要麼要求框架掌控整個 agent 迴圈。ACC 的 agent 迴圈在 Claude/Codex 程序裡，框架無法回放。只借鑑它們的語義即可：outbox、租約、審批只消費一次、版本戳 |
| 改成經 claude-agent-acp 或 codex-acp 接入 Claude/Codex | 多一跳程序，還會丟掉程序內 MCP、`canUseTool` 的權限更新、`turn/steer`、execpolicy 修訂、檔案檢查點等原生能力。建議混合方案：Claude/Codex 繼續直連，ACP 只用來接其他 agent |
| 用 LLM 做路由、用 LLM 判定審批風險，或者採信模型自己報告的風險和 `requires_approval` | 違背“確定性規則優先、結構化訊號優先”的原則。反面案例：OpenHands #4157（以 not planned 關閉）、Cline 的 safe command 由模型判定、goose 的 smart_approve、CrewAI 的 hierarchical 管理者和 `@human_feedback` |
| 用終端抓屏或字串匹配來判斷 agent 狀態，或引入 tmux、PTY 依賴 | Claude Squad 這類做法很脆弱，coder 的 agentapi 也已歸檔；tmux 不能在原生 Windows 上執行，而原生支援 Windows 正是 ACC 的隱性優勢 |
| 把 ACC 暴露為 A2A 服務 | A2A 面向遠端、不透明的 agent，會把工具級審批和檔案副作用隱藏起來。V1 本地單使用者用不上，記為暫緩或拒絕 |
| 做線上 OTel SDK 插樁，或引入 OpenLLMetry 自動插樁、AgentOps SDK | 程序崩潰會丟掉還沒結束的 span；ACC 程序裡本來就沒有直接的 LLM 呼叫。應該從事件日誌離線投影生成 span |
| 內建 Langfuse v4，或用 Helicone 這類閘道器式代理採整合本 | Langfuse 自託管需要 6 個元件，太重；Helicone 已進入維護模式，而且改 `ANTHROPIC_BASE_URL` 會影響認證路徑和 traceparent 傳遞。只把它們作為可選的 OTLP 匯出目標 |
| V1 引入雲端 microVM（E2B、Daytona）或 gVisor | 原始碼會離開本機，而且需要 Linux 核心，與“本地優先、Windows 原生”衝突。只在路線圖裡登記為將來“不可信倉庫模式”的候選 |
| 依賴已停運或低活躍專案的執行時 | vibe-kanban（社群維護）、Roo（已歸檔）、Crystal（已棄用）、Plandex（已停滯）、Aider（低活躍）、Helicone（維護模式）都只借鑑設計 |
| 複製 AGPL 或 ELv2 許可的程式碼 | Claude Squad、opcode、Kandev 是 AGPL-3.0，Phoenix 是 ELv2，只能參考思路 |
| 未經實測就設定 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` | 已知它會把權限模式強制改回 default（issue #51258），可能破壞唯讀步驟的保證。環境變數隔離先靠顯式白名單實現 |
| 在原生 Windows 上開啟 Claude 的 `sandbox.enabled` | 官方不支援原生 Windows；而經 SDK 開啟時 `failIfUnavailable` 預設為 true，query 會直接失敗。應改為提示使用者當前只有審批門控這一層隔離 |
| 在 Windows 上用 srt 按命令傳入檔案系統配置 | 原生 Windows 上會直接拋錯，只能在 `initialize()` 裡做會話級配置 |
| 遇到巢狀 `.git` 時靠改名規避 | Cline #9590 出現過 `.git` 被永久改成 `.git_disabled`；Roo 的禁用方案也出現過任務內容丟失。檢測到巢狀倉庫時，應禁用相關功能並提示使用者 |
| 追求 Gas Town 式的“AI 排程大量併發終端” | 這個品類已經高度同質化。ACC 的差異化在於可恢復、可審計、確定性的跨 agent 協作，精力應該放在這裡 |
| 採用 MCP Tasks 擴充套件或 Sampling | Sampling 已棄用；長任務語義已經由 run 和 workflow 承擔 |

---

*依據說明：問題清單來自對抗式核實後的審查結果。高危問題大多用探針腳本實測復現，這些腳本已歸檔到 `docs/analysis-probes/`（原樣保留，依賴分析時的臨時資料庫路徑，不能直接執行），路線圖 P0-0 要求把它們改寫成 `tests/` 下的迴歸測試。標註“程式碼已核”的條目，是在 `c30c7a2` 上重新讀過程式碼確認的，沒有執行復現。開源對照只採用事實核查確認準確的內容，或已按核查意見更正的內容，例如：ACP 登錄檔有 41 個 agent；CCManager 使用 Bun 內建 PTY；Gas Town 倉庫已遷移；OpenCode 的 prune 預設關閉；Gemini 需要升級到 0.60 以上才支援 `--acp`；OpenHands StuckDetector 實際實現了 4 種模式；遞減式停滯計數最早見於 AutoGen；MAF 的 10/3/2 只是文件示例；Codex 的 MXC 實現下就緒狀態恆為 ready。3.5 節和 3.6 節中標為“輸入線索”或“推斷”的條目尚未核實，只作為排查方向。*