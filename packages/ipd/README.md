# @earendil-works/pi-ipd

Private V1 package for IPD workflow assets, deterministic compilation, transactional execution records,
Artifact integrity, mechanical checks, semantic review views, and workspace locking.

The package currently targets Node.js 24 and includes an AgentSession adapter for
isolated Execution and Decision nodes plus Compiler-guided ST Workflow planning and
immutable Workflow Asset storage. Its deterministic Graph Engine schedules frozen
Workflows through Node and Gate state transitions recorded in the SQLite Ledger.
Dynamic Gates combine deterministic checks, independent semantic Reviewers, strict
Criterion aggregation, and Staff arbitration without majority-vote approval.
Budget governance aggregates every AgentSession usage trace, emits soft and hard
limit events, lets ST continue or reduce later Reviewer budgets, and prevents new
work after an explicit Hard Limit. Blocked Nodes are resolved by ST or escalated
to a user-bound record that can only resume through its matching escalation ID.

The current AgentSession API exposes no governed long-term-memory provider, so IPD
does not add a separate memory directory, retrieval mechanism, or write path.

The `ipd` Extension example exposes `start`, `resume`, `status`, and `cancel` Actions.
It snapshots a mandatory Pi Skill, loads AgentCards and Workflow Assets at start,
forwards the current cwd/model/AbortSignal, and returns concise text with a complete
structured result for questions, accepted Artifacts, failures, and usage.
