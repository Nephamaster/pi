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

Draft implementation; Node24 type checks, native/faux integration, governance
regressions and the existing real Docker workflow must run before review.
The working container lacks full repository dependencies and Docker; do not
claim local mock or syntax checks as full validation. General Node22 CI remains
outside scope as requested. Results will be recorded in the PR against the
verified head SHA.

Remaining in PR3/4/5: Run recovery/resource ownership, bounded cancellation,
unified Docker shell policy, storage projections and telemetry backend cleanup.
No production changes to those components belong in this PR.
