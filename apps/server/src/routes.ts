import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { BUDGET_LIMITS, BUDGET_LIMIT_RANGES, DEFAULT_MAX_CONSECUTIVE_AUTO_APPROVALS, buildContinuationPrompt, eventsToSpans, ruleFromApproval, spansToOtlp, summarizeTask, summarizeUsage } from '@acc/core';
import type { AgentInfo, ControlPlaneStore, Orchestrator, RecoveryReport, TaskRecord } from '@acc/core';
import type { FilePolicyStore } from './policy-store.js';
import { MergeError, cleanupTaskWorktree, createTaskWorktree, forkWorktreeFromCheckpoint, isGitRepository, mergeTaskWorktree, previewWorktreeMerge, removeTaskWorktree, setupTaskWorktree } from '@acc/adapters';

/**
 * REST / WebSocket 路由（從入口檔案中拆出，便於 startServer 複用和 app.inject 測試）。
 * 路由只做引數校驗和轉發；跨 agent 的決策全部由編排器負責。
 */
export interface RouteContext {
  store: ControlPlaneStore;
  orchestrator: Orchestrator;
  runtimeMode: string;
  storeMode: string;
  workspace: string;
  /** 啟動恢復報告：恢復完成之前為 undefined。 */
  recovery: () => RecoveryReport | undefined;
  /** WebSocket 連線集合（廣播用）。 */
  sockets: Set<{ send(data: string): void; readyState: number; close(code?: number, reason?: string): void }>;
  /**
   * 任務工作目錄的校驗（絕對路徑、已存在的目錄、不能與控制面資料互相包含、ACC_ALLOWED_ROOTS 等）。
   * 返回錯誤說明表示拒絕；返回 undefined 表示通過。
   */
  validateTaskCwd?: (cwd: string) => string | undefined;
  /** 同時線上的 WebSocket 連線上限（預設不限制）。 */
  maxWsConnections?: number;
  /** 審批策略（P2-7）：沒有時相關介面返回 404。 */
  policy?: FilePolicyStore;
  /** 連續自動放行上限（P2-7，給介面顯示）。 */
  maxConsecutiveAutoApprovals?: number;
}

const CreateTaskSchema = z.object({
  projectId: z.string().optional(),
  /** 可省略：預設取訊息的第一行。 */
  title: z.string().optional(),
  prompt: z.string().min(1),
  agentId: z.string().optional(),
  workflow: z.enum(['implementation-v1', 'manual']).optional(),
  testCommand: z.string().max(2000).optional(),
  reviewGate: z.boolean().optional(),
  cwd: z.string().optional(),
  /** 為該任務在 cwd（預設工作區）所在倉庫建立獨立 git worktree。 */
  worktree: z.boolean().optional(),
  sharedWorkspace: z.boolean().optional(),
  /** agent 主動請求交接的策略：ask（每次問我）/ auto（自動，有次數上限） */
  handoffPolicy: z.enum(['ask', 'auto']).optional(),
  /** 第一條訊息同時發給 Claude 和 Codex（主 agent 可寫，其餘唯讀給意見） */
  askBoth: z.boolean().optional(),
  /** 步驟不活動看門狗的閾值（毫秒，最長 24 小時）；預設用服務端預設值（ACC_STEP_INACTIVITY_MS），0 表示關閉 */
  inactivityTimeoutMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
});

/**
 * resume（P0-7）：對話任務已阻塞時，先恢復任務（因預算阻塞的先放寬預算）再傳送——介面上是使用者確認後的「恢復並傳送」。
 * 不帶它時，向已阻塞的對話任務發訊息得到 409 TASK_BLOCKED（說明原因和出路），什麼都不會發給 agent。
 */
const MessageSchema = z.object({
  agentId: z.string().min(1),
  message: z.string().min(1),
  resume: z.boolean().optional(),
});

const HandoffSchema = z.object({
  fromAgentId: z.string().min(1),
  toAgentId: z.string().min(1),
  content: z.string().min(1).max(32_000),
  instruction: z.string().max(4000).optional(),
  resume: z.boolean().optional(),
});

const AskBothSchema = z.object({
  message: z.string().min(1),
  primaryAgentId: z.string().optional(),
  resume: z.boolean().optional(),
});

/** 一項限額：範圍內的整數（範圍與編排器的校驗共用 BUDGET_LIMIT_RANGES）。 */
const limitField = (limit: keyof typeof BUDGET_LIMIT_RANGES) => z.number().int().min(BUDGET_LIMIT_RANGES[limit].min).max(BUDGET_LIMIT_RANGES[limit].max).optional();

/**
 * 預算調整（P0-7）：設定新的限額，或者 relax（開一個新的計數視窗，再給一份同樣的額度）。
 * resume（預設 true）：因預算阻塞的任務在調整後不再超限時恢復。未知欄位、超出範圍、非整數都是 400。
 */
const BudgetSchema = z
  .strictObject({
    maxTurns: limitField('maxTurns'),
    maxAgentCalls: limitField('maxAgentCalls'),
    maxReviewRounds: limitField('maxReviewRounds'),
    maxStallCount: limitField('maxStallCount'),
    maxDurationMs: limitField('maxDurationMs'),
    maxEstimatedTokens: limitField('maxEstimatedTokens'),
    // 美元上限可以是小數（例如 2.5）
    maxCostUsd: z.number().min(BUDGET_LIMIT_RANGES.maxCostUsd.min).max(BUDGET_LIMIT_RANGES.maxCostUsd.max).optional(),
    relax: z.boolean().optional(),
    resume: z.boolean().optional(),
  })
  .refine((body) => body.relax === true || BUDGET_LIMITS.some((limit) => body[limit] !== undefined), {
    message: '請至少指定一項要調整的預算（例如 maxDurationMs），或者用 relax: true 放寬用完的那一項。',
  });

