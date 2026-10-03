# Roadmap

## Milestone A — Control-plane MVP

- unified types
- EventBus
- task/run state machine
- mock adapters
- REST + WS
- dashboard

Status in this package: **skeleton provided**.

## Milestone B — Durable runtime

- SQLite store
- RunSnapshot schema/version
- crash/restart recovery
- approval persistence
- event replay/projection recovery

This is the highest priority next milestone.

## Milestone C — Codex

- App Server lifecycle
- native thread identity
- turn/item streaming
- approval mapping
- cancel/resume
- usage mapping

## Milestone D — Claude

- Agent SDK session/run integration
- streaming/tool event normalization
- permission/approval mapping
- cancel/resume
- usage mapping

## Milestone E — Deterministic collaboration

- implementation workflow
- test adapter
- rescue path
- manual review path
- Context Manager
- review/budget/stall limits

## Milestone F — Production-quality local app

- worktree isolation
- runtime health/reconnect
- task history/replay
- richer usage dashboard
- Tauri packaging

## Later

- more providers
- intelligent router
- DAG workflows
- remote workers
- plugin policy system
