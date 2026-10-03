# 分析探針腳本（歸檔）

這些腳本是 `docs/ANALYSIS_REPORT.md` 裡標“實測”的問題所用的復現探針，按分析時的原樣儲存（基於 commit `c30c7a2`）。

- 它們引用的是分析時的臨時資料庫和絕對路徑，**不能直接執行**，只作為證據和改寫參考。
- 不在 typecheck / vitest 範圍內。
- 路線圖 P0-0：把報告第 3.2 節引用的每個場景（probe、probe2～probe9 及其場景編號）改寫成 `tests/regression/` 下的 vitest 用例，然後才能刪除這裡的腳本。

## 改寫狀態（P0 修復系列 `f8fba78`～`f3901cf` 之後）

結論：**報告第 3.2 節引用的探針場景都已有對應的迴歸測試**，另外場景 10、11 也已覆蓋。修復和測試是同一批提交進來的，
所以用例直接寫成正常斷言（沒有用 `it.fails`），每個測試檔案開頭的註釋寫明瞭修復前怎麼復現。
還有幾條歸屬 P1 的場景沒有專門用例（見下面第二張表），所以**這裡的腳本繼續保留**，等 P1 補齊後再刪。

報告裡的 “probe 場景 N” 是分析時一組探針的場景編號，歸檔時分散在下面幾個腳本里；“主要相關腳本”一列只是改寫參考，以測試為準。
測試檔案都在 `tests/regression/` 下。

### 已有迴歸測試

| 報告引用 | 問題 | 主要相關腳本 | 迴歸測試 |
|---|---|---|---|
| probe7 | H-2：同一輪並行兩次 `request_handoff`，程序以 exit 1 退出 | `probe7.mjs`、`probe7seq.mjs`、`probe-handoff.mts`、`probe-seq.mts` | `reaction-queue.test.ts`（“probe7 迴歸”） |
| H-2 同類 | 測試執行器 `void run()` 的未處理拒絕 | `repro.mjs` | `adapter-emit-safety.test.ts`、`process-guard.test.ts` |
| H-14 | codex stdin 寫入 EOF 讓程序崩潰 | `epipe-probe*.mjs`、`probeA.mjs`、`probeA2.mjs`、`probeC.mjs`、`probeD.mjs`、`probeW.mjs`、`probe.js`、`probe2.js`、`probe3.js`、`verify-stdin.mts` | `codex-transport.test.ts` |
| H-3 | 兩個實例共用一個庫，序號衝突 | `repro-two-instances.mts`、`verify.mts` S3 | `single-instance.test.ts` |
| H-1、L-10 | 外域 WS 旁聽、Host 任意、跨站無 body `POST /cancel` | `cswsh.mjs`、`ws-probe.mjs`、`wstest.mjs`、`wstest.cjs`、`probe.mjs` | `access-control.test.ts` |
| probe 場景 4 | H-5：Ask Both 後取消只停一個 agent | `repro.mts` 場景 A / C、`probe-verify.mjs` 場景 1 / 3 | `multi-session-stop.test.ts` |
| probe3 場景 B | H-5：Ask Both 時重啟，只續接 currentAgentId | `probe3.mjs` B、`repro.mts` 場景 B、`probe-verify.mjs` 場景 2、`probe-refute.mts` | `multi-session-stop.test.ts`、`recovery-handoff-approval.test.ts` |
| H-5（執行序列 `['A','C','B']`） | 已取消任務上批准遺留審批，工具照樣執行 | `verify.mts` S2 | `dispatch-guard.test.ts`、`approval-blocked-by.test.ts`（終態作廢待審批） |
| probe 場景 3 | H-6：agent 啟動期間取消，會話隨後被登記為線上 | `refute-dispatch.mts` 場景 A、`probe.mts` | `dispatch-guard.test.ts`（“probe 場景 3”）、`codex-cancel-inflight.test.ts` |
| probe3 場景 D | H-6：取消後批准舊審批，agent 被重新拉起 | `probe3.mjs` D、`refute-dispatch.mts` 場景 B、`probe.mts` B | `dispatch-guard.test.ts`（“probe3 場景 D”） |
| H-6 同類 | BLOCKED 狀態下給已有會話發訊息照常派發 | `refute-dispatch.mts` 場景 C | `budget-semantics.test.ts`（“向 BLOCKED 任務發訊息”）、`blocked-hold.test.ts` |
| probe8 | H-7：評審閘門停留 31 分鐘後 accept 永遠完成不了 | `probe8.mjs`、`probeA.mts` | `budget-semantics.test.ts`（“probe8”） |
| probe2 | H-7：停滯阻塞後 gate retry，完成訊號被丟棄 | `probe2.mjs` | `budget-semantics.test.ts`（“probe2”） |
| H-8 | 對話任務沿用實現型任務的預算 | `repro-budget.mjs`、`probeB.mts`、`probeA.mts` scenarioManual | `budget-semantics.test.ts`（H-8 一組）、`budget-working-agents.test.ts` |
| probe 場景 1 | H-9：交接審批期間完成訊號被丟棄 | `probe2.mts` | `handoff-signal.test.ts`（“probe 場景 1”） |
| probe5 | H-10：Claude 以錯誤 result 結束時不發終態 | `probe5.mjs`、`repro-error-result.mjs` | `claude-no-hang.test.ts`（“probe5”）、`adapter-terminal-contract.test.ts`、`step-watchdog.test.ts` |
| probe 場景 6 | H-11：Codex app-server 崩潰後重試發往已關閉的會話 | `probe-codex.mts` | `codex-no-hang.test.ts`（“probe 場景 6”） |
| probe4 | H-11：Claude CLI 崩潰後 “continue” 塞進已結束的 query | `probe4.mjs`、`probe-claude.mts`、`probe-claude-crash.mts`、`probe-claude-retry.mts` | `claude-no-hang.test.ts`（“probe4”） |
| H-12 | 同一交接審批併發提交兩次，交接投遞兩次 | `race.mts`、`race2.mts` | `approval-once.test.ts` |
| probe 場景 10 | M-5：審批把 fail-closed 的 BLOCKED 改回 RUNNING | `refute-approval.ts` | `approval-blocked-by.test.ts`（“probe 場景 10”）、`blocked-hold.test.ts` |
| probe 場景 11 | L-1：adapter 直接發 `run.status COMPLETED` 等編排器專屬事件 | — | `adapter-sink-guard.test.ts`（“probe 場景 11”） |
| probe3 場景 A | M-2：評審閘門期間給沒有會話的 agent 發訊息，閘門失效（報告原排在 P1-4，已隨 P0-5 第二批修復） | `probe3.mjs` A | `review-gate-guard.test.ts` |
| M-8 同類 | 工作流已決定下一步、還沒派發就崩潰（P1-1 之前的緩解） | `verify.mts` S4 | `recovery-workflow-step.test.ts` |

