# IPD execution Profiles

This directory builds the only new execution backend supported by IPD: Linux Docker/OCI. Both Profiles share the
same Provider and differ only in declared capabilities and image contents.

## Build and verify

From the repository root:

```bash
./packages/ipd/environments/build.sh
PI_IPD_DOCKER_INTEGRATION=1 \
  node node_modules/vitest/dist/cli.js --run packages/ipd/test/docker-provider.integration.test.ts
```

The build creates `pi-ipd/code-node24:1.0.0` and `pi-ipd/office-pptx:1.0.0`. Runtime resolves these tags to the
Engine's actual `sha256` image ID and `linux/amd64` or `linux/arm64` platform before compiling a Run. Tags are never
used as the frozen execution identity.

The real integration test does not call an LLM. It verifies code install/build/test, local HTTP, Unix sockets,
managed processes, cancellation, input rebinding, all Pi file/search/image/Bash tools, paused output export, and a
multilingual PPTX with chart and notes through LibreOffice and Poppler.

## Locked inputs

- Base image: `node:24.19.0-bookworm-slim` at the digest in `code-node24/Dockerfile`.
- Direct Debian packages are pinned to the versions observed in the tested Bookworm snapshot.
- PptxGenJS uses `package-lock.json` and `npm ci --ignore-scripts`.
- `image-size` is overridden to 2.0.3 because the version range requested by PptxGenJS 4.0.1 contains known
  denial-of-service vulnerabilities. The real PPTX smoke protects API compatibility.
- Python direct and transitive dependencies are pinned in `requirements.lock` and installed into a private venv.
- Noto CJK and Liberation fonts come from Debian packages under their packaged licenses; no commercial font files are
  downloaded or committed.

The image ID proves the exact locally built content used by a Run. The Dockerfiles and locks make changes reviewable,
but this version does not claim bit-for-bit reproducible builds across different Docker/apt implementations.

## Runtime boundary

Containers run as UID/GID 1000 with `network=none`, a read-only root, no added capabilities, no-new-privileges, and
memory/CPU/PID/log limits. Only Provider-private context, Skill, input, workspace, scratch, cache, Home and tmp paths
are mounted. Docker socket, host Home, project root, Run root and credentials are never mounted.

Restricted internet egress is not implemented. A Profile or Skill requiring it fails static/runtime admission instead
of receiving the default Docker bridge network.

For migration rollback, start Pi with `PI_IPD_ENVIRONMENT_MODE=legacy-srt`. This is an explicit old backend, not an
automatic fallback, and lacks the OCI isolation and stable export guarantees.
