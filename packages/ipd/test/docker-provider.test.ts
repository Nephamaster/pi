import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeBridgeRequest } from "../src/environment/bridge/protocol.ts";
import type {
	DockerCommandRunner,
	DockerRunOptions,
	DockerRunResult,
	EnvironmentBinding,
	EnvironmentLease,
	RoundBinding,
} from "../src/index.ts";
import {
	createEnvironmentToolDefinitions,
	DockerEnvironmentProvider,
	EnvironmentError,
	EnvironmentManager,
	hashJson,
} from "../src/index.ts";

const imageId = `sha256:${"a".repeat(64)}`;

function binding(): EnvironmentBinding {
	return {
		bindingId: "binding",
		nodeId: "node",
		participantId: "participant",
		profileRef: { id: "code-node24", version: "1.0.0", hash: "b".repeat(64) },
		provider: "docker",
		image: { reference: "pi-ipd/code-node24:1.0.0", contentId: imageId, platform: "linux/amd64" },
		capabilities: [{ id: "node", version: "24.19.0" }],
		commands: ["bash", "node", "rg"],
		supportedTools: ["bash", "read", "write"],
		environment: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
		network: { mode: "none" },
		resources: { memoryBytes: 512 * 1024 * 1024, cpus: 1, pids: 128, logBytes: 1024 * 1024 },
		probes: [{ id: "node", version: "1.0.0", command: ["node", "--version"], timeoutSeconds: 10 }],
		paths: {
			context: "/ipd/context",
			skills: "/ipd/skills",
			inputs: "/ipd/inputs",
			workspace: "/workspace",
			scratch: "/scratch",
			cache: "/cache",
			home: "/home/agent",
			temporary: "/tmp",
		},
		readPaths: [],
		writePaths: ["outputs/node"],
		skillHashes: [],
		probeHash: "c".repeat(64),
		policyHash: "d".repeat(64),
	};
}

class FauxDocker implements DockerCommandRunner {
	probeFailure = false;
	cleanupFailure = false;
	commandTimeout = false;
	cancelFailure = false;
	private owner = "";
	private runHash = "";
	private status = "created";
	private exists = false;
	fileError?: { code: string; message: string };
	readonly calls: Array<{ args: string[]; options: DockerRunOptions }> = [];

	async run(args: readonly string[], options: DockerRunOptions = {}): Promise<DockerRunResult> {
		this.calls.push({ args: [...args], options });
		if (args.includes("/usr/local/lib/pi-ipd/command-bridge.mjs")) {
			const request = decodeBridgeRequest(args.at(-1)!);
			if (request.operation === "cancel_command") {
				if (this.cancelFailure) throw new Error("synthetic cancellation failure");
				return { exitCode: 0, stdout: Buffer.from('{"stopped":true}'), stderr: Buffer.alloc(0) };
			}
			if (request.operation === "exec" && request.processId && this.commandTimeout)
				throw new EnvironmentError("process_timeout", "synthetic command timeout");
		}
		if (args[0] === "create") {
			this.exists = true;
			this.owner = `${args.find((arg) => arg.startsWith("pi.ipd.controller="))!.split("=")[1]}|${args.find((arg) => arg.startsWith("pi.ipd.lease="))!.split("=")[1]}`;
			this.runHash = args.find((arg) => arg.startsWith("pi.ipd.run="))!.split("=")[1];
			this.status = "created";
		}
		if (args[0] === "start") this.status = "running";
		if (args[0] === "stop") this.status = "exited";
		if (args[0] === "rm") {
			if (this.cleanupFailure) throw new EnvironmentError("environment_unavailable", "synthetic cleanup failure");
			this.exists = false;
		}
		if (args[0] === "container" && args.at(-1)?.startsWith("{{index .Config.Labels"))
			return {
				exitCode: this.exists ? 0 : 1,
				stdout: Buffer.from(this.owner),
				stderr: Buffer.from(this.exists ? "" : "No such container"),
			};
		if (args[0] === "container" && args[1] === "inspect" && args.at(-1)?.startsWith("{{.Id}}|{{.Image}}")) {
			const [controller, lease] = this.owner.split("|");
			const extended = args.at(-1)?.includes("pi.ipd.run");
			return {
				exitCode: this.exists ? 0 : 1,
				stdout: Buffer.from(
					this.exists
						? extended
							? `container-id|${imageId}|${controller}|${lease}|${this.runHash}|${this.status}`
							: `container-id|${imageId}|${controller}|${lease}`
						: "",
				),
				stderr: Buffer.from(this.exists ? "" : "No such container"),
			};
		}
		if (
			this.probeFailure &&
			args.includes("/usr/local/lib/pi-ipd/command-bridge.mjs") &&
			JSON.parse(args.at(-1)!).operation === "exec"
		)
			return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
		if (this.fileError && args.includes("/usr/local/lib/pi-ipd/command-bridge.mjs")) {
			const request = decodeBridgeRequest(args.at(-1)!);
			if (request.operation === "exec" && request.launch.argv.includes("/usr/local/lib/pi-ipd/fs-bridge.mjs"))
				return {
					exitCode: 1,
					stdout: Buffer.alloc(0),
					stderr: Buffer.from(JSON.stringify({ bridgeError: this.fileError })),
				};
		}
		if (args.includes("/usr/local/lib/pi-ipd/command-bridge.mjs") && JSON.parse(args.at(-1)!).operation === "hello")
			return {
				exitCode: 0,
				stdout: Buffer.from(JSON.stringify({ version: 1, commandCancellation: true })),
				stderr: Buffer.alloc(0),
			};
		if (args[0] === "image" && args[1] === "inspect")
			return { exitCode: 0, stdout: Buffer.from(`${imageId}|linux/amd64\n`), stderr: Buffer.alloc(0) };
		if (args[0] === "container" && args[1] === "inspect" && args.at(-1) === "{{json .HostConfig}}")
			return {
				exitCode: 0,
				stdout: Buffer.from(
					JSON.stringify({
						ReadonlyRootfs: true,
						Privileged: false,
						NetworkMode: "none",
						CapDrop: ["ALL"],
						SecurityOpt: ["no-new-privileges:true"],
						Memory: 512 * 1024 * 1024,
						NanoCpus: 1_000_000_000,
						PidsLimit: 128,
					}),
				),
				stderr: Buffer.alloc(0),
			};
		return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
	}
}

