# Orchestrator Specification

## Principle

The Orchestrator is the only module authorized to select the next agent or create a cross-agent handoff.

It receives normalized state/events and produces a deterministic `NextAction`.

## NextAction

```ts
type NextAction =
  | { type: 'CONTINUE'; agentId: string; prompt?: string }
  | { type: 'HANDOFF'; fromAgentId: string; toAgentId: string; contextRef: string; reason: string }
  | { type: 'RUN_TOOL'; toolId: string; args: unknown }
  | { type: 'WAIT_INPUT'; requestId: string; prompt: string }
  | { type: 'WAIT_APPROVAL'; approvalId: string }
  | { type: 'FINAL'; resultRef: string }
  | { type: 'FAIL'; error: NormalizedError };
```

## V1 Router

Use deterministic rules.

- implementation/default → Claude
- independent review → Codex
- rescue/root-cause after repeated implementation/test failure → Codex
- build/test → TestAdapter
- final human approval → Human Gate

Do not use an LLM to route V1 tasks.

## V1 implementation workflow

```text
CREATE
  ↓
CLAUDE_IMPLEMENT
  ↓
TEST
  ├─ pass ───────────────┐
  └─ fail                │
       ↓                 │
   CLAUDE_RETRY (max 1)  │
       ↓                 │
      TEST               │
       ├─ pass ──────────┤
       └─ fail            │
            ↓             │
        CODEX_RESCUE      │
            ↓             │
        CLAUDE_FIX        │
            ↓             │
           TEST           │
                         ↓
              OPTIONAL MANUAL REVIEW
                         ↓
                    FINAL TEST
                         ↓
                      COMPLETE
```

## Review policy

Defaults:

```ts
{
  autoReview: false,
  maxReviewRounds: 1
}
```

A review can produce:

- `ACCEPT`
- `SUGGEST_CHANGES`
- `BLOCKED`

One implementation follow-up is allowed after `SUGGEST_CHANGES`; automatic second review is not scheduled unless the operator explicitly asks.

## Retry classification

- transient transport/runtime → bounded retry
- deterministic command/test failure → workflow decision, not transport retry
- approval required → wait
- safety/policy block → wait/stop, never blind retry
- quota/budget → stop/wait operator
- repeated no-progress → stall limit → handoff or human gate

## Stall detection

Progress is a semantic event that changes at least one of:

- completed workflow step
- test/build outcome
- artifact/result reference
- diagnosed root cause
- resolved blocker
- changed current-action target

Raw token generation alone is not progress.

If `maxStallCount` consecutive agent turns produce no semantic progress, emit `budget.stalled` and enter Human Gate or configured rescue path.
