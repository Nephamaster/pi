import { describe, expect, it } from "vitest";
import type {
	EnvironmentBinding,
	EnvironmentDirectoryEntry,
	EnvironmentExecRequest,
	EnvironmentExecResult,
	EnvironmentExportRequest,
	EnvironmentExportResult,
	EnvironmentLease,
	EnvironmentProvider,
	EnvironmentSearchMatch,
	ProcessHandle,
	RoundBinding,
} from "../src/index.ts";
import { EnvironmentError, EnvironmentManager } from "../src/index.ts";

function binding(nodeId: string): EnvironmentBinding {
	return {
		bindingId: `binding-${nodeId}`,
		nodeId,
		participantId: "worker",
		profileRef: { id: "test", version: "1.0.0", hash: "a".repeat(64) },
		provider: "legacy-srt",
		capabilities: [],
		commands: [],
		supportedTools: [],
		environment: {},
		network: { mode: "none" },
		resources: { memoryBytes: 1024, cpus: 1, pids: 8, logBytes: 1024 },
		probes: [],
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
		readPaths: ["."],
		writePaths: ["outputs"],
		skillHashes: [],
		probeHash: "b".repeat(64),
		policyHash: "c".repeat(64),
	};
}

class FauxProvider implements EnvironmentProvider {
	readonly kind = "legacy-srt";
	prepareCalls = 0;
	disposeCalls = 0;
	bindCalls = 0;
	waitForAbort = false;

	async prepare(request: { leaseId: string }, signal?: AbortSignal): Promise<{ providerHandle: string }> {
		this.prepareCalls++;
		if (this.waitForAbort)
			await new Promise<void>((_resolve, reject) => {
				const abort = () => reject(new EnvironmentError("cancelled", "cancelled"));
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
			});
		return { providerHandle: `faux:${request.leaseId}` };
	}

	async bindRound(): Promise<void> {
		this.bindCalls++;
	}

	async bindStaticAssets(): Promise<void> {}

	async exec(
		_lease: EnvironmentLease,
		_binding: RoundBinding,
		_request: EnvironmentExecRequest,
	): Promise<EnvironmentExecResult> {
		throw new Error("unused");
	}

	async readFile(): Promise<Buffer> {
		throw new Error("unused");
	}

	async stat() {
		return { type: "file" as const, size: 0 };
	}

	async makeDirectory(): Promise<void> {}

	async writeFile(): Promise<void> {
		throw new Error("unused");
	}

	async list(): Promise<EnvironmentDirectoryEntry[]> {
		throw new Error("unused");
	}

	async search(): Promise<EnvironmentSearchMatch[]> {
		throw new Error("unused");
	}

	async findFiles(): Promise<string[]> {
		throw new Error("unused");
	}

	async startProcess(): Promise<ProcessHandle> {
		throw new Error("unused");
	}

	async processStatus(): Promise<ProcessHandle> {
		throw new Error("unused");
	}

	async processLogs(): Promise<{ data: Buffer; cursor: number; eof: boolean }> {
		throw new Error("unused");
	}

	async stopProcess(): Promise<ProcessHandle> {
		throw new Error("unused");
	}

	async exportOutputs(
		_lease: EnvironmentLease,
		_binding: RoundBinding,
		_request: EnvironmentExportRequest,
	): Promise<EnvironmentExportResult> {
		throw new Error("unused");
	}

	async describe(): Promise<Record<string, unknown>> {
		return {};
	}

	async dispose(): Promise<void> {
		this.disposeCalls++;
	}
}

describe("EnvironmentManager", () => {
	it("reuses one lease per node participant while preventing cross-node identity collisions", async () => {
		const provider = new FauxProvider();
		const manager = new EnvironmentManager([provider]);
		const first = await manager.prepare("run-1", binding("first"));
		const repeated = await manager.prepare("run-1", binding("first"));
		const secondNode = await manager.prepare("run-1", binding("second"));
		expect(repeated.leaseId).toBe(first.leaseId);
		expect(secondNode.leaseId).not.toBe(first.leaseId);
		expect(provider.prepareCalls).toBe(2);
		const round = await manager.bindRound(first.leaseId, {
			roundId: "round-1",
			inputs: [],
			allowedOperations: ["read", "write", "exec"],
		});
		expect(round.generation).toBe(1);
		expect(manager.context(first.leaseId, "round-1").lease.generation).toBe(1);
		await manager.releaseRun("run-1");
		expect(provider.disposeCalls).toBe(2);
	});

	it("cancels asynchronous preparation and removes the unusable lease", async () => {
		const provider = new FauxProvider();
		provider.waitForAbort = true;
		const manager = new EnvironmentManager([provider]);
		const preparing = manager.prepare("run-1", binding("first"));
		await manager.releaseRun("run-1");
		await expect(preparing).rejects.toMatchObject({ code: "cancelled" });
		provider.waitForAbort = false;
		const replacement = await manager.prepare("run-1", binding("first"));
		expect(replacement.state).toBe("ready");
		expect(provider.prepareCalls).toBe(2);
	});
});
