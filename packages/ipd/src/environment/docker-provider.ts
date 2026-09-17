// 实现单一 Docker/OCI Provider，统一容器生命周期、文件、命令和受管进程。
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { hashJson } from "../ir/hash.ts";
import { hashSkillPackage } from "../registry/skill-package.ts";
import { BRIDGE_VERSION, type BridgeRequest, encodeBridgeRequest, quoteCommand, shellArgv } from "./bridge/protocol.ts";
import {
	buildIsolatedEnvironment,
	type EnvironmentBinding,
	type EnvironmentDirectoryEntry,
	EnvironmentError,
	type EnvironmentExecRequest,
	type EnvironmentExecResult,
	type EnvironmentExportRequest,
	type EnvironmentExportResult,
	type EnvironmentFileStat,
	type EnvironmentLease,
	type EnvironmentProvider,
	type EnvironmentSearchMatch,
	type EnvironmentStaticAsset,
	type PreparedEnvironment,
	type ProcessHandle,
	type RoundBinding,
	throwIfAborted,
} from "./contracts.ts";
import type { DockerCommandRunner, DockerRunOptions, DockerRunResult } from "./docker-adapter.ts";
import {
	assertVirtualExportAllowed,
	assertVirtualPathAllowed,
	assertVirtualWorkingDirectoryAllowed,
	hashEnvironmentSource,
	hashWorkspaceState,
	materializeEnvironmentAssets,
	materializeEnvironmentInputs,
	resolveEnvironmentLayout,
} from "./paths.ts";

const COMMAND_EXIT_CODES = Array.from({ length: 256 }, (_value, index) => index);
const LEASE_ID = /^[a-f0-9-]{36}$/;
const PROCESS_ID = /^[a-f0-9-]{36}$/;

interface DockerLeaseState {
	containerName: string;
	root: string;
	contextRoot: string;
	skillsRoot: string;
	inputsRoot: string;
	workspaceRoot: string;
	scratchRoot: string;
	cacheRoot: string;
	homeRoot: string;
	binding: EnvironmentBinding;
	currentRound?: RoundBinding;
	assetHash?: string;
	processes: Map<string, ProcessHandle>;
	suspendedIdentity?: string;
	suspendedWorkspaceHash?: string;
}

export interface DockerEnvironmentProviderOptions {
	docker: DockerCommandRunner;
	storageRoot?: string;
	controllerId?: string;
}

function requireLeaseId(leaseId: string): void {
	if (!LEASE_ID.test(leaseId)) throw new EnvironmentError("policy_denied", `Invalid environment lease ID: ${leaseId}`);
}

function parseJson<T>(content: Buffer, description: string): T {
	try {
		return JSON.parse(content.toString("utf8")) as T;
	} catch (error) {
		throw new EnvironmentError("environment_lost", `Environment returned invalid ${description}`, { cause: error });
	}
}

function commandEnvironment(
	binding: EnvironmentBinding,
	overrides: Record<string, string> = {},
): Record<string, string> {
	return buildIsolatedEnvironment(binding.environment, {
		HOME: binding.paths.home,
		TMPDIR: binding.paths.temporary,
		TMP: binding.paths.temporary,
		TEMP: binding.paths.temporary,
		XDG_CONFIG_HOME: `${binding.paths.home}/.config`,
		XDG_CACHE_HOME: binding.paths.cache,
		PYTHONDONTWRITEBYTECODE: "1",
		...overrides,
	});
}

export class DockerEnvironmentProvider implements EnvironmentProvider {
	readonly kind = "docker";
	private readonly docker: DockerCommandRunner;
	private readonly storageRoot: string;
	private readonly controllerId: string;
	private readonly leases = new Map<string, DockerLeaseState>();

	constructor(options: DockerEnvironmentProviderOptions) {
		this.docker = options.docker;
		this.storageRoot = resolve(options.storageRoot ?? "/tmp/pi-ipd-environments");
		this.controllerId = options.controllerId ?? randomUUID();
	}

