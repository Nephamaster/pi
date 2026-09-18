# Changelog

## [Unreleased]

### Breaking Changes

- Removed implicit host I/O fallback. Legacy adapters now require the explicit `/legacy` entry and optional sandbox-runtime peer; execution images must be rebuilt for the versioned bridge protocol.

### Added

- Added PPT workflow template 1.0.3 with parallel storyline and visual design, a joint design Gate, and explicit visual production and review criteria.

- Added explicit proxy-only public egress, authorized reuse of registered Pi read-service tools, private Docker review checks, and deferred project-dependency probes.

- Added content-addressed static Run snapshots, revision-aware dashboard caching, typed esbuild dashboard assets, and packed-entry verification in the root build workflow.
- Added template evidence prerequisites and metadata-only Pi telemetry spans with native Session timing.

- Added the `/workspace` entry for ordinary Pi SDK consumers and real-tool Skill dependency probes.
- Added managed execution Run pause/resume, retained Session and workspace references, and configurable soft work-package deadlines.
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
- Added Run-level cancellation, bounded node concurrency, round timeouts, quality-rework limits, and isolated runtime
  mutation/round metrics.
- Added an interactive `/ipd` launcher for choosing ProcessSpec and saved Workflow templates, entering the verbatim
  task, and attaching task materials; selected Workflow templates bypass control-role Agent preparation.

### Changed

- Centralized candidate/review state transitions and frozen-Baseline lookup indexes; moved PPTX task dependencies out of the host root package into the Office Profile.
- Allowed default startup with an uninstalled unrelated Profile while retaining fail-closed Docker and capability checks.

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
- Changed shared-workspace review permissions to reject mutation/Shell tools; Docker reviews may use authorized tools in their private inspection workspace.
- Reduced IPD Run creation input to request ID, Skill name, the verbatim user task, and optional user-supplied task
  materials; derived objectives, requirements, and unresolved facts now start empty instead of being authored by the outer Agent.
- Changed Review submissions to bind evidence and criterion-level rework to exact Submission node/output identities.
- Changed generated Run IDs to contain only the UTC creation timestamp.
- Changed the IPD Dashboard to a Chinese light theme with Markdown task rendering, stable live-refresh controls, and
  richer node details.
- Changed the Dashboard task panel to use 12px text and expand its scroll viewport to the full card height.

### Fixed

- Moved persistent round state into native system sections, distinguished real resume/rework dispatches, and recorded effective session/deadline policies. Added retrieval receipts and explicit paging dependencies with PPT workflow template 1.0.2.

- Disabled implicit whole-round deadlines and materialized pi-web-access PDF results in the node workspace without host I/O fallback.

- Closed joint-approval invalidation over downstream work, cancelled entire business rounds during export/check, isolated command timeouts from other services, and retained provisional environment ownership after failed cleanup.
- Separated file transport limits from management responses, bounded search inside containers, aligned CI to Node 24, and added clean tarball installation verification.

- Unified command, log, managed-process and probe environments; preserved Profile interpreter selection without login shell overrides.
- Retained ownership of blocked Runs, bounded cancellation and cleanup, and fenced late submissions by execution generation without consuming quality rework rounds.
- Prevented sandbox-runtime bridge socket failures by using a short per-command temporary directory for `TMPDIR`,
  `TMP`, and `TEMP` instead of a Run-scoped path.
- Fixed Linux Bash isolation hiding authorized Workspace, sealed input, Skill, command-runtime, and seccomp paths by
  replacing the unsupported `allowRead` setting with schema-compatible sibling denies and pre-created write roots.
- Fixed bwrap initialization when a denied symbolic link points inside an already denied parent directory.
- Included the live visualization and snapshot URLs directly in successful IPD Run creation receipts.
- Invalidated every Approval issued by a stale joint Review and made all required Review nodes part of Run completion.
- Applied node read scopes consistently to read, grep, find, and ls, and isolated each sealed Submission output.
- Contained asynchronous Dashboard snapshot failures within their HTTP request.
- Terminated the outer Agent turn after an accepted Run receipt so business execution cannot continue outside IPD.
- Fixed execution and review Agents that omit their structured submission tool call so they receive protocol correction
  in the same Session and work round instead of blocking the node.
- Fixed partial Gate approval that could release an output or complete a Run before all semantic criteria passed.
- Fixed ProcessSpec coverage that previously accepted arbitrary Workflow criteria without proving that normative
  evidence and review requirements were instantiated.
- Fixed genuine execution business blocks being retried as malformed Artifact submissions until the correction limit.
