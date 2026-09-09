# @earendil-works/pi-ipd

Private IPD V2 package for governed multi-Agent task execution on Pi.

The package provides an explicitly loaded Pi Extension; it is not enabled by default. The example entry is
`examples/ipd-extension.ts`.

## Runtime flow

```text
ipd create_run
  → Process Selector chooses one versioned ProcessSpec
  → Workflow Designer builds a managed draft
  → Compiler validates and freezes an ExecutionBaseline
  → Runtime schedules execution/review nodes
  → sealed Submissions, criterion-complete approvals, rework, and final delivery
```

Each execution or review node currently binds one AgentCard and one persistent Pi AgentSession. Forward dependencies
come from typed inputs and remain a DAG; review rework returns to the responsible execution Session without changing
the frozen acceptance criteria.

## Main capabilities

- TaskInput, ProcessSpec v2, WorkflowDefinition v2, ExecutionBaseline, and Runtime state contracts.
- Versioned AgentCard, ProcessSpec, Skill, Tool, and Workflow asset loading.
- Dedicated `process-selection` and `workflow-design` Skills bound only to their corresponding control-role Sessions.
- Incremental Workflow draft tools with revision and operation idempotency.
- Compiler checks for assets, permissions, output ownership, complete Gate coverage, ProcessSpec criterion/evidence
  mappings, requirement coverage, and independent review.
- Shared Run workspace with non-overlapping execution output roots and sealed, hashed Submission copies.
- Parallel ready-node scheduling, exact input-version binding, local and cross-node rework invalidation, and final
  delivery projection.
- Query-only `ipd_get_run`, `ipd_read_events`, and `ipd_get_result` tools.

Run data is stored under `<project>/.pi/ipd/runs/<run-id>/`; reusable Workflow assets are stored under
`<project>/.pi/ipd/workflow/`.

## Current boundaries

- No node-internal multi-Agent collaboration, budget governance, HITL, asset self-evolution, or complete replan flow.
- File `read/write/edit` calls are path-scoped, and review nodes cannot receive mutation or general-purpose Shell
  tools. Execution-node Bash still requires a trusted environment or an external sandbox for system-level isolation.
- State serialization and request idempotency are single-process; active Runs cannot resume their original
  AgentSessions after process loss.
- `packages/ipd/docs/develop/` contains retired V1 documentation and is not the V2 capability reference.

The package requires Node.js 24.
