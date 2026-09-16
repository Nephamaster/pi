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
- PR: https://github.com/Nephamaster/pi/pull/11 (Draft).
- Changes: real-Pi/faux-provider contract tests, a native/governance CI lane,
  reuse of the existing shared Vitest source aliases, catalog hydration in CI,
  and the ownership/settings/behavior/retirement inventory in
  `packages/ipd/docs/refactor-baseline.md`.
- No production source, assets, Schema, permissions, dependencies or lockfile
  changes relative to main. Existing Docker scenarios and assertions are intact;
  its CI job now prepares the generated model data required by source imports.

## Verification status

Local authoring used Node 22.16.0 without Docker or a complete installed checkout;
terminal GitHub DNS was unavailable. Local syntax checks are not type checking or
executed behavior tests. Sources, writes and actual CI were accessed via GitHub.

CI exposed and corrected two test-bootstrap gaps: absent generated catalog JSON
and IPD's standalone Vitest aliases resolving to nonexistent dist entries. Use
`hydrate:model-data` / `check:model-data` and the repository's shared source aliases,
not mock catalogs or copied dependency implementations. Hydration reads public
metadata; test model calls use faux responses and no real credentials.

Actual run `35088997984` on head `51dde599`:
- Entry graph and new-test Biome checks: passed.
- Native Pi: 7 suites / 165 tests passed.
- IPD: 14 suites passed; 75 tests passed and 1 new assertion failed.

That assertion conflated semantic submission rejection with Pi's transport-level
`tool_execution_end.isError`. In current `agent-loop.ts`, a normally returned tool
result is marked non-error unless `afterToolCall` overrides it; `AgentToolResult`
does not declare a returned `isError` flag. IPD's submission tool nevertheless
returns one, so this does not currently increment event-based tool-error counters.
PR 2 must resolve that adaptation intent explicitly, not preserve a silent mismatch.
The baseline now verifies the actual business contract instead: no premature
capture, rejection and corrective diagnostics delivered to the next model call,
no model retry, corrected capture, and termination only for the valid receipt.
It does not assert that the observed false error flag is desirable.

The next run also performs repository type checking. Results are pending.
Existing general CI previously failed during Node 22/npm 10 installation with
EBADPLATFORM for clipboard-darwin-arm64, before build/tests. No force install or
lockfile mutation is used here to hide that separate baseline obstacle.

## Resume point

Inspect PR 11 head and all CI results first. Fix newly added tests and test setup
without changing production behavior or weakening governance. Record pre-existing
failures separately. Keep Draft until verification/review is sufficient; do not
merge automatically. PR 2 begins mechanism removal only after baseline acceptance.
