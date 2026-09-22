import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { DockerCommandRunner } from "../src/environment/docker-adapter.ts";
import {
	compileWorkflow,
	createEnvironmentBinding,
	createEnvironmentToolDefinitions,
	DockerCli,
	DockerEnvironmentProvider,
	EnvironmentManager,
	loadRegisteredDockerProfile,
	resolveExecutionProfile,
	verifyEnvironmentProbes,
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

const template = new URL("../environments/general-purpose/profile.template.json", import.meta.url).pathname;

it("selects the general default without a Skill and retains explicit specialized environments", async () => {
	const docker: DockerCommandRunner = {
		run: async () => ({
			exitCode: 0,
			stdout: Buffer.from(`sha256:${"a".repeat(64)}|linux/amd64`),
			stderr: Buffer.alloc(0),
		}),
	};
	const general = await loadRegisteredDockerProfile(template, docker);
	const office = await loadRegisteredDockerProfile(
		new URL("../environments/office-pptx/profile.template.json", import.meta.url).pathname,
		docker,
	);
	const policy = { allowedProfiles: [general.ref, office.ref], defaultProfile: general.ref };
	const fixture = createCompilerFixture();
	const compiled = compileWorkflow({
		...fixture,
		assets: { ...fixture.assets, skills: [], environmentProfiles: [general, office], environmentPolicy: policy },
	});
	expect(compiled.ok).toBe(true);
	if (!compiled.ok) throw new Error(JSON.stringify(compiled.report.diagnostics));
	for (const binding of compiled.baseline.environmentBindings) {
		expect(binding.profileRef.id).toBe("general-purpose");
		expect(binding.resources).toMatchObject({ cpus: 2, memoryBytes: 2 * 1024 ** 3 });
		expect(binding.capabilities).toContainEqual({ id: "python", version: "3.12.14" });
	}
	expect(
		resolveExecutionProfile({
			profiles: [general, office],
			policy,
			explicitRef: office.ref,
			requiredTools: [],
			requirements: { schemaVersion: 1, capabilities: [{ id: "pptx" }], commands: [] },
		}).ref.id,
	).toBe("office-pptx");
});

it.runIf(process.env.PI_IPD_DOCKER_INTEGRATION === "1")(
	"runs Node/Python data work through the real general-purpose Provider at 2 CPU / 2 GiB",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-general-smoke-"));
		const docker = new DockerCli({
			dockerConfigDirectory: join(root, "docker-config"),
			managementTimeoutMs: 120_000,
		});
		let templatePath = template;
		if (process.env.PI_IPD_GENERAL_IMAGE) {
			const selected = JSON.parse(await readFile(template, "utf8")) as { image: { reference: string } };
			selected.image.reference = process.env.PI_IPD_GENERAL_IMAGE;
			templatePath = join(root, "general-profile.json");
			await writeFile(templatePath, JSON.stringify(selected));
		}
		const profile = await loadRegisteredDockerProfile(templatePath, docker);
		const binding = createEnvironmentBinding({
			nodeId: "smoke",
			participantId: "worker",
			profile,
			readPaths: [],
			writePaths: ["outputs/smoke"],
			skillHashes: [],
			policy: { allowedProfiles: [profile.ref], defaultProfile: profile.ref },
		});
		const provider = new DockerEnvironmentProvider({ docker, storageRoot: join(root, "leases") });
		const manager = new EnvironmentManager([provider]);
		try {
			const lease = await manager.prepare("general-smoke", binding);
			await manager.bindStaticAssets(lease.leaseId, []);
			const round = await manager.bindRound(lease.leaseId, {
				roundId: "round",
				inputs: [],
				allowedOperations: ["read", "write", "exec", "process", "export"],
			});
			const backend = { hostWorkspace: root, getContext: () => manager.context(lease.leaseId, round.roundId) };
			await verifyEnvironmentProbes(backend, binding.probes);
			const tools = createEnvironmentToolDefinitions(backend);
			const execute = async (name: string, input: Record<string, unknown>) => {
				const tool = tools.find((candidate) => candidate.name === name);
				if (!tool) throw new Error(`Missing tool ${name}`);
				return tool.execute(`call-${name}`, input as never, undefined, undefined, {} as never);
			};
			await execute("write", {
				path: "smoke.py",
				content: [
					"import io, json, pathlib, sqlite3, zipfile",
					"import numpy as np, pandas as pd, yaml, jsonschema, openpyxl, requests",
					"from bs4 import BeautifulSoup",
					"from lxml import etree",
					"out = pathlib.Path('outputs/smoke'); out.mkdir(parents=True, exist_ok=True)",
					"table = pd.read_csv(io.StringIO('name,value\\na,2\\nb,3\\n'))",
					"record = {'total': int(np.sum(table['value']))}",
					"jsonschema.validate(record, {'type': 'object', 'required': ['total']})",
					"assert yaml.safe_load(yaml.safe_dump(record)) == {'total': 5}",
					"table.to_excel(out / 'data.xlsx', index=False)",
					"assert openpyxl.load_workbook(out / 'data.xlsx').active['B3'].value == 3",
					"assert BeautifulSoup('<p>evidence</p>', 'html.parser').get_text() == 'evidence'",
					"assert etree.fromstring(b'<root/>').tag == 'root'",
					"db = sqlite3.connect(':memory:'); assert db.execute('select 2 + 3').fetchone()[0] == 5",
					"(out / 'result.json').write_text(json.dumps(record))",
					"with zipfile.ZipFile(out / 'archive.zip', 'w') as archive: archive.write(out / 'result.json', 'result.json')",
					"print('general-data-smoke-ok')",
				].join("\n"),
			});
			const result = await execute("bash", {
				command:
					"python3 smoke.py && node -e \"if (require('./outputs/smoke/result.json').total !== 5) process.exit(1)\" && jq -e '.total == 5' outputs/smoke/result.json && unzip -t outputs/smoke/archive.zip && curl --fail --silent file:///workspace/outputs/smoke/result.json && python3 -m venv --system-site-packages .venv && .venv/bin/python -c 'import pandas; print(\"private-venv-ok\")'",
			});
			const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
			expect(text).toContain("general-data-smoke-ok");
			expect(text).toContain("private-venv-ok");
			expect(
				JSON.parse((await provider.readFile(lease, round, "/workspace/outputs/smoke/result.json")).toString()),
			).toEqual({ total: 5 });
			await expect(execute("write", { path: "/usr/local/forbidden.txt", content: "must fail" })).rejects.toThrow();
			const host = await docker.run([
				"inspect",
				lease.providerHandle,
				"--format",
				"{{.HostConfig.Memory}}|{{.HostConfig.NanoCpus}}|{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.NetworkMode}}",
			]);
			expect(host.stdout.toString().trim()).toBe("2147483648|2000000000|true|none");
		} finally {
			await manager.releaseRun("general-smoke");
			await rm(root, { recursive: true, force: true });
		}
	},
	120_000,
);
