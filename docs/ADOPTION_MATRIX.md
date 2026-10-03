# Adoption Matrix

| Capability | Reference | Decision | Local implementation |
|---|---|---|---|
| Stable UI/runtime boundary | Better Agent Terminal | Adopt | Unified API + Adapter contract |
| Explicit session runtime owner | Better Agent Terminal | Adopt | Session registry |
| Agent tree / activity | Hermes | Adopt | Agent projections + activity events |
| Global free-form shared KV | Hermes | Modify | Task-scoped typed SharedContext |
| Direct peer agent signaling | Hermes | Reject | Handoff only through Orchestrator |
| Checkpoint cursor | LangGraph | Adopt | `runId` + `RunSnapshot` |
| Interrupt/resume | LangGraph / Agents SDK / MAF | Adopt | durable WAIT_INPUT / WAIT_APPROVAL |
| Explicit next-step state machine | OpenAI Agents SDK | Adopt strongly | `NextAction` discriminated union |
| Guardrail ordering | OpenAI Agents SDK | Adopt | safety/approval pipeline |
| Trace hierarchy | OpenAI Agents SDK | Adopt | workflow/turn/agent/tool spans |
| Codex structured runtime | Codex App Server | Direct use | `CodexAdapter` |
| Claude structured runtime | Claude Agent SDK | Direct use | `ClaudeAdapter` |
| Stall limit | Microsoft Agent Framework | Adopt | `maxStallCount` |
| Whole orchestration framework | LangGraph/MAF | Reject | Small local TypeScript core |
| Auto review loop | none | Reject by default | manual review + `maxReviewRounds=1` |