	async prepare(
		request: { leaseId: string; runId: string; binding: EnvironmentBinding },
		signal?: AbortSignal,
	): Promise<PreparedEnvironment> {
		throwIfAborted(signal);
		requireLeaseId(request.leaseId);
		if (request.binding.provider !== "docker" || !request.binding.image)
			throw new EnvironmentError("profile_incompatible", "Docker Provider requires a locked Docker image identity");
		if (request.binding.network.mode !== "none")
			throw new EnvironmentError(
				"profile_incompatible",
				"Restricted egress is not implemented; this Provider only accepts network mode none",
			);
		const existing = this.leases.get(request.leaseId);
		if (existing) return { providerHandle: existing.containerName, image: { ...request.binding.image } };

		const inspection = await this.docker.run(
			["image", "inspect", request.binding.image.reference, "--format", "{{.Id}}|{{.Os}}/{{.Architecture}}"],
			{ signal },
		);
		const [contentId, platform] = inspection.stdout.toString("utf8").trim().split("|");
		if (contentId !== request.binding.image.contentId || platform !== request.binding.image.platform)
			throw new EnvironmentError(
				"profile_incompatible",
				`Docker image identity changed for ${request.binding.image.reference}`,
			);
		const runtimeUid = process.getuid?.();
		const runtimeGid = process.getgid?.();
		if (runtimeUid === undefined || runtimeGid === undefined || runtimeUid === 0)
			throw new EnvironmentError(
				"environment_unavailable",
				"Docker environment preparation requires a non-root local host UID/GID",
			);

		const root = join(this.storageRoot, request.leaseId);
		const state: DockerLeaseState = {
			containerName: `pi-ipd-${request.leaseId}`,
			root,
			contextRoot: join(root, "context"),
			skillsRoot: join(root, "skills"),
			inputsRoot: join(root, "inputs"),
			workspaceRoot: join(root, "workspace"),
			scratchRoot: join(root, "scratch"),
			cacheRoot: join(root, "cache"),
			homeRoot: join(root, "home"),
			binding: structuredClone(request.binding),
			processes: new Map(),
		};
		await Promise.all(
			[
				state.contextRoot,
				state.skillsRoot,
				state.inputsRoot,
				state.workspaceRoot,
				state.scratchRoot,
				state.cacheRoot,
				state.homeRoot,
			].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })),
		);
		const environment = commandEnvironment(request.binding);
		const runtimeUser = `${runtimeUid}:${runtimeGid}`;
		const mount = (source: string, destination: string, readonly = false) =>
			`type=bind,src=${source},dst=${destination}${readonly ? ",readonly" : ""}`;
		const createArgs = [
			"create",
			"--name",
			state.containerName,
			"--label",
			"pi.ipd.managed=true",
			"--label",
			`pi.ipd.controller=${this.controllerId}`,
			"--label",
			`pi.ipd.lease=${request.leaseId}`,
			"--label",
			`pi.ipd.run=${hashJson(request.runId)}`,
			"--user",
			runtimeUser,
			"--network",
			"none",
			"--read-only",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--memory",
			String(request.binding.resources.memoryBytes),
			"--cpus",
			String(request.binding.resources.cpus),
			"--pids-limit",
			String(request.binding.resources.pids),
			"--log-driver",
			"local",
			"--log-opt",
			`max-size=${request.binding.resources.logBytes}`,
			"--mount",
			mount(state.contextRoot, request.binding.paths.context, true),
			"--mount",
			mount(state.skillsRoot, request.binding.paths.skills, true),
			"--mount",
			mount(state.inputsRoot, request.binding.paths.inputs, true),
			"--mount",
			mount(state.workspaceRoot, request.binding.paths.workspace),
			"--mount",
			mount(state.scratchRoot, request.binding.paths.scratch),
			"--mount",
			mount(state.cacheRoot, request.binding.paths.cache),
			"--mount",
			mount(state.homeRoot, request.binding.paths.home),
			"--tmpfs",
			`${request.binding.paths.temporary}:rw,nosuid,nodev,size=67108864,mode=1777`,
			"--workdir",
			request.binding.paths.workspace,
			...Object.entries(environment).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
			request.binding.image.contentId,
			"/bin/sh",
			"-c",
			"trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done",
		];
		let created = false;
		try {
			try {
				await this.docker.run(createArgs, { signal });
				created = true;
			} catch (error) {
				const recovery = await this.docker
					.run(
						[
							"container",
							"inspect",
							state.containerName,
							"--format",
							'{{index .Config.Labels "pi.ipd.controller"}}|{{index .Config.Labels "pi.ipd.lease"}}',
						],
						{ acceptedExitCodes: [0, 1] },
					)
					.catch(() => undefined);
				if (!recovery)
					throw new EnvironmentError(
						"external_outcome_unknown",
						"Cannot confirm the outcome of Docker container creation",
						{
							cause: error,
						},
					);
				if (
					recovery.exitCode === 0 &&
					recovery.stdout.toString("utf8").trim() === `${this.controllerId}|${request.leaseId}`
				) {
					created = true;
					if (signal?.aborted) throw error;
				} else if (recovery.exitCode === 1) throw error;
				else
					throw new EnvironmentError(
						"external_outcome_unknown",
						"Cannot confirm the owner of the Docker container",
						{
							cause: error,
						},
					);
			}
			throwIfAborted(signal);
			await this.docker.run(["start", state.containerName], { signal });
			const security = await this.docker.run(
				["container", "inspect", state.containerName, "--format", "{{json .HostConfig}}"],
				{ signal },
			);
			const hostConfig = parseJson<{
				ReadonlyRootfs?: boolean;
				Privileged?: boolean;
				NetworkMode?: string;
				CapDrop?: string[];
				SecurityOpt?: string[];
				Memory?: number;
				NanoCpus?: number;
				PidsLimit?: number;
			}>(security.stdout, "Docker security configuration");
			if (
				hostConfig.ReadonlyRootfs !== true ||
				hostConfig.Privileged !== false ||
				hostConfig.NetworkMode !== "none" ||
				!hostConfig.CapDrop?.includes("ALL") ||
				!hostConfig.SecurityOpt?.some((option) => option.startsWith("no-new-privileges")) ||
				hostConfig.Memory !== request.binding.resources.memoryBytes ||
				hostConfig.NanoCpus !== Math.round(request.binding.resources.cpus * 1_000_000_000) ||
				hostConfig.PidsLimit !== request.binding.resources.pids
			)
				throw new EnvironmentError("policy_denied", "Docker Engine did not apply the required security policy");
			const layout = resolveEnvironmentLayout(request.binding.paths);
			try {
				await this.docker.run(
					[
						"exec",
						state.containerName,
						"/bin/sh",
						"-c",
						'for path in "$@"; do test -r "$path" && test -x "$path" || exit 71; done',
						"--",
						...layout.readOnlyRoots,
					],
					{ signal },
				);
				await this.docker.run(
					[
						"exec",
						state.containerName,
						"/bin/sh",
						"-c",
						'for path in "$@"; do test -r "$path" && test -w "$path" && test -x "$path" || exit 72; done',
						"--",
						...layout.writableRoots,
					],
					{ signal },
				);
			} catch (error) {
				throw new EnvironmentError(
					"environment_unavailable",
					`Container user ${runtimeUser} cannot access the configured environment layout`,
					{ cause: error },
				);
			}
			const hello = await this.docker.run(
				[
					"exec",
					state.containerName,
					"/usr/local/bin/node",
					"/usr/local/lib/pi-ipd/command-bridge.mjs",
					encodeBridgeRequest({ version: BRIDGE_VERSION, operation: "hello" }),
				],
				{ signal },
			);
			if (parseJson<{ version: number }>(hello.stdout, "bridge handshake").version !== BRIDGE_VERSION)
				throw new EnvironmentError(
					"profile_incompatible",
					"Container bridge version does not match the host; rebuild the execution image",
				);
			for (const probe of request.binding.probes) {
				const result = await this.runCommand(state, shellArgv(quoteCommand(probe.command)), {
					signal,
					timeoutMs: probe.timeoutSeconds * 1000,
					acceptedExitCodes: COMMAND_EXIT_CODES,
				});
				if (result.exitCode !== 0)
					throw new EnvironmentError(
						"profile_incompatible",
						`Environment probe failed: ${probe.id}@${probe.version} (exit ${result.exitCode})`,
					);
			}
			this.leases.set(request.leaseId, state);
			return { providerHandle: state.containerName, image: { ...request.binding.image } };
		} catch (error) {
			if (created)
				await this.docker
					.run(["rm", "--force", state.containerName], { acceptedExitCodes: [0, 1] })
					.catch(() => {});
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	async bindRound(lease: EnvironmentLease, binding: RoundBinding, signal?: AbortSignal): Promise<void> {
		const state = this.requiredState(lease);
		throwIfAborted(signal);
		if (state.suspendedIdentity) {
			await this.verifyResume(lease, state.suspendedIdentity, state.suspendedWorkspaceHash!, signal);
			await this.docker.run(["start", state.containerName], { signal });
			state.suspendedIdentity = undefined;
		}
		await Promise.all(
			[...state.processes.values()]
				.filter((process) => process.state === "running" || process.state === "stopping")
				.map((process) => this.stopProcess(lease, process, signal)),
		);
		state.processes.clear();
		state.currentRound = undefined;
		const destinations = await materializeEnvironmentInputs(
			state.inputsRoot,
			state.binding.paths.inputs,
			binding.inputs,
			signal,
		);
		for (const input of binding.inputs) {
			const destination = destinations.get(input.bindingId);
			if (!destination || (await hashEnvironmentSource(destination)) !== input.contentHash)
				throw new EnvironmentError(
					"environment_lost",
					`Input hash changed during materialization: ${input.bindingId}`,
				);
		}
		throwIfAborted(signal);
		state.currentRound = structuredClone(binding);
	}

	async bindStaticAssets(
		lease: EnvironmentLease,
		assets: readonly EnvironmentStaticAsset[],
		signal?: AbortSignal,
	): Promise<void> {
		const state = this.requiredState(lease);
		const assetHash = hashJson(
			assets.map((asset) => ({
				assetId: asset.assetId,
				contentHash: asset.contentHash,
				virtualPath: asset.virtualPath,
			})),
		);
		if (state.assetHash === assetHash) return;
		if (state.currentRound)
			throw new EnvironmentError("policy_denied", "Static environment assets cannot change after a round is bound");
		const contextPrefix = `${state.binding.paths.context}/`;
		const skillsPrefix = `${state.binding.paths.skills}/`;
		const contextAssets = assets.filter((asset) => asset.virtualPath.startsWith(contextPrefix));
		const skillAssets = assets.filter((asset) => asset.virtualPath.startsWith(skillsPrefix));
		if (contextAssets.length + skillAssets.length !== assets.length)
			throw new EnvironmentError(
				"policy_denied",
				`Static assets must be located under ${state.binding.paths.context} or ${state.binding.paths.skills}`,
			);
		const destinations = new Map([
			...(await materializeEnvironmentAssets(state.contextRoot, state.binding.paths.context, contextAssets, signal)),
			...(await materializeEnvironmentAssets(state.skillsRoot, state.binding.paths.skills, skillAssets, signal)),
		]);
		for (const asset of assets) {
			const destination = destinations.get(asset.assetId);
			if (!destination)
				throw new EnvironmentError("environment_lost", `Static asset was not materialized: ${asset.assetId}`);
			const stat = await lstat(destination);
			const actualHash = stat.isDirectory()
				? await hashSkillPackage(destination)
				: createHash("sha256")
						.update(await readFile(destination))
						.digest("hex");
			if (actualHash !== asset.contentHash)
				throw new EnvironmentError(
					"environment_lost",
					`Static asset hash changed during materialization: ${asset.assetId}`,
				);
		}
		state.assetHash = assetHash;
	}

	async exec(
		lease: EnvironmentLease,
		binding: RoundBinding,
		request: EnvironmentExecRequest,
		signal?: AbortSignal,
	): Promise<EnvironmentExecResult> {
		const state = this.requiredActiveState(lease, binding, "exec");
		const cwd = assertVirtualWorkingDirectoryAllowed(request.cwd, state.binding);
		for (const name of Object.keys(request.environment ?? {})) {
			if (!(name in state.binding.environment))
				throw new EnvironmentError("policy_denied", `Command environment variable is not authorized: ${name}`);
		}
		try {
			const result = await this.runCommand(state, shellArgv(request.command), {
				cwd,
				environment: request.environment,
				logPath: request.fullOutputPath
					? assertVirtualPathAllowed(request.fullOutputPath, state.binding, "write")
					: undefined,
				signal,
				timeoutMs: request.timeoutSeconds ? request.timeoutSeconds * 1000 : 0,
				onStdout: request.onData,
				onStderr: request.onData,
				acceptedExitCodes: COMMAND_EXIT_CODES,
				streamOutput: true,
			});
			return { exitCode: result.exitCode };
		} catch (error) {
			if (error instanceof EnvironmentError && ["cancelled", "process_timeout"].includes(error.code)) {
				await this.docker.run(["kill", state.containerName], { acceptedExitCodes: [0, 1] }).catch(() => {});
				await this.docker.run(["start", state.containerName], { acceptedExitCodes: [0, 1] }).catch(() => {});
				for (const process of state.processes.values()) process.state = "lost";
			}
			throw error;
		}
	}

	async readFile(lease: EnvironmentLease, binding: RoundBinding, path: string, signal?: AbortSignal): Promise<Buffer> {
		const state = this.requiredActiveState(lease, binding, "read");
		const target = assertVirtualPathAllowed(path, state.binding, "read");
		const result = await this.fileOperation(
			state,
			{ version: BRIDGE_VERSION, operation: "read", path: target },
			signal,
		);
		return result.stdout;
	}

	async stat(
		lease: EnvironmentLease,
		binding: RoundBinding,
		path: string,
		signal?: AbortSignal,
	): Promise<EnvironmentFileStat> {
		const state = this.requiredActiveState(lease, binding, "read");
		const target = assertVirtualPathAllowed(path, state.binding, "read");
		const result = await this.fileOperation(
			state,
			{ version: BRIDGE_VERSION, operation: "stat", path: target },
			signal,
		);
		return parseJson<EnvironmentFileStat>(result.stdout, "file status");
	}

	async makeDirectory(
		lease: EnvironmentLease,
		binding: RoundBinding,
		path: string,
		signal?: AbortSignal,
	): Promise<void> {
		const state = this.requiredActiveState(lease, binding, "write");
		const target = assertVirtualPathAllowed(path, state.binding, "write");
		await this.fileOperation(state, { version: BRIDGE_VERSION, operation: "mkdir", path: target }, signal);
	}

	async writeFile(
		lease: EnvironmentLease,
		binding: RoundBinding,
		path: string,
		content: Buffer,
		signal?: AbortSignal,
	): Promise<void> {
		const state = this.requiredActiveState(lease, binding, "write");
		const target = assertVirtualPathAllowed(path, state.binding, "write");
		await this.fileOperation(state, { version: BRIDGE_VERSION, operation: "write", path: target }, signal, content);
	}

	async list(
		lease: EnvironmentLease,
		binding: RoundBinding,
		path: string,
		signal?: AbortSignal,
	): Promise<EnvironmentDirectoryEntry[]> {
		const state = this.requiredActiveState(lease, binding, "read");
		const target = assertVirtualPathAllowed(path, state.binding, "read");
		const result = await this.fileOperation(
			state,
			{ version: BRIDGE_VERSION, operation: "list", path: target },
			signal,
		);
		return parseJson<EnvironmentDirectoryEntry[]>(result.stdout, "directory listing");
	}

	async search(
		lease: EnvironmentLease,
		binding: RoundBinding,
		request: {
			path: string;
			pattern: string;
			glob?: string;
			maxResults?: number;
			ignoreCase?: boolean;
			literal?: boolean;
		},
		signal?: AbortSignal,
	): Promise<EnvironmentSearchMatch[]> {
		const state = this.requiredActiveState(lease, binding, "read");
		const target = assertVirtualPathAllowed(request.path, state.binding, "read");
		const args = [
			"rg",
			"--json",
			"--line-number",
			...(request.ignoreCase ? ["--ignore-case"] : []),
			...(request.literal ? ["--fixed-strings"] : []),
			...(request.glob ? ["--glob", request.glob] : []),
			"--",
			request.pattern,
			target,
		];
		const result = await this.runCommand(state, args, { signal, acceptedExitCodes: [0, 1] });
		const matches: EnvironmentSearchMatch[] = [];
		for (const line of result.stdout.toString("utf8").split("\n")) {
			if (!line) continue;
			const event = JSON.parse(line) as {
				type: string;
				data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
			};
			if (event.type !== "match" || !event.data?.path?.text) continue;
			matches.push({ path: event.data.path.text, line: event.data.line_number, text: event.data.lines?.text });
			if (matches.length >= (request.maxResults ?? 1000)) break;
		}
		return matches;
	}

	async findFiles(
		lease: EnvironmentLease,
		binding: RoundBinding,
		request: { path: string; glob: string; maxResults?: number },
		signal?: AbortSignal,
	): Promise<string[]> {
		const state = this.requiredActiveState(lease, binding, "read");
		const target = assertVirtualPathAllowed(request.path, state.binding, "read");
		const result = await this.runCommand(
			state,
			[
				"rg",
				"--files",
				"--hidden",
				"--glob",
				request.glob,
				"--glob",
				"!**/node_modules/**",
				"--glob",
				"!**/.git/**",
				"--",
				target,
			],
			{ signal, acceptedExitCodes: [0, 1] },
		);
		return result.stdout
			.toString("utf8")
			.split("\n")
			.filter(Boolean)
			.slice(0, request.maxResults ?? 1000);
	}

	async startProcess(
		lease: EnvironmentLease,
		binding: RoundBinding,
		request: EnvironmentExecRequest,
		signal?: AbortSignal,
	): Promise<ProcessHandle> {
		const state = this.requiredActiveState(lease, binding, "process");
		if (request.environment && Object.keys(request.environment).length > 0)
			throw new EnvironmentError("policy_denied", "Managed process environment overrides are not enabled");
		const processId = randomUUID();
		const cwd = assertVirtualWorkingDirectoryAllowed(request.cwd, state.binding);
		const result = await this.runCommand(
			state,
			[
				"/usr/local/bin/node",
				"/usr/local/lib/pi-ipd/process-bridge.mjs",
				encodeBridgeRequest({
					version: BRIDGE_VERSION,
					operation: "start",
					scratch: state.binding.paths.scratch,
					processId,
					launch: {
						argv: shellArgv(request.command),
						cwd,
						environment: commandEnvironment(state.binding),
						maxLogBytes: state.binding.resources.logBytes,
					},
				}),
			],
			{ signal },
		);
		const started = parseJson<{ version: number; pid: number }>(result.stdout, "process start result");
		if (started.version !== BRIDGE_VERSION || !Number.isInteger(started.pid) || started.pid < 1)
			throw new EnvironmentError("environment_lost", "Environment returned an invalid process ID");
		const process: ProcessHandle = {
			processId,
			leaseId: lease.leaseId,
			roundId: binding.roundId,
			generation: binding.generation,
			state: "running",
			logCursor: 0,
		};
		state.processes.set(processId, process);
		return structuredClone(process);
	}

	async processStatus(lease: EnvironmentLease, process: ProcessHandle, signal?: AbortSignal): Promise<ProcessHandle> {
		const state = this.requiredProcess(lease, process);
		const result = await this.runCommand(
			state,
			[
				"/usr/local/bin/node",
				"/usr/local/lib/pi-ipd/process-bridge.mjs",
				encodeBridgeRequest({
					version: BRIDGE_VERSION,
					operation: "status",
					scratch: state.binding.paths.scratch,
					processId: process.processId,
				}),
			],
			{ signal },
		);
		const status = parseJson<{ state: "running" | "exited"; exitCode?: number }>(result.stdout, "process status");
		const current = state.processes.get(process.processId)!;
		current.state = status.state;
		current.exitCode = status.exitCode;
		return structuredClone(current);
	}

	async processLogs(
		lease: EnvironmentLease,
		process: ProcessHandle,
		cursor: number,
		signal?: AbortSignal,
	): Promise<{ data: Buffer; cursor: number; eof: boolean }> {
		const state = this.requiredProcess(lease, process);
		if (!Number.isInteger(cursor) || cursor < 0) throw new EnvironmentError("policy_denied", "Invalid log cursor");
		const logPath = `${state.binding.paths.scratch}/.ipd-processes/${process.processId}.log`;
		const stat = await this.fileOperation(
			state,
			{ version: BRIDGE_VERSION, operation: "stat", path: logPath },
			signal,
		);
		const size = parseJson<EnvironmentFileStat>(stat.stdout, "process log size").size;
		const next = Math.min(size, cursor + Math.min(state.binding.resources.logBytes, 1024 * 1024));
		const data =
			next <= cursor
				? Buffer.alloc(0)
				: (
						await this.fileOperation(
							state,
							{
								version: BRIDGE_VERSION,
								operation: "read",
								path: logPath,
								offset: cursor,
								length: next - cursor,
							},
							signal,
						)
					).stdout;
		return { data, cursor: next, eof: next === size };
	}

	async stopProcess(lease: EnvironmentLease, process: ProcessHandle, signal?: AbortSignal): Promise<ProcessHandle> {
		const state = this.requiredProcess(lease, process);
		const current = state.processes.get(process.processId)!;
		if (!["running", "stopping"].includes(current.state)) {
			current.stopResult = "already_stopped";
			return structuredClone(current);
		}
		current.state = "stopping";
		const result = await this.runCommand(
			state,
			[
				"/usr/local/bin/node",
				"/usr/local/lib/pi-ipd/process-bridge.mjs",
				encodeBridgeRequest({
					version: BRIDGE_VERSION,
					operation: "stop",
					scratch: state.binding.paths.scratch,
					processId: process.processId,
				}),
			],
			{ signal },
		);
		const stopped = parseJson<{ state: "exited" | "stopped"; exitCode?: number; killed: boolean }>(
			result.stdout,
			"process stop result",
		);
		current.state = stopped.state;
		current.exitCode = stopped.exitCode;
		current.stopResult = stopped.killed ? "killed" : "exited";
		return structuredClone(current);
	}

	async exportOutputs(
		lease: EnvironmentLease,
		binding: RoundBinding,
		request: EnvironmentExportRequest,
		signal?: AbortSignal,
	): Promise<EnvironmentExportResult> {
		const state = this.requiredActiveState(lease, binding, "export");
		throwIfAborted(signal);
		for (const process of state.processes.values()) await this.stopProcess(lease, process, signal);
		await rm(request.destination, { recursive: true, force: true });
		await mkdir(request.destination, { recursive: true, mode: 0o700 });
		let paused = false;
		const files: EnvironmentExportResult["files"] = [];
		try {
			try {
				await this.docker.run(["pause", state.containerName], { signal });
				paused = true;
			} catch (error) {
				const inspection = await this.docker
					.run(["container", "inspect", state.containerName, "--format", "{{.State.Paused}}"], {
						acceptedExitCodes: [0, 1],
					})
					.catch(() => undefined);
				paused = inspection?.exitCode === 0 && inspection.stdout.toString("utf8").trim() === "true";
				throw error;
			}
			const workspace = await realpath(state.workspaceRoot);
			for (const output of request.outputs) {
				throwIfAborted(signal);
				const logicalPath = output.logicalPath.replaceAll("\\", "/");
				if (isAbsolute(logicalPath) || logicalPath.split("/").includes(".."))
					throw new EnvironmentError("policy_denied", `Invalid exported output path: ${logicalPath}`);
				const virtualPath = `${state.binding.paths.workspace}/${logicalPath}`;
				assertVirtualExportAllowed(virtualPath, output.outputRoot, state.binding);
				const source = await realpath(resolve(workspace, logicalPath));
				const sourceRelative = relative(workspace, source);
				if (sourceRelative.startsWith("..") || isAbsolute(sourceRelative))
					throw new EnvironmentError("policy_denied", `Exported output escapes the workspace: ${logicalPath}`);
				const sourceStat = await lstat(source);
				if (!sourceStat.isFile())
					throw new EnvironmentError("policy_denied", `Exported output is not a regular file: ${logicalPath}`);
				const destination = resolve(request.destination, logicalPath);
				const destinationRelative = relative(resolve(request.destination), destination);
				if (destinationRelative.startsWith("..") || isAbsolute(destinationRelative))
					throw new EnvironmentError("policy_denied", `Export destination escapes staging: ${logicalPath}`);
				await mkdir(dirname(destination), { recursive: true });
				await copyFile(source, destination, constants.COPYFILE_EXCL);
				const content = await readFile(destination);
				files.push({
					outputId: output.outputId,
					logicalPath,
					stagedPath: destination,
					size: content.length,
					sha256: createHash("sha256").update(content).digest("hex"),
				});
			}
			return { root: request.destination, files };
		} catch (error) {
			await rm(request.destination, { recursive: true, force: true });
			throw error;
		} finally {
			if (paused)
				await this.docker.run(["unpause", state.containerName], { acceptedExitCodes: [0, 1] }).catch(() => {});
		}
	}

	async describe(lease: EnvironmentLease): Promise<Record<string, unknown>> {
		const state = this.requiredState(lease);
		return {
			provider: this.kind,
			image: state.binding.image,
			capabilities: state.binding.capabilities,
			commands: state.binding.commands,
			network: state.binding.network,
			resources: state.binding.resources,
			paths: state.binding.paths,
			layout: resolveEnvironmentLayout(state.binding.paths),
			generation: state.currentRound?.generation ?? 0,
		};
	}

	async suspend(
		lease: EnvironmentLease,
		signal?: AbortSignal,
	): Promise<{ workspace: string; identity: string; workspaceHash: string }> {
		const state = this.requiredState(lease);
		if (!state.suspendedIdentity) {
			const identity = await this.inspectIdentity(lease, signal);
			// Stop the container, including untracked descendants; keep its private bind mounts and identity.
			await this.docker.run(["stop", "--time", "1", state.containerName], { signal });
			state.suspendedIdentity = identity;
			state.currentRound = undefined;
			for (const process of state.processes.values()) process.state = "stopped";
		}
		state.suspendedWorkspaceHash = await hashWorkspaceState(state.workspaceRoot);
		return {
			workspace: state.workspaceRoot,
			identity: state.suspendedIdentity,
			workspaceHash: state.suspendedWorkspaceHash,
		};
	}

	async verifyResume(
		lease: EnvironmentLease,
		identity: string,
		workspaceHash: string,
		signal?: AbortSignal,
	): Promise<void> {
		const state = this.requiredState(lease);
		if (state.suspendedIdentity !== identity || (await this.inspectIdentity(lease, signal)) !== identity)
			throw new EnvironmentError("environment_lost", "The retained Docker container identity changed");
		if (!(await lstat(state.workspaceRoot)).isDirectory())
			throw new EnvironmentError("environment_lost", "The retained workspace is unavailable");
		if (
			state.suspendedWorkspaceHash !== workspaceHash ||
			(await hashWorkspaceState(state.workspaceRoot)) !== workspaceHash
		)
			throw new EnvironmentError("environment_lost", "The retained workspace changed after its checkpoint");
	}

	private async inspectIdentity(lease: EnvironmentLease, signal?: AbortSignal): Promise<string> {
		const state = this.requiredState(lease);
		const result = await this.docker.run(
			[
				"container",
				"inspect",
				state.containerName,
				"--format",
				'{{.Id}}|{{.Image}}|{{index .Config.Labels "pi.ipd.controller"}}|{{index .Config.Labels "pi.ipd.lease"}}',
			],
			{ signal },
		);
		const identity = result.stdout.toString("utf8").trim();
		const [id, image, controller, leaseId] = identity.split("|");
		if (
			!id ||
			image !== state.binding.image?.contentId ||
			controller !== this.controllerId ||
			leaseId !== lease.leaseId
		)
			throw new EnvironmentError(
				"environment_lost",
				"Docker container ownership or image no longer matches the lease",
			);
		return identity;
	}

	async dispose(lease: EnvironmentLease, signal?: AbortSignal): Promise<void> {
		const state = this.leases.get(lease.leaseId);
		if (!state) return;
		for (const process of state.processes.values()) await this.stopProcess(lease, process).catch(() => {});
		await this.docker.run(["rm", "--force", state.containerName], { signal });
		this.leases.delete(lease.leaseId);
		await rm(state.root, { recursive: true, force: true });
		throwIfAborted(signal);
	}

	private runCommand(
		state: DockerLeaseState,
		argv: string[],
		options: DockerRunOptions & { cwd?: string; environment?: Record<string, string>; logPath?: string } = {},
	): Promise<DockerRunResult> {
		return this.docker.run(
			[
				"exec",
				...(options.input ? ["--interactive"] : []),
				state.containerName,
				"/usr/local/bin/node",
				"/usr/local/lib/pi-ipd/command-bridge.mjs",
				encodeBridgeRequest({
					version: BRIDGE_VERSION,
					operation: "exec",
					launch: {
						argv,
						cwd: options.cwd ?? state.binding.paths.workspace,
						environment: commandEnvironment(state.binding, options.environment),
						maxLogBytes: state.binding.resources.logBytes,
						logPath: options.logPath,
					},
				}),
			],
			options,
		);
	}

	private async fileOperation(
		state: DockerLeaseState,
		request: BridgeRequest,
		signal?: AbortSignal,
		input?: Buffer,
	): Promise<DockerRunResult> {
		const result = await this.runCommand(
			state,
			["/usr/local/bin/node", "/usr/local/lib/pi-ipd/fs-bridge.mjs", encodeBridgeRequest(request)],
			{ signal, input, acceptedExitCodes: [0, 1] },
		);
		if (result.exitCode !== 0) {
			const error = parseJson<{ bridgeError: { code: string; message: string } }>(
				result.stderr,
				"file error",
			).bridgeError;
			throw new EnvironmentError(
				["ENOENT", "ENOTDIR"].includes(error.code) ? "path_not_found" : "environment_unavailable",
				error.message,
			);
		}
		return result;
	}

	private requiredState(lease: EnvironmentLease): DockerLeaseState {
		const state = this.leases.get(lease.leaseId);
		if (!state || state.containerName !== lease.providerHandle)
			throw new EnvironmentError("environment_lost", `Docker environment lease is unavailable: ${lease.leaseId}`);
		return state;
	}

	private requiredActiveState(
		lease: EnvironmentLease,
		binding: RoundBinding,
		operation: RoundBinding["allowedOperations"][number],
	): DockerLeaseState {
		const state = this.requiredState(lease);
		if (
			!state.currentRound ||
			state.currentRound.roundId !== binding.roundId ||
			state.currentRound.generation !== binding.generation
		)
			throw new EnvironmentError("policy_denied", `Stale environment round binding: ${binding.roundId}`);
		if (!state.currentRound.allowedOperations.includes(operation))
			throw new EnvironmentError(
				"policy_denied",
				`Environment operation is not allowed in this round: ${operation}`,
			);
		return state;
	}

	private requiredProcess(lease: EnvironmentLease, process: ProcessHandle): DockerLeaseState {
		if (!PROCESS_ID.test(process.processId) || process.leaseId !== lease.leaseId)
			throw new EnvironmentError("policy_denied", "Process handle does not belong to this environment lease");
		const state = this.requiredState(lease);
		const trusted = state.processes.get(process.processId);
		if (
			!trusted ||
			trusted.roundId !== process.roundId ||
			trusted.generation !== process.generation ||
			trusted.generation !== state.currentRound?.generation
		)
			throw new EnvironmentError("policy_denied", `Stale or unknown managed process: ${process.processId}`);
		return state;
	}
}