describe("DockerEnvironmentProvider", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("creates one locked, non-privileged, networkless container and binds a round", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-provider-"));
		roots.push(root);
		const docker = new FauxDocker();
		const provider = new DockerEnvironmentProvider({ docker, storageRoot: root, controllerId: "controller" });
		const leaseId = "11111111-1111-4111-8111-111111111111";
		const configuredBinding = binding();
		const prepared = await provider.prepare({ leaseId, runId: "run-1", binding: configuredBinding });
		const lease: EnvironmentLease = {
			leaseId,
			runId: "run-1",
			nodeId: "node",
			participantId: "participant",
			provider: "docker",
			providerHandle: prepared.providerHandle,
			generation: 0,
			state: "ready",
			image: prepared.image,
			createdAt: new Date().toISOString(),
		};
		const round: RoundBinding = {
			roundId: "round-1",
			leaseId,
			generation: 1,
			inputHash: "e".repeat(64),
			inputs: [],
			allowedOperations: ["read", "write", "exec", "process"],
		};
		await provider.bindRound(lease, round);
		const create = docker.calls.find((call) => call.args[0] === "create")?.args;
		expect(create).toBeDefined();
		expect(create).toContain("--read-only");
		expect(create).toContain("--cap-drop");
		expect(create).toContain("no-new-privileges");
		expect(create).toContain("none");
		expect(create).toContain(imageId);
		expect(create).toContain(`${process.getuid?.()}:${process.getgid?.()}`);
		expect(create).not.toContain("--privileged");
		expect(create?.join(" ")).not.toContain("docker.sock");
		expect((await provider.describe(lease)).generation).toBe(1);
		expect(
			await provider.exec(lease, round, {
				command: "pwd",
				cwd: "/workspace",
			}),
		).toEqual({ exitCode: 0 });
		docker.commandTimeout = true;
		await expect(provider.exec(lease, round, { command: "sleep 10", cwd: "/workspace" })).rejects.toMatchObject({
			code: "process_timeout",
		});
		expect(docker.calls.some((call) => call.args[0] === "kill")).toBe(false);
		docker.commandTimeout = false;
		await expect(provider.exec(lease, round, { command: "pwd", cwd: "/etc" })).rejects.toMatchObject({
			code: "policy_denied",
		});
		const find = createEnvironmentToolDefinitions({
			hostWorkspace: "/workspace",
			getContext: () => ({ provider, lease, round, binding: configuredBinding }),
		}).find((tool) => tool.name === "find")!;
		docker.fileError = { code: "EACCES", message: "Synthetic permission failure" };
		await expect(
			find.execute("denied", { path: "/workspace", pattern: "*" }, undefined, undefined, {} as never),
		).rejects.toThrow("Synthetic permission failure");
		docker.fileError = { code: "ENOENT", message: "Synthetic missing path" };
		await expect(
			find.execute("missing", { path: "/workspace", pattern: "*" }, undefined, undefined, {} as never),
		).rejects.toThrow("Path not found: /workspace");
		docker.commandTimeout = true;
		docker.cancelFailure = true;
		await expect(provider.exec(lease, round, { command: "sleep 10", cwd: "/workspace" })).rejects.toMatchObject({
			code: "environment_lost",
		});
		await expect(provider.readFile(lease, round, "/workspace/anything")).rejects.toMatchObject({
			code: "environment_lost",
		});
		expect(docker.calls.filter((call) => call.args[0] === "start")).toHaveLength(1);
		await provider.dispose(lease);
		expect(
			docker.calls.some((call) => call.args.slice(0, 3).join(" ") === `rm --force ${prepared.providerHandle}`),
		).toBe(true);
	});

	it("kills untracked writers before binding a later round", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-provider-round-boundary-"));
		roots.push(root);
		const docker = new FauxDocker();
		const provider = new DockerEnvironmentProvider({ docker, storageRoot: root, controllerId: "controller" });
		const leaseId = "44444444-4444-4444-8444-444444444444";
		const prepared = await provider.prepare({ leaseId, runId: "run-1", binding: binding() });
		const lease: EnvironmentLease = {
			leaseId,
			runId: "run-1",
			nodeId: "node",
			participantId: "participant",
			provider: "docker",
			providerHandle: prepared.providerHandle,
			generation: 0,
			state: "ready",
			image: prepared.image,
			createdAt: new Date().toISOString(),
		};
		const first: RoundBinding = {
			roundId: "round-1",
			leaseId,
			generation: 1,
			inputHash: hashJson([]),
			inputs: [],
			allowedOperations: ["read"],
		};
		await provider.bindRound(lease, first);
		await provider.bindRound(lease, { ...first, roundId: "round-2", generation: 2 });

		expect(docker.calls.some((call) => call.args.slice(0, 3).join(" ") === "stop --time 1")).toBe(true);
		expect(docker.calls.filter((call) => call.args[0] === "start")).toHaveLength(2);
	});

	it("records network-capable Bash intent and leaves uncertain outcomes for reconciliation", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-provider-external-operation-"));
		roots.push(root);
		const docker = new FauxDocker();
		const provider = new DockerEnvironmentProvider({ docker, storageRoot: root, controllerId: "controller" });
		const leaseId = "55555555-5555-4555-8555-555555555555";
		const configuredBinding: EnvironmentBinding = {
			...binding(),
			network: { mode: "restricted", allowedEndpoints: ["example.com"] },
		};
		const prepared = await provider.prepare({ leaseId, runId: "run-1", binding: binding() });
		const lease: EnvironmentLease = {
			leaseId,
			runId: "run-1",
			nodeId: "node",
			participantId: "participant",
			provider: "docker",
			providerHandle: prepared.providerHandle,
			generation: 0,
			state: "ready",
			image: prepared.image,
			createdAt: new Date().toISOString(),
		};
		const round: RoundBinding = {
			roundId: "round-1",
			leaseId,
			generation: 1,
			inputHash: "e".repeat(64),
			inputs: [],
			allowedOperations: ["exec"],
		};
		await provider.bindRound(lease, round);
		const started: Array<{ operationKey: string; targetRef: string }> = [];
		const settled: Array<{ operationId: string; outcome: string }> = [];
		const tools = createEnvironmentToolDefinitions({
			hostWorkspace: "/workspace",
			getContext: () => ({ provider, lease, round, binding: configuredBinding }),
			getExternalOperationRecorder: () => ({
				async begin(intent) {
					started.push({ operationKey: intent.operationKey, targetRef: intent.targetRef });
					return `operation-${started.length}`;
				},
				async settle(operationId, outcome) {
					settled.push({ operationId, outcome });
				},
			}),
		});
		const bash = tools.find((tool) => tool.name === "bash")!;
		await bash.execute("call-1", { command: "printf ok" }, undefined, undefined, {} as never);
		expect(started).toEqual([{ operationKey: "bash:call-1", targetRef: "network:example.com" }]);
		expect(settled).toEqual([{ operationId: "operation-1", outcome: "succeeded" }]);

		docker.commandTimeout = true;
		await expect(
			bash.execute("call-2", { command: "sleep 10" }, undefined, undefined, {} as never),
		).rejects.toMatchObject({ code: "external_outcome_unknown" });
		expect(settled.at(-1)).toEqual({ operationId: "operation-2", outcome: "unknown" });
		await provider.dispose(lease);
	});

	it("rejects a changed image identity before creating a container", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-provider-identity-"));
		roots.push(root);
		const docker = new FauxDocker();
		const configuredBinding = binding();
		configuredBinding.image = { ...configuredBinding.image!, contentId: `sha256:${"f".repeat(64)}` };
		const provider = new DockerEnvironmentProvider({ docker, storageRoot: root });
		await expect(
			provider.prepare({
				leaseId: "22222222-2222-4222-8222-222222222222",
				runId: "run-1",
				binding: configuredBinding,
			}),
		).rejects.toMatchObject({ code: "profile_incompatible" });
		expect(docker.calls.some((call) => call.args[0] === "create")).toBe(false);
	});

	it("recovers a stopped container using its retained identity and workspace hash", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-provider-recover-"));
		roots.push(root);
		const docker = new FauxDocker();
		const configuredBinding = binding();
		const leaseId = "33333333-3333-4333-8333-333333333333";
		const first = new DockerEnvironmentProvider({ docker, storageRoot: root, controllerId: "controller-a" });
		const prepared = await first.prepare({ leaseId, runId: "run-1", binding: configuredBinding });
		const lease: EnvironmentLease = {
			leaseId,
			runId: "run-1",
			nodeId: "node",
			participantId: "participant",
			provider: "docker",
			providerHandle: prepared.providerHandle,
			generation: 2,
			state: "active",
			image: prepared.image,
			createdAt: new Date().toISOString(),
		};
		const saved = await first.suspend(lease);

		const second = new DockerEnvironmentProvider({ docker, storageRoot: root, controllerId: "controller-b" });
		const recovered = await second.recover({
			leaseId,
			runId: "run-1",
			binding: configuredBinding,
			providerHandle: prepared.providerHandle,
			generation: 2,
			identity: saved.identity,
			workspaceHash: saved.workspaceHash,
		});
		expect(recovered.providerHandle).toBe(prepared.providerHandle);
		await second.verifyResume(lease, saved.identity, saved.workspaceHash);
		await second.bindRound(lease, {
			roundId: "round-3",
			leaseId,
			generation: 3,
			inputHash: hashJson([]),
			inputs: [],
			allowedOperations: ["read"],
		});
		expect((await second.describe(lease)).generation).toBe(3);
	});

	it("quarantines a still-running container before adopting interrupted work", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-provider-quarantine-"));
		roots.push(root);
		const docker = new FauxDocker();
		const configuredBinding = binding();
		const leaseId = "66666666-6666-4666-8666-666666666666";
		const first = new DockerEnvironmentProvider({ docker, storageRoot: root, controllerId: "controller-a" });
		const prepared = await first.prepare({ leaseId, runId: "run-1", binding: configuredBinding });
		const lease: EnvironmentLease = {
			leaseId,
			runId: "run-1",
			nodeId: "node",
			participantId: "participant",
			provider: "docker",
			providerHandle: prepared.providerHandle,
			generation: 1,
			state: "active",
			image: prepared.image,
			createdAt: new Date().toISOString(),
		};
		await first.bindRound(lease, {
			roundId: "round-1",
			leaseId,
			generation: 1,
			inputHash: hashJson([]),
			inputs: [],
			allowedOperations: ["read"],
		});

		const second = new DockerEnvironmentProvider({ docker, storageRoot: root, controllerId: "controller-b" });
		const saved = await second.quarantine({
			leaseId,
			runId: "run-1",
			binding: configuredBinding,
			providerHandle: prepared.providerHandle,
			generation: 1,
		});
		expect(saved.providerHandle).toBe(prepared.providerHandle);
		expect(saved.identity).toContain("controller-a");
		expect(docker.calls.some((call) => call.args[0] === "stop")).toBe(true);
		await second.verifyResume(lease, saved.identity, saved.workspaceHash);
	});

	it("confirms an allocated container was never created and removes its empty storage", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-provider-uncreated-"));
		roots.push(root);
		const leaseId = "77777777-7777-4777-8777-777777777777";
		await mkdir(join(root, leaseId), { recursive: true });
		const provider = new DockerEnvironmentProvider({ docker: new FauxDocker(), storageRoot: root });
		await expect(
			provider.quarantine({
				leaseId,
				runId: "run-1",
				binding: binding(),
				providerHandle: "",
				generation: 0,
			}),
		).rejects.toMatchObject({ code: "path_not_found" });
		await expect(lstat(join(root, leaseId))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("retains provisional ownership and files after probe and cleanup failures, then retries cleanup", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-prepare-cleanup-"));
		roots.push(root);
		const docker = new FauxDocker();
		docker.probeFailure = true;
		docker.cleanupFailure = true;
		const manager = new EnvironmentManager([new DockerEnvironmentProvider({ docker, storageRoot: root })]);
		await expect(manager.prepare("failed-run", binding())).rejects.toMatchObject({
			code: "external_outcome_unknown",
		});
		const [lease] = manager.inspectRun("failed-run");
		expect(lease.state).toBe("disposing");
		expect(lease.providerHandle).toBe(`pi-ipd-${lease.leaseId}`);
		expect((await lstat(join(root, lease.leaseId))).isDirectory()).toBe(true);
		docker.cleanupFailure = false;
		await manager.releaseRun("failed-run");
		expect(manager.inspectRun("failed-run")).toEqual([]);
		await expect(lstat(join(root, lease.leaseId))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