const ReassignSchema = z.object({
  toAgentId: z.string().min(1),
  note: z.string().max(8000).optional(),
});

const SettingsSchema = z.object({ handoffPolicy: z.enum(['ask', 'auto']) });

const ContinueSchema = z.object({
  agentId: z.string().min(1),
  message: z.string().min(1),
});

/** rerun：把阻塞的這一步交還給負責它的 agent 重做（例如診斷的 Codex 失敗後重新請它診斷）；沒有可以重跑的步驟時 409。 */
const GateSchema = z.object({
  action: z.enum(['accept', 'review', 'retry', 'rerun']),
  note: z.string().max(8000).optional(),
});

/** 確認測試配置的改動（H-15）：digest 是介面上顯示的那份差異的摘要，確認之前配置又變了會得到 409。 */
const TestConfigConfirmSchema = z.object({ digest: z.string().min(1).max(200) });

const ApprovalSchema = z.object({
  taskId: z.string().min(1).optional(),
  decision: z.enum(['approve', 'decline']),
  /** once（預設）或 session：本會話內同類操作不再詢問 */
  scope: z.enum(['once', 'session']).optional(),
  /**
   * 批准交接請求時對話任務已阻塞：先恢復任務再轉交（介面上是使用者確認後的「恢復並轉交」）。
   * 不帶它時得到 409 TASK_BLOCKED，審批保持待處理。
   */
  resume: z.boolean().optional(),
  /** 回答 AI 的問題（P2-6）：問題 ID → 答案 */
  answers: z.record(z.string().max(200), z.array(z.string().max(4000)).max(10)).optional(),
});

/** HTTP 層的請求錯誤（4xx），錯誤處理器按 statusCode 原樣返回。 */
class RequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const hasCapability = (agent: AgentInfo, capability: string) => agent.capabilities.includes(capability);

/** 按 id 找 agent；不存在時給出中文說明（列出可用的 agent）。 */
function findAgent(agents: AgentInfo[], agentId: string): AgentInfo | string {
  const agent = agents.find((item) => item.id === agentId);
  if (agent) return agent;
  const available = agents.filter((item) => item.kind !== 'test').map((item) => item.id);
  return `未知的 Agent「${agentId}」。可用的有：${available.join('、') || '（無）'}。`;
}

/** 能對話（直接對話、同時問兩個、換人接手、繼續對話）的 agent：不是測試執行器，且能實現或分析。 */
function chatAgentProblem(agents: AgentInfo[], agentId: string): string | undefined {
  const agent = findAgent(agents, agentId);
  if (typeof agent === 'string') return agent;
  if (agent.kind === 'test') return `「${agent.name}」是測試執行器，不能直接對話或寫程式，請選擇其他 Agent。`;
  if (!hasCapability(agent, 'implement') && !hasCapability(agent, 'analysis')) return `「${agent.name}」不具備對話所需的能力（implement 或 analysis）。`;
  return undefined;
}

/**
 * 建立任務時 agent 的能力校驗（L-12）：
 * - 對話任務（manual）：主 agent 能對話；
 * - 自動流程（implementation-v1）：主 agent 必須能實現（implement）；設定了測試命令時必須有測試執行器（test 能力）。
 */
function taskAgentProblem(agents: AgentInfo[], input: { agentId?: string; workflow?: string; testCommand?: string }): string | undefined {
  const agentId = input.agentId ?? 'claude';
  const chat = chatAgentProblem(agents, agentId);
  if (chat) return chat;
  if ((input.workflow ?? 'implementation-v1') !== 'implementation-v1') return undefined;
  const agent = agents.find((item) => item.id === agentId)!;
  if (!hasCapability(agent, 'implement')) {
    return `「${agent.name}」不具備實作能力（implement），不能負責自動流程；請改選其他 Agent，或關閉「自動流程」直接對話。`;
  }
  if (input.testCommand?.trim()) {
    const tester = agents.find((item) => item.id === 'test');
    if (!tester || !hasCapability(tester, 'test')) return '設定了測試命令，但沒有可用的測試執行器（需要 test 能力）。';
  }
  return undefined;
}

