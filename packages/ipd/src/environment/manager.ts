// 管理 EnvironmentLease 的唯一身份、轮次代际、取消和幂等释放。
import { randomUUID } from "node:crypto";
import { hashJson } from "../ir/hash.ts";
import {
	type EnvironmentBinding,
	EnvironmentError,
	type EnvironmentInputBinding,
	type EnvironmentLease,
	type EnvironmentOperation,
	type EnvironmentProgressReference,
	type EnvironmentProvider,
	type EnvironmentStaticAsset,
	type RoundBinding,
	throwIfAborted,
} from "./contracts.ts";

interface ManagedLease {
	binding: EnvironmentBinding;
	provider: EnvironmentProvider;
	lease: EnvironmentLease;
	prepareController: AbortController;
	preparePromise: Promise<EnvironmentLease>;
	round?: RoundBinding;
}

function leaseKey(runId: string, binding: EnvironmentBinding): string {
	return `${runId}\0${binding.nodeId}\0${binding.participantId}`;
}

function clonedLease(lease: EnvironmentLease): EnvironmentLease {
	return structuredClone(lease);
}

export class EnvironmentManager {
	private readonly providers = new Map<EnvironmentProvider["kind"], EnvironmentProvider>();
	private readonly leasesByKey = new Map<string, ManagedLease>();
	private readonly leasesById = new Map<string, ManagedLease>();

	constructor(providers: readonly EnvironmentProvider[]) {
		for (const provider of providers) {
			if (this.providers.has(provider.kind))
				throw new EnvironmentError("environment_unavailable", `Duplicate environment Provider: ${provider.kind}`);
			this.providers.set(provider.kind, provider);
		}
	}

	prepare(runId: string, binding: EnvironmentBinding, signal?: AbortSignal): Promise<EnvironmentLease> {
		throwIfAborted(signal);
		const key = leaseKey(runId, binding);
		const existing = this.leasesByKey.get(key);
		if (existing) {
			if (existing.binding.bindingId !== binding.bindingId)
				return Promise.reject(
					new EnvironmentError(
						"policy_denied",
						`Environment binding changed after lease creation for ${binding.nodeId}/${binding.participantId}`,
					),
				);
			return existing.preparePromise.then(clonedLease);
		}
		const provider = this.providers.get(binding.provider);
		if (!provider)
			return Promise.reject(
				new EnvironmentError(
					"environment_unavailable",
					`Environment Provider is not configured: ${binding.provider}`,
				),
			);
		const controller = new AbortController();
		const abort = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", abort, { once: true });
		const lease: EnvironmentLease = {
			leaseId: randomUUID(),
			runId,
			nodeId: binding.nodeId,
			participantId: binding.participantId,
			provider: provider.kind,
			providerHandle: "",
			generation: 0,
			state: "preparing",
			image: binding.image ? { ...binding.image } : undefined,
			createdAt: new Date().toISOString(),
		};
		const managed = {
			binding,
			provider,
			lease,
			prepareController: controller,
			preparePromise: Promise.resolve(lease),
		} satisfies ManagedLease;
		managed.preparePromise = (async () => {
			let prepared = false;
			try {
				throwIfAborted(controller.signal);
				const preparedEnvironment = await provider.prepare(
					{ leaseId: lease.leaseId, runId, binding },
					controller.signal,
				);
				lease.providerHandle = preparedEnvironment.providerHandle;
				lease.image = preparedEnvironment.image ? { ...preparedEnvironment.image } : lease.image;
				prepared = true;
				throwIfAborted(controller.signal);
				lease.state = "ready";
				return lease;
			} catch (error) {
				if (prepared) {
					lease.state = "disposing";
					// Keep the known handle registered if cleanup fails; releaseRun can retry it.
					await provider.dispose(clonedLease(lease));
				}
				this.leasesByKey.delete(key);
				this.leasesById.delete(lease.leaseId);
				if (controller.signal.aborted && !(error instanceof EnvironmentError && error.code === "cancelled"))
					throw new EnvironmentError("cancelled", "Environment preparation was cancelled", { cause: error });
				throw error;
			} finally {
				signal?.removeEventListener("abort", abort);
			}
		})();
		this.leasesByKey.set(key, managed);
		this.leasesById.set(lease.leaseId, managed);
		return managed.preparePromise.then(clonedLease);
	}

