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

Templates may declare `prerequisites: { minimum_materials: 1, retrieval_tools: ["search_sources"] }`.
The Compiler requires either enough user-supplied materials or a registered retrieval tool actually bound to an
execution node (normal AgentCard/Profile checks still apply). Without either, compilation reports
`workflow_prerequisite_missing`; provide sources or explicitly adapt the Workflow using the Designer. The Compiler
does not infer that an arbitrary URL or a passing structural check proves sufficient research. Final reviewers must
evaluate assigned quality criteria against the preserved original task, including substantive content adequacy.

## Main capabilities

- TaskInput and ProcessSpec v2, WorkflowDefinition v3, ExecutionBaseline, and Runtime state contracts.
- Versioned AgentCard, ProcessSpec, Skill, Tool, and Workflow asset loading.
- Dedicated `process-selection` and `workflow-design` Skills bound only to their corresponding control-role Sessions.
- Incremental Workflow draft tools with revision and operation idempotency.
- Compiler checks for assets, permissions, output ownership, complete Gate coverage, ProcessSpec criterion/evidence
  mappings, requirement coverage, and independent review.
- Per-node controlled execution leases with non-overlapping output roots and independently sealed, hashed output views.
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

The server caches the versioned dashboard projection using state/draft file versions. Unchanged polls return HTTP 304
with a revision ETag and do not reread Run history or rebuild the page. The client uses the same typed renderer for
live and offline views; TS/CSS are bundled by `scripts/generate-ipd-dashboard.mjs` using esbuild. Generated assets are
embedded in HTML and checked for source consistency by `npm run check:ipd-dashboard`.

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

The on-disk state snapshot uses `storageVersion: 1` and hash references to immutable `objects/<hash>.json` files for
Baseline, task, selection and locked static assets. Back up the whole Run directory, not just `state.json`.
`FileRunStore.read()` and `ipd_get_run` still return a hydrated RunState. Existing inline snapshots are read and migrated
on their next committed mutation. Business state, audit events and operation idempotency remain in one atomic state
replacement; object files are durable before publication. Interrupted writes can leave unreferenced object files;
these are retained, not automatically deleted from a potentially active Run.

## Controlled execution environments

The default mode is Docker/OCI. Build the two trusted local Profiles before starting a Run:

```bash
./packages/ipd/environments/build.sh
```

`code-node24` supplies Node.js 24, npm, Git, Python, build tools, and ripgrep. `office-pptx` extends it with
PptxGenJS, the PPTX Skill's Python dependencies, LibreOffice, Poppler, fontconfig, Liberation fonts, and Noto CJK.
Profile templates contain only trusted image references; service initialization resolves each reference to the current
immutable Docker image ID and platform. A missing or changed image fails before Workflow execution and never falls
back to the host.

An uninstalled optional Profile is omitted from the executable catalog with a diagnostic. A text-only Workflow can
therefore use `code-node24` without an Office image. Docker connection errors still fail initialization; a task requiring
an unavailable capability fails compilation. Existing Runs retain their frozen image identities.

Each node receives one lease that survives normal rounds and rework. All local `read`, `write`, `edit`, `grep`, `find`,
`ls`, image reads, Bash, full command logs, and managed processes use the same private filesystem. The model sees only:

```text
/ipd/context/                  frozen task and node context, read-only
/ipd/skills/<id>/<hash>/      content-addressed Skill snapshot, read-only
/ipd/inputs/<input-id>/       exact current-round input, read-only
/workspace/                   node worktree under Workflow permissions
/scratch/ /cache/ /home/agent/ /tmp/   lease-private writable state
```

`/workspace` is the node-private business workspace and the default command cwd. Execution nodes may use its root for
source files, build configuration, dependencies, and intermediate work without declaring every temporary directory as
an Artifact. The Runtime validates cwd against the environment layout, independently of file access and export rules.
Context, Skill snapshots, and exact round inputs remain read-only mounts. Only files below `/workspace/outputs` that
also belong to a frozen output contract can be exported and sealed; writable files are not automatically publishable.

The container has no host root, Home, Run root, credential directory, or Docker socket mount. It runs as the
non-privileged invoking host UID/GID, with a read-only image root, dropped capabilities, `no-new-privileges`,
default `network=none` (or explicitly authorized proxy-only egress), and enforced memory/CPU/PID/log
limits. At preparation time the Provider uses the invoking host identity and verifies that the container process can
traverse read-only roots and write every private runtime root; it fails before node execution instead of relaxing
permissions. Container environment variables start from the Profile allowlist instead of inheriting the Pi process.

