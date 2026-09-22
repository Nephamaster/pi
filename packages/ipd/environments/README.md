# IPD execution Profiles

This directory builds the only new execution backend supported by IPD: Linux Docker/OCI. All Profiles share the
same Provider and differ only in declared capabilities and image contents.

## Build and verify

From the repository root:

```bash
node scripts/generate-ipd-bridges.mjs
./packages/ipd/environments/build.sh
PI_IPD_DOCKER_INTEGRATION=1 \
  node node_modules/vitest/dist/cli.js --run packages/ipd/test/docker-provider.integration.test.ts
```

The build creates `pi-ipd/general-purpose:1.0.0`, `pi-ipd/code-node24:1.0.0` and `pi-ipd/office-pptx:1.0.0`. Runtime resolves these tags to the
Engine's actual `sha256` image ID and `linux/amd64` or `linux/arm64` platform before compiling a Run. Tags are never
used as the frozen execution identity.

The real integration test does not call an external model API. It verifies code install/build/test, local HTTP, Unix sockets,
managed processes, cancellation, input rebinding, all Pi file/search/image/Bash tools, paused output export, and a
multilingual PPTX through the repository's actual PPTX Skill validator and renderer. An ordinary Pi SDK session with
a faux provider also uses the same Workspace tools, without an IPD Runtime.

`build.sh` forwards extra arguments to all `docker build` calls, including proxy build arguments when required.
The Docker daemon proxy does not automatically configure package downloads inside build steps.
For concurrent development, set `PI_IPD_GENERAL_IMAGE`, `PI_IPD_CODE_IMAGE` and `PI_IPD_OFFICE_IMAGE` to unique local tags
for the build script and integration tests. The Office recipe uses the selected code image as its base. Production template references
remain explicit; these test/build variables do not silently change a Run's frozen image identity.

## Bridge and preflight contract

### General-purpose default

`general-purpose@1.0.0` supplies Node 24.19.0, Python 3.12.14, npm/pip/venv, Bash, Git, compiler/build tools,
curl/wget, ripgrep/find, jq/sqlite3, file/diff/patch, process inspection and tar/zip/gzip/bzip2/xz utilities.
Pinned Python packages include NumPy, pandas, PyYAML, jsonschema, openpyxl, requests, BeautifulSoup and lxml.
JSON/CSV/SQLite are also available through the Python standard library. Dependencies for a particular job remain
private project installs; Office, browsers and database servers are not preinstalled here.

The default is **2 CPUs, 2 GiB**, 512 PIDs and 8 MiB logs. Container networking remains disabled unless explicitly
authorized. curl/wget are transport tools, not a search engine; registered Pi search tools still require separate authorization.

Build only the new default (no changes to existing Code/Office images):

```bash
docker build -f packages/ipd/environments/general-purpose/Dockerfile \
  -t pi-ipd/general-purpose:1.0.0 packages/ipd/environments
cd packages/ipd
PI_IPD_DOCKER_INTEGRATION=1 node ../../node_modules/vitest/dist/cli.js --run test/general-environment.test.ts
```

Optional build arguments are `DEBIAN_MIRROR`, `DEBIAN_SECURITY_MIRROR` and `PIP_INDEX_URL`; defaults use the official
Debian/PyPI endpoints. Node and Python base images are digest-pinned. Python direct/transitive versions are locked;
Debian packages receive the configured Bookworm repository's updates and their exact versions are recorded in
`/opt/pi-ipd/system-packages.txt`. The frozen Runtime binding records the final image ID.

Missing general-purpose fails initialization; uninstalled optional Code/Office Profiles remain skippable. Explicit
Workflow `environment_ref` and actual capability needs still select specialized Profiles. Existing Runs are unchanged.

### Shared bridge

`src/environment/bridge` is the sole implementation of the versioned request protocol and command launcher.
`common/*-bridge.mjs` files are generated artifacts; `npm run check:ipd-bridges` detects stale copies. Rebuild all affected
images after bridge changes. Startup checks the bridge version and command-cancellation capability and never falls back to host execution.

Normal Bash, full-output Bash, managed processes and probes use explicit argv, cwd and the same Profile environment.
Bash uses `--noprofile --norc`; host shell startup files and variables are not inherited. Logs are bounded by the Profile
limit and include a truncation marker; managed logs are paginated. Process acknowledgement confirms spawn, not service readiness.
An omitted Bash timeout does not inherit Docker management-command timeouts; explicit tool deadlines and cancellation
still apply. Management calls and capability probes retain their own bounded deadlines.

A foreground command owns a separate process group. Cancellation/timeout waits for its stop acknowledgement and leaves
unrelated managed services running. If acknowledgement fails, the Provider terminates and marks the lease unusable;
it never silently restarts the container. Pause deliberately stops all lease processes, retaining files and Session history,
not live process memory. Preparation and cleanup failures retain provisional resource ownership for retry.
File reads have a separate 64 MiB transport limit (`output_limit`), independent of Pi display truncation and Docker management
responses. Search results are limited inside the environment before transport.

