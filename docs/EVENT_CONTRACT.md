# Unified Event Contract

## Goal

Provider runtimes generate different event shapes. Adapters normalize them into one event stream consumed by storage, orchestrator, metrics and UI.

## Core shape

```ts
interface UnifiedEvent {
  id: string;
  projectId: string;
  taskId: string;
  runId: string;
  agentId?: string;
  sessionId?: string;
  type: EventType;
  severity: 'info' | 'warning' | 'error' | 'critical';
  confidence: 'confirmed' | 'inferred';
  timestamp: number;
  sequence: number;
  data: Record<string, unknown>;
}
```

## Required event families

- `run.started`
- `run.status`
- `run.completed`
- `run.failed`
- `agent.started`
- `agent.status`
- `agent.message`
- `model.turn.started`
- `model.turn.completed`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `handoff.requested`
- `handoff.completed`
- `approval.required`
- `approval.resolved`
- `safety.blocked`
- `budget.exceeded`
- `budget.stalled`
- `runtime.warning`
- `runtime.error`

## Ordering

Within one run, persisted `sequence` must be monotonic. Provider timestamps are metadata only; local sequence decides projection order.

## Confidence

`confirmed` means derived from a structured/native signal or deterministic runtime result.

`inferred` means derived from text/heuristics. UI must not display inferred incidents as proven provider policy decisions.

## Event log

Events are append-only. Corrections are new events, never destructive rewrites.

Examples:

```text
approval.required
approval.resolved
```

not “update old approval event”.
