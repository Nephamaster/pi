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
- Added usage aggregation, soft and hard budget controls, ST budget decisions, Reviewer budget reduction, blocked-node escalation, user-command resume, and unified failure categories.
- Added the Skill-required IPD Tool Runtime and Extension example with model-callable start/resume_run/status/watch/cancel, user-only `/ipd-resume`, structured results, context forwarding, asset discovery, and Tool-call idempotency.
- Added specialized AgentCard fields for applicable scenarios, operating principles, deliverables, prompt profiles, and permission-bound knowledge bases.
- Added a versioned ST Workflow Authoring Guide and fixed Staff Core selection with capability-specific planning, delivery, budget, and quality governance.
- Added isolated Attempt workspaces with rework checkpoints, Gate-controlled file publication, cumulative Execution guards, PDF-safe reads, and MIME content validation.
- Added inherited active outer-Pi ToolDefinitions for IPD child sessions, excluding recursive `ipd` access; web search and source retrieval are supplied by an external Pi Extension instead of an IPD-owned search backend.
- Added exact Workflow template ID/version/hash references and latest-SemVer selection when only an ID is supplied.
- Added standalone Markdown prompt assets, explicit Planner revision section state, and conservative pre-schema normalization for unambiguous Workflow Tool argument formatting.
- Added asynchronous Run start receipts and structured progress polling through status/watch with event sequence cursors and Run-root visibility.
- Added explicit same-Run recovery through `resume_run`, append-only Workflow revision history, controlled Workflow Amendment, and Run-scoped AgentSession traces.
- Added Tool effect declarations for read-only, Run-workspace writes, and idempotent/non-idempotent external actions with unknown-outcome reconciliation.

### Changed

- Changed IPD Runs to default to an explicit unbounded budget policy; bounded Token and time controls now require `ifBudget=true`, `tokenBudget`, and `timeBudgetMs`, while Usage remains observable in both modes.
- Changed the default Workflow Node Attempt limit to 10 and the structured-submission failure guard to 10 consecutive Assistant turns.
- Simplified Execution Artifact submissions to one or more unique `{path, mimeType}` files; file purpose and mechanical/semantic acceptance now belong exclusively to Staff-authored Gate criteria.
- Moved execution output into per-Run roots under `.pi/ipd/runs/<runId>`, with isolated Attempt work, Gate-controlled accepted publication, final delivery publication, and parallel reads over immutable inputs.
- Moved Workflow Asset storage to the global `~/.pi/ipd/workflow/<workflow-id>/<version>/<hash>.json` hierarchy.
- Changed interrupted execution records to preserve monotonic Attempt numbering without consuming the Node quality-rework allowance.
- Replaced the IPD-owned Bing RSS search implementation with the pinned project-level `pi-web-access` Extension and its zero-config Exa MCP/provider fallback chain.

### Fixed

- Allowed retryable execution and Artifact failures to enter `rework_pending` from a running Node Attempt.
- Rejected different Workflow content under an existing ID and version so generated assets require an explicit version increment.
- Replaced monolithic Planner Workflow submission with staged, locally assembled sections, registered Check context, and bounded malformed-submission and Session usage guards.
- Fixed exhausted Attempt governance so Staff cannot create an impossible retry beyond the frozen limit, user-command resume only answers user-targeted Escalations, and Run failures retain the underlying Node/Gate category.
- Fixed soft-budget recovery to feed the user answer into a new Staff Decision attempt and removed stale questions from terminal Tool results.
- Fixed unbounded Runs so Planner, Execution, Reviewer, and Staff do not inherit hidden AgentCard Token or Timeout limits.
- Fixed exhausted replan routes so they amend the current Run instead of terminating it and forcing an unrelated replacement Run.
- Fixed Workflow Asset version conflicts so Planner receives a targeted `/version` Diagnostic and can resubmit a higher SemVer instead of terminating the Run as `asset_write_failed`.
- Fixed Compiler and Runtime Reviewer selection drift by using one deterministic global matching allocator that enforces mutually exclusive AgentCard assignments across every Gate requirement.
- Removed Escalation `resume` from the model Tool schema; only the user-triggered `/ipd-resume` command can collect, confirm, submit, and record the provenance of a human answer.