Skills may declare `environment-requirements.probes`, with `id`, `version`, `command` (argv) and `timeoutSeconds`.
`$SKILL_DIR` in an argument resolves to the locked Skill path. These probes execute through the actual Pi Bash tool
before model work begins. The PPTX Skill checks its validator, thumbnail, Office wrapper and JavaScript dependencies.

Use `environment-requirements.project-probes` for dependencies the Agent can prepare inside its project. These run before
artifact export; failures request correction in the same Session rather than rejecting the environment before work starts.
Keep base-image capability probes under `probes`. Unknown task-specific npm/pip packages need not be listed in the Profile.
Code images include Python venv support; use `python3 -m venv --system-site-packages /workspace/.venv` and that interpreter
explicitly. Install npm dependencies locally and retain lockfiles/version records. System packages remain image-owned.

## Locked inputs

- Base image: `node:24.19.0-bookworm-slim` at the digest in `code-node24/Dockerfile`.
- Code/Office direct Debian packages are pinned to the versions observed in the tested Bookworm snapshot; general-purpose records installed OS versions as described above.
- PptxGenJS, React, react-dom, react-icons and sharp use `package-lock.json` and `npm ci --ignore-scripts`.
- `image-size` is overridden to 2.0.3 because the version range requested by PptxGenJS 4.0.1 contains known
  denial-of-service vulnerabilities. The real PPTX smoke protects API compatibility.
- Python direct and transitive dependencies are pinned in each `requirements.lock`: general-purpose installs them in
  the read-only Python base; Office uses `/opt/pi-ipd/venv`. Node-created project venvs remain private and writable.
- Noto CJK and Liberation fonts come from Debian packages under their packaged licenses; no commercial font files are
  downloaded or committed.

The image ID proves the exact locally built content used by a Run. The Dockerfiles and locks make changes reviewable,
but this version does not claim bit-for-bit reproducible builds across different Docker/apt implementations.

## Runtime boundary

Containers run as the non-root host UID/GID with a read-only root, no added capabilities, no-new-privileges, and
memory/CPU/PID/log limits. Only Provider-private context, Skill, input, workspace, scratch, cache, Home and tmp paths
are mounted. Docker socket, host Home, project root, Run root and credentials are never mounted.

Networking defaults to `none`. To explicitly authorize public destinations before starting Pi, set for example:

```bash
export PI_IPD_ALLOWED_ENDPOINTS='example.com,registry.npmjs.org,pypi.org,files.pythonhosted.org'
```

This freezes a restricted policy into each Profile/Binding. Requires Docker Engine 28+ on Linux. Each lease has an internal
`isolated` bridge and a separate proxy sidecar, with no published ports or task mounts. Only the sidecar has external routing.
HTTP/HTTPS proxy variables are supplied to commands and managed processes. Removing them does not grant direct egress.
The proxy authenticates the lease, checks exact/wildcard hostnames, rejects private/loopback/link-local/host addresses and
nonstandard ports, and pins DNS answers. IPv6, arbitrary TCP and SSH are not supported. Add required redirect/CDN hosts explicitly.
`*` permits all public IPv4 hosts: use only for tasks whose data is authorized to leave the environment. Domain filtering cannot
prevent exfiltration to an allowed host. Network access, malicious web content and dependency supply chains remain trust decisions.

Internet tools provided by Pi extensions are a separate path, not container commands. Register the extension normally, then
authorize audited read-only service tools with `PI_IPD_EXTERNAL_READ_TOOLS=web_search,fetch_content` (actual registered names).
IPD retains their original schema/implementation and never provides a search engine or same-name substitute. Such tools run
in the control process: do not authorize extensions that capture host filesystem/Shell access or perform external writes.
AgentCards and Workflow bindings must still permit each tool. SDK users can provide the same trusted options to
`registerDefaultIpdExtension`. A service tool can work while container networking remains disabled.

Docker review nodes may bind authorized write/edit/Bash tools for their own private `/workspace`. Copy sealed inputs there
for build/test/render activities; `/ipd/inputs` remains read-only. Reviews cannot export replacement submissions or perform
external actions. Legacy shared-workspace reviews remain read-only.

Opt-in real network verification (public example page and pinned test dependencies, no model API):

```bash
PI_IPD_NETWORK_INTEGRATION=1 node node_modules/vitest/dist/cli.js --run packages/ipd/test/network-environment.integration.test.ts
```

The default entry requires an execution backend for built-in I/O tools. Control roles have a separate read-only tool
for their locked Skill assets. Generic consumers can import `@earendil-works/pi-ipd/workspace` without workflow governance.

Legacy compatibility is exported only by `@earendil-works/pi-ipd/legacy`; load its default extension explicitly and
install its optional peer `@anthropic-ai/sandbox-runtime@0.0.26` when needed. Setting `PI_IPD_ENVIRONMENT_MODE=legacy-srt`
on the normal entry is insufficient. Legacy lacks the OCI isolation and stable export guarantees; Docker failures never
activate it automatically. Source and compiled entry graphs can be checked with `node scripts/check-entry-graphs.mjs`
and, after compilation, `node scripts/check-entry-graphs.mjs --installed-ipd`.
