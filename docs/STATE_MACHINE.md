# State Machine

## Task status transitions (generated from code)

The table below is generated from `packages/core/src/state-machine.ts` (`renderTransitionTable()`); the test
`tests/regression/docs-sync.test.ts` fails when the two drift apart. Update the code, then paste the new output here.

<!-- transitions:start -->
| 從 | 可以遷移到 |
|---|---|
| `CREATED` | `QUEUED`, `CANCELLED`, `BLOCKED` |
| `QUEUED` | `RUNNING`, `CANCELLED`, `FAILED`, `BLOCKED` |
| `RUNNING` | `WAITING_INPUT`, `WAITING_APPROVAL`, `BLOCKED`, `FAILED`, `CANCELLED`, `COMPLETED` |
| `WAITING_INPUT` | `RUNNING`, `CANCELLED`, `FAILED`, `BLOCKED` |
| `WAITING_APPROVAL` | `RUNNING`, `BLOCKED`, `CANCELLED`, `FAILED` |
| `BLOCKED` | `RUNNING`, `CANCELLED`, `FAILED` |
| `FAILED` | —（終態） |
| `CANCELLED` | —（終態） |
| `COMPLETED` | —（終態） |
<!-- transitions:end -->

Notes (current behaviour):

- `BLOCKED` is not terminal: the operator leaves it through a gate action (retry / review / accept), 「放寬預算並繼續」, reassign,
  sending a message to a chat task with explicit resume, stop (→ `CANCELLED`) or abandon (→ `FAILED`, P1-12).
- An approval only resumes `WAITING_APPROVAL`; it never lifts a `BLOCKED` run (M-5).
- Rejected transitions are reported (`TRANSITION_REJECTED` / 409), never silently dropped (P0-7).

## Agent status

- `idle`
- `starting`
- `planning`
- `coding`
- `reviewing`
- `testing`
- `waiting`
- `blocked`
- `failed`
- `completed`
- `cancelled`

## RunSnapshot

```ts
interface RunSnapshot {
  schemaVersion: number;
  runId: string;
  taskId: string;
  status: TaskStatus;
  workflow: string;
  currentStep: string;
  currentAgentId?: string;
  agentSessions: Record<string, SessionSnapshot>;
  pendingApprovals: PendingApproval[];
  pendingInputs: PendingInput[];
  budget: BudgetSnapshot;
  reviewRounds: number;
  stallCount: number;
  lastEventId?: string;
  lastSequence: number;
  updatedAt: number;
}
```

## Recovery contract

After process restart:

1. Load all non-terminal RunSnapshots.
2. Rehydrate adapter session ownership metadata.
3. Do not assume provider session is alive; perform adapter-specific reconnect/resume.
4. Restore pending approval/input identities.
5. Continue from the recorded workflow boundary.
6. Never replay completed side effects solely because the process restarted.

Unknown newer `schemaVersion` must produce an explicit blocked incident and require migration/newer binary.
