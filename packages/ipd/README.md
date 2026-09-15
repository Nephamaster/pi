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

## Interactive launch

In Pi interactive mode, run `/ipd` to select an executable ProcessSpec, optionally select a compatible saved Workflow
asset, enter the verbatim task in a multiline editor, and attach task materials. Selecting a ProcessSpec skips the
Process Selector. Selecting both a ProcessSpec and a Workflow asset also skips the Workflow Designer: IPD rebinds the
template to the current TaskInput and ProcessSelection, compiles it deterministically, and activates Runtime only when
the template remains valid. Workflow templates already contain their node AgentCard assignments.

## Main capabilities

- TaskInput and ProcessSpec v2, WorkflowDefinition v3, ExecutionBaseline, and Runtime state contracts.
- Versioned AgentCard, ProcessSpec, Skill, Tool, and Workflow asset loading.
- Dedicated `process-selection` and `workflow-design` Skills bound only to their corresponding control-role Sessions.
- Incremental Workflow draft tools with revision and operation idempotency.
- Compiler checks for assets, permissions, output ownership, complete Gate coverage, ProcessSpec criterion/evidence
  mappings, requirement coverage, and independent review.
- Shared Run workspace with non-overlapping execution output roots and independently sealed, hashed output views.
- Bounded ready-node scheduling, exact input-version binding, local and cross-node rework invalidation, and final
  delivery projection.
- Run control through `ipd_cancel_run`, plus query-only `ipd_get_run`, `ipd_read_events`, and `ipd_get_result` tools.
- Zero-dependency local visualization for TaskInput, ProcessSpec selection, live Workflow draft/compiled graph, node
  execution state, review/rework routes, Runtime events, and downloadable self-contained HTML snapshots.

## Local visualization

The default IPD Extension starts a lightweight Node.js HTTP dashboard when the first Run is accepted. No React,
Vite, WebSocket server, graph library, or other frontend dependency is added to the IPD package. The page uses a
small self-contained HTML/CSS/JavaScript client and native SVG for the Workflow graph.

`ipd create_run` returns two additional links when visualization starts successfully:

```text
Visualization: http://127.0.0.1:<port>/runs/<run-id>
Snapshot:      http://127.0.0.1:<port>/runs/<run-id>/snapshot.html
```

The live page polls a read-only JSON projection of the existing Run state and `workflow-draft.json`; visualization
does not mutate Runtime state. As the Workflow Designer incrementally builds the managed draft, the graph appears and
updates. After compilation, the same view switches to the frozen execution graph and overlays live node status,
rounds, reviews, rework relationships, and recent events.

The snapshot endpoint returns a single standalone HTML file with the current projection embedded. It does not require
the IPD server after download, so it can be archived or shared as a point-in-time Workflow snapshot.

By default the server binds only to loopback:

```text
PI_IPD_DASHBOARD_HOST=127.0.0.1
PI_IPD_DASHBOARD_PORT=0
```

Port `0` asks the OS for a free local port. To let other machines on a trusted LAN view the page, explicitly bind all
interfaces and optionally choose a fixed port:

```bash
PI_IPD_DASHBOARD_HOST=0.0.0.0 PI_IPD_DASHBOARD_PORT=8765 pi
```

The dashboard currently has no authentication layer, so do not expose `0.0.0.0` on an untrusted network or public
interface. The page can contain the original task, requirements, ProcessSpec rationale, Workflow contracts, employee
assignments, and Runtime events.

Run data is stored under `<project>/.pi/ipd/runs/<run-id>/`; reusable Workflow assets are stored under
`<project>/.pi/ipd/workflow/`.

## Runtime safeguards

The default Runtime uses these safety limits:

```text
PI_IPD_MAX_CONCURRENT_NODES=4
PI_IPD_MAX_QUALITY_REWORK_ROUNDS=10
PI_IPD_ROUND_TIMEOUT_MS=1800000
```

Low-frequency state-write and round-duration metrics are appended outside authoritative Run state at
`<project>/.pi/ipd/telemetry.ndjson`. Run state writes use a per-file writer lock and fail closed when another process
is mutating the same Run.

## Current boundaries

- No node-internal multi-Agent collaboration, budget governance, HITL, asset self-evolution, or complete replan flow.
- File `read/grep/find/ls/write/edit` calls share path authorization, Bash uses the node sandbox, and review nodes
  cannot receive mutation or general-purpose Shell tools. Custom Tool behavior still requires explicit capability metadata.
- State mutation has cross-process conflict detection, but active Runs cannot resume their original
  AgentSessions after process loss.
- The visualization server is process-local and intentionally read-only; it does not provide remote control, approval,
  Run mutation, or authentication.
- `packages/ipd/docs/develop/` contains retired V1 documentation and is not the V2 capability reference.

The package requires Node.js 24.
