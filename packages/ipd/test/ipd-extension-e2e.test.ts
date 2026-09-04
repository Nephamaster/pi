import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	type BeforeAgentStartEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	ModelRegistry,
	ModelRuntime,
	type SessionShutdownEvent,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { type IpdExtensionDetails, registerIpdExtension } from "../examples/ipd-extension.ts";
import {
	AgentSessionNodeRunner,
	CheckExecutorRegistry,
	compileWorkflow,
	createArtifactIntegrityCheckExecutor,
	createDefaultArtifactViewRegistry,
	createSkillSnapshot,
	DynamicGateEvaluator,
	FileWorkflowAssetStore,
	GraphEngine,
	IpdRuntime,
	type IpdRuntimeAssetContext,
	type IpdToolCommandParametersSchema,
	MechanicalChecker,
	type PreparedIpdRuntimeAssets,
	SqliteIpdLedger,
	WorkflowPlanner,
} from "../src/index.ts";
import {
	createCompileContext,
	createTestCards,
	createValidWorkflow,
	createWorkflowSubmissionMessages,
	TEST_SKILL,
} from "./fixtures.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface RegisteredExtension {
	beforeAgentStart?: (event: BeforeAgentStartEvent, context: ExtensionContext) => unknown;
	sessionShutdown?: (event: SessionShutdownEvent, context: ExtensionContext) => unknown;
	tool?: ToolDefinition<typeof IpdToolCommandParametersSchema, IpdExtensionDetails>;
	ipdResumeCommand?: { handler: (args: string, context: ExtensionCommandContext) => Promise<void> };
}

function extensionApi(registered: RegisteredExtension): ExtensionAPI {
	return {
		on(event: string, handler: unknown) {
			if (event === "before_agent_start") {
				registered.beforeAgentStart = handler as RegisteredExtension["beforeAgentStart"];
			}
			if (event === "session_shutdown") {
				registered.sessionShutdown = handler as RegisteredExtension["sessionShutdown"];
			}
		},
		registerTool(tool: ToolDefinition<typeof IpdToolCommandParametersSchema, IpdExtensionDetails>) {
			registered.tool = tool;
		},
		registerCommand(name: string, options: RegisteredExtension["ipdResumeCommand"]) {
			if (name === "ipd-resume") registered.ipdResumeCommand = options;
		},
	} as unknown as ExtensionAPI;
}