### 還沒有專門的迴歸測試（歸屬 P1 或未核實線索）

| 報告引用 | 問題 | 主要相關腳本 | 現狀 |
|---|---|---|---|
| probe3 場景 C | M-2：等待審批時給新 agent 發訊息，run 變 RUNNING 但仍有待審批 | `probe3.mjs` C | 程式碼已由同一處守衛修復（只有任務首次啟動才遷到 RUNNING），暫無 `WAITING_APPROVAL` 的專門用例，隨 P1-4 補 |
| probe 場景 8 | M-1：插話後第一輪的 completed 把流程推進到測試 | — | P1-3；緩解見 `workflow-stale-completion.test.ts` |
| probe 場景 9 | M-3：換人接手後新實現者仍在唯讀沙箱裡 | — | P1-4；過渡處理（`READ_ONLY_TAKEOVER` 說明）見 `ask-both-advisor-rounds.test.ts` |
| probe9 | M-4：對話任務在同一目錄無限併發寫；L-3：重啟後對終態任務 `setHandoffPolicy` 撞 UNIQUE | `probe9.mjs`、`verify.mts` S1 | M-4 → P1-4；L-3 現在由終態守衛返回 409 `TASK_TERMINAL`（不再 500），序號分配 → P1-1，均無專門用例 |
| probe6 | 3.5 節未核實線索：帶 code 的系統錯誤不重試、引用的 `VERDICT:` 改變評審結論 | `probe6.mjs` | 不屬於 P0，未改寫 |
| L-8 | 孫程序佔著管道時超時 kill 無效 | `grandchild-probe.mjs`、`probe.cjs` | P1-5 |
| L-5、M-11 | 快照整份重寫、`/api/usage` 全量掃描的耗時 | `bench.cjs`、`bench.mts` | P2-10、P1-9 |

各項修復的狀態和驗收證據見 `TASKS.md` 的「P4 — Hardening / P4 加固」一節。
