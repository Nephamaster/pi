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

- Base: `3e7736d1433e785631fa524409e9ebfea689ef34`.
- Runtime audit base: `07095ad825ef76cd4d9896180233659447d3ca4f`.
- Difference: the new base adds the approved plan document; production code is unchanged.
- Branch: `refactor/ipd-01-behavior-baseline`.
- Changes: a real-Pi/faux-provider integration test, a fast native/governance CI lane,
  and `packages/ipd/docs/refactor-baseline.md` with the dependency/ownership map,
  effective settings, behavior matrix and retain/merge/retire list.
- No production source, asset, Schema, permission, dependency or lockfile changes.

## Verification status

This authoring environment has Node 22.16.0, no Docker, and cannot resolve
`github.com` from the terminal. The live repository was read through the GitHub
connector; it was not replaced by an old ZIP. The connector can publish changes.

Only syntax/static checks possible in this environment are recorded in the PR.
They are not a substitute for Vitest, `npm run check`, a complete repository build,
or real Docker testing. At authoring time those suites have not run here.

The PR must remain Draft until the native/governance baseline and existing
repository checks are verified. The existing real-Docker workflow is retained;
its outcome is reported independently, with failures attributed rather than
hidden or bypassed. No paid model calls or real credentials are used by the new test.

## Resume point

Check the PR head and CI first. Correct new-test issues in this batch, but do not
alter production behavior or weaken existing assertions to make PR 1 green.
Record pre-existing failures separately. Once the baseline is reviewed and
accepted, PR 2 uses it to remove duplicate model retry and consolidate session
policy. Do not silently merge PRs or start later mechanism deletion while the
baseline is unverified.