See [environment configuration](environments/README.md) for `PI_IPD_ALLOWED_ENDPOINTS` and
`PI_IPD_EXTERNAL_READ_TOOLS`: container egress and registered Pi service tools are authorized separately. IPD does not
implement its own web search. Project npm/Python dependencies can be installed privately; base software remains image-owned.
Docker reviewers may use authorized file/Shell tools in their own inspection workspace without modifying sealed inputs.

For temporary migration only, explicitly select the old sandbox-runtime backend before launching Pi:

```bash
PI_IPD_ENVIRONMENT_MODE=legacy-srt pi
```

`legacy-srt` is never selected after a Docker failure. It retains the old host-workspace architecture and does not
provide OCI leases, managed processes, stable paused export, or the same host-filesystem isolation. Remove this setting
after the Docker Profiles are deployed. `PI_IPD_DOCKER_TIMEOUT_MS` controls Docker management-operation timeout and
defaults to 120000 ms.

## Runtime safeguards

The default Runtime uses these safety limits:

```text
PI_IPD_MAX_CONCURRENT_NODES=4
PI_IPD_MAX_QUALITY_REWORK_ROUNDS=10
PI_IPD_ROUND_TIMEOUT_MS=0
```

Whole-round deadlines are disabled by default: an omitted value or `0` permits long-running work without an elapsed-time
cutoff. Only an explicitly configured positive value enables a round deadline. Optional `PI_IPD_SOFT_ROUND_TIMEOUT_MS`
requests a checkpoint but does not stop the node, and can be used without a hard deadline. Individual command, network,
preflight and cleanup deadlines remain separate. Running Pi processes retain the configuration they already loaded.

For registered `pi-web-access` tools, the controlled-session adapter copies returned PDF Markdown files from the specific
extraction cache into `/workspace/.external-content/<content-hash>.md` before presenting the path to the node. It validates
the extraction directory, regular-file status, size, source URL and reported character count; it does not mount host `/tmp`
or grant arbitrary host reads. The registered tool schema and fetch implementation are unchanged. HTML/search paging still
requires `get_search_content` to be explicitly authorized and bound when the tool returns a `responseId`; authorization
alone does not add a tool to a frozen Workflow. This adapter targets the default pi-web-access tool names and PDF response
format, not arbitrary file paths in other external tools' prose.

Low-frequency state-write and round-duration metrics are appended outside authoritative Run state at
`<project>/.pi/ipd/telemetry.ndjson`. Run state writes use a per-file writer lock and fail closed when another process
is mutating the same Run.

Native Session observations include model message duration/token counts, tool duration/ToolCall identity and native
retry/compaction counts. State mutations also expose the Pi `TelemetryContext` contract through a local metadata-only
exporter. Model message duration is not a breakdown of provider queue/transport time. Prompts, tool payloads, headers
and free-form provider errors are not written to telemetry.

## Build and verify

Root `npm run build` and `npm run build:offline` build IPD after coding-agent. The offline command requires hydrated
model data. Both generate and type-check the dashboard; bridge consistency is checked before compiling IPD.
`npm run check:ipd-install` consumes the real npm-packed file set in a temporary directory using current workspace
dependencies; it does not publish or claim a fresh registry installation. PPTX/React/icon/sharp runtime dependencies
belong to the Office image, not the host root package. Legacy users must provision their own task dependencies.
`node scripts/check-ipd-install.mjs --clean` additionally installs workspace tarballs and external npm dependencies in a clean
temporary directory without workspace dependency links. Private packages are not assumed to be published to npm.

## Current boundaries

- No node-internal multi-Agent collaboration, budget governance, HITL, asset self-evolution, or complete replan flow.
- Docker egress is optional and public HTTP/HTTPS only, enforced through per-lease proxy networking. Arbitrary host-bound
  extensions are not sandboxed by rebinding native Pi tools and must not be admitted as external read services.
- State mutation has cross-process conflict detection, but active Runs cannot resume their original
  AgentSessions after process loss.
- The visualization server is process-local and intentionally read-only; it does not provide remote control, approval,
  Run mutation, or authentication.
- `packages/ipd/docs/develop/` contains retired V1 documentation and is not the V2 capability reference.

The package requires Node.js 24.
