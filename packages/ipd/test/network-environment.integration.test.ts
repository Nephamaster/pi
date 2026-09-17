import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	createEnvironmentBinding,
	DockerCli,
	DockerEnvironmentProvider,
	EnvironmentManager,
	hashEnvironmentSource,
	loadRegisteredDockerProfile,
	registerExecutionProfiles,
} from "../src/workspace.ts";

it.runIf(process.env.PI_IPD_NETWORK_INTEGRATION === "1")(
	"allows public research and project installs while isolating inputs, peer workspaces and networking",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "ipd-network-integration-"));
		const docker = new DockerCli({ dockerConfigDirectory: join(root, "docker"), managementTimeoutMs: 120_000 });
		const provider = new DockerEnvironmentProvider({ docker, storageRoot: join(root, "leases") });
		const manager = new EnvironmentManager([provider]);
		try {
			const template = JSON.parse(
				await readFile(new URL("../environments/code-node24/profile.template.json", import.meta.url), "utf8"),
			);
			template.image.reference = process.env.PI_IPD_CODE_IMAGE ?? template.image.reference;
			await writeFile(join(root, "profile.json"), JSON.stringify(template));
			const registered = await loadRegisteredDockerProfile(join(root, "profile.json"), docker);
			const profile = registerExecutionProfiles([
				{ ...registered.profile, network: { mode: "restricted", allowedEndpoints: ["*"] } },
			])[0];
			const create = async (nodeId: string) => {
				const binding = createEnvironmentBinding({
					nodeId,
					participantId: "worker",
					profile,
					readPaths: [],
					writePaths: [],
					skillHashes: [],
					policy: { allowedProfiles: [profile.ref] },
				});
				const lease = await manager.prepare("network-run", binding);
				const source = join(root, "source.txt");
				await writeFile(source, "sealed original");
				const round = await manager.bindRound(lease.leaseId, {
					roundId: "round",
					inputs: [
						{
							bindingId: "source",
							contentHash: await hashEnvironmentSource(source),
							virtualPath: "/ipd/inputs/source",
							sourcePath: source,
						},
					],
					allowedOperations: ["read", "write", "exec", "process"],
				});
				return { lease, round };
			};
			const first = await create("first");
			const second = await create("second");
			const exec = async (current: typeof first, command: string, timeoutSeconds = 90) => {
				const chunks: Buffer[] = [];
				const result = await provider.exec(current.lease, current.round, {
					command,
					cwd: "/workspace",
					timeoutSeconds,
					onData: (chunk) => chunks.push(chunk),
				});
				return { ...result, text: Buffer.concat(chunks).toString() };
			};
			expect(
				await exec(
					first,
					`node -e 'fetch("https://example.com").then(async r=>{if(!r.ok)process.exit(1);require("node:fs").writeFileSync("research.html",await r.text())})'`,
				),
			).toMatchObject({ exitCode: 0 });
			const installed = await exec(
				first,
				"python3 -m venv .venv && .venv/bin/pip install --disable-pip-version-check six==1.17.0 && npm install --ignore-scripts --no-audit --no-fund is-number@7.0.0 && .venv/bin/python -m pip freeze > requirements.lock",
				180,
			);
			expect(installed.exitCode, installed.text).toBe(0);
			expect(
				(
					await exec(
						first,
						"printf repaired > work.txt; cp /ipd/inputs/source inspection.txt; printf tested >> inspection.txt; test ! -w /ipd/inputs/source",
					)
				).exitCode,
			).toBe(0);
			expect((await provider.readFile(first.lease, first.round, "/ipd/inputs/source")).toString()).toBe(
				"sealed original",
			);
			expect(
				(
					await exec(
						second,
						"test ! -e /workspace/node_modules/is-number && test ! -e /workspace/.venv && test ! -e /workspace/work.txt",
					)
				).exitCode,
			).toBe(0);
			const service = await provider.startProcess(second.lease, second.round, {
				command: 'node -e \'require("node:http").createServer((q,r)=>r.end("peer")).listen(3000,"0.0.0.0")\'',
				cwd: "/workspace",
			});
			await expect
				.poll(
					async () =>
						(await exec(second, "node -e 'fetch(\"http://127.0.0.1:3000\").then(r=>{if(!r.ok)process.exit(1)})'"))
							.exitCode,
				)
				.toBe(0);
			const peer = (
				await docker.run([
					"inspect",
					second.lease.providerHandle,
					"--format",
					"{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
				])
			).stdout
				.toString()
				.trim();
			for (const url of [`http://${peer}:3000`, "http://169.254.169.254", "http://127.0.0.1:80"])
				expect(
					(
						await exec(
							first,
							`NO_PROXY= no_proxy= node -e 'fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'`,
						)
					).exitCode,
				).not.toBe(0);
			expect(
				(
					await exec(
						first,
						'node -e \'const n=require("node:net").connect(80,"1.1.1.1",()=>process.exit(0));n.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),1500)\'',
					)
				).exitCode,
			).toBe(1);
			await expect(
				provider.exec(second.lease, second.round, { command: "sleep 60", cwd: "/workspace", timeoutSeconds: 0.2 }),
			).rejects.toMatchObject({ code: "process_timeout" });
			expect((await provider.processStatus(second.lease, service)).state).toBe("running");
			const saved = await manager.suspendRun("network-run");
			for (const reference of saved) await manager.verifyResume(reference.environment);
			first.round = await manager.bindRound(first.lease.leaseId, {
				roundId: "round",
				inputs: [],
				allowedOperations: ["read", "write", "exec"],
			});
			expect(
				(
					await exec(
						first,
						`.venv/bin/python -c 'import six; assert six.__version__=="1.17.0"' && node -e 'if(!require("is-number")(2))process.exit(1)' && test -s research.html && test -s work.txt`,
					)
				).exitCode,
			).toBe(0);
		} finally {
			await manager.releaseRun("network-run");
			await rm(root, { recursive: true, force: true });
		}
	},
	300_000,
);
