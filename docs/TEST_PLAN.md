# Test Plan

## Unit tests

- task state legal/illegal transitions
- EventBus subscribe/unsubscribe
- budget counters
- stall counter
- review-round guard
- provider error normalization
- snapshot serialize/deserialize

## Adapter contract tests

Every adapter must pass the same suite using a fake runtime:

- start emits started/status events
- send message preserves session identity
- cancel reaches deterministic terminal state
- provider error becomes normalized event
- approval maps to stable approval identity
- resume does not create a second logical session accidentally

## Recovery tests — mandatory before real provider rollout

1. Run starts.
2. Tool A completes.
3. Approval B is requested.
4. Persist snapshot and shut down server.
5. Restart.
6. Resolve approval B.
7. Resume.
8. Assert Tool A is not executed again.

Also test:

- restart during WAITING_INPUT
- restart after provider disconnect
- corrupted snapshot
- unknown schema version
- terminal run must not resume

## Workflow tests

- implementation success first try
- first test fails, Claude retry succeeds
- repeated failure hands to Codex rescue
- review round limit prevents loops
- stall limit blocks task
- time/call budget blocks task

## UI tests

- WebSocket events update agent state
- confirmed vs inferred incidents display differently
- approval dialog resolves correct approval ID
- reconnect fetches fresh projection