describe("IPD Extension", () => {
	it("completes a faux Skill Run and preserves Tool Action contracts", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-extension-"));
		roots.push(root);
		await mkdir(join(root, "outputs"));
		await writeFile(join(root, "outputs", "primary.txt"), "final primary content");
		await writeFile(join(root, "outputs", "review.txt"), "reviewable final content");
		const skillContent = "Drive a controlled multi-agent task with independent quality review.";
		const skillPath = join(root, "SKILL.md");
		await writeFile(skillPath, skillContent);
		const skill = createSkillSnapshot({ name: TEST_SKILL, path: skillPath, baseDir: root, content: skillContent });

		const faux = fauxProvider();
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		await modelRuntime.refresh({ allowNetwork: false });

		const cards = createTestCards();
		const candidate = createValidWorkflow(cards);
		candidate.skill = { name: skill.name, hash: skill.hash };
		candidate.globalBudget = {
			mode: "bounded",
			tokens: 100_000,
			timeLimitMs: 3_600_000,
			staffTokens: 15_000,
			reviewerTokens: 20_000,
			reworkTokens: 15_000,
		};
		for (const gate of [candidate.nodes[0].gate, candidate.finalGate]) {
			gate.mechanicalCriteria[0].checkId = "artifact-integrity";
			gate.mechanicalCriteria[0].parameters = {};
		}

		const ledger = new SqliteIpdLedger({ databasePath: join(root, "ipd.sqlite") });
		const nodeRunner = new AgentSessionNodeRunner({
			modelRuntime,
			agentDir: join(root, "agent"),
			sessionDir: join(root, "sessions"),
		});
		const checks = new CheckExecutorRegistry();
		checks.add(createArtifactIntegrityCheckExecutor());
		const gateEvaluator = new DynamicGateEvaluator({
			mechanicalChecker: new MechanicalChecker(checks),
			artifactViews: createDefaultArtifactViewRegistry(),
			nodeRunner,
		});
		const graphEngine = new GraphEngine({ ledger, nodeRunner, gateEvaluator });
		const toolAbort = new AbortController();
		let prepareCount = 0;
		const assetProvider = {
			async prepare(context: IpdRuntimeAssetContext): Promise<PreparedIpdRuntimeAssets> {
				prepareCount++;
				expect(context.cwd).toBe(root);
				expect(context.projectTrusted).toBe(true);
				expect(context.availableSkills.map((item) => item.name)).toEqual([TEST_SKILL]);
				const planner = new WorkflowPlanner({
					ledger,
					nodeRunner,
					assetStore: new FileWorkflowAssetStore({ directory: join(root, "workflow-assets") }),
					toolNames: new Set(["read", "write", "bash"]),
					checks: checks.list(),
				});
				return {
					agentCards: [cards.executor, cards.reviewer, cards.staff],
					plannerCard: cards.staff,
					staffCoreCards: [cards.staff],
					workflowAssets: [],
					planner: {
						planAndFreeze(request) {
							expect(request.signal).toBeUndefined();
							expect(request.runDefaultModel.id).toBe(faux.getModel().id);
							expect(request.globalBudget.mode).toBe("unbounded");
							return planner.planAndFreeze(request);
						},
					},
				};
			},
		};
		const ids = ["run-tool", "trace-tool"];
		const runtime = new IpdRuntime({
			ledger,
			graphEngine,
			assetProvider,
			idFactory: () => ids.shift() ?? "unexpected-id",
		});

		faux.setResponses([
			...createWorkflowSubmissionMessages(candidate),
			fauxAssistantMessage(
				fauxToolCall("write", { path: "outputs/primary.txt", content: "final primary content" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("write", { path: "outputs/review.txt", content: "reviewable final content" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("submit_artifact", {
					summary: "Completed Artifact",
					files: [
						{ path: "outputs/primary.txt", mimeType: "text/plain" },
						{ path: "outputs/review.txt", mimeType: "text/plain" },
					],
					metadata: {},
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("submit_review", {
					decision: "PASS",
					criteria: [
						{
							criterionId: "produce-gate-semantic",
							result: "PASS",
							evidence: { scope: "node" },
							rationale: "Node objective satisfied",
							requiredRework: [],
						},
					],
					unresolvedRisks: [],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("submit_review", {
					decision: "PASS",
					criteria: [
						{
							criterionId: "final-gate-semantic",
							result: "PASS",
							evidence: { scope: "final" },
							rationale: "End-to-end objective satisfied",
							requiredRework: [],
						},
					],
					unresolvedRisks: [],
				}),
				{ stopReason: "toolUse" },
			),
		]);

		const registered: RegisteredExtension = {};
		registerIpdExtension(extensionApi(registered), { runtimeFactory: async () => runtime });
		if (!registered.beforeAgentStart || !registered.tool || !registered.ipdResumeCommand) {
			throw new Error("IPD Extension did not register");
		}
		expect(JSON.stringify(registered.tool.parameters)).toContain('"status"');
		expect(registered.tool.parameters.properties).toHaveProperty("runId");
		const context = {
			cwd: root,
			model: faux.getModel(),
			thinkingLevel: "off",
			modelRegistry: new ModelRegistry(modelRuntime),
			isProjectTrusted: () => true,
			signal: undefined,
		} as unknown as ExtensionContext;
		await registered.beforeAgentStart(
			{
				type: "before_agent_start",
				prompt: "Run IPD",
				systemPrompt: "system",
				systemPromptOptions: {
					cwd: root,
					skills: [{ name: TEST_SKILL, filePath: skillPath, baseDir: root }],
				},
			} as unknown as BeforeAgentStartEvent,
			context,
		);

		const startCommand = { action: "start", task: "Produce the final content", skillName: TEST_SKILL } as const;
		const started = await registered.tool.execute("tool-start", startCommand, toolAbort.signal, undefined, context);
		expect(started.details).toMatchObject({ runId: "run-tool", status: "running" });
		if ("error" in started.details) throw new Error(started.details.error.message);
		expect(started.content[0]).toMatchObject({ type: "text" });
		expect(prepareCount).toBe(1);
		for (let attempt = 0; attempt < 500 && runtime.status("run-tool").status === "running"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		const completed = runtime.status("run-tool", "full");
		expect(completed.status).toBe("succeeded");
		expect(completed.artifacts).toHaveLength(1);
		expect(completed.progress.runRoot).toBe(join(root, ".pi", "ipd", "runs", "run-tool"));
		expect(await readdir(join(root, ".pi", "ipd", "runs", "run-tool", "sessions"))).not.toHaveLength(0);
		const lastSequence = completed.progress.lastEvent?.sequence ?? 0;
		expect(runtime.status("run-tool", "summary", 0).progress.changedSinceSequence).toBe(true);
		expect(runtime.status("run-tool", "summary", lastSequence).progress.changedSinceSequence).toBe(false);
		expect(faux.state.callCount).toBe(11);

		const duplicate = await registered.tool.execute("tool-start", startCommand, toolAbort.signal, undefined, context);
		expect(duplicate.details).toEqual(started.details);
		expect(prepareCount).toBe(1);
		expect(faux.state.callCount).toBe(11);

		const unknown = await registered.tool.execute(
			"tool-unknown-skill",
			{ action: "start", task: "Unknown", skillName: "unknown-skill" },
			undefined,
			undefined,
			context,
		);
		expect("error" in unknown.details ? unknown.details.error.code : undefined).toBe("unknown_skill");
		expect(prepareCount).toBe(1);

		const eventCount = ledger.getRunSnapshot("run-tool").events.length;
		const status = await registered.tool.execute(
			"tool-status",
			{ action: "status", runId: "run-tool", detail: "summary" },
			undefined,
			undefined,
			context,
		);
		expect("error" in status.details ? undefined : status.details.details.detail).toBe("summary");
		expect(ledger.getRunSnapshot("run-tool").events).toHaveLength(eventCount);

		const compileContext = createCompileContext(cards);
		compileContext.runSkill = { name: skill.name, hash: skill.hash };
		compileContext.checks = [
			{ id: "artifact-integrity", parameters: Type.Object({}, { additionalProperties: false }) },
		];
		const compiled = compileWorkflow(candidate, compileContext);
		if (!compiled.ok) throw new Error(compiled.diagnostics.map((item) => item.message).join("\n"));
		ledger.createRun({
			runId: "waiting-run",
			traceId: "waiting-trace",
			idempotencyKey: "waiting-create",
			task: "Wait for user",
			skill: { name: skill.name, hash: skill.hash },
			globalBudget: candidate.globalBudget,
		});
		ledger.transitionRun({ runId: "waiting-run", idempotencyKey: "waiting-compiling", status: "compiling" });
		ledger.freezeWorkflow({ runId: "waiting-run", idempotencyKey: "waiting-freeze", workflow: compiled.value });
		ledger.transitionRun({ runId: "waiting-run", idempotencyKey: "waiting-running", status: "running" });
		ledger.createEscalation({
			runId: "waiting-run",
			idempotencyKey: "waiting-escalation",
			escalationId: "expected-escalation",
			target: "user",
			question: "Which source should be used?",
			context: { options: ["A", "B"] },
			nodeId: "produce",
		});
		ledger.transitionRun({ runId: "waiting-run", idempotencyKey: "waiting-user", status: "waiting_user" });

		const waiting = await registered.tool.execute(
			"tool-waiting-status",
			{ action: "status", runId: "waiting-run", detail: "full" },
			undefined,
			undefined,
			context,
		);
		expect("error" in waiting.details ? undefined : waiting.details.question).toMatchObject({
			escalationId: "expected-escalation",
			allowedResolutions: ["retry_node", "request_replan", "fail_run"],
		});
		expect(registered.tool.parameters.properties.action.anyOf).not.toContainEqual(
			expect.objectContaining({ const: "resume" }),
		);
		expect(ledger.getRunSnapshot("waiting-run").run.status).toBe("waiting_user");
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("write", { path: "outputs/primary.txt", content: "resumed primary content" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("write", { path: "outputs/review.txt", content: "resumed review content" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("submit_artifact", {
					summary: "Resumed Artifact",
					files: [
						{ path: "outputs/primary.txt", mimeType: "text/plain" },
						{ path: "outputs/review.txt", mimeType: "text/plain" },
					],
					metadata: {},
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("submit_review", {
					decision: "PASS",
					criteria: [
						{
							criterionId: "produce-gate-semantic",
							result: "PASS",
							evidence: { scope: "resumed-node" },
							rationale: "The resumed Node passed",
							requiredRework: [],
						},
					],
					unresolvedRisks: [],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("submit_review", {
					decision: "PASS",
					criteria: [
						{
							criterionId: "final-gate-semantic",
							result: "PASS",
							evidence: { scope: "resumed-final" },
							rationale: "The resumed Run passed end-to-end review",
							requiredRework: [],
						},
					],
					unresolvedRisks: [],
				}),
				{ stopReason: "toolUse" },
			),
		]);
		const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
		const commandContext = {
			...context,
			hasUI: true,
			ui: {
				select: async () => "重试当前节点",
				input: async () => "Use A",
				confirm: async () => true,
				notify(message: string, type?: "info" | "warning" | "error") {
					notifications.push({ message, type });
				},
			},
			getSystemPromptOptions: () => ({
				skills: [{ name: TEST_SKILL, filePath: skillPath, baseDir: root }],
			}),
		} as unknown as ExtensionCommandContext;
		await registered.ipdResumeCommand.handler("waiting-run wrong-escalation", commandContext);
		expect(ledger.getRunSnapshot("waiting-run").run.status).toBe("waiting_user");
		expect(notifications.at(-1)).toMatchObject({ type: "error" });
		await registered.ipdResumeCommand.handler("waiting-run expected-escalation", commandContext);
		expect(notifications.at(-1)?.message).toContain("已完成");
		expect(ledger.getRunSnapshot("waiting-run").escalations[0]).toMatchObject({
			status: "answered",
			answer: "Use A",
		});
		expect(ledger.getRunSnapshot("waiting-run").decisions).toContainEqual(
			expect.objectContaining({
				type: "user_answer_receipt",
				action: "answer_escalation",
				evidence: expect.objectContaining({ source: "user_command" }),
			}),
		);

		ledger.createRun({
			runId: "cancel-run",
			traceId: "cancel-trace",
			idempotencyKey: "cancel-create",
			task: "Cancel this run",
			skill: { name: skill.name, hash: skill.hash },
			globalBudget: candidate.globalBudget,
		});
		ledger.transitionRun({ runId: "cancel-run", idempotencyKey: "cancel-compiling", status: "compiling" });
		ledger.freezeWorkflow({ runId: "cancel-run", idempotencyKey: "cancel-freeze", workflow: compiled.value });
		ledger.transitionRun({ runId: "cancel-run", idempotencyKey: "cancel-running", status: "running" });
		ledger.createEscalation({
			runId: "cancel-run",
			idempotencyKey: "cancel-escalation",
			escalationId: "cancel-open-escalation",
			target: "user",
			question: "This question must not survive in the public cancelled result",
			context: {},
		});
		ledger.transitionRun({ runId: "cancel-run", idempotencyKey: "cancel-waiting", status: "waiting_user" });
		const cancelled = await registered.tool.execute(
			"tool-cancel",
			{ action: "cancel", runId: "cancel-run", reason: "No longer needed" },
			undefined,
			undefined,
			context,
		);
		expect("error" in cancelled.details ? undefined : cancelled.details.status).toBe("cancelled");
		expect("error" in cancelled.details ? undefined : cancelled.details.question).toBeUndefined();
		const cancelledAgain = await registered.tool.execute(
			"tool-cancel-again",
			{ action: "cancel", runId: "cancel-run", reason: "Already cancelled" },
			undefined,
			undefined,
			context,
		);
		expect("error" in cancelledAgain.details ? undefined : cancelledAgain.details.status).toBe("cancelled");

		const conflict = await registered.tool.execute(
			"tool-start",
			{ action: "status", runId: "run-tool" },
			undefined,
			undefined,
			context,
		);
		expect("error" in conflict.details ? conflict.details.error.code : undefined).toBe("idempotency_conflict");

		if (registered.sessionShutdown) {
			await registered.sessionShutdown({ type: "session_shutdown" } as SessionShutdownEvent, context);
		}
	});
});
