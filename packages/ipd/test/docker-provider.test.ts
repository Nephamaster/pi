import { mkdtemp, rm } from "node:fs/promises";
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
import { createEnvironmentToolDefinitions, DockerEnvironmentProvider } from "../src/index.ts";

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
	fileError?: { code: string; message: string };
	readonly calls: Array<{ args: string[]; options: DockerRunOptions }> = [];

	async run(args: readonly string[], options: DockerRunOptions = {}): Promise<DockerRunResult> {
		this.calls.push({ args: [...args], options });
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
			return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ version: 1 })), stderr: Buffer.alloc(0) };
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
		await provider.dispose(lease);
		expect(
			docker.calls.some((call) => call.args.slice(0, 3).join(" ") === `rm --force ${prepared.providerHandle}`),
		).toBe(true);
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
});
