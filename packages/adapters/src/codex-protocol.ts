/**
 * Codex App Server 協議子集（僅 adapter 用到的部分）。
 *
 * 摘錄自 `codex app-server generate-ts`（codex-cli 0.156.1）生成的 v2 型別。
 * 傳輸：stdio，每行一個 JSON 訊息，不帶 "jsonrpc" 欄位：
 *   請求  { id, method, params }     響應 { id, result } | { id, error }
 *   通知  { method, params }
 * 服務端也會向客戶端發請求（審批等），客戶端必須用相同 id 響應。
 *
 * 這些型別只在 adapters 包內部使用，不得洩漏到 core/UI。
 */

export type AskForApproval = 'untrusted' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
/**
 * 審批請求交給誰審（M-35）：user = 發給客戶端（ACC 轉給操作員）；auto_review / guardian_subagent = 由 Codex 自己的審閱子 agent 決定。
 * 預設取使用者 ~/.codex/config.toml 裡的 approvals_reviewer，所以 ACC 必須顯式傳 'user'。
 */
export type ApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent';
/** 配置覆蓋：鍵是點分路徑（與命令列 `-c key=value` 相同，例如 'features.multi_agent'），值按 TOML 值解釋。 */
export type CodexConfigOverrides = Record<string, string | number | boolean | null>;

export interface UserInputText {
  type: 'text';
  text: string;
  text_elements: unknown[];
}

export interface ThreadStartParams {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  /** 這個執行緒（及之後各回合）的審批交給誰審（M-35）。 */
  approvalsReviewer?: ApprovalsReviewer | null;
  sandbox?: SandboxMode | null;
  /** 這個執行緒的配置覆蓋（M-35：關閉 multi_agent、shell_environment_policy 只繼承核心變數）。 */
  config?: CodexConfigOverrides | null;
  developerInstructions?: string | null;
}

export interface ThreadResumeParams extends ThreadStartParams {
  threadId: string;
  excludeTurns?: boolean;
}

export interface CodexThread {
  id: string;
  sessionId: string;
}

export interface ThreadStartResponse {
  thread: CodexThread;
  model: string;
  cwd: string;
  /** 這個執行緒實際使用的審批去向（thread/start 與 thread/resume 的響應都有；舊版服務端可能沒有）。 */
  approvalsReviewer?: ApprovalsReviewer;
}

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export type CodexErrorInfo = string | Record<string, unknown>;

export interface TurnError {
  message: string;
  codexErrorInfo: CodexErrorInfo | null;
  additionalDetails: string | null;
}

export interface CodexTurn {
  id: string;
  status: TurnStatus;
  error: TurnError | null;
  durationMs: number | null;
}

/**
 * 沙箱策略（turn/start 的 sandboxPolicy：覆蓋本回合及之後回合的沙箱）。
 * 摘錄自 codex-cli 0.156.1 生成的 v2 SandboxPolicy（只列 adapter 用到的兩種）。
 */
export type SandboxPolicy =
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };

export interface TurnStartParams {
  threadId: string;
  input: UserInputText[];
  cwd?: string | null;
  sandboxPolicy?: SandboxPolicy | null;
}

export interface TurnStartResponse {
  turn: CodexTurn;
}

export interface TurnSteerParams {
  threadId: string;
  input: UserInputText[];
  expectedTurnId: string;
}

export type ThreadItem =
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'commandExecution'; id: string; command: string; cwd: string; status: 'inProgress' | 'completed' | 'failed' | 'declined'; exitCode: number | null; durationMs: number | null; aggregatedOutput: string | null }
  | { type: 'fileChange'; id: string; changes: Array<{ path: string; kind?: PatchChangeKind; diff?: string }>; status: 'inProgress' | 'completed' | 'failed' | 'declined' }
  | { type: 'mcpToolCall'; id: string; server: string; tool: string; status: 'inProgress' | 'completed' | 'failed'; arguments: unknown }
  | { type: 'dynamicToolCall'; id: string; tool: string; status: 'inProgress' | 'completed' | 'failed'; arguments: unknown }
  | { type: string; id: string };

/** 檔案改動的種類；update 帶 move_path 時表示改名（移動）到那個路徑。 */
export type PatchChangeKind = { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null };

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

/** 服務端通知（adapter 關心的部分）。 */
export type CodexNotification =
  | { method: 'turn/started'; params: { threadId: string; turn: CodexTurn } }
  | { method: 'turn/completed'; params: { threadId: string; turn: CodexTurn } }
  | { method: 'item/started'; params: { threadId: string; turnId: string; item: ThreadItem } }
  | { method: 'item/completed'; params: { threadId: string; turnId: string; item: ThreadItem } }
  | { method: 'thread/tokenUsage/updated'; params: { threadId: string; turnId: string; tokenUsage: { total: TokenUsageBreakdown; last: TokenUsageBreakdown } } }
  | { method: 'thread/status/changed'; params: { threadId: string; status: { type: string } } }
  | { method: 'error'; params: { threadId: string; turnId: string; willRetry: boolean; error: TurnError } }
  | { method: string; params?: Record<string, unknown> };

/** 服務端 → 客戶端請求（審批）。 */
export interface CommandApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
}

export interface FileChangeApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
}

export interface PermissionsApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  cwd: string;
  reason: string | null;
  permissions: { network: unknown; fileSystem: AdditionalFileSystemPermissions | null };
}

/** 額外的檔案系統權限（read / write 是舊欄位，entries 是新欄位）。 */
export interface AdditionalFileSystemPermissions {
  read?: string[] | null;
  write?: string[] | null;
  entries?: Array<{ path: { type: string; path?: string; pattern?: string }; access: 'read' | 'write' | 'deny' }>;
}

export type CodexIncoming =
  | { id: number | string; result?: unknown; error?: { code: number; message: string } } // 響應
  | { id: number | string; method: string; params?: unknown } // 服務端請求
  | { method: string; params?: unknown }; // 通知
