import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	type AgentToolResult,
	createAgentSessionFromServices,
	createAgentSessionServices,
	defineTool,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PiNodeSessionFactory } from "../src/adapter/pi-node-session-factory.ts";
import { PiNodeWorker } from "../src/adapter/pi-node-worker.ts";
import { compileWorkflow, type NodeRoundWork } from "../src/index.ts";
import {
	createEnvironmentBinding,
	createEnvironmentToolDefinitions,
	DockerCli,
	DockerEnvironmentProvider,
	EnvironmentError,
	EnvironmentManager,
	hashEnvironmentSource,
	hashSkillPackage,
	loadRegisteredDockerProfile,
	parseSkillEnvironmentRequirements,
	verifyEnvironmentProbes,
} from "../src/workspace.ts";
import { createCompilerFixture } from "./fixtures.ts";

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

	async function environment(profileName: "code-node24" | "office-pptx", realSkill = false) {
		let templatePath = join(environmentsRoot, profileName, "profile.template.json");
		const image = profileName === "code-node24" ? process.env.PI_IPD_CODE_IMAGE : process.env.PI_IPD_OFFICE_IMAGE;
		if (image) {
			const template = JSON.parse(await readFile(templatePath, "utf8")) as { image: { reference: string } };
			template.image.reference = image;
			templatePath = join(root, `${profileName}.json`);
			await writeFile(templatePath, JSON.stringify(template));
		}
		const registered = await loadRegisteredDockerProfile(templatePath, docker);
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
		const skillRoot = realSkill
			? fileURLToPath(new URL("../../../.pi/skills/pptx", import.meta.url))
			: join(root, `skill-${profileName}`);
		if (!realSkill) {
			await mkdir(skillRoot, { recursive: true });
			await writeFile(join(skillRoot, "SKILL.md"), `---\nname: smoke\ndescription: smoke\n---\n${profileName}\n`);
		}
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
		return { manager, provider, lease, round, registered, skillRoot, skillPath: `/ipd/skills/smoke/${skillHash}` };
	}

	it("lets the real node Session repair a project dependency before export without failing preparation", async () => {
		const current = await environment("code-node24");
		const faux = registerFauxProvider();
		let worker: PiNodeWorker | undefined;
		try {
			const model = faux.getModel();
			const modelRuntime = await ModelRuntime.create({
				authPath: join(root, "project-auth.json"),
				modelsPath: null,
				refreshOnCreate: false,
			});
			modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
			await modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
			const fixture = createCompilerFixture();
			fixture.assets.agentCards = fixture.assets.agentCards.map((card) =>
				card.id === "producer" ? { ...card, tools: ["read", "bash"] } : card,
			);
			fixture.assets.tools = ["read", "bash"].map((id) => ({ id, hash: "a".repeat(64), source: "pi-native" }));
			fixture.assets.skills = [
				{
					id: "smoke",
					hash: await hashSkillPackage(current.skillRoot),
					source: "test",
					filePath: join(current.skillRoot, "SKILL.md"),
					baseDir: current.skillRoot,
					description: "Project setup test",
					allowedTools: ["bash"],
					environmentRequirements: {
						schemaVersion: 1,
						capabilities: [],
						commands: [],
						projectProbes: [
							{
								id: "dependency-ready",
								version: "1.0.0",
								command: ["/usr/bin/test", "-f", "/workspace/dependency-ready"],
								timeoutSeconds: 10,
							},
						],
					},
				},
			];
			fixture.workflow.nodes[0].agents[0].tools = [{ id: "read" }, { id: "bash" }];
			fixture.workflow.nodes[0].agents[0].skills = [{ id: "smoke" }];
			const compiled = compileWorkflow({
				...fixture,
				assets: {
					...fixture.assets,
					environmentProfiles: [current.registered],
					environmentPolicy: { allowedProfiles: [current.registered.ref] },
				},
			});
			if (!compiled.ok) throw new Error(JSON.stringify(compiled.report.diagnostics));
			worker = new PiNodeWorker({
				agentDir: root,
				workspace: root,
				sessionDirectory: join(root, "project-sessions"),
				modelRuntime,
				model,
				thinkingLevel: "off",
				environmentManager: current.manager,
			});
			const work: NodeRoundWork = {
				runId: "run-code-node24",
				roundId: "project-round",
				node: compiled.baseline.nodes[0],
				inputSubmissions: [],
				inputBindings: [],
				taskContext: { materials: [], unresolvedFacts: [] },
				forbiddenMutableReadPaths: [],
				feedback: [],
				environmentBinding: compiled.baseline.environmentBindings[0],
			};
			await worker.prepareRound(work);
			const submitted = {
				summary: "candidate",
				outputs: [
					{
						output_id: "content-output",
						files: [{ path: "outputs/produce/result.txt", media_type: "text/plain" }],
					},
				],
				evidence: [],
				metadata: {},
			};
			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall("bash", {
						command: "mkdir -p outputs/produce; printf result > outputs/produce/result.txt",
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxToolCall("submit_artifact", submitted), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("bash", { command: "touch dependency-ready" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("submit_artifact", submitted), { stopReason: "toolUse" }),
			]);
			await worker.runExecution(work);
			const original = worker.inspectRun(work.runId).find((reference) => reference.sessionId)?.sessionId;
			await expect(worker.exportSubmission(work, submitted)).rejects.toThrow("Project dependencies are not ready");
			await worker.runExecution({
				...work,
				feedback: [{ type: "submission_correction", issue: "Prepare the project dependency" }],
			});
			const exported = await worker.exportSubmission(work, submitted);
			expect(await readFile(join(exported!, "outputs/produce/result.txt"), "utf8")).toBe("result");
			expect(worker.inspectRun(work.runId).find((reference) => reference.sessionId)?.sessionId).toBe(original);
			await rm(exported!, { recursive: true, force: true });
			const exec = current.provider.exec;
			current.provider.exec = async () => {
				throw new EnvironmentError("environment_lost", "synthetic lost environment");
			};
			try {
				await expect(worker.exportSubmission(work, submitted)).rejects.toMatchObject({ kind: "environment_lost" });
			} finally {
				current.provider.exec = exec;
			}
		} finally {
			await worker?.releaseRun("run-code-node24");
			await current.manager.releaseRun("run-code-node24");
			faux.unregister();
		}
	}, 120_000);

	it("materializes an external PDF result before native Pi read, grep and Bash consume it", async () => {
		const current = await environment("code-node24");
		const faux = registerFauxProvider();
		const pdfRoot = join(tmpdir(), "pi-web-pdf");
		const pdfPath = join(pdfRoot, `ipd-test-${randomUUID()}.md`);
		let session: Awaited<ReturnType<PiNodeSessionFactory["create"]>> | undefined;
		try {
			const body = "# PDF\n\n> Source: https://example.com/report.pdf\n> Pages: 1\n\n---\n\nverified-pdf-body\n";
			let fetches = 0;
			const fetch = defineTool({
				name: "fetch_content",
				label: "Fetch",
				description: "Registered external fetch fixture",
				parameters: Type.Object({ url: Type.String() }),
				async execute() {
					fetches++;
					await mkdir(pdfRoot, { recursive: true });
					await writeFile(pdfPath, body);
					return {
						content: [
							{
								type: "text",
								text: `PDF extracted and saved to: ${pdfPath}\n\nPages: 1\nCharacters: ${body.length}`,
							},
						],
						details: { urls: ["https://example.com/report.pdf"], responseId: "pdf-response" },
					};
				},
			});
			const model = faux.getModel();
			const modelRuntime = await ModelRuntime.create({
				authPath: join(root, "pdf-auth.json"),
				modelsPath: null,
				refreshOnCreate: false,
			});
			modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
			await modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
			const compiled = compileWorkflow(createCompilerFixture());
			if (!compiled.ok) throw new Error("Invalid fixture");
			const participant = structuredClone(compiled.baseline.nodes[0].agents[0]);
			participant.lockedTools = ["read", "grep", "bash", "fetch_content"].map((id) => ({
				id,
				hash: "a".repeat(64),
				source: "test",
				...(id === "fetch_content" ? { execution: "control_read" as const } : {}),
			}));
			const getContext = () => current.manager.context(current.lease.leaseId, current.round.roundId);
			session = await new PiNodeSessionFactory({ agentDir: root, modelRuntime, customTools: [fetch] }).create({
				nodeId: "pdf-reader",
				workspace: root,
				sessionDirectory: join(root, "pdf-sessions"),
				systemPrompt: "Read the fetched document",
				participant,
				runDefaultModel: model,
				runDefaultThinkingLevel: "off",
				environmentCwd: "/workspace",
				environmentTools: createEnvironmentToolDefinitions({ hostWorkspace: root, getContext }),
				getEnvironmentContext: getContext,
			});
			const destination = `/workspace/.external-content/${createHash("sha256").update(body).digest("hex")}.md`;
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("fetch_content", { url: "https://example.com/report.pdf" }), {
					stopReason: "toolUse",
				}),
				(context) => {
					expect(JSON.stringify(context.messages)).toContain(destination);
					expect(JSON.stringify(context.messages)).not.toContain(pdfPath);
					return fauxAssistantMessage(fauxToolCall("read", { path: destination }), { stopReason: "toolUse" });
				},
				fauxAssistantMessage(fauxToolCall("grep", { path: destination, pattern: "verified-pdf-body" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("bash", { command: `cat ${destination}` }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Done"),
			]);
			await session.prompt("Fetch and inspect the PDF");
			const results = session.messages.filter((message) => message.role === "toolResult");
			expect(results).toHaveLength(4);
			expect(results.every((result) => !result.isError)).toBe(true);
			for (const result of results.slice(1)) expect(JSON.stringify(result.content)).toContain("verified-pdf-body");
			expect(fetches).toBe(1);
		} finally {
			await session?.abort();
			session?.dispose();
			faux.unregister();
			await current.manager.releaseRun("run-code-node24");
			await rm(pdfPath, { force: true });
		}
	}, 120_000);

	it.each(["code-node24", "office-pptx"] as const)(
		"ships the generated bridges unchanged in %s",
		async (profile) => {
			const current = await environment(profile);
			try {
				const names = ["command-bridge.mjs", "process-bridge.mjs", "fs-bridge.mjs"];
				const output: Buffer[] = [];
				await current.provider.exec(current.lease, current.round, {
					cwd: "/workspace",
					command: `node -e 'const fs=require("node:fs"),crypto=require("node:crypto");for(const name of ${JSON.stringify(names)})console.log(name+" "+crypto.createHash("sha256").update(fs.readFileSync("/usr/local/lib/pi-ipd/"+name)).digest("hex"))'`,
					onData: (data) => output.push(data),
				});
				const expected = await Promise.all(
					names.map(
						async (name) =>
							`${name} ${createHash("sha256")
								.update(await readFile(join(environmentsRoot, "common", name)))
								.digest("hex")}`,
					),
				);
				expect(Buffer.concat(output).toString().trim().split("\n")).toEqual(expected);
			} finally {
				await current.manager.releaseRun(`run-${profile}`);
			}
		},
		120_000,
	);

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
			await expect(
				current.provider.exec(current.lease, current.round, {
					command: "sleep 60",
					cwd: "/workspace",
					timeoutSeconds: 0.2,
				}),
			).rejects.toMatchObject({ code: "process_timeout" });
			expect((await current.provider.processStatus(current.lease, service)).state).toBe("running");
			expect(
				(
					await current.provider.exec(current.lease, current.round, {
						command: "node -e 'fetch(\"http://127.0.0.1:3010\").then(r=>{if(!r.ok)process.exit(1)})'",
						cwd: "/workspace",
					})
				).exitCode,
			).toBe(0);

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
			expect((await current.provider.processStatus(current.lease, service)).state).toBe("running");
			expect((await current.provider.stopProcess(current.lease, service)).state).toBe("stopped");
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

	it.each(["code-node24", "office-pptx"] as const)(
		"uses identical interpreter selection for all %s command paths",
		async (profile) => {
			const current = await environment(profile);
			try {
				const command = "python3 -c 'import sys; print(sys.executable)'";
				const normal: Buffer[] = [];
				const logged: Buffer[] = [];
				await current.provider.exec(current.lease, current.round, {
					command,
					cwd: "/workspace",
					onData: (data) => normal.push(data),
				});
				await current.provider.exec(current.lease, current.round, {
					command,
					cwd: "/workspace",
					fullOutputPath: "/scratch/interpreter.log",
					onData: (data) => logged.push(data),
				});
				const process = await current.provider.startProcess(current.lease, current.round, {
					command,
					cwd: "/workspace",
				});
				await expect
					.poll(() => current.provider.processStatus(current.lease, process))
					.toMatchObject({ state: "exited", exitCode: 0 });
				const output = Buffer.concat(normal).toString();
				expect(Buffer.concat(logged).toString()).toBe(output);
				expect((await current.provider.processLogs(current.lease, process, 0)).data.toString()).toBe(output);
				expect(
					(await current.provider.readFile(current.lease, current.round, "/scratch/interpreter.log")).toString(),
				).toBe(output);
				expect(output.trim()).toBe(profile === "office-pptx" ? "/opt/pi-ipd/venv/bin/python3" : "/usr/bin/python3");
			} finally {
				await current.manager.releaseRun(`run-${profile}`);
			}
		},
		120_000,
	);

	it("uses the same Workspace tools from an ordinary Pi SDK session without an IPD Runtime", async () => {
		const current = await environment("code-node24");
		const faux = registerFauxProvider();
		const host = join(root, "ordinary-sdk");
		await mkdir(host);
		const model = faux.getModel();
		const modelRuntime = await ModelRuntime.create({
			authPath: join(host, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
		await modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
		const services = await createAgentSessionServices({
			cwd: host,
			agentDir: host,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noContextFiles: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const tools = createEnvironmentToolDefinitions({
			hostWorkspace: host,
			getContext: () => current.manager.context(current.lease.leaseId, current.round.roundId),
		});
		const { session } = await createAgentSessionFromServices({
			services,
			model,
			thinkingLevel: "off",
			sessionManager: SessionManager.inMemory(host),
			tools: ["write", "read", "bash"],
			customTools: tools,
		});
		try {
			await writeFile(join(host, "sdk.txt"), "host decoy");
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path: "sdk.txt", content: "ordinary SDK workspace" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("read", { path: "sdk.txt" }), { stopReason: "toolUse" }),
				(context) => {
					expect(JSON.stringify(context.messages)).toContain("ordinary SDK workspace");
					return fauxAssistantMessage(fauxToolCall("bash", { command: "cat sdk.txt" }), { stopReason: "toolUse" });
				},
				fauxAssistantMessage("Done"),
			]);
			await session.prompt("Write and inspect a file in the provided Workspace.");
			expect(faux.state.callCount).toBe(4);
			expect((await current.provider.readFile(current.lease, current.round, "/workspace/sdk.txt")).toString()).toBe(
				"ordinary SDK workspace",
			);
			expect(await readFile(join(host, "sdk.txt"), "utf8")).toBe("host decoy");
		} finally {
			await session.abort();
			session.dispose();
			faux.unregister();
			await current.manager.releaseRun("run-code-node24");
		}
	}, 120_000);

	it("generates and renders a real multilingual PPTX with chart, notes, text, image, and font checks", async () => {
		const current = await environment("office-pptx", true);
		try {
			const backend = {
				hostWorkspace: root,
				getContext: () => current.manager.context(current.lease.leaseId, current.round.roundId),
			};
			const requirements = parseSkillEnvironmentRequirements(
				await readFile(join(current.skillRoot, "SKILL.md"), "utf8"),
				"pptx",
			)!;
			await verifyEnvironmentProbes(
				backend,
				(requirements.probes ?? []).map((probe) => ({
					...probe,
					command: probe.command.map((arg) => arg.replaceAll("$SKILL_DIR", current.skillPath)),
				})),
			);
			const script = `const pptxgen=require("pptxgenjs"); const p=new pptxgen(); p.layout="LAYOUT_WIDE"; p.author="IPD smoke"; const s=p.addSlide(); s.addText("IPD Office Smoke / 中文演示",{x:0.7,y:0.5,w:7,h:0.5,fontFace:"Noto Sans CJK SC",fontSize:24}); s.addChart(p.ChartType.bar,[{name:"Score",labels:["A","B"],values:[2,4]}],{x:0.8,y:1.4,w:6,h:4}); s.addNotes("Synthetic speaker note / 合成备注"); p.writeFile({fileName:"/workspace/outputs/smoke/smoke.pptx"});\n`;
			await current.provider.writeFile(
				current.lease,
				current.round,
				"/workspace/outputs/smoke/create.cjs",
				Buffer.from(script),
			);
			const command = [
				"node /workspace/outputs/smoke/create.cjs",
				`python3 ${current.skillPath}/scripts/office/validate.py /workspace/outputs/smoke/smoke.pptx`,
				"python3 -m markitdown /workspace/outputs/smoke/smoke.pptx",
				'python3 -c \'import zipfile; z=zipfile.ZipFile("/workspace/outputs/smoke/smoke.pptx"); assert any(n.startswith("ppt/notesSlides/") for n in z.namelist())\'',
				`python3 ${current.skillPath}/scripts/office/soffice.py --headless -env:UserInstallation=file:///tmp/lo-profile --convert-to pdf --outdir /workspace/outputs/smoke /workspace/outputs/smoke/smoke.pptx`,
				"pdfinfo /workspace/outputs/smoke/smoke.pdf | grep -Eq '^Pages:[[:space:]]+1$'",
				"pdftoppm -f 1 -singlefile -png -r 96 /workspace/outputs/smoke/smoke.pdf /workspace/outputs/smoke/rendered",
				"test -s /workspace/outputs/smoke/rendered.png",
				"pdftotext /workspace/outputs/smoke/smoke.pdf /workspace/outputs/smoke/text.txt",
				"grep -q 'IPD Office Smoke' /workspace/outputs/smoke/text.txt",
				"fc-match 'Noto Sans CJK SC' | grep -qi 'NotoSansCJK'",
			].join(" && ");
			const tools = createEnvironmentToolDefinitions(backend);
			const bash = tools.find((tool) => tool.name === "bash")!;
			const result = await bash.execute(
				"real-skill-qa",
				{ command, timeout: 120 },
				undefined,
				undefined,
				{} as never,
			);
			expect(
				result.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n"),
			).toContain("All validations PASSED");
			const image = await tools
				.find((tool) => tool.name === "read")!
				.execute(
					"rendered-qa",
					{ path: "/workspace/outputs/smoke/rendered.png" },
					undefined,
					undefined,
					{} as never,
				);
			expect(image.content.some((part) => part.type === "image")).toBe(true);
			const entries = await current.provider.list(current.lease, current.round, "/workspace/outputs/smoke");
			expect(entries.map((entry) => entry.name)).toEqual(
				expect.arrayContaining(["smoke.pptx", "smoke.pdf", "rendered.png", "text.txt"]),
			);
			const exported = await current.provider.exportOutputs(current.lease, current.round, {
				destination: join(root, "office-delivery"),
				outputs: [{ outputId: "smoke", outputRoot: "outputs/smoke", logicalPath: "outputs/smoke/smoke.pptx" }],
			});
			const delivered = await readFile(exported.files[0].stagedPath);
			expect(delivered.subarray(0, 2).toString()).toBe("PK");
			expect(createHash("sha256").update(delivered).digest("hex")).toBe(exported.files[0].sha256);
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
			await current.provider.writeFile(
				current.lease,
				current.round,
				"/workspace/large.txt",
				Buffer.alloc(9 * 1024 * 1024, "x"),
			);
			expect((await current.provider.readFile(current.lease, current.round, "/workspace/large.txt")).length).toBe(
				9 * 1024 * 1024,
			);
			await execute("bash", { command: "truncate -s 67108865 too-large.dat" });
			await expect(
				current.provider.readFile(current.lease, current.round, "/workspace/too-large.dat"),
			).rejects.toMatchObject({ code: "output_limit" });
			await current.provider.writeFile(
				current.lease,
				current.round,
				"/workspace/many.txt",
				Buffer.from("needle\n".repeat(100_000)),
			);
			expect(
				await current.provider.search(current.lease, current.round, {
					path: "/workspace/many.txt",
					pattern: "needle",
					maxResults: 5,
				}),
			).toHaveLength(5);
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
			).rejects.toMatchObject({ code: "path_not_found" });
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

	it.each(["code-node24", "office-pptx"] as const)(
		"retains the original %s lease and WIP across pause and resume",
		async (profile) => {
			const current = await environment(profile);
			try {
				await current.provider.writeFile(
					current.lease,
					current.round,
					"/workspace/progress.txt",
					Buffer.from("unapproved work\n"),
				);
				await current.provider.startProcess(current.lease, current.round, {
					command: "sleep 60",
					cwd: "/workspace",
				});
				const saved = await current.manager.suspendRun(`run-${profile}`);
				expect(saved).toHaveLength(1);
				expect(saved[0].environment.leaseId).toBe(current.lease.leaseId);
				await writeFile(join(saved[0].workspace, "progress.txt"), "changed outside the paused container");
				await expect(current.manager.verifyResume(saved[0].environment)).rejects.toMatchObject({
					code: "environment_lost",
				});
				await writeFile(join(saved[0].workspace, "progress.txt"), "unapproved work\n");
				await expect(
					current.provider.readFile(current.lease, current.round, "/workspace/progress.txt"),
				).rejects.toMatchObject({ code: "policy_denied" });
				await current.manager.verifyResume(saved[0].environment);
				const resumed = await current.manager.bindRound(current.lease.leaseId, {
					roundId: current.round.roundId,
					inputs: [],
					allowedOperations: ["read", "write", "exec", "process", "export"],
				});
				expect(resumed.generation).toBe(current.round.generation + 1);
				const context = current.manager.context(current.lease.leaseId, resumed.roundId);
				expect(context.lease.providerHandle).toBe(current.lease.providerHandle);
				expect(
					(await current.provider.readFile(context.lease, resumed, "/workspace/progress.txt")).toString(),
				).toBe("unapproved work\n");
				await expect(
					current.provider.writeFile(current.lease, current.round, "/workspace/progress.txt", Buffer.from("late")),
				).rejects.toMatchObject({ code: "policy_denied" });
			} finally {
				await current.manager.releaseRun(`run-${profile}`);
			}
		},
		120_000,
	);
});
