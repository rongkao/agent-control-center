# Architecture v1

## Goal

Agent Control Center is a local-first control plane for multiple coding-agent runtimes. It owns scheduling, state, recovery, safety/approval, budgets, observability and UI projection.

Provider runtimes own model-specific sessions and tool execution. They do **not** own cross-agent orchestration.

## System boundaries

```text
React UI
  │ REST commands + WebSocket events
  ▼
API / Session Router
  ▼
Orchestrator
  ├─ Router
  ├─ Workflow Engine
  ├─ Context Manager
  ├─ Review Manager
  ├─ Retry Manager
  ├─ Budget Manager
  ├─ Stall Detector
  └─ Human Gate
  │
  ▼
Run State Machine ── EventBus ── EventLog / State Projection / UI
  │
  ├─ ClaudeAdapter ── Claude Agent SDK
  ├─ CodexAdapter  ── Codex App Server
  └─ TestAdapter   ── Local process runner
  │
  ▼
Durable Store: RunSnapshot + Events + Approvals + Sessions + Usage
```

## Ownership rules

### UI owns

- command intent
- rendering projections
- operator actions

UI never owns:

- provider session state
- retry policy
- handoff decisions
- approval semantics

### Orchestrator owns

- task workflow
- current step
- next action
- cross-agent handoff
- budgets and stalls
- human-gate transitions

### Adapter owns

- runtime connection/process
- provider session/thread IDs
- event normalization
- provider cancel/resume/approval API translation

### Storage owns

- durable recovery data
- append-only events
- stable approval identities
- run snapshot versions

## One runtime owner per session

A session is attached to exactly one adapter/runtime for its lifetime. Runtime fallback may occur only before a session is committed/started, or through an explicit migration workflow.

This keeps ordering, cancellation, permissions and resume semantics deterministic.

## Why not direct agent-to-agent calls?

Direct peer coordination creates hidden state and bypasses budgets, approvals and observability. Agents may **request** a handoff using a structured result, but the Orchestrator authorizes and creates the target run/session.

## Current-state vs durable truth

The UI's current state is a projection and may be rebuilt. Durable truth needed for recovery is:

1. RunSnapshot
2. append-only EventLog
3. stable approval/request identity
4. provider session/thread identity
5. budget counters

## Initial deployment

V1 is local-only, single-user, one server process, SQLite, one WebSocket hub. Do not add Redis/Kafka/distributed scheduling before the single-process recovery model is proven.
