// Own a per-lease internal network and its sole authorized public egress proxy.
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { type EnvironmentBinding, EnvironmentError } from "./contracts.ts";
import type { DockerCommandRunner } from "./docker-adapter.ts";

export class DockerEgress {
	readonly network: string;
	readonly container: string;
	readonly environment: Record<string, string>;
	private readonly token = randomBytes(24).toString("hex");
	private readonly docker: DockerCommandRunner;
	private readonly owner: string;
	constructor(docker: DockerCommandRunner, leaseId: string, controllerId: string) {
		this.docker = docker;
		this.owner = `${controllerId}:${leaseId}`;
		this.network = `pi-ipd-net-${leaseId}`;
		this.container = `pi-ipd-egress-${leaseId}`;
		const proxy = `http://ipd:${this.token}@egress:8080`;
		this.environment = {
			HTTP_PROXY: proxy,
			HTTPS_PROXY: proxy,
			http_proxy: proxy,
			https_proxy: proxy,
			NO_PROXY: "localhost,127.0.0.1,::1",
			no_proxy: "localhost,127.0.0.1,::1",
			NODE_USE_ENV_PROXY: "1",
		};
	}
	async prepare(binding: EnvironmentBinding, signal?: AbortSignal): Promise<void> {
		if (binding.network.mode !== "restricted" || !binding.image)
			throw new Error("Restricted Docker profile required");
		const version = await this.docker.run(["version", "--format", "{{.Server.Version}}"], { signal });
		if (Number.parseInt(version.stdout.toString(), 10) < 28 || !/^\d+\./.test(version.stdout.toString()))
			throw new EnvironmentError(
				"profile_incompatible",
				"Restricted egress requires Docker Engine 28 or newer with isolated bridge support",
			);
		await this.docker.run(
			[
				"network",
				"create",
				"--internal",
				"--driver",
				"bridge",
				"--opt",
				"com.docker.network.bridge.gateway_mode_ipv4=isolated",
				"--label",
				`pi.ipd.egress-owner=${this.owner}`,
				this.network,
			],
			{ signal },
		);
		const network = await this.docker.run(
			[
				"network",
				"inspect",
				this.network,
				"--format",
				'{{.Internal}}|{{index .Options "com.docker.network.bridge.gateway_mode_ipv4"}}',
			],
			{ signal },
		);
		if (network.stdout.toString().trim() !== "true|isolated")
			throw new EnvironmentError("policy_denied", "Docker did not apply isolated internal networking");
		const denied = Object.values(networkInterfaces()).flatMap(
			(entries) => entries?.map((entry) => entry.address) ?? [],
		);
		await this.docker.run(
			[
				"create",
				"--name",
				this.container,
				"--label",
				`pi.ipd.egress-owner=${this.owner}`,
				"--network",
				this.network,
				"--network-alias",
				"egress",
				"--user",
				"1000:1000",
				"--read-only",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				"--memory",
				"134217728",
				"--cpus",
				"1",
				"--pids-limit",
				"64",
				"--log-driver",
				"local",
				"--log-opt",
				"max-size=1m",
				"--env",
				`IPD_EGRESS_POLICY=${JSON.stringify({ hosts: binding.network.allowedEndpoints, denied, token: this.token })}`,
				"--entrypoint",
				"/usr/local/bin/node",
				binding.image.contentId,
				"/usr/local/lib/pi-ipd/egress-bridge.mjs",
			],
			{ signal },
		);
		await this.docker.run(["network", "connect", "bridge", this.container], { signal });
		await this.resume(signal);
	}
	async resume(signal?: AbortSignal): Promise<void> {
		await this.docker.run(["start", this.container], { signal });
		await this.docker.run(
			[
				"exec",
				this.container,
				"/usr/local/bin/node",
				"-e",
				'const net=require("node:net");const end=Date.now()+5000;function probe(){const c=net.connect(8080,"127.0.0.1",()=>{c.end();process.exit(0)});c.on("error",()=>Date.now()<end?setTimeout(probe,50):process.exit(1))}probe()',
			],
			{ signal, timeoutMs: 10_000 },
		);
	}
	async suspend(): Promise<void> {
		await this.docker.run(["stop", "--time", "1", this.container]);
	}
	async dispose(signal?: AbortSignal): Promise<void> {
		for (const [kind, name] of [
			["container", this.container],
			["network", this.network],
		]) {
			const format =
				kind === "container"
					? '{{index .Config.Labels "pi.ipd.egress-owner"}}'
					: '{{index .Labels "pi.ipd.egress-owner"}}';
			const result = await this.docker.run([kind, "inspect", name, "--format", format], {
				signal,
				acceptedExitCodes: [0, 1],
			});
			if (
				result.exitCode === 1 &&
				/No such (object|container|network)|network .* not found/i.test(result.stderr.toString())
			)
				continue;
			if (result.exitCode !== 0 || result.stdout.toString().trim() !== this.owner)
				throw new EnvironmentError("external_outcome_unknown", `Cannot verify egress resource ownership: ${name}`);
			await this.docker.run(kind === "container" ? ["rm", "--force", name] : ["network", "rm", name], { signal });
		}
	}
}
