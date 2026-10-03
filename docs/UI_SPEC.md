# UI Specification

Reference prototype: `prototypes/control-console-demo.html`.

The production React UI should optimize for operator decisions, not code browsing.

## Primary information hierarchy

1. Task title/status/workflow step.
2. Per-agent state + current action.
3. Conversation/task communication.
4. Event stream.
5. Incident/Safety/Approval center.
6. Background jobs and usage.

Do not devote large permanent panels to raw code diff; open those on demand.

## Agent card minimum fields

- agent name
- runtime readiness
- status
- current action
- elapsed time
- last event
- blocker if any

## Incident center

Separate:

- confirmed native safety/policy signal
- approval required
- runtime/permission error
- quota/budget exceeded
- inferred possible refusal

Never label an inferred text match as a confirmed provider policy block.

## Operator actions

- Ask Claude
- Ask Codex
- Ask Both (creates two orchestrator-controlled runs, not direct peer calls)
- Review
- Rescue
- Run Tests
- Approve / Decline
- Retry
- Reassign
- Stop

## WebSocket projection

The browser receives `UnifiedEvent`, updates local projection, and periodically/reconnect fetches canonical task state from REST.
