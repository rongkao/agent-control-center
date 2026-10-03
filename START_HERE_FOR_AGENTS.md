# Start Here — Handoff to Codex / Claude Code

This file exists so you can open the repository in either agent and give a short instruction instead of re-explaining the architecture.

## Prompt for Codex

```text
Read AGENTS.md, README.md, docs/ARCHITECTURE.md, docs/ORCHESTRATOR_SPEC.md,
docs/STATE_MACHINE.md, docs/DATABASE.md and TASKS.md.

Do not redesign the architecture yet.
First inspect the existing skeleton and run/typecheck it.
Then take the highest-priority incomplete task in TASKS.md.

The current priority is durable storage and crash/resume correctness before real provider integration.
Keep all provider details behind AgentAdapter.
Add tests for every lifecycle/recovery change.
Report exactly what you changed, what remains, and any upstream API assumptions you had to verify.
```

## Prompt for Claude Code

```text
Read CLAUDE.md, README.md, docs/ARCHITECTURE.md, docs/ORCHESTRATOR_SPEC.md,
docs/EVENT_CONTRACT.md, docs/SAFETY_APPROVAL.md and TASKS.md.

Treat the architecture as an agreed baseline. Do not collapse orchestration into Claude-specific code.
Run the skeleton first, then implement the highest-priority task whose dependencies are complete.

For every change:
1. preserve the AgentAdapter boundary;
2. preserve deterministic NextAction/state transitions;
3. add tests;
4. do not replay completed side effects on resume;
5. keep autoReview disabled by default.
```

## Suggested two-agent workflow

1. Codex implements or researches one isolated task.
2. Claude Code verifies integration and tests.
3. Run the complete test suite.
4. Use a **manual** Codex review at milestone boundaries only.
5. Do not enable automatic review gate.
