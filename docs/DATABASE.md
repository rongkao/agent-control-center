# Database Plan

V1 target: SQLite.

## Tables

### projects

- id
- name
- root_path
- created_at

### tasks

- id
- project_id
- title
- prompt
- status
- workflow
- created_at
- updated_at

### run_snapshots

- run_id PK
- task_id
- schema_version
- status
- current_step
- current_agent_id
- snapshot_json
- last_sequence
- updated_at

### agent_sessions

- id
- run_id
- agent_id
- adapter_type
- provider_session_id
- owner_instance_id
- status
- metadata_json

### events

- id PK
- task_id
- run_id
- sequence
- timestamp
- type
- severity
- confidence
- agent_id nullable
- session_id nullable
- data_json

Unique: `(run_id, sequence)`.

### approvals

- id PK
- run_id
- agent_id
- provider_call_id nullable
- status
- request_json
- decision_json nullable
- created_at
- resolved_at nullable

### usage

- id
- run_id
- agent_id
- model nullable
- input_tokens nullable
- output_tokens nullable
- cached_tokens nullable
- duration_ms nullable
- provider_reported boolean
- created_at

## Atomicity

For state-affecting runtime events, persist within one transaction when practical:

1. append event
2. update run snapshot/projection
3. update approval/session/budget records

The event must never claim an approval or step transition that the snapshot failed to persist.
