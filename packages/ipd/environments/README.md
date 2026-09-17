# IPD execution Profiles

This directory builds the only new execution backend supported by IPD: Linux Docker/OCI. Both Profiles share the
same Provider and differ only in declared capabilities and image contents.

## Build and verify

From the repository root:

```bash
node scripts/generate-ipd-bridges.mjs
./packages/ipd/environments/build.sh
PI_IPD_DOCKER_INTEGRATION=1 \
  node node_modules/vitest/dist/cli.js --run packages/ipd/test/docker-provider.integration.test.ts
```

The build creates `pi-ipd/code-node24:1.0.0` and `pi-ipd/office-pptx:1.0.0`. Runtime resolves these tags to the
Engine's actual `sha256` image ID and `linux/amd64` or `linux/arm64` platform before compiling a Run. Tags are never
used as the frozen execution identity.

The real integration test does not call an external model API. It verifies code install/build/test, local HTTP, Unix sockets,
managed processes, cancellation, input rebinding, all Pi file/search/image/Bash tools, paused output export, and a
multilingual PPTX through the repository's actual PPTX Skill validator and renderer. An ordinary Pi SDK session with
a faux provider also uses the same Workspace tools, without an IPD Runtime.

`build.sh` forwards extra arguments to both `docker build` calls, including proxy build arguments when required.
The Docker daemon proxy does not automatically configure package downloads inside build steps.
For concurrent development, set `PI_IPD_CODE_IMAGE` and `PI_IPD_OFFICE_IMAGE` to unique local tags for both the build
script and integration test. The Office recipe uses the selected code image as its base. Production template references
remain explicit; these test/build variables do not silently change a Run's frozen image identity.

## Bridge and preflight contract

`src/environment/bridge` is the sole implementation of the versioned request protocol and command launcher.
`common/*-bridge.mjs` files are generated artifacts; `npm run check:ipd-bridges` detects stale copies. Rebuild both
images after bridge changes. Startup checks the bridge version and never falls back to host execution.

Normal Bash, full-output Bash, managed processes and probes use explicit argv, cwd and the same Profile environment.
Bash uses `--noprofile --norc`; host shell startup files and variables are not inherited. Logs are bounded by the Profile
limit and include a truncation marker; managed logs are paginated. Process acknowledgement confirms spawn, not service readiness.
An omitted Bash timeout does not inherit Docker management-command timeouts; explicit tool deadlines and cancellation
still apply. Management calls and capability probes retain their own bounded deadlines.

Skills may declare `environment-requirements.probes`, with `id`, `version`, `command` (argv) and `timeoutSeconds`.
`$SKILL_DIR` in an argument resolves to the locked Skill path. These probes execute through the actual Pi Bash tool
before model work begins. The PPTX Skill checks its validator, thumbnail, Office wrapper and JavaScript dependencies.

## Locked inputs

- Base image: `node:24.19.0-bookworm-slim` at the digest in `code-node24/Dockerfile`.
- Direct Debian packages are pinned to the versions observed in the tested Bookworm snapshot.
- PptxGenJS, React, react-dom, react-icons and sharp use `package-lock.json` and `npm ci --ignore-scripts`.
- `image-size` is overridden to 2.0.3 because the version range requested by PptxGenJS 4.0.1 contains known
  denial-of-service vulnerabilities. The real PPTX smoke protects API compatibility.
- Python direct and transitive dependencies are pinned in `requirements.lock` and installed into a private venv.
- Noto CJK and Liberation fonts come from Debian packages under their packaged licenses; no commercial font files are
  downloaded or committed.

The image ID proves the exact locally built content used by a Run. The Dockerfiles and locks make changes reviewable,
but this version does not claim bit-for-bit reproducible builds across different Docker/apt implementations.

## Runtime boundary

Containers run as the non-root host UID/GID with `network=none`, a read-only root, no added capabilities, no-new-privileges, and
memory/CPU/PID/log limits. Only Provider-private context, Skill, input, workspace, scratch, cache, Home and tmp paths
are mounted. Docker socket, host Home, project root, Run root and credentials are never mounted.

Restricted internet egress is not implemented. A Profile or Skill requiring it fails static/runtime admission instead
of receiving the default Docker bridge network.

The default entry requires an execution backend for built-in I/O tools. Control roles have a separate read-only tool
for their locked Skill assets. Generic consumers can import `@earendil-works/pi-ipd/workspace` without workflow governance.

Legacy compatibility is exported only by `@earendil-works/pi-ipd/legacy`; load its default extension explicitly and
install its optional peer `@anthropic-ai/sandbox-runtime@0.0.26` when needed. Setting `PI_IPD_ENVIRONMENT_MODE=legacy-srt`
on the normal entry is insufficient. Legacy lacks the OCI isolation and stable export guarantees; Docker failures never
activate it automatically. Source and compiled entry graphs can be checked with `node scripts/check-entry-graphs.mjs`
and, after compilation, `node scripts/check-entry-graphs.mjs --installed-ipd`.
