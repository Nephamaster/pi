# IPD refactor checkpoint

## Agreed sequence

1. Behavior baseline and native reuse inventory.
2. Session-policy simplification; remove duplicate model retries.
3. Run ownership, interruption/resume and bounded cancellation.
4. Unified Docker/tool execution path and real capability verification.
5. Governance internals, read model, frontend build and package boundaries.

Follow the approved overall refactor plan. Do not introduce a second agent loop,
context store, workflow engine or sandbox platform. Each later PR identifies the
previous owner that it removes or retires, not just a new wrapper.

## PR 1 scope

- Initial base: `3e7736d1433e785631fa524409e9ebfea689ef34`.
- Runtime audit base: `07095ad825ef76cd4d9896180233659447d3ca4f`.
- Main moved to `038dbde85f2431a06880399abfde2ff5eed9e3c8` during authoring.
  Its upstream merge is preserved by a merge into the feature branch, not a force push.
  The changed-file comparison contains no IPD source or selected test-path changes;
  native session/model-config changes remain covered by the actual merged CI run.
- Branch: `refactor/ipd-01-behavior-baseline`.
- PR: https://github.com/Nephamaster/pi/pull/11 (Draft).
- Changes: a real-Pi/faux-provider integration test, a fast native/governance CI lane,
  and `packages/ipd/docs/refactor-baseline.md` with dependency/ownership, effective
  settings, behavior matrix and retain/merge/retire lists.
- No production source, asset, Schema, permission, dependency or lockfile changes
  relative to main. Upstream changes are not authored by this PR.

## Verification status

This authoring environment has Node 22.16.0, no Docker, and cannot resolve
`github.com` from the terminal. Repository sources and CI were accessed through
GitHub; no older ZIP was substituted for current source.

Local TypeScript syntax parsing and YAML validation passed. They are not type
checking, Vitest, a complete repository build or real Docker execution.

The first real CI run (`35088161029`) checked the merged main/feature tree and
installed dependencies successfully. The entry-point graph check and 33 native
tests passed, but five suites failed during import because generated model JSON
was absent; the new IPD test had not run. The CI preparation now uses the existing
`hydrate:model-data` and `check:model-data` commands. This is public catalog data
preparation, not an inference call or a fabricated test fixture. Tests then run
with `PI_OFFLINE=1`. Native and IPD suites report independently without suppressing
failure or weakening assertions. The result of the revised run is still pending.

The PR remains Draft until its baseline and repository checks are verified. Keep
the existing real-Docker workflow unchanged and report its outcome separately.
No paid model calls or real credentials are used by the new test.

## Resume point

Inspect PR 11 head and CI first. Correct test/CI preparation issues in this batch,
but do not change production behavior or lower assertions to make PR 1 green.
Attribute pre-existing failures separately. Once the baseline is accepted, PR 2
uses it to remove duplicate model retry and consolidate session policy. Do not
merge automatically or start later mechanism deletion while it is unverified.
