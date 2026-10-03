# Open-source Research Notes

This architecture borrows proven ideas while avoiding framework lock-in.

## Better Agent Terminal

Repository: https://github.com/tony1223/better-agent-terminal
Guidance: https://github.com/tony1223/better-agent-terminal/blob/main/AGENTS.md

Important ideas:

- Renderer-facing IPC/event names are a compatibility contract.
- New runtimes adapt below that contract rather than forcing UI changes.
- Runtime ownership is explicit per session.
- Fallback occurs below renderer/UI call sites.

Adoption:

- **Adopt strongly**: stable UI contract, adapter boundary, session runtime ownership.
- **Do not copy** BAT-specific Claude naming into our neutral contract.

## Hermes

Repository: https://github.com/pantheonforge/hermes

Important ideas:

- agent tree
- structured activity telemetry
- shared state
- local multi-agent observability
- MCP coordination surface

Adoption:

- **Adopt** agent-tree/activity concepts and task-scoped shared context.
- **Do not adopt** unrestricted direct agent-to-agent signaling. Cross-agent scheduling belongs to the Orchestrator.
- Prefer runtime-native telemetry normalized by adapters over asking agents to self-report all progress.

## LangGraph

Repository: https://github.com/langchain-ai/langgraph
Interrupt documentation: https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/interrupts.mdx

Important ideas:

- durable checkpoints
- `thread_id` as persistent cursor
- explicit interrupt payload
- resume using the same durable identity

Critical caveat:

LangGraph notes that resumed nodes may restart from node beginning, meaning code before an interrupt can execute again. Our control plane therefore treats side-effect identity/idempotency as a first-class concern.

Adoption:

- **Adopt** durable cursor/checkpoint/interrupt-resume concepts.
- **Do not bind** the product to LangGraph graph abstractions.

## OpenAI Agents SDK

Repository: https://github.com/openai/openai-agents-python
Runner lifecycle: https://github.com/openai/openai-agents-python/blob/main/.agents/references/runner-lifecycle.md
Tool lifecycle: https://github.com/openai/openai-agents-python/blob/main/.agents/references/tool-execution-lifecycle.md
Tracing: https://github.com/openai/openai-agents-python/blob/main/docs/tracing.md

Important ideas:

- explicit step-state boundary after each model response
- turn budgets survive resume
- interruptions preserve processed work
- guardrail ordering around side effects
- trace → turn → agent → model/tool/guardrail/handoff spans
- provider payload, public run item and internal executable record are distinct representations

Adoption:

- **Adopt strongly** explicit `NextAction`, guardrail order, versioned resumable state, tracing hierarchy.
- Keep our state types provider-neutral.

## Codex App Server

Repository: https://github.com/openai/codex

Important ideas:

- client-friendly structured runtime instead of terminal scraping
- thread / turn / item lifecycle
- native approvals and resume
- provider-owned thread identity

Adoption:

- **Direct integration target** for `CodexAdapter`.
- Preserve native thread identity inside adapter metadata.
- Translate app-server events into `UnifiedEvent`; never expose protocol shape directly to React.

## Claude Agent SDK

Documentation/source examples should be verified at implementation time because SDK surfaces can evolve.

Adoption:

- `ClaudeAdapter` owns SDK/session details.
- Normalize lifecycle/tool/permission/error events into the same `UnifiedEvent` contract used by Codex.

## Microsoft Agent Framework

Repository: https://github.com/microsoft/agent-framework

Important ideas:

- workflow event model
- durable human request/response workflow
- max round and max stall concepts
- checkpoint restore

Adoption:

- **Adopt** stall limit and correlation identity for pending human requests.
- Do not depend on the whole runtime.
