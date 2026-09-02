# Changelog

## [Unreleased]

### Added

- Added the initial AgentCard and Workflow asset schemas, registries, loaders, and deterministic Workflow compiler.
- Added the transactional SQLite Ledger with immutable events, idempotent writes, state validation, snapshots, and recovery checks.
- Added Artifact integrity validation, extensible mechanical checks, semantic Review Bundles, and workspace read/write locking.
- Added the AgentSession NodeRunner with isolated resources, constrained tools, structured Execution and Decision submissions, usage traces, timeout, and abort support.
- Added ST Workflow planning with Compiler-guided revisions, immutable Workflow Asset persistence, and transactional Run freezing.
- Added the deterministic Graph Engine with dependency scheduling, parallel fan-out/fan-in, workspace locking, Gate-controlled Artifact visibility, rework, cancellation, and interruption recovery.
- Added the Dynamic Gate Pipeline with mechanical checks, review views, independent Reviewer selection, AgentSession reviews, Criterion aggregation, and Staff arbitration.
- Added usage aggregation, soft and hard budget controls, ST budget decisions, Reviewer budget reduction, blocked-node escalation, strict user resume, and unified failure categories.
- Added the Skill-required IPD Tool Runtime and Extension example with start, resume, status, cancel, structured results, context forwarding, asset discovery, and Tool-call idempotency.
- Added specialized AgentCard fields for applicable scenarios, operating principles, deliverables, prompt profiles, and permission-bound knowledge bases.
- Added a versioned ST Workflow Authoring Guide and fixed Staff Core selection with capability-specific planning, delivery, budget, and quality governance.
- Added isolated Attempt workspaces with rework checkpoints, Gate-controlled file publication, cumulative Execution guards, PDF-safe reads, and MIME content validation.

### Fixed

- Allowed retryable execution and Artifact failures to enter `rework_pending` from a running Node Attempt.
- Rejected different Workflow content under an existing ID and version so generated assets require an explicit version increment.
- Replaced monolithic Planner Workflow submission with staged, locally assembled sections, registered Check context, and bounded malformed-submission and Session usage guards.
- Fixed exhausted Attempt governance so Staff cannot create an impossible retry beyond the frozen limit, user resume only answers user-targeted Escalations, and Run failures retain the underlying Node/Gate category.
- Fixed soft-budget recovery to feed the user answer into a new Staff Decision attempt and removed stale questions from terminal Tool results.
