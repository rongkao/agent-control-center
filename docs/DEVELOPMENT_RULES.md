# Development Rules

## Keep contracts small

Provider SDK types do not leak across adapter package boundaries.

## Fail closed on recovery ambiguity

If the server cannot prove whether a side effect already happened, block and ask for operator intervention rather than executing it again.

## Prefer provider-native IDs

Store native Codex thread/call IDs and Claude session/tool identities as adapter metadata. Do not fabricate replacements when native continuation depends on them.

## Explicit compatibility versions

Version:

- RunSnapshot schema
- UnifiedEvent schema when breaking changes eventually occur
- stored handoff/context envelopes

## Logging

Do not log credentials, raw auth tokens or secrets. Tracing may contain code/input/output; provide a redaction/sensitive-data switch before production use.

## Security scope

The platform may coordinate coding/security-analysis agents, but runtime permissions and operator approvals must remain visible. Never silently widen sandbox or filesystem/network permissions to “make the task work”.
