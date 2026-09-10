# Changelog

## [Unreleased]

### Added

- Added IPD V2 TaskInput, ProcessSpec, WorkflowDefinition, ExecutionBaseline, Runtime state, and structured submission
  contracts.
- Added versioned AgentCard, ProcessSpec, Skill, Tool, and Workflow asset assembly with semantic ProcessSpec
  validation.
- Added ProcessSpec and AgentCard catalog search/read tools for progressive disclosure to control roles.
- Added incremental Workflow draft tools, deterministic compilation, sealed Artifact submissions, mechanical checks,
  independent reviews, approval records, rework invalidation, event-backed Run state, and final delivery projection.
- Added the explicitly loaded IPD Extension with create, state, event, and result tools.
- Added default general-delivery producer and reviewer assets so every ProcessSpec marked executable can be staffed by
  the packaged employee pool.
- Added structured execution-node business blocking through `report_node_blocked`, including persisted causes,
  affected requirements, evidence, and recovery conditions.

### Changed

- Reorganized prompts into single-owner core rules, task scope, authoritative contract, professional role, role
  protocol, and current-round projections.
- Upgraded ProcessSpec and WorkflowDefinition to schema version 2. Process evidence requirements and review criteria
  now have stable IDs that Workflow outputs and semantic criteria must explicitly implement.
- Changed Gate approval to require complete semantic-criterion coverage for downstream consumption and final
  completion.
- Changed Workflow Designer revisions to reuse stable Session context and send only the draft revision and new Compiler
  diagnostics.
- Changed Process Selector startup to bind and explicitly load the packaged `process-selection` Skill.
- Changed default Tool asset discovery to use only ToolDefinitions exposed by the active Pi registry.
- Changed review-node permissions to reject write, edit, Bash, and PowerShell tools.

### Fixed

- Fixed execution and review Agents that omit their structured submission tool call so they receive protocol correction
  in the same Session and work round instead of blocking the node.
- Fixed partial Gate approval that could release an output or complete a Run before all semantic criteria passed.
- Fixed ProcessSpec coverage that previously accepted arbitrary Workflow criteria without proving that normative
  evidence and review requirements were instantiated.
- Fixed genuine execution business blocks being retried as malformed Artifact submissions until the correction limit.
