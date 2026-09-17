import type { EnvironmentBinding, EnvironmentLease, PreparedEnvironment } from "./contracts.ts";
import { EnvironmentError } from "./contracts.ts";
import type { DockerCommandRunner } from "./docker-adapter.ts";
import { DockerEnvironmentProvider, type DockerEnvironmentProviderOptions } from "./docker-provider.ts";

/**
 * Extends the hardened Docker provider with one deliberately broad networking mode.
 *
 * `internet` means ordinary outbound access through Docker's default bridge. It is
 * intentionally not called restricted egress: there is no hostname allowlist or
 * credential broker in this implementation. `restricted` remains fail-closed until
 * a policy-enforced egress implementation exists.
 */
export class NetworkedDockerEnvironmentProvider extends DockerEnvironmentProvider {
	private readonly networkDocker: DockerCommandRunner;
	private readonly internetLeases = new Set<string>();

	constructor(options: DockerEnvironmentProviderOptions) {
		super(options);
		this.networkDocker = options.docker;
	}

	override async prepare(
		request: { leaseId: string; runId: string; binding: EnvironmentBinding },
		signal?: AbortSignal,
	): Promise<PreparedEnvironment> {
		if (request.binding.network.mode === "none") return super.prepare(request, signal);
		if (request.binding.network.mode === "restricted")
			throw new EnvironmentError(
				"profile_incompatible",
				"Restricted egress requires a policy-enforced network provider; ordinary Docker bridge access is not equivalent",
			);

		const offlineBinding: EnvironmentBinding = {
			...structuredClone(request.binding),
			network: { mode: "none" },
		};
		const prepared = await super.prepare({ ...request, binding: offlineBinding }, signal);
		try {
			await this.networkDocker.run(["network", "connect", "bridge", prepared.providerHandle], { signal });
			const inspection = await this.networkDocker.run(
				["container", "inspect", prepared.providerHandle, "--format", "{{json .NetworkSettings.Networks}}"],
				{ signal },
			);
			const networks = JSON.parse(inspection.stdout.toString("utf8")) as Record<string, unknown>;
			if (!networks.bridge)
				throw new EnvironmentError("environment_unavailable", "Docker did not attach the Internet bridge network");
			this.internetLeases.add(request.leaseId);
			return prepared;
		} catch (error) {
			const cleanupLease: EnvironmentLease = {
				leaseId: request.leaseId,
				runId: request.runId,
				nodeId: request.binding.nodeId,
				participantId: request.binding.participantId,
				provider: "docker",
				providerHandle: prepared.providerHandle,
				generation: 0,
				state: "ready",
				...(prepared.image ? { image: prepared.image } : {}),
				createdAt: new Date().toISOString(),
			};
			await super.dispose(cleanupLease).catch(() => {});
			throw error;
		}
	}

	override async describe(lease: EnvironmentLease): Promise<Record<string, unknown>> {
		const description = await super.describe(lease);
		return this.internetLeases.has(lease.leaseId) ? { ...description, network: { mode: "internet" } } : description;
	}

	override async dispose(lease: EnvironmentLease, signal?: AbortSignal): Promise<void> {
		try {
			await super.dispose(lease, signal);
		} finally {
			this.internetLeases.delete(lease.leaseId);
		}
	}
}
