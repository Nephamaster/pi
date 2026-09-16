# IPD refactor PR2 — native session policy

Base: `a6e30598b2f4a361a3b1a0051d0760f4cec09e2b` (PR1 and PR1.5 merged).

## Ownership and scope

Pi AgentSession owns provider retries, compaction and persisted message history.
IPD owns submission correction, quality rework and the frozen work contract.
The existing NodeSessionAdapter owns the participant-to-session binding and
forwards native events; it is not another model loop.

Removed `RetryingNodeWorker`, its stopped-round set and `technical_retry`
feedback. The default service dispatches PiNodeWorker directly. Exhausted model
errors do not replay the node; an aborted model result is cancellation rather
than a missing submission to be corrected. Existing Runtime correction/rework
loops, limits, approval rules and Workflow schemas are unchanged.

Removed `omitConsumedImages`. An intervening successful response is not proof
that image findings were saved. The native context hook only appends current
round data to the request view; Pi retains history and performs compaction.
No custom compactor, image checkpoint store, timer or model-request watchdog
was added. Image retention can increase requests until native compaction;
work-specific incremental QA remains the Skill's responsibility.

## Shared trusted settings

`session-policy.ts` selects only native `retry`, `compaction`,
`httpIdleTimeoutMs` and `images` settings, using Pi's own types and defaults.
The default extension reads the global agent settings through SettingsManager
with project settings disabled. Resource paths, extensions, shell commands,
credentials and project trust are not inherited. Corrupt global settings fail
explicitly. Programmatic consumers can pass `sessionSettings` to the worker or
control-role options.

The selected snapshot participates in the service cache key and execution
identity; existing sessions retain their own cloned snapshot. ST, designer,
execution and review all use the same factory. Model and thinking selection
remain governed by the existing card/run policy.

## Submission and observation adapters

Pi ignores a top-level `isError` returned by ToolDefinition.execute. The shared
factory now maps rejected IPD control receipts through the native `tool_result`
hook. It retains diagnostics and details, does not terminate rejected output,
and leaves successful sequential/terminating submissions unchanged. This also
makes existing tool-error counters see real submission rejections.

All role constructors forward native session envelopes. The existing NDJSON
sink receives allowlisted scalar metadata for retry, compaction, tool completion
and settled events, correlated with Run/node/participant/round. It does not store
model error text, prompts, summaries, tool payloads or image bytes. This is not a
second event framework or a replacement for the later telemetry/storage work.

## Migration

Callers constructing `RetryingNodeWorker` must use their NodeWorker directly and
configure Pi retry settings instead. `technical_retry` and `omitConsumedImages`
are intentionally retired exports, not retained as no-op compatibility APIs.
Restart to load the code and begin a new Run; do not reinterpret an active
Baseline in place. No Workflow template or Docker image changes are required.

## Verification

The first implementation `83e3cd565bd92ad260d39a2466f7ad807c268afd` was tested
on GitHub Actions with Node 24, against merge `1b36e9c9db2cbbf739205be410d5f7ea36ea7daf`:

- `35103217650`: repository type-check and entry graphs passed; native Pi
  regression 165/165 and expanded IPD suites 93/93 passed. This includes actual
  automatic compaction/resume and persisted compaction entries, image retention,
  native error flags, frozen retry policies and no whole-round replay.
- `35103217508`: the entire Docker integration workflow passed, including
  image builds, 6 native process tests, 4 real Docker cases and subsequent
  ordinary Pi and IPD governance regressions. No Docker source was changed.
- `npm run check` completed all its subcommands. The extra cleanliness guard
  caught six formatting issues in PR2 files, now fixed, plus pre-existing
  formatting drift in six unchanged files: mechanical-checker.ts, three
  dashboard files, asset-yaml-scalars.test.ts and visualization.test.ts.
  Root checks still run in full and report that drift. The additional guard
  requires PR2-owned files to remain clean; unrelated files are not reformatted
  in this scoped PR. No lint rule or functional assertion was relaxed.

The follow-up commit only applies the reported PR2 formatting and records this
boundary. Final head-specific verification is recorded in the PR description;
first-run evidence must not be represented as verification of a later head.
The working container has no Docker or complete repository dependencies.
General Node22 CI remains outside scope as requested.

Remaining in PR3/4/5: Run recovery/resource ownership, bounded cancellation,
unified Docker shell policy, storage projections and telemetry backend cleanup.
No production changes to those components belong in this PR.
