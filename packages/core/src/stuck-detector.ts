import type { UnifiedEvent } from './types.js';

/**
 * 原地打轉檢測（P1-8，參考 OpenCode 的 doom_loop 與 OpenHands 的 StuckDetector）。純邏輯，狀態只放記憶體：
 * 服務重啟後從零開始計數（最壞情況是多跑幾次才發現，不會誤判）。
 *
 * 檢測兩種模式（按 agent 分別統計）：
 * - repeated-call：同一個工具、同樣的輸入，連續呼叫 N 次（預設 3）——例如反覆跑同一條命令。
 * - repeated-error：同一個工具連續失敗 N 次（預設 3），而且失敗輸出一樣——換著引數也跑不通，說明在原地打轉。
 *
 * 交接的來回往返（A→B→A）和交接鏈長度在編排器裡檢查（見 handoffLoop），因為它們要看的是 agent 之間的關係。
 */

export type StuckPattern = 'repeated-call' | 'repeated-error';

export interface StuckFinding {
  pattern: StuckPattern;
  agentId: string;
  toolName: string;
  count: number;
  /** 給操作員看的中文說明。 */
  message: string;
}

export interface StuckThresholds {
  repeatedCall: number;
  repeatedError: number;
}

export const DEFAULT_STUCK_THRESHOLDS: StuckThresholds = { repeatedCall: 3, repeatedError: 3 };

interface AgentTrack {
  /** 最近一次呼叫的簽名與連續次數。 */
  lastCall?: string;
  callCount: number;
  /** 最近一次失敗的簽名與連續次數。 */
  lastError?: string;
  errorCount: number;
  /** toolCallId → 工具名（失敗事件裡不一定帶輸入）。 */
  names: Map<string, string>;
}

export class StuckDetector {
  private readonly runs = new Map<string, Map<string, AgentTrack>>();

  constructor(private readonly thresholds: StuckThresholds = DEFAULT_STUCK_THRESHOLDS) {}

  /** 喂入一個事件；發現打轉時返回結果（同一次打轉只報告一次，之後計數清零）。 */
  observe(event: UnifiedEvent): StuckFinding | undefined {
    const agentId = event.agentId;
    if (!agentId) return undefined;
    // 操作員給了新的指令：之前的重複不再算數
    if (event.type === 'agent.message' && event.data.direction === 'to-agent') {
      this.runs.get(event.runId)?.delete(agentId);
      return undefined;
    }
    if (event.type !== 'tool.started' && event.type !== 'tool.completed' && event.type !== 'tool.failed') return undefined;
    const toolName = typeof event.data.toolName === 'string' ? event.data.toolName : '';
    // 測試執行器每次都跑同一條命令，這是正常的（重試由工作流控制）
    if (!toolName || toolName === 'test') return undefined;
    const track = this.track(event.runId, agentId);
    const callId = typeof event.data.toolCallId === 'string' ? event.data.toolCallId : undefined;

    if (event.type === 'tool.started') {
      if (callId) track.names.set(callId, toolName);
      const signature = `${toolName}\u0000${stableJson(event.data.toolInput ?? {})}`;
      track.callCount = track.lastCall === signature ? track.callCount + 1 : 1;
      track.lastCall = signature;
      if (track.callCount >= this.thresholds.repeatedCall) {
        const count = track.callCount;
        track.callCount = 0;
        track.lastCall = undefined;
        return {
          pattern: 'repeated-call',
          agentId,
          toolName,
          count,
          message: `${agentId} 已經用同樣的引數連續執行 ${toolName} ${count} 次，看起來在原地打轉。先停下來等你決定：可以補充說明後讓它重試、換另一個 AI 接手，或者停止任務。`,
        };
      }
      return undefined;
    }

    if (event.type === 'tool.completed') {
      // 成功了：連續失敗清零
      track.lastError = undefined;
      track.errorCount = 0;
      return undefined;
    }

    // tool.failed：被拒絕的審批不算“失敗”（那是操作員的決定）
    if (event.data.declined === true) return undefined;
    const output = typeof event.data.output === 'string' ? normalizeOutput(event.data.output) : '';
    const signature = `${toolName}\u0000${output}`;
    track.errorCount = track.lastError === signature ? track.errorCount + 1 : 1;
    track.lastError = signature;
    if (track.errorCount >= this.thresholds.repeatedError) {
      const count = track.errorCount;
      track.errorCount = 0;
      track.lastError = undefined;
      return {
        pattern: 'repeated-error',
        agentId,
        toolName,
        count,
        message: `${agentId} 執行 ${toolName} 已經連續 ${count} 次得到同樣的錯誤，看起來在原地打轉。先停下來等你決定：可以補充說明後讓它重試、換另一個 AI 接手，或者停止任務。`,
      };
    }
    return undefined;
  }

  /** 任務結束或放寬限制後清掉這個 run 的計數。 */
  reset(runId: string, agentId?: string): void {
    if (agentId) this.runs.get(runId)?.delete(agentId);
    else this.runs.delete(runId);
  }

  private track(runId: string, agentId: string): AgentTrack {
    let agents = this.runs.get(runId);
    if (!agents) {
      agents = new Map();
      this.runs.set(runId, agents);
    }
    let track = agents.get(agentId);
    if (!track) {
      track = { callCount: 0, errorCount: 0, names: new Map() };
      agents.set(agentId, track);
    }
    return track;
  }
}

/**
 * 交接的來回往返與鏈長度（P1-8）。chain 是最近一次操作員指令之後，agent 主動發起的交接（按時間順序）。
 * - ping-pong：最近三次交接在同一對 agent 之間來回（A→B、B→A、A→B）；
 * - chain-limit：連續交接次數達到上限。
 */
export function handoffLoop(chain: ReadonlyArray<{ from: string; to: string }>, maxChain: number): 'ping-pong' | 'chain-limit' | undefined {
  if (chain.length >= maxChain) return 'chain-limit';
  if (chain.length >= 3) {
    const [a, b, c] = chain.slice(-3) as [{ from: string; to: string }, { from: string; to: string }, { from: string; to: string }];
    if (a.from === b.to && a.to === b.from && b.from === c.to && b.to === c.from) return 'ping-pong';
  }
  return undefined;
}

/** 預設的交接鏈上限：一條操作員指令之後，AI 之間最多自己交接這麼多次。 */
export const DEFAULT_MAX_HANDOFF_CHAIN = 6;

/** 輸出裡的時間、耗時、臨時路徑等容易變的數字不參與比較，避免把“同一個錯誤”看成不同。 */
function normalizeOutput(output: string): string {
  return output
    .slice(-2000)
    .replace(/\d+(\.\d+)?\s*(ms|s|秒)\b/g, '#')
    .replace(/\b\d{2}:\d{2}:\d{2}(\.\d+)?\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}