/** 沒填標題時，用訊息第一行生成標題。 */
function autoTitle(prompt: string): string {
  const line = prompt.split(/\r?\n/).find((x) => x.trim())?.trim() ?? '新對話';
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, orchestrator, runtimeMode, storeMode, workspace, sockets } = ctx;

  /** agent 必須已註冊，否則 400（而不是編排器丟擲後變成 500）。 */
  const requireAgent = (agentId: string) => {
    const agent = findAgent(orchestrator.listAgents(), agentId);
    if (typeof agent === 'string') throw new RequestError(400, agent);
  };
  /** agent 必須能對話（不是測試執行器）。 */
  const requireChatAgent = (agentId: string) => {
    const problem = chatAgentProblem(orchestrator.listAgents(), agentId);
    if (problem) throw new RequestError(400, problem);
  };

  // 業務錯誤統一返回 4xx，不暴露為 500
  app.setErrorHandler((error: Error & { statusCode?: number; code?: unknown }, _request, reply) => {
    const message = error.message ?? String(error);
    // 請求本身的問題（請求體不是合法 JSON、空的 JSON 請求體、請求體過大、引數錯誤等）：按原狀態碼返回，不算服務端故障
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      // 帶上結構化錯誤碼（例如 TASK_BLOCKED、BUDGET_EXHAUSTED、TASK_TERMINAL），介面據此給出對應的出路
      const code = typeof error.code === 'string' ? error.code : undefined;
      return reply.code(error.statusCode).send({ error: message, ...(code ? { code } : {}) });
    }
    const code = /not found/i.test(message)
      ? 404
      : /illegal task transition|terminal|pending approval|budget|not waiting|review round|requires an instruction|no workflow|ownership|workspace conflict|not a git repository|no commits yet|already assigned|cannot reassign|two different agents/i.test(message)
        ? 409
        : 500;
    if (code === 500) app.log.error(error);
    return reply.code(code).send({ error: message });
  });

  app.get('/health', async () => ({
    ok: true,
    runtimeMode,
    storeMode,
    instanceId: orchestrator.instanceId,
    /** 啟動恢復是否已完成（先監聽埠、再恢復：恢復期間為 false）。 */
    ready: ctx.recovery() !== undefined,
    recovery: ctx.recovery(),
    agents: orchestrator.listAgents(),
  }));

  app.get('/api/agents', async () => orchestrator.listAgents());

  app.get('/api/tasks', async () => store.listTasks());

  // 執行配置：UI 用來顯示執行模式、預設工作區、是否可建立 worktree
  app.get('/api/config', async () => ({
    runtimeMode,
    storeMode,
    workspace,
    workspaceIsGit: await isGitRepository(workspace),
    workspacePolicy: runtimeMode === 'real' ? 'exclusive' : 'shared',
    instanceId: orchestrator.instanceId,
    recovery: ctx.recovery(),
  }));

  // 任務摘要列表（含阻塞原因、待審批/待輸入數量、重啟恢復標記）
  app.get('/api/dashboard', async () => {
    const tasks = await store.listTasks();
    return Promise.all(
      tasks.map(async (task) => {
        const loaded = await store.loadRun(task.runId);
        return summarizeTask(task, loaded?.status === 'ok' ? loaded.snapshot : undefined, loaded?.status);
      }),
    );
  });

  // 用量彙總（呼叫次數、輪次、token、耗時、失敗、停滯、評審輪次）
  // 用量彙總按版本快取（P1-9 / M-11）：所有任務的事件序號都沒變時直接返回上次的結果，不再每次掃描全部事件
  let usageCache: { version: string; day: string; value: unknown } | undefined;
  app.get('/api/usage', async () => {
    const snapshots = [];
    for (const task of await store.listTasks()) {
      const loaded = await store.loadRun(task.runId);
      if (loaded?.status === 'ok') snapshots.push(loaded.snapshot);
    }
    const version = snapshots.map((s) => `${s.runId}:${s.lastSequence}`).join('|');
    const day = new Date().toDateString();
    if (usageCache && usageCache.version === version && usageCache.day === day) return usageCache.value;
    const items = [];
    for (const snapshot of snapshots) {
      items.push({ run: snapshot, usage: await store.listUsage(snapshot.runId), events: await store.listEvents(snapshot.runId) });
    }
    const value = summarizeUsage(items);
    usageCache = { version, day, value };
    return value;
  });

  app.get<{ Params: { taskId: string }; Querystring: { after?: string } }>('/api/tasks/:taskId', async (request, reply) => {
    const task = await store.getTask(request.params.taskId);
    if (!task) return reply.code(404).send({ error: 'Task not found' });
    const run = await store.loadRun(task.runId);
    // 增量重新整理（P1-9 / M-22）：?after=N 只返回序號大於 N 的事件，介面按 id 合併，不再每次重傳整份事件日誌
    const after = Number(request.query.after);
    const incremental = Number.isInteger(after) && after > 0;
    const [events, approvals, usage] = await Promise.all([
      store.listEvents(task.runId, incremental ? after : 0),
      store.listApprovals(task.runId),
      store.listUsage(task.runId),
    ]);
    // 快照不可讀時仍返回任務與事件，並顯式給出載入狀態
    return { task, run: run?.status === 'ok' ? run.snapshot : undefined, runLoadStatus: run?.status, events, approvals, usage, ...(incremental ? { incrementalAfter: after } : {}) };
  });

  app.post('/api/tasks', async (request, reply) => {
    const parsed = CreateTaskSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { worktree, ...rest } = parsed.data;
    const cwd = rest.cwd?.trim() || undefined;
    const input = { ...rest, cwd, title: rest.title?.trim() || autoTitle(rest.prompt) };
    // 所有校驗都在建立 worktree 之前完成：校驗失敗不留下任何目錄或分支（L-12）
    if (cwd !== undefined) {
      const cwdProblem = ctx.validateTaskCwd?.(cwd);
      if (cwdProblem) return reply.code(400).send({ error: cwdProblem });
      input.cwd = path.resolve(cwd);
    } else {
      // 不帶工作目錄的任務用預設工作區：同樣要通過校驗（例如預設工作區落在資料目錄之內時拒絕），與顯式傳同一目錄一致
      const workspaceProblem = ctx.validateTaskCwd?.(workspace);
      if (workspaceProblem) {
        return reply.code(400).send({ error: `預設工作區不能直接使用：${workspaceProblem} 請在「更多選項 → 工作目錄」填寫專案所在的資料夾。` });
      }
    }
    const agentProblem = taskAgentProblem(orchestrator.listAgents(), input);
    if (agentProblem) return reply.code(400).send({ error: agentProblem });
    if (worktree) {
      const repoPath = input.cwd ?? workspace;
      const existing = new Set((await store.listTasks()).map((task) => task.id));
      const wt = await createTaskWorktree(repoPath, `task-${randomUUID().slice(0, 8)}`);
      // 準備 worktree（P2-4）：連結依賴目錄、執行倉庫的 setup 腳本；失敗只記錄，不影響建立任務
      const setup = await setupTaskWorktree(wt).catch((error: unknown) => ({ linked: [], error: (error as Error).message }));
      app.log.info({ worktree: wt.path, setup }, 'task worktree prepared');
      let task: TaskRecord;
      try {
        task = await orchestrator.createTask({ ...input, cwd: wt.path, workspace: { kind: 'worktree', repoPath: wt.repoRoot, branch: wt.branch } });
      } catch (error) {
        // 任務沒有落盤：回滾剛建的 worktree 和分支。
        // 已經有新任務落盤時保守處理（可能正是引用它的任務），保留 worktree。
        const persisted = (await store.listTasks().catch(() => [])).some((item) => !existing.has(item.id));
        if (!persisted) {
          await removeTaskWorktree(wt).catch((rollbackError: unknown) => app.log.error({ err: rollbackError }, 'failed to roll back task worktree'));
        }
        throw error;
      }
      return reply.code(201).send(task);
    }
    const task = await orchestrator.createTask(input);
    return reply.code(201).send(task);
  });

  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/message', async (request, reply) => {
    const parsed = MessageSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    requireAgent(parsed.data.agentId);
    await orchestrator.sendMessage(request.params.taskId, parsed.data.agentId, parsed.data.message, { resume: parsed.data.resume });
    return { ok: true };
  });

  // 調整預算（P0-7）：調高限額或一鍵放寬；因預算阻塞的任務隨後恢復。引數非法 400，終態任務 409
  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/budget', async (request, reply) => {
    const parsed = BudgetSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { relax, resume, ...rest } = parsed.data;
    const limits = Object.fromEntries(BUDGET_LIMITS.filter((limit) => rest[limit] !== undefined).map((limit) => [limit, rest[limit]]));
    const result = await orchestrator.adjustBudget(request.params.taskId, { limits, relax, resume });
    return { ok: true, ...result };
  });

  // agent 間交接（由操作員發起，編排器執行並記錄）
  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/handoff', async (request, reply) => {
    const parsed = HandoffSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const d = parsed.data;
    requireAgent(d.fromAgentId);
    requireAgent(d.toAgentId);
    await orchestrator.handoffMessage(request.params.taskId, d.fromAgentId, d.toAgentId, d.content, d.instruction, { resume: d.resume });
    return { ok: true };
  });

  // 同時問兩個：主 agent 可寫，其餘 agent 唯讀給意見；不指定主 agent 時沿用任務記錄的主 agent（工作流任務為實現者，測試執行器不能當主 agent）
  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/ask-both', async (request, reply) => {
    const parsed = AskBothSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (parsed.data.primaryAgentId !== undefined) requireChatAgent(parsed.data.primaryAgentId);
    await orchestrator.askBoth(request.params.taskId, parsed.data.message, parsed.data.primaryAgentId, { resume: parsed.data.resume });
    return { ok: true };
  });

  // 換人接手：停止原 agent，把任務連同上下文交給另一個 agent
  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/reassign', async (request, reply) => {
    const parsed = ReassignSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    requireChatAgent(parsed.data.toAgentId);
    await orchestrator.reassign(request.params.taskId, parsed.data.toAgentId, parsed.data.note);
    return { ok: true };
  });

  // 任務級協作設定
  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/settings', async (request, reply) => {
    const parsed = SettingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    await orchestrator.setHandoffPolicy(request.params.taskId, parsed.data.handoffPolicy);
    return { ok: true };
  });

  /**
   * 繼續對話：任務結束後，基於原任務開一個新的對話任務（同一工作目錄），
   * 第一條訊息附帶前情提要（原任務目標、流程結果、各 agent 最近輸出），讓 agent 接得上。
   * 前情提要可能被注入過（P0 第三批審查，H-13 漏修的同類路徑）：整段放進資料區塊，操作員這次寫的話是唯一的指令；
   * 新任務的 prompt 只記錄操作員這次寫的話，之後「換人接手」時前情提要不會進入指令區。
   */
  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/continue', async (request, reply) => {
    const parsed = ContinueSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    requireChatAgent(parsed.data.agentId);
    const task = await store.getTask(request.params.taskId);
    if (!task) return reply.code(404).send({ error: 'Task not found' });
    const loaded = await store.loadRun(task.runId);
    const run = loaded?.status === 'ok' ? loaded.snapshot : undefined;
    const ws = run?.workflowState;
    const cwd = ws?.cwd ?? run?.workspace?.cwd ?? Object.values(run?.agentSessions ?? {}).map((x) => x.metadata?.cwd).find((x): x is string => typeof x === 'string');
    const firstMessage = buildContinuationPrompt({
      previous: { title: task.title, prompt: task.prompt, status: task.status },
      ...(ws ? { workflow: ws } : {}),
      message: parsed.data.message,
    });
    const next = await orchestrator.createTask({
      title: `繼續：${task.title}`.slice(0, 60),
      prompt: parsed.data.message,
      firstMessage,
      agentId: parsed.data.agentId,
      workflow: 'manual',
      cwd,
    });
    return reply.code(201).send(next);
  });

  // 人工閘門：接受結果 / 請求一輪評審 / 帶說明重試
  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/gate', async (request, reply) => {
    const parsed = GateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    await orchestrator.resolveGate(request.params.taskId, parsed.data.action, parsed.data.note);
    return { ok: true };
  });

  // 確認測試配置的改動並執行測試（P0-8 / H-15）：agent 改過測試配置時，測試步驟停在 WAITING_INPUT 等這個確認
  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/test-config/confirm', async (request, reply) => {
    const parsed = TestConfigConfirmSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    await orchestrator.confirmTestConfig(request.params.taskId, parsed.data.digest);
    return { ok: true };
  });

  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/cancel', async (request) => {
    await orchestrator.cancelTask(request.params.taskId);
    return { ok: true };
  });

  // 改動審查（P2-3 / P2-4）：?seq=N 是第 N 個檢查點這一輪的改動；不帶時是當前工作區相對任務開始時的全部改動
  app.get<{ Params: { taskId: string }; Querystring: { seq?: string } }>('/api/tasks/:taskId/diff', async (request) => {
    const seq = request.query.seq !== undefined ? Number(request.query.seq) : undefined;
    return orchestrator.checkpointDiff(request.params.taskId, Number.isInteger(seq) ? seq : undefined);
  });

  // 多個實現擇一（P2-11 best-of-N）：同一個要求交給幾個 AI，各自在獨立的 worktree 裡做；之後比較、選一個合入
  const GroupSchema = z.object({
    prompt: z.string().min(1).max(20_000),
    title: z.string().optional(),
    agentIds: z.array(z.string()).min(2).max(4),
    workflow: z.enum(['implementation-v1', 'manual']).optional(),
    testCommand: z.string().max(2000).optional(),
    cwd: z.string().optional(),
  });
  app.post('/api/groups', async (request, reply) => {
    const parsed = GroupSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const ids = [...new Set(parsed.data.agentIds)];
    if (ids.length < 2) return reply.code(400).send({ error: '至少選兩個不同的 AI。' });
    for (const id of ids) requireChatAgent(id);
    const repoPath = parsed.data.cwd?.trim() ? path.resolve(parsed.data.cwd.trim()) : workspace;
    const cwdProblem = ctx.validateTaskCwd?.(repoPath);
    if (cwdProblem) return reply.code(400).send({ error: cwdProblem });
    if (!(await isGitRepository(repoPath))) return reply.code(400).send({ error: '「多個 AI 各做一份」需要工作目錄是 git 倉庫（每個 AI 在自己的 worktree 裡做）。' });
    const groupId = randomUUID().slice(0, 8);
    const title = parsed.data.title?.trim() || autoTitle(parsed.data.prompt);
    const created: TaskRecord[] = [];
    for (const [index, agentId] of ids.entries()) {
      const wt = await createTaskWorktree(repoPath, `best-${groupId}-${index + 1}`);
      await setupTaskWorktree(wt).catch(() => undefined);
      try {
        created.push(
          await orchestrator.createTask({
            title: `${title}（${index + 1}/${ids.length}）`,
            prompt: parsed.data.prompt,
            agentId,
            workflow: parsed.data.workflow ?? 'manual',
            testCommand: parsed.data.testCommand?.trim() || undefined,
            cwd: wt.path,
            workspace: { kind: 'worktree', repoPath: wt.repoRoot, branch: wt.branch },
            group: { id: groupId, index, size: ids.length },
          }),
        );
      } catch (error) {
        await removeTaskWorktree(wt).catch(() => undefined);
        throw error;
      }
    }
    return reply.code(201).send({ groupId, tasks: created });
  });

  /** 一組候選的比較資料與推薦（確定性規則：測試通過 > 評審接受 > 已完成 > 改動少 > 花費少）。 */
  interface GroupCandidate {
    taskId: string;
    index: number;
    agentId?: string;
    status: string;
    busy: boolean;
    testsPassed?: boolean;
    verdict?: string;
    costUsd: number;
    merged: boolean;
    cleaned: boolean;
    files: number;
    insertions: number;
    deletions: number;
  }
  const groupCandidates = async (groupId: string): Promise<{ candidates: GroupCandidate[]; recommended?: string }> => {
    const list: GroupCandidate[] = [];
    for (const task of await store.listTasks()) {
      const run = await store.getRun(task.runId);
      if (run?.group?.id !== groupId) continue;
      const wt = await orchestrator.taskWorktree(task.id);
      let stats = { files: 0, insertions: 0, deletions: 0 };
      if (wt.worktree && !run.workspace?.cleanedAt) {
        const preview = await previewWorktreeMerge(wt.worktree).catch(() => undefined);
        if (preview) stats = { files: preview.files.length, ...(await diffStat(wt.worktree.path).catch(() => ({ insertions: 0, deletions: 0 }))) };
      }
      list.push({
        taskId: task.id,
        index: run.group.index,
        agentId: run.primaryAgentId ?? run.currentAgentId ?? task.currentAgentId,
        status: run.status,
        busy: wt.busy,
        testsPassed: run.workflowState?.lastTest?.passed,
        verdict: run.workflowState?.review?.verdict,
        costUsd: run.budget.costUsdUsed ?? 0,
        merged: Boolean(run.workspace?.merged),
        cleaned: Boolean(run.workspace?.cleanedAt),
        ...stats,
      });
    }
    list.sort((a, b) => a.index - b.index);
    const score = (c: GroupCandidate) => [c.testsPassed === true ? 0 : c.testsPassed === false ? 2 : 1, c.verdict === 'ACCEPT' ? 0 : 1, c.status === 'COMPLETED' ? 0 : 1, c.files === 0 ? 1 : 0, c.insertions + c.deletions, c.costUsd];
    const ranked = list.filter((c) => !c.cleaned).sort((a, b) => {
      const x = score(a);
      const y = score(b);
      for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i]! - y[i]!;
      return a.index - b.index;
    });
    return { candidates: list, recommended: ranked[0]?.taskId };
  };

  app.get<{ Params: { groupId: string } }>('/api/groups/:groupId', async (request, reply) => {
    const result = await groupCandidates(request.params.groupId);
    if (result.candidates.length === 0) return reply.code(404).send({ error: '找不到這一組。' });
    return result;
  });

  // 選定一個：合入它（merge / apply），其餘的放棄並刪除 worktree
  const PickSchema = z.object({ taskId: z.string(), mode: z.enum(['merge', 'apply']), allowSecrets: z.boolean().optional() });
  app.post<{ Params: { groupId: string } }>('/api/groups/:groupId/pick', async (request, reply) => {
    const parsed = PickSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { candidates } = await groupCandidates(request.params.groupId);
    if (!candidates.some((c) => c.taskId === parsed.data.taskId)) return reply.code(404).send({ error: '這個任務不在這一組裡。' });
    if (candidates.some((c) => c.busy)) return reply.code(409).send({ error: '還有 AI 在工作，請等它們做完（或先停下）再選。', code: 'AGENT_WORKING' });
    const chosen = await orchestrator.taskWorktree(parsed.data.taskId);
    if (!chosen.worktree) return reply.code(409).send({ error: '選中的任務沒有 worktree。' });
    try {
      const result = await mergeTaskWorktree(chosen.worktree, parsed.data.mode, `acc: ${chosen.task.title}`, { allowSecrets: parsed.data.allowSecrets });
      await orchestrator.recordWorkspaceEvent(chosen.task.id, 'workspace.merged', { mode: parsed.data.mode, ...result, branch: chosen.worktree.branch, pickedFromGroup: request.params.groupId, action: '在比較中被選中，已合入主倉庫' });
    } catch (error) {
      if (error instanceof MergeError) return reply.code(409).send({ error: error.message, code: 'MERGE_REFUSED', conflicts: error.conflicts });
      throw error;
    }
    const discarded: string[] = [];
    for (const c of candidates) {
      if (c.taskId === parsed.data.taskId || c.cleaned) continue;
      const other = await orchestrator.taskWorktree(c.taskId);
      if (!['COMPLETED', 'CANCELLED', 'FAILED'].includes(other.run.status)) await orchestrator.abandonTask(c.taskId).catch(() => undefined);
      if (other.worktree) {
        try {
          await cleanupTaskWorktree(other.worktree);
          await orchestrator.recordWorkspaceEvent(c.taskId, 'workspace.cleaned', { path: other.worktree.path, branch: other.worktree.branch, action: '比較中沒有被選中，已刪除 worktree 與分支' });
          discarded.push(c.taskId);
        } catch (error) {
          app.log.warn({ err: error }, 'failed to clean up a discarded candidate');
        }
      }
    }
    return { ok: true, discarded };
  });

  // 從檢查點分叉（P2-3）：新的任務在新的 worktree 裡，從那個檢查點的內容開始；原任務不受影響
  const ForkSchema = z.object({ seq: z.number().int().min(0), prompt: z.string().min(1).max(20_000), agentId: z.string().optional() });
  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/fork', async (request, reply) => {
    const parsed = ForkSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { task: source, ref, cwd, label } = await orchestrator.checkpointFor(request.params.taskId, parsed.data.seq);
    const agentId = parsed.data.agentId ?? source.currentAgentId ?? orchestrator.listAgents().find((a) => a.kind !== 'test')?.id;
    if (!agentId) return reply.code(400).send({ error: '沒有可以接手的 Agent。' });
    requireChatAgent(agentId);
    const wt = await forkWorktreeFromCheckpoint(cwd, `fork-${randomUUID().slice(0, 8)}`, ref);
    try {
      const task = await orchestrator.createTask({
        title: `分叉：${source.title}（${label}）`.slice(0, 200),
        prompt: parsed.data.prompt,
        agentId,
        workflow: 'manual',
        cwd: wt.path,
        workspace: { kind: 'worktree', repoPath: wt.repoRoot, branch: wt.branch },
      });
      return reply.code(201).send(task);
    } catch (error) {
      await removeTaskWorktree(wt).catch(() => undefined);
      throw error;
    }
  });

  // 撤銷最後一輪（P2-3）：工作區恢復到上一個檢查點；追加事件，不刪除歷史
  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/undo', async (request) => {
    return { ok: true, ...(await orchestrator.undoLastTurn(request.params.taskId)) };
  });

  // 合入閘門（P2-4）：預覽合入會執行的命令、改動的檔案和衝突預檢，不改動任何東西
  app.get<{ Params: { taskId: string } }>('/api/tasks/:taskId/merge-preview', async (request, reply) => {
    const { worktree } = await orchestrator.taskWorktree(request.params.taskId);
    if (!worktree) return reply.code(409).send({ error: '這個任務沒有使用獨立 worktree，改動已經直接在工作目錄裡了，不需要合入。', code: 'NOT_A_WORKTREE_TASK' });
    return previewWorktreeMerge(worktree);
  });

  // 合入（P2-4）：merge 保留提交；apply 只把改動暫存到主倉庫（不提交）。AI 正在工作、主倉庫有未提交改動、有衝突時都不合入
  const MergeSchema = z.object({ mode: z.enum(['merge', 'apply']), allowSecrets: z.boolean().optional() });
  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/merge', async (request, reply) => {
    const parsed = MergeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { task, busy, worktree } = await orchestrator.taskWorktree(request.params.taskId);
    if (!worktree) return reply.code(409).send({ error: '這個任務沒有使用獨立 worktree，不需要合入。', code: 'NOT_A_WORKTREE_TASK' });
    if (busy) return reply.code(409).send({ error: 'AI 正在工作，現在合入會漏掉它接下來的改動。請等這一輪做完，或者先停下它。', code: 'AGENT_WORKING' });
    try {
      const result = await mergeTaskWorktree(worktree, parsed.data.mode, `acc: ${task.title}`, { allowSecrets: parsed.data.allowSecrets });
      await orchestrator.recordWorkspaceEvent(task.id, 'workspace.merged', { mode: parsed.data.mode, ...result, branch: worktree.branch, ...(parsed.data.allowSecrets ? { secretsOverridden: true } : {}), action: `已合入主倉庫（${parsed.data.mode === 'merge' ? 'merge' : 'apply，只暫存'}）：${result.files} 個檔案` });
      return { ok: true, ...result };
    } catch (error) {
      if (error instanceof MergeError) return reply.code(409).send({ error: error.message, code: 'MERGE_REFUSED', conflicts: error.conflicts });
      throw error;
    }
  });

  // 清理 worktree（P2-4）：刪除任務的 worktree 目錄與 acc/* 分支；只能在任務結束或已經合入之後
  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/worktree/cleanup', async (request, reply) => {
    const { task, run, busy, worktree } = await orchestrator.taskWorktree(request.params.taskId);
    if (!worktree) return reply.code(409).send({ error: '這個任務沒有使用獨立 worktree。', code: 'NOT_A_WORKTREE_TASK' });
    const finished = ['COMPLETED', 'CANCELLED', 'FAILED'].includes(run.status);
    if (busy || (!finished && !run.workspace?.merged)) {
      return reply.code(409).send({ error: '任務還在進行、而且改動還沒有合入：刪除 worktree 會丟掉這些改動。請先合入，或者先結束任務。', code: 'WORKTREE_IN_USE' });
    }
    try {
      await cleanupTaskWorktree(worktree);
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message, code: 'WORKTREE_CLEANUP_FAILED' });
    }
    await orchestrator.recordWorkspaceEvent(task.id, 'workspace.cleaned', { path: worktree.path, branch: worktree.branch, action: '已刪除 worktree 與分支' });
    return { ok: true };
  });

  // 執行隔離（P2-8）：測試執行器、Codex 等在什麼隔離級別下執行命令，以及怎麼開啟
  app.get('/api/isolation', async () => ({ agents: await orchestrator.agentIsolation() }));
  app.post<{ Params: { agentId: string } }>('/api/agents/:agentId/isolation/setup', async (request) => {
    requireAgent(request.params.agentId);
    return orchestrator.setupAgentIsolation(request.params.agentId);
  });

  // 追蹤（P2-2）：這個任務的事件投影成 OTLP/HTTP JSON（可以匯入 Phoenix / Jaeger 等）；?content=1 才附帶命令和工具輸入摘要
  app.get<{ Params: { taskId: string }; Querystring: { content?: string } }>('/api/tasks/:taskId/trace', async (request, reply) => {
    const task = await store.getTask(request.params.taskId);
    if (!task) return reply.code(404).send({ error: 'Task not found' });
    const spans = eventsToSpans(await store.listEvents(task.runId), { includeContent: request.query.content === '1' });
    return spansToOtlp(spans);
  });

  // 審批策略（P2-7）：自主度與「以後都允許」的規則；介面上可以檢視和撤銷
  const PolicyModeSchema = z.object({ mode: z.enum(['ask', 'rules', 'unattended']) });
  const PolicyRuleSchema = z.object({ approvalId: z.string().min(1).max(500), allAgents: z.boolean().optional() });
  app.get('/api/policy', async (_request, reply) => {
    if (!ctx.policy) return reply.code(404).send({ error: '審批策略沒有啟用。' });
    return { mode: ctx.policy.mode(), rules: ctx.policy.rules(), maxConsecutive: ctx.maxConsecutiveAutoApprovals ?? DEFAULT_MAX_CONSECUTIVE_AUTO_APPROVALS };
  });
  app.put('/api/policy/mode', async (request, reply) => {
    if (!ctx.policy) return reply.code(404).send({ error: '審批策略沒有啟用。' });
    const parsed = PolicyModeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    ctx.policy.setMode(parsed.data.mode);
    return { ok: true, mode: ctx.policy.mode() };
  });
  // 從一個審批生成規則（「以後都允許」）：高風險的操作不能生成規則
  app.post('/api/policy/rules', async (request, reply) => {
    if (!ctx.policy) return reply.code(404).send({ error: '審批策略沒有啟用。' });
    const parsed = PolicyRuleSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const approval = await store.getApproval(parsed.data.approvalId);
    if (!approval) return reply.code(404).send({ error: '找不到這個審批。' });
    const rule = ruleFromApproval(approval.request, approval.agentId);
    if (!rule) return reply.code(400).send({ error: '這是高風險的操作（或交接、提問），不能設成「以後都允許」，每次都需要你確認。', code: 'HIGH_RISK' });
    return reply.code(201).send(ctx.policy.addRule(parsed.data.allAgents ? { ...rule, agentId: undefined } : rule));
  });
  app.delete<{ Params: { ruleId: string } }>('/api/policy/rules/:ruleId', async (request, reply) => {
    if (!ctx.policy) return reply.code(404).send({ error: '審批策略沒有啟用。' });
    if (!ctx.policy.removeRule(request.params.ruleId)) return reply.code(404).send({ error: '找不到這條規則。' });
    return { ok: true };
  });

  // 放棄 / 歸檔（P1-12）：任務進入終態，重啟後不再恢復
  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/abandon', async (request) => {
    await orchestrator.abandonTask(request.params.taskId);
    return { ok: true };
  });

  // 刪除（P1-12）：只能刪已經結束的任務；清除它的事件、快照、審批和用量記錄
  app.delete<{ Params: { taskId: string } }>('/api/tasks/:taskId', async (request, reply) => {
    const task = await store.getTask(request.params.taskId);
    if (!task) return reply.code(404).send({ error: 'Task not found' });
    const loaded = await store.loadRun(task.runId);
    if (loaded?.status === 'ok' && !['COMPLETED', 'CANCELLED', 'FAILED'].includes(loaded.snapshot.status)) {
      return reply.code(409).send({ error: '只能刪除已經結束的任務：請先「停止」、「接受結果」或「放棄」它。', code: 'TASK_NOT_TERMINAL' });
    }
    if (!store.deleteTask) return reply.code(501).send({ error: '目前的儲存方式不支援刪除。' });
    await store.deleteTask(task.id);
    return { ok: true };
  });

  // 匯出（P1-12）：JSON Lines，第一行是任務和快照，後面每行一個事件
  app.get<{ Params: { taskId: string } }>('/api/tasks/:taskId/export', async (request, reply) => {
    const task = await store.getTask(request.params.taskId);
    if (!task) return reply.code(404).send({ error: 'Task not found' });
    const loaded = await store.loadRun(task.runId);
    const events = await store.listEvents(task.runId);
    const lines = [JSON.stringify({ kind: 'task', task, run: loaded?.status === 'ok' ? loaded.snapshot : undefined }), ...events.map((e) => JSON.stringify({ kind: 'event', ...e }))];
    reply.header('content-type', 'application/x-ndjson; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="task-${task.id.slice(0, 8)}.jsonl"`);
    return `${lines.join('\n')}\n`;
  });

  // 只停下某一個 agent 當前這一輪（P1-10 / M-27）；任務和其他 agent 不受影響
  const InterruptSchema = z.object({ agentId: z.string().min(1).max(64) });
  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/interrupt', async (request, reply) => {
    const parsed = InterruptSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    await orchestrator.interruptAgent(request.params.taskId, parsed.data.agentId);
    return { ok: true };
  });

  app.post<{ Params: { approvalId: string } }>('/api/approvals/:approvalId/resolve', async (request, reply) => {
    const parsed = ApprovalSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    // 審批身份是持久化的：taskId 可省略，從 approvals 表反查
    const approval = await store.getApproval(request.params.approvalId);
    const taskId = parsed.data.taskId ?? approval?.taskId;
    if (!taskId) return reply.code(404).send({ error: 'Approval not found' });
    await orchestrator.resolveApproval(taskId, request.params.approvalId, parsed.data.decision, parsed.data.scope, { resume: parsed.data.resume, answers: parsed.data.answers });
    return { ok: true };
  });

  const maxWsConnections = ctx.maxWsConnections ?? Number.POSITIVE_INFINITY;
  const wsLimitMessage = '即時連線數已達上限（可能開了太多控制台分頁），請關閉不用的分頁後重新整理。';
  app.get(
    '/ws/events',
    {
      websocket: true,
      // 升級之前檢查連線數：超過上限直接以 HTTP 503 拒絕（訪問控制已在 onRequest 鉤子裡完成）
      preValidation: async (_request, reply) => {
        if (sockets.size >= maxWsConnections) return reply.code(503).send({ error: wsLimitMessage, code: 'ACC_WS_LIMIT' });
      },
    },
    (socket) => {
      // 併發升級時可能同時透過上面的檢查：登記前再確認一次
      if (sockets.size >= maxWsConnections) {
        socket.close(1013, 'too many connections');
        return;
      }
      sockets.add(socket);
      socket.send(JSON.stringify({ type: 'system.connected', timestamp: Date.now() }));
      socket.on('close', () => sockets.delete(socket));
    },
  );
}

/** worktree 相對 HEAD 的增刪行數（包括未提交的改動和新檔案）。 */
async function diffStat(cwd: string): Promise<{ insertions: number; deletions: number }> {
  const { execFile } = await import('node:child_process');
  const run = (args: string[]) =>
    new Promise<string>((resolve, reject) => execFile('git', ['-C', cwd, ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (e, out) => (e ? reject(e) : resolve(out))));
  const untracked = (await run(['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
  let insertions = 0;
  let deletions = 0;
  for (const line of (await run(['diff', '--numstat', 'HEAD'])).split('\n')) {
    const [a, d] = line.split('\t');
    insertions += Number(a) || 0;
    deletions += Number(d) || 0;
  }
  // 新檔案不在 git diff 裡：按行數計入新增
  const { readFile } = await import('node:fs/promises');
  for (const file of untracked.slice(0, 2000)) insertions += (await readFile(path.join(cwd, file), 'utf8').catch(() => '')).split('\n').length;
  return { insertions, deletions };
}
