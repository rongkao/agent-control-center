# AGENTS.md — Instructions for Codex and other coding agents

## Mission

Build Agent Control Center according to the architecture in this repository. Do not redesign the product around a single provider. Claude, Codex and future runtimes must remain interchangeable behind `AgentAdapter`.

## Read first

1. `README.md`
2. `docs/ARCHITECTURE.md`
3. `docs/ORCHESTRATOR_SPEC.md`
4. `docs/EVENT_CONTRACT.md`
5. `docs/STATE_MACHINE.md`
6. `docs/SAFETY_APPROVAL.md`
7. `TASKS.md`

Before touching a runtime adapter, also read `docs/OPEN_SOURCE_RESEARCH.md` and `docs/ADOPTION_MATRIX.md`.

## Hard architecture constraints

- Do not let an agent directly spawn/schedule another agent. It may **request** a handoff; the Orchestrator decides.
- Do not expose raw Claude/Codex events to React components.
- Do not add provider-specific fields to shared `TaskState` unless they are under a namespaced metadata bag.
- Never replay a completed side effect after pause/resume.
- Every approval must retain stable identity across persistence/resume.
- Every state transition must be explicit and testable.
- `autoReview` defaults to false; do not silently enable review loops.
- Enforce `maxTurns`, `maxAgentCalls`, `maxReviewRounds`, `maxStallCount`, and wall-clock budget.
- Append events before/with state projection updates so incidents are debuggable.
- Runtime fallback occurs below the UI contract.

## Development workflow

1. Pick one unchecked item from `TASKS.md`.
2. Read the affected interfaces and tests.
3. Make the smallest coherent change.
4. Add/update tests before considering the task complete.
5. Run `npm run typecheck` and `npm test`.
6. Update `TASKS.md` only when acceptance criteria are met.

## Source research behavior

When implementing Codex/Claude integration, inspect the current upstream SDK/protocol rather than assuming old event names. Preserve our local adapter contract and translate upstream changes inside the adapter.

## First recommended Codex task

Implement `packages/storage` durable SQLite persistence for:

- tasks
- runs/snapshots
- events
- approvals
- agent sessions
- usage counters

Then add crash/restart recovery tests proving that pending approval resumes without re-executing prior completed work.