	async bindRound(
		leaseId: string,
		input: {
			roundId: string;
			inputs: readonly EnvironmentInputBinding[];
			allowedOperations: readonly EnvironmentOperation[];
		},
		signal?: AbortSignal,
	): Promise<RoundBinding> {
		throwIfAborted(signal);
		const managed = this.requiredLease(leaseId);
		await managed.preparePromise;
		throwIfAborted(signal);
		if (["disposing", "disposed", "lost"].includes(managed.lease.state))
			throw new EnvironmentError("environment_lost", `Environment lease is not available: ${leaseId}`);
		const generation = managed.lease.generation + 1;
		const inputs = input.inputs.map((item) => ({ ...item }));
		const round: RoundBinding = {
			roundId: input.roundId,
			leaseId,
			generation,
			inputHash: hashJson(
				inputs.map(({ bindingId, contentHash, virtualPath }) => ({ bindingId, contentHash, virtualPath })),
			),
			inputs,
			allowedOperations: [...new Set(input.allowedOperations)],
		};
		await managed.provider.bindRound(clonedLease(managed.lease), structuredClone(round), signal);
		throwIfAborted(signal);
		managed.round = round;
		managed.lease.generation = generation;
		managed.lease.state = "active";
		return structuredClone(round);
	}

	async bindStaticAssets(
		leaseId: string,
		assets: readonly EnvironmentStaticAsset[],
		signal?: AbortSignal,
	): Promise<void> {
		const managed = this.requiredLease(leaseId);
		await managed.preparePromise;
		throwIfAborted(signal);
		await managed.provider.bindStaticAssets(clonedLease(managed.lease), assets, signal);
	}

	context(
		leaseId: string,
		roundId: string,
	): {
		lease: EnvironmentLease;
		binding: EnvironmentBinding;
		round: RoundBinding;
		provider: EnvironmentProvider;
	} {
		const managed = this.requiredLease(leaseId);
		if (!managed.round || managed.round.roundId !== roundId)
			throw new EnvironmentError("policy_denied", `Round is not bound to the environment lease: ${roundId}`);
		return {
			lease: clonedLease(managed.lease),
			binding: structuredClone(managed.binding),
			round: structuredClone(managed.round),
			provider: managed.provider,
		};
	}

	async releaseRun(runId: string, signal?: AbortSignal): Promise<void> {
		const managed = [...this.leasesById.values()].filter((candidate) => candidate.lease.runId === runId);
		for (const candidate of managed) candidate.prepareController.abort();
		const outcomes = await Promise.allSettled(managed.map((candidate) => this.dispose(candidate, signal)));
		const failure = outcomes.find((outcome) => outcome.status === "rejected");
		if (failure?.status === "rejected")
			throw new EnvironmentError("environment_unavailable", "One or more environment leases could not be disposed", {
				cause: failure.reason,
			});
	}

	async suspendRun(runId: string): Promise<EnvironmentProgressReference[]> {
		const progress: EnvironmentProgressReference[] = [];
		for (const managed of this.leasesById.values()) {
			if (managed.lease.runId !== runId) continue;
			await managed.preparePromise;
			if (!managed.provider.suspend)
				throw new EnvironmentError("environment_unavailable", "Provider does not support retaining paused work");
			const saved = await managed.provider.suspend(clonedLease(managed.lease));
			managed.lease.state = "idle";
			progress.push({
				nodeId: managed.lease.nodeId,
				participantId: managed.lease.participantId,
				workspace: saved.workspace,
				environment: {
					leaseId: managed.lease.leaseId,
					generation: managed.lease.generation,
					bindingId: managed.binding.bindingId,
					identity: saved.identity,
					workspaceHash: saved.workspaceHash,
				},
			});
		}
		return progress;
	}

	inspectRun(runId: string): EnvironmentLease[] {
		return [...this.leasesById.values()]
			.filter((managed) => managed.lease.runId === runId)
			.map((managed) => clonedLease(managed.lease));
	}

	async verifyResume(reference: EnvironmentProgressReference["environment"]): Promise<void> {
		const managed = this.requiredLease(reference.leaseId);
		if (
			managed.binding.bindingId !== reference.bindingId ||
			managed.lease.generation !== reference.generation ||
			managed.lease.state !== "idle"
		)
			throw new EnvironmentError("environment_lost", "Retained environment binding or generation changed");
		if (!managed.provider.verifyResume)
			throw new EnvironmentError("environment_lost", "Provider cannot verify retained work");
		await managed.provider.verifyResume(clonedLease(managed.lease), reference.identity, reference.workspaceHash);
	}

	private requiredLease(leaseId: string): ManagedLease {
		const managed = this.leasesById.get(leaseId);
		if (!managed) throw new EnvironmentError("environment_lost", `Unknown environment lease: ${leaseId}`);
		return managed;
	}

	private async dispose(managed: ManagedLease, signal?: AbortSignal): Promise<void> {
		if (managed.lease.state === "disposed") return;
		try {
			await managed.preparePromise;
		} catch {
			if (!managed.lease.providerHandle) return;
		}
		managed.lease.state = "disposing";
		await managed.provider.dispose(clonedLease(managed.lease), signal);
		managed.lease.state = "disposed";
		managed.lease.disposedAt = new Date().toISOString();
		this.leasesById.delete(managed.lease.leaseId);
		this.leasesByKey.delete(leaseKey(managed.lease.runId, managed.binding));
	}
}
