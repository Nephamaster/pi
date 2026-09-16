import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createEnvironmentBinding,
	createEnvironmentToolDefinitions,
	DockerCli,
	DockerEnvironmentProvider,
	EnvironmentManager,
	hashEnvironmentSource,
	hashSkillPackage,
	loadRegisteredDockerProfile,
} from "../src/index.ts";

const integrationEnabled = process.env.PI_IPD_DOCKER_INTEGRATION === "1";
const environmentsRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "environments");

describe.runIf(integrationEnabled)("Docker environment integration", () => {
	let root: string;
	let docker: DockerCli;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-ipd-docker-integration-"));
		docker = new DockerCli({ dockerConfigDirectory: join(root, "docker-config"), managementTimeoutMs: 120_000 });
	});

	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true });
	});

	async function environment(profileName: "code-node24" | "office-pptx") {
		const registered = await loadRegisteredDockerProfile(
			join(environmentsRoot, profileName, "profile.template.json"),
			docker,
		);
		const binding = createEnvironmentBinding({
			nodeId: "smoke",
			participantId: "worker",
			profile: registered,
			readPaths: [],
			writePaths: ["outputs/smoke"],
			skillHashes: [],
			policy: {
				allowedProfiles: [{ id: registered.profile.id, version: registered.profile.version }],
				defaultProfile: { id: registered.profile.id, version: registered.profile.version },
			},
		});
		const provider = new DockerEnvironmentProvider({ docker, storageRoot: join(root, "leases") });
		const manager = new EnvironmentManager([provider]);
		const lease = await manager.prepare(`run-${profileName}`, binding);
		const skillRoot = join(root, `skill-${profileName}`);
		await mkdir(skillRoot, { recursive: true });
		await writeFile(join(skillRoot, "SKILL.md"), `---\nname: smoke\ndescription: smoke\n---\n${profileName}\n`);
		const skillHash = await hashSkillPackage(skillRoot);
		await manager.bindStaticAssets(lease.leaseId, [
			{
				assetId: "context",
				contentHash: createHash("sha256").update("context-ok\n").digest("hex"),
				virtualPath: "/ipd/context/TASK_SCOPE.md",
				content: Buffer.from("context-ok\n"),
			},
			{
				assetId: "skill",
				contentHash: skillHash,
				virtualPath: `/ipd/skills/smoke/${skillHash}`,
				sourcePath: skillRoot,
			},
		]);
		const round = await manager.bindRound(lease.leaseId, {
			roundId: "round-1",
			inputs: [],
			allowedOperations: ["read", "write", "exec", "process", "export"],
		});
		return { manager, provider, lease, round };
	}

	it("runs the real code Profile with persistent files, local HTTP, Unix IPC, cancellation, and no host secret", async () => {
		const current = await environment("code-node24");
		try {
			const files = {
				"/workspace/package.json": `{"scripts":{"build":"node build.mjs","test":"node --test"},"devDependencies":{}}\n`,
				"/workspace/package-lock.json": `{"name":"ipd-smoke","lockfileVersion":3,"requires":true,"packages":{"":{"name":"ipd-smoke","devDependencies":{}}}}\n`,
				"/workspace/build.mjs": `import {mkdir,writeFile} from "node:fs/promises"; await mkdir("outputs/smoke",{recursive:true}); await writeFile("outputs/smoke/build.txt", "built\\n");\n`,
				"/workspace/smoke.test.mjs": `import test from "node:test"; import assert from "node:assert/strict"; test("smoke",()=>assert.equal(2+2,4));\n`,
				"/workspace/server.mjs": `import http from "node:http"; import net from "node:net"; const socket="/scratch/ipd-smoke.sock"; setTimeout(()=>{net.createServer(c=>c.end("unix-ok")).listen(socket); http.createServer((_q,r)=>r.end("http-ok")).listen(3010,"127.0.0.1"); console.log("ready")},750);\n`,
			};
			for (const [path, content] of Object.entries(files))
				await current.provider.writeFile(current.lease, current.round, path, Buffer.from(content));
			const output: Buffer[] = [];
			const build = await current.provider.exec(current.lease, current.round, {
				command: "npm ci --ignore-scripts && npm run build && npm test",
				cwd: "/workspace",
				onData: (data) => output.push(data),
			});
			expect(build.exitCode, Buffer.concat(output).toString()).toBe(0);
			await expect(
				current.provider.exec(current.lease, current.round, { command: "pwd", cwd: "/etc" }),
			).rejects.toMatchObject({ code: "policy_denied" });
			expect(
				(
					await current.provider.readFile(current.lease, current.round, "/workspace/outputs/smoke/build.txt")
				).toString(),
			).toBe("built\n");

			const service = await current.provider.startProcess(current.lease, current.round, {
				command: "node server.mjs",
				cwd: "/workspace",
			});
			// Process acknowledgement is not application readiness. Probe the actual services.
			await expect
				.poll(
					async () => {
						const diagnostics: Buffer[] = [];
						const client = await current.provider.exec(current.lease, current.round, {
							command: `node -e 'Promise.all([fetch("http://127.0.0.1:3010").then(r=>r.text()),new Promise((ok,fail)=>{const n=require("node:net").connect("/scratch/ipd-smoke.sock");let s="";n.on("data",d=>s+=d);n.on("end",()=>ok(s));n.on("error",fail)})]).then(v=>{if(v.join("|")!=="http-ok|unix-ok")process.exit(1)})'`,
							cwd: "/workspace",
							onData: (data) => diagnostics.push(data),
						});
						return { exitCode: client.exitCode, output: Buffer.concat(diagnostics).toString() };
					},
					{ timeout: 10_000, interval: 100 },
				)
				.toMatchObject({ exitCode: 0 });
			expect((await current.provider.stopProcess(current.lease, service)).state).toBe("stopped");

			process.env.IPD_SYNTHETIC_API_KEY = "must-not-reach-container";
			const environmentOutput: Buffer[] = [];
			await current.provider.exec(current.lease, current.round, {
				command: "env",
				cwd: "/workspace",
				onData: (data) => environmentOutput.push(data),
			});
			delete process.env.IPD_SYNTHETIC_API_KEY;
			expect(Buffer.concat(environmentOutput).toString()).not.toContain("must-not-reach-container");

			const controller = new AbortController();
			const longCommand = current.provider.exec(
				current.lease,
				current.round,
				{ command: "sleep 60", cwd: "/workspace" },
				controller.signal,
			);
			setTimeout(() => controller.abort(), 100);
			await expect(longCommand).rejects.toMatchObject({ code: "cancelled" });
			expect(
				(
					await current.provider.readFile(current.lease, current.round, "/workspace/outputs/smoke/build.txt")
				).toString(),
			).toBe("built\n");
		} finally {
			delete process.env.IPD_SYNTHETIC_API_KEY;
			await current.manager.releaseRun("run-code-node24");
		}
	}, 120_000);

	it("generates and renders a real multilingual PPTX with chart, notes, text, image, and font checks", async () => {
		const current = await environment("office-pptx");
		try {
			const script = `const pptxgen=require("pptxgenjs"); const p=new pptxgen(); p.layout="LAYOUT_WIDE"; p.author="IPD smoke"; const s=p.addSlide(); s.addText("IPD Office Smoke / 中文演示",{x:0.7,y:0.5,w:7,h:0.5,fontFace:"Noto Sans CJK SC",fontSize:24}); s.addChart(p.ChartType.bar,[{name:"Score",labels:["A","B"],values:[2,4]}],{x:0.8,y:1.4,w:6,h:4}); s.addNotes("Synthetic speaker note / 合成备注"); p.writeFile({fileName:"/workspace/outputs/smoke/smoke.pptx"});\n`;
			await current.provider.writeFile(
				current.lease,
				current.round,
				"/workspace/outputs/smoke/create.cjs",
				Buffer.from(script),
			);
			const command = [
				"node /workspace/outputs/smoke/create.cjs",
				'python3 -c \'import zipfile; z=zipfile.ZipFile("/workspace/outputs/smoke/smoke.pptx"); assert any(n.startswith("ppt/notesSlides/") for n in z.namelist())\'',
				"soffice --headless -env:UserInstallation=file:///tmp/lo-profile --convert-to pdf --outdir /workspace/outputs/smoke /workspace/outputs/smoke/smoke.pptx",
				"pdfinfo /workspace/outputs/smoke/smoke.pdf | grep -Eq '^Pages:[[:space:]]+1$'",
				"pdftoppm -f 1 -singlefile -png -r 96 /workspace/outputs/smoke/smoke.pdf /workspace/outputs/smoke/rendered",
				"test -s /workspace/outputs/smoke/rendered.png",
				"pdftotext /workspace/outputs/smoke/smoke.pdf /workspace/outputs/smoke/text.txt",
				"grep -q 'IPD Office Smoke' /workspace/outputs/smoke/text.txt",
				"fc-match 'Noto Sans CJK SC' | grep -qi 'NotoSansCJK'",
			].join(" && ");
			const logs: Buffer[] = [];
			const result = await current.provider.exec(current.lease, current.round, {
				command,
				cwd: "/workspace",
				timeoutSeconds: 120,
				onData: (data) => logs.push(data),
			});
			expect(Buffer.concat(logs).toString()).not.toContain("Error");
			expect(result.exitCode).toBe(0);
			const entries = await current.provider.list(current.lease, current.round, "/workspace/outputs/smoke");
			expect(entries.map((entry) => entry.name)).toEqual(
				expect.arrayContaining(["smoke.pptx", "smoke.pdf", "rendered.png", "text.txt"]),
			);
		} finally {
			await current.manager.releaseRun("run-office-pptx");
		}
	}, 120_000);

	it("routes every Pi file, search, image, and Bash tool through the same lease", async () => {
		const current = await environment("code-node24");
		const hostWorkspace = join(root, "host-decoy");
		await mkdir(hostWorkspace);
		await writeFile(join(hostWorkspace, "shared.txt"), "host-secret\n");
		try {
			const tools = createEnvironmentToolDefinitions({
				hostWorkspace,
				getContext: () => ({
					provider: current.provider,
					lease: current.lease,
					round: current.round,
					binding: current.manager.context(current.lease.leaseId, current.round.roundId).binding,
				}),
			});
			const execute = async (name: string, input: unknown) => {
				const tool = tools.find((candidate) => candidate.name === name);
				if (!tool) throw new Error(`Missing environment tool: ${name}`);
				return tool.execute(`call-${name}`, input as never, undefined, undefined, {} as never) as Promise<
					AgentToolResult<{ fullOutputPath?: string } | undefined>
				>;
			};
			const text = (result: AgentToolResult<unknown>) =>
				result.content.find((item) => item.type === "text")?.text ?? "";

			await execute("write", { path: "shared.txt", content: "container-value\nneedle\n" });
			const read = await execute("read", { path: "shared.txt" });
			expect(text(read)).toBe("container-value\nneedle\n");
			expect(text(await execute("read", { path: "/ipd/context/TASK_SCOPE.md" }))).toBe("context-ok\n");
			await execute("edit", { path: "shared.txt", edits: [{ oldText: "container-value", newText: "edited" }] });
			const directMatches = await current.provider.search(current.lease, current.round, {
				path: "/workspace",
				pattern: "needle",
			});
			expect(directMatches).toHaveLength(1);
			const grep = await execute("grep", { path: ".", pattern: "needle" });
			expect(text(grep)).toContain("shared.txt:2: needle");
			const find = await execute("find", { path: ".", pattern: "*.txt" });
			expect(text(find)).toContain("shared.txt");
			const ls = await execute("ls", { path: "." });
			expect(text(ls)).toContain("shared.txt");

			const png = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
				"base64",
			);
			await current.provider.writeFile(current.lease, current.round, "/workspace/pixel.png", png);
			const image = await execute("read", { path: "pixel.png" });
			expect(image.content.some((item) => item.type === "image")).toBe(true);

			const bash = await execute("bash", { command: "yes x | head -c 70000" });
			expect(bash.details?.fullOutputPath).toMatch(/^\/scratch\/logs\/[a-f0-9]{64}\.log$/);
			const fullLog = await current.provider.readFile(
				current.lease,
				current.round,
				bash.details?.fullOutputPath ?? "",
			);
			expect(fullLog.length).toBe(70_000);
			const started = JSON.parse(
				text(
					await execute("environment_process_start", {
						command: "node -e 'console.log(\"managed-ready\"); setInterval(()=>{},1000)'",
						cwd: "/workspace",
					}),
				),
			) as { processId: string };
			// The log must already exist when start returns, even if the application is silent.
			await execute("environment_process_logs", { process_id: started.processId, cursor: 0 });
			await expect
				.poll(
					async () => {
						const processLogs = JSON.parse(
							text(await execute("environment_process_logs", { process_id: started.processId, cursor: 0 })),
						) as { text: string };
						return processLogs.text;
					},
					{ timeout: 10_000, interval: 100 },
				)
				.toContain("managed-ready");
			const stopped = JSON.parse(
				text(await execute("environment_process_stop", { process_id: started.processId })),
			) as { state: string };
			expect(stopped.state).toBe("stopped");
			await execute("write", { path: "outputs/smoke/export.txt", content: "stable-export\n" });
			const exportRoot = join(root, "exported");
			const exported = await current.provider.exportOutputs(current.lease, current.round, {
				destination: exportRoot,
				outputs: [{ outputId: "smoke", outputRoot: "outputs/smoke", logicalPath: "outputs/smoke/export.txt" }],
			});
			expect(exported.files[0]).toMatchObject({
				outputId: "smoke",
				logicalPath: "outputs/smoke/export.txt",
				size: 14,
			});
			expect(await readFile(join(exportRoot, "outputs/smoke/export.txt"), "utf8")).toBe("stable-export\n");
			await expect(
				current.provider.exportOutputs(current.lease, current.round, {
					destination: join(root, "work-export"),
					outputs: [{ outputId: "smoke", outputRoot: "outputs/smoke", logicalPath: "shared.txt" }],
				}),
			).rejects.toMatchObject({ code: "policy_denied" });
			await execute("bash", { command: "ln -s /etc/passwd outputs/smoke/leak.txt" });
			await expect(
				current.provider.exportOutputs(current.lease, current.round, {
					destination: join(root, "invalid-export"),
					outputs: [{ outputId: "smoke", outputRoot: "outputs/smoke", logicalPath: "outputs/smoke/leak.txt" }],
				}),
			).rejects.toMatchObject({ code: "policy_denied" });
			const readonlyAttempt = await current.provider.exec(current.lease, current.round, {
				command: "touch /ipd/context/forbidden /ipd/skills/forbidden /ipd/inputs/forbidden >/dev/null 2>&1",
				cwd: "/workspace",
			});
			expect(readonlyAttempt.exitCode).not.toBe(0);
			await execute("write", { path: "persistent.txt", content: "lease-state\n" });
			const reboundInput = join(root, "rebound-input.txt");
			await writeFile(reboundInput, "new-input\n");
			const nextRound = await current.manager.bindRound(current.lease.leaseId, {
				roundId: "round-2",
				inputs: [
					{
						bindingId: "upstream",
						contentHash: await hashEnvironmentSource(reboundInput),
						virtualPath: "/ipd/inputs/upstream",
						sourcePath: reboundInput,
					},
				],
				allowedOperations: ["read", "write", "exec", "process", "export"],
			});
			const nextContext = current.manager.context(current.lease.leaseId, nextRound.roundId);
			await expect(
				current.provider.readFile(current.lease, current.round, "/workspace/persistent.txt"),
			).rejects.toMatchObject({ code: "policy_denied" });
			expect(
				(await current.provider.readFile(nextContext.lease, nextContext.round, "/ipd/inputs/upstream")).toString(),
			).toBe("new-input\n");
			expect(
				(
					await current.provider.readFile(nextContext.lease, nextContext.round, "/workspace/persistent.txt")
				).toString(),
			).toBe("lease-state\n");
			const finalRound = await current.manager.bindRound(current.lease.leaseId, {
				roundId: "round-3",
				inputs: [],
				allowedOperations: ["read"],
			});
			const finalContext = current.manager.context(current.lease.leaseId, finalRound.roundId);
			await expect(
				current.provider.readFile(finalContext.lease, finalContext.round, "/ipd/inputs/upstream"),
			).rejects.toMatchObject({ code: "environment_unavailable" });
			expect(await readFile(join(hostWorkspace, "shared.txt"), "utf8")).toBe("host-secret\n");
		} finally {
			await current.manager.releaseRun("run-code-node24");
		}
	}, 120_000);

	it("rejects process initialization failures and preserves immediate command exit status", async () => {
		const current = await environment("code-node24");
		try {
			await expect(
				current.provider.startProcess(current.lease, current.round, {
					command: "echo must-not-run",
					cwd: "/workspace/does-not-exist",
				}),
			).rejects.toThrow(/failed to start.*ENOENT/);
			const process = await current.provider.startProcess(current.lease, current.round, {
				command: "printf 'quick-exit'; exit 7",
				cwd: "/workspace",
			});
			await current.provider.processLogs(current.lease, process, 0);
			await expect
				.poll(() => current.provider.processStatus(current.lease, process), { timeout: 10_000, interval: 100 })
				.toMatchObject({ state: "exited", exitCode: 7 });
			expect((await current.provider.processLogs(current.lease, process, 0)).data.toString()).toBe("quick-exit");
		} finally {
			await current.manager.releaseRun("run-code-node24");
		}
	}, 120_000);
});
