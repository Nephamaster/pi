# IPD refactor checkpoint

## Agreed sequence

1. Behavior baseline and native reuse inventory.
2. Session-policy simplification; remove duplicate model retries.
3. Run ownership, interruption/resume and bounded cancellation.
4. Unified Docker/tool execution path and real capability verification.
5. Governance internals, read model, frontend build and package boundaries.

Follow the approved overall plan. Do not introduce a second agent loop, context
store, workflow engine or sandbox platform. Each later PR identifies the previous
owner it removes or retires, not merely a new wrapper.

## PR 1 scope

- Initial base: `3e7736d1433e785631fa524409e9ebfea689ef34`.
- Runtime audit base: `07095ad825ef76cd4d9896180233659447d3ca4f`.
- Main moved to `038dbde85f2431a06880399abfde2ff5eed9e3c8` during authoring.
  Its upstream merge was preserved by merging into the feature branch, not by
  force-pushing or overwriting user changes.
- Branch: `refactor/ipd-01-behavior-baseline`.
- PR: https://github.com/Nephamaster/pi/pull/11 (Draft, not merged).
- Changes: real-Pi/faux-provider contract tests, a native/governance CI lane,
  reuse of shared Vitest source aliases, catalog hydration in CI, and the
  ownership/settings/behavior/retirement inventory in
  `packages/ipd/docs/refactor-baseline.md`.
- No production source, assets, Schema, permissions, dependencies or lockfile
  changes relative to main. Existing Docker scenarios and assertions are intact;
  its CI job now prepares the generated model data required by source imports.

## Verified implementation commit

`0d37feef3b0fcb551a92b10f86dbb663aed22aec`, tested against main `038dbde8`.
A subsequent checkpoint-only commit records these results; it does not alter the
verified tests, test configuration, CI workflows or production code.

### Native / governance lane: passed

https://github.com/Nephamaster/pi/actions/runs/35089584979

Actual GitHub Actions Node 24 run:
- Install and official model-data hydration/check: passed.
- Existing entry-point graph checks: passed.
- Baseline formatting/lint step: passed.
- Repository `tsgo --noEmit`: passed.
- Native Pi: 7 suites / 165 tests passed.
- IPD: 15 suites / 76 tests passed, including all 5 newly added contract tests.
- Total selected behavior tests: 241 passed. This is not the full repository test
  suite, a production-model evaluation, or a complete build/release verification.

Only provider responses use faux; Pi sessions, retries, persisted history,
submission validation and synthetic file side effects execute normally. No real
model credentials or paid inference calls are used.

### Existing Docker integration: 1 passed, 2 failed

https://github.com/Nephamaster/pi/actions/runs/35089584981

Both code-node24 and office-pptx images built successfully. The real integration
suite ran, rather than being skipped or replaced by mocks.

- Passed: multilingual PPTX generation, notes/chart, PDF conversion, rendered
  image, extracted text and font checks. This single-page smoke is not complete
  production Skill or long-run acceptance.
- Failed: code Profile's managed HTTP/Unix service client exited 1 at
  `test/docker-provider.integration.test.ts:118`, where 0 is required. Assertions
  later in that same test (including cancellation) were not reached.
- Failed: unified tool-route case could not open the managed process log under
  `/scratch/.ipd-processes/<id>.log` (ENOENT, fs-bridge).
- Downstream regression steps in this job did not run after the failure; their
  overlapping native/governance coverage passed in the separate lane above.

The production Provider/bridge and these assertions are unchanged by PR 1.
These results expose existing process/service/log paths needing repair. They are
consistent with the prior bridge-protocol finding, but do not by themselves prove
that every failure has one cause. Preserve the failing expectations for PR 4;
no accepting exit 1, ignoring missing logs, or force-green fallback.

### General CI: installation blocked

https://github.com/Nephamaster/pi/actions/runs/35089584980

The existing Node 22.23.2/npm 10.9.8 job fails in `npm ci --ignore-scripts` with
EBADPLATFORM for `@mariozechner/clipboard-darwin-arm64@0.3.9` on Linux x64.
Build/check/test steps do not run. Node-engine messages are warnings, not the
reported fatal error. Dependencies, lockfile and this job are unchanged in PR 1;
record the baseline toolchain/package issue rather than force installation.

## Bootstrap corrections and adaptation finding

CI first exposed absent generated catalog JSON and standalone IPD Vitest aliases
resolving to nonexistent dist entries. Reuse `hydrate:model-data`,
`check:model-data` and `vitest.base.ts`; do not mock catalogs or copy dependencies.
Hydration reads public metadata, not model inference. Faux tests then run offline.

One new assertion incorrectly equated semantic submission rejection with Pi's
transport-level `tool_execution_end.isError`. Current `AgentToolResult` does not
expose a returned isError flag; the loop derives the event flag from exceptions
or afterToolCall. IPD nevertheless returns isError for rejection, so event-based
error counters do not currently count this as intended. PR 2 must resolve that
adaptation explicitly, not preserve the mismatch as a desired API.

The corrected test verifies the stronger business boundary: no premature capture,
rejection/corrective diagnostics delivered to the next model call, no model retry,
corrected capture, and termination only for the valid receipt. It does not assert
that the observed false event-error flag is desirable.

## Resume point

PR 1 implementation and the selected behavioral baseline are verified; overall
CI is not green. Keep Draft pending review/triage of the two existing failure
classes. Inspect the current head and CI before further work. Do not merge
without authorization, erase failed checks, weaken tests, or quietly fold unrelated
production changes into this baseline batch. PR 2 begins after the baseline and
its explicitly recorded known failures are accepted. No later PR is created yet.
