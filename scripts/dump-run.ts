import { resolveControlPlanePaths } from '@acc/server';
import { SqliteControlPlaneStore } from '@acc/storage';
import { formatEvent } from '../apps/server/src/event-log.js';

/**
 * 除錯命令（P1-16，參考 absurdctl dump-task）：快速檢視一個卡住的任務。
 *
 *   npm run dump-run                 列出最近的任務（狀態、當前步驟、阻塞原因）
 *   npm run dump-run -- <任務 ID 前綴>  列印這個任務的快照要點和最近 40 條事件
 *   npm run dump-run -- <前綴> --all    列印全部事件
 *
 * 不修改任何任務資料，服務正在執行時也可以用（SQLite WAL 允許同時讀）。資料庫位置與服務端一致（ACC_DATA_DIR / ACC_DB_PATH 可以覆蓋）。
 * 注意：資料庫還是舊版本結構時，開啟它會先按正常流程升級（升級前自動備份），和服務啟動時一樣。
 */

const args = process.argv.slice(2);
const all = args.includes('--all');
const prefix = args.find((a) => !a.startsWith('--'));
const paths = resolveControlPlanePaths({ env: process.env, platform: process.platform, cwd: process.cwd() });
const store = new SqliteControlPlaneStore({ path: paths.dbPath });

try {
  const tasks = await store.listTasks();
  if (!prefix) {
    console.log(`資料庫：${paths.dbPath}\n最近的任務：`);
    for (const task of tasks.slice(0, 20)) {
      const loaded = await store.loadRun(task.runId);
      const run = loaded?.status === 'ok' ? loaded.snapshot : undefined;
      const blocked = run?.blockedBy ? `  阻塞：${run.blockedBy.source}/${run.blockedBy.code}` : '';
      console.log(`  ${task.id.slice(0, 8)}  ${String(run?.status ?? task.status).padEnd(16)} ${run?.currentStep ?? ''}  ${task.title.slice(0, 40)}${blocked}`);
    }
    console.log('\n檢視某個任務：npm run dump-run -- <任務 ID 前綴>');
  } else {
    const task = tasks.find((t) => t.id.startsWith(prefix));
    if (!task) {
      console.error(`找不到 ID 以 ${prefix} 開頭的任務`);
      process.exitCode = 1;
    } else {
      const loaded = await store.loadRun(task.runId);
      console.log(`任務 ${task.id}  「${task.title}」`);
      if (loaded?.status !== 'ok') {
        console.log(`快照無法讀取：${loaded?.status ?? '不存在'}`);
      } else {
        const run = loaded.snapshot;
        console.log(`狀態 ${run.status}  步驟 ${run.currentStep}  當前 agent ${run.currentAgentId ?? '-'}`);
        if (run.blockedBy) console.log(`阻塞原因 ${JSON.stringify(run.blockedBy)}`);
        if (run.workflowState) console.log(`工作流 step=${run.workflowState.step} stepSeq=${run.workflowState.stepSeq} 等待 ${run.workflowState.awaitingAgentId ?? '-'}`);
        console.log(`會話 ${Object.values(run.agentSessions).map((s) => `${s.agentId}:${s.status}`).join('  ') || '-'}`);
        console.log(`待審批 ${run.pendingApprovals.filter((a) => a.status === 'pending').map((a) => `${a.agentId}:${a.summary ?? a.id}`).join('  ') || '-'}`);
        console.log(`預算 輪次 ${run.budget.turnsUsed}/${run.budget.maxTurns}  呼叫 ${run.budget.agentCallsUsed}/${run.budget.maxAgentCalls}  正在工作 ${(run.budget.workingAgentIds ?? []).join(',') || '-'}`);
        if (run.recovery) console.log(`恢復 ${run.recovery.count} 次（連續 ${run.recovery.streak ?? 0} 次沒有做完一輪）`);
      }
      const events = await store.listEvents(task.runId);
      const shown = all ? events : events.slice(-40);
      console.log(`\n事件（共 ${events.length} 條，${all ? '全部' : '最近 40 條'}）：`);
      for (const event of shown) console.log(formatEvent(event));
    }
  }
} finally {
  store.close();
}
