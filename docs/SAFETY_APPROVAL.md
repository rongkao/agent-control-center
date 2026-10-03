# Safety, Approval and Human Gate

## Classification priority

1. Native structured provider/runtime signal.
2. Deterministic local runtime error/permission result.
3. Text/heuristic inference only as fallback.

## Guard/approval order

Conceptual pipeline:

```text
Input Guard
  ↓
Agent Turn
  ↓
Tool Input Guard
  ↓
Approval Required?
  ↓
Side Effect
  ↓
Tool Output Guard
  ↓
Next Turn / Final Output Guard
```

The exact provider may implement different boundaries; adapters must preserve the semantic order visible to our Orchestrator.

## Approval identity

Every approval contains:

- stable `approvalId`
- `runId`
- `agentId`
- provider/session identifier
- tool/action identity where applicable
- request payload summary
- creation timestamp
- resolution + resolver metadata

The approval ID and provider call identity survive persistence/resume.

## Never blindly retry

- policy/safety block
- explicit permission denial
- destructive action denial
- quota/budget exhausted
- user rejection

## Human Gate actions

- approve
- decline
- retry after changed context
- reassign agent
- convert to read-only analysis
- stop task

## Loop protection

`autoReview=false` by default.

Hard limits:

- max review rounds
- max agent calls
- max model turns
- max stall count
- max wall time

Limit events are first-class incidents, not hidden exceptions.
