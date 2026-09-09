import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { compileWorkflow, hashSkillPackage, NodeSessionAdapter, PiNodeSessionFactory } from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

describe("PiNodeSessionFactory", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("continues two rounds on the same real Pi AgentSession", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-node-session-"));
		const skillDir = join(root, "skills", "analysis-skill");
		await mkdir(skillDir, { recursive: true });
		await writeFile(
			join(skillDir, "SKILL.md"),
			"---\nname: analysis-skill\ndescription: Analyze the assigned evidence.\n---\n\nFollow the analysis procedure.\n",
		);
		const faux = registerFauxProvider();
		let observedSystemPrompt = "";
		faux.setResponses([
			(context) => {
				observedSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("first complete");
			},
			fauxAssistantMessage("rework complete"),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "400 BadRequest.TooLarge: request body exceeds 6 MiB",
			}),
		]);
		cleanups.push(async () => {
			faux.unregister();
			await rm(root, { recursive: true, force: true });
		});
		const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});
		await modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
		const compiled = compileWorkflow(createCompilerFixture());
		if (!compiled.ok) throw new Error("Fixture Workflow did not compile");
		const node = compiled.baseline.nodes.find((item) => item.definition.node_id === "produce");
		const participant = node?.agents[0] ? structuredClone(node.agents[0]) : undefined;
		if (!participant) throw new Error("Missing compiled execution participant");
		participant.lockedSkills.push({
			id: "analysis-skill",
			hash: await hashSkillPackage(skillDir),
			source: "test",
			filePath: join(skillDir, "SKILL.md"),
			baseDir: skillDir,
			description: "Analyze the assigned evidence.",
			allowedTools: ["read"],
		});
		participant.lockedTools.push({ id: "read", hash: "a".repeat(64), source: "pi-builtin" });
		const adapter = new NodeSessionAdapter(new PiNodeSessionFactory({ agentDir: root, modelRuntime }));
		const binding = await adapter.create({
			runId: "run-1",
			nodeId: "produce",
			participantId: "producer",
			createInput: {
				workspace: root,
				sessionDirectory: join(root, "sessions"),
				systemPrompt: "Execute the supplied work round.",
				participant,
				runDefaultModel: model,
				runDefaultThinkingLevel: "off",
			},
		});
		await adapter.dispatch("run-1", "produce", "producer", "round-1", "Create the first result");
		await adapter.dispatch("run-1", "produce", "producer", "round-2", "Revise it using the review feedback");
		await expect(
			adapter.dispatch("run-1", "produce", "producer", "round-3", "Inspect additional evidence"),
		).rejects.toThrow("400 BadRequest.TooLarge: request body exceeds 6 MiB");
		expect(adapter.inspect("run-1", "produce", "producer")).toMatchObject({
			sessionId: binding.sessionId,
			status: "idle",
		});
		expect(faux.state.callCount).toBe(3);
		expect(observedSystemPrompt).toContain("Execute the supplied work round.");
		expect(observedSystemPrompt).toContain("analysis-skill");
		expect(observedSystemPrompt).toContain(join(skillDir, "SKILL.md"));
		await adapter.release("run-1", "produce", "producer");
	});
});
