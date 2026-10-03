# CLAUDE.md — Claude Code project guidance

You are the primary implementation engineer for Agent Control Center. The architecture is already decided; optimize and refine it, but do not collapse the control plane into Claude-specific behavior.

## Product intent

A single UI coordinates Claude, Codex and future coding agents through a deterministic orchestrator. The user should always be able to answer:

- Which agent is working?
- What state is it in?
- What just happened?
- Why is it blocked?
- Does it need approval?
- How much budget has it consumed?
- What is the next orchestrator action?

## Required reading

`README.md` → `docs/ARCHITECTURE.md` → `docs/ORCHESTRATOR_SPEC.md` → `TASKS.md`.

## Implementation principles

- The orchestrator owns cross-agent decisions.
- Adapters normalize provider behavior; UI never knows provider internals.
- Event log and run snapshot are durable truth needed for recovery.
- Current UI projection may be rebuilt.
- Safety/approval signals should use structured runtime signals first; text inference is fallback only.
- Pause/resume must not replay completed side effects.
- Prefer deterministic rules in V1 over AI-driven routing.
- Keep the first release local-first and single-user.

## First recommended Claude Code task

After storage/recovery is stable, implement `ClaudeAdapter` using the current Claude Agent SDK streaming API while preserving `AgentAdapter`. Map SDK lifecycle/tool/permission/error events into `UnifiedEvent` and add adapter contract tests with a fake runtime.

## Validation

Before marking a task complete:

```bash
npm run typecheck
npm test
npm run build
```

Keep `TASKS.md` acceptance criteria synchronized with implementation.
