# IPD PR1.5 — managed process startup

Base: `551afcc18fe7320aee63b18fc47acdc7530cd848` (PR1 merged).

## Scope and cause

The WSL run and PR1 CI both failed the HTTP/Unix service and process-log tests,
while the Office smoke passed. `process-bridge.mjs` dropped `scratchRoot` when
starting its runner. The runner exited during argument validation, but the
caller returned success from a PID alone and discarded bootstrap stderr.

## Changes

- Forward one unchanged argument vector to the runner; resolve its own path with
  `fileURLToPath`, including paths containing spaces.
- Create the log before spawning and retain bootstrap stderr in it.
- Use Node IPC for a bounded (10-second) startup acknowledgement and ownership
  acceptance. A successful start means the log and metadata exist and Bash
  spawned, not that the application is ready or its command will exit zero.
- Failed or timed-out startup reports an error, terminates the detached process
  group, and records failure instead of returning a running handle.
- The runner owns running/exited metadata. Atomic replacement prevents readers
  from observing partial JSON; the starter no longer overwrites fast exits.
- Docker tests probe HTTP/Unix readiness and expected log content with deadlines;
  they no longer assume readiness after 200/300 ms. Missing logs are not hidden.

No Workflow, permission, Profile, dependency, model-retry, or ordinary Bash
launch-policy changes. Existing stop semantics remain; complete Run cancellation,
recovery, and unified Shell policy belong to the planned later refactor PRs.

## Verification

Local Node 22.16: all 6 native subprocess tests passed (no mocks, models, Docker,
or external dependencies). The local environment has no Docker or full repository
dependencies. Full lint/type checks and real Docker validation must be reported
from the Node 24 GitHub Actions run; local syntax checks are not integration proof.

```bash
node --test packages/ipd/test/process-bridge.test.mjs
bash packages/ipd/environments/build.sh
(cd packages/ipd && PI_IPD_DOCKER_INTEGRATION=1 \
  node ../../node_modules/vitest/dist/cli.js --run test/docker-provider.integration.test.ts --reporter=verbose)
```

Rebuild both images before retesting: the bridge is copied into the images;
`git pull` alone does not update existing images or active leases. Do not prune
unrelated containers, volumes, or task work. General CI's Node 22 / platform
installation issue is explicitly outside this PR.
