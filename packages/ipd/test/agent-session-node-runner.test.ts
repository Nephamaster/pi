import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentSessionNodeRunner,
	createSkillSnapshot,
	type ExecutionNodeRunInput,
	type ReviewerRunInput,
	type StaffDecisionRunInput,
	WORKFLOW_HEADER_TOOL_NAME,
	WORKFLOW_NODE_TOOL_NAME,
	type WorkflowPlannerRunInput,
} from "../src/index.ts";
import { createTestCards, createValidWorkflow, createWorkflowSubmissionMessages, TEST_SKILL } from "./fixtures.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixture(options: { maxExecutionToolCalls?: number } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-ipd-runner-"));
	roots.push(root);
	const faux = fauxProvider();
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });
	const cards = createTestCards();
	const workflow = createValidWorkflow(cards);
	const skill = createSkillSnapshot({
		name: TEST_SKILL,
		path: join(root, "SKILL.md"),
		baseDir: root,
		content: "Complete the requested business task and provide reviewable output.",
	});
	const runner = new AgentSessionNodeRunner({
		modelRuntime,
		agentDir: join(root, "agent"),
		sessionDir: join(root, "sessions"),
		idFactory: () => "artifact-generated",
		maxExecutionToolCalls: options.maxExecutionToolCalls,
	});
	const common = {
		runId: "run-1",
		task: "Produce a reviewed artifact",
		workflowHash: "1".repeat(64),
		cwd: root,
		skills: [skill],
		runDefaultModel: faux.getModel(),
		runDefaultThinkingLevel: "off" as const,
	};
	const execution: ExecutionNodeRunInput = {
		...common,
		kind: "execution",
		instanceId: "attempt-1",
		attemptId: "attempt-1",
		agentCard: cards.executor,
		node: workflow.nodes[0],
		inputArtifacts: [],
		reworkInstructions: [],
	};
	return { root, faux, runner, cards, workflow, skill, common, execution };
}

function waitForTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await waitForTurn();
	}
	throw new Error("Condition was not reached");
}

function plannerConstraints(workflow: ReturnType<typeof createValidWorkflow>) {
	return {
		skill: workflow.skill,
		globalBudget: workflow.globalBudget,
		staff: workflow.staff,
	};
}

describe("AgentSessionNodeRunner", () => {
	it("runs an Execution Node with restricted tools and one structured Artifact submission", async () => {
		const fixture = await createFixture();
		await writeFile(join(fixture.root, "AGENTS.md"), "UNRELATED_PROJECT_CONTEXT");
		let exposedTools: string[] = [];
		let systemPrompt = "";
		fixture.faux.setResponses([
			(context) => {
				exposedTools = context.tools?.map((tool) => tool.name) ?? [];
				systemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage(
					fauxToolCall("submit_artifact", {
						summary: "Completed artifact",
						files: [
							{ path: "outputs/result.bin", mimeType: "application/octet-stream" },
							{ path: "outputs/review.txt", mimeType: "text/plain" },
						],
						metadata: { quality: "self-checked" },
					}),
					{ stopReason: "toolUse" },
				);
			},
		]);

		const result = await fixture.runner.runExecutionNode(fixture.execution);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(new Set(exposedTools)).toEqual(new Set(["read", "write", "submit_artifact"]));
		expect(systemPrompt).toContain("submit_artifact exactly once");
		expect(systemPrompt).toContain(TEST_SKILL);
		expect(systemPrompt).toContain("A bounded business Artifact needs implementation");
		expect(systemPrompt).toContain("Submit evidence, not completion claims");
		expect(systemPrompt).toContain("Check the output contract before submission");
		expect(systemPrompt).toContain("workspace-inputs");
		expect(systemPrompt).not.toContain("UNRELATED_PROJECT_CONTEXT");
		expect(result.submission).toMatchObject({
			id: "artifact-generated",
			runId: "run-1",
			nodeId: "produce",
			attemptId: "attempt-1",
			contractId: "content-output",
		});
		expect(result.trace.sessionId).toBeTruthy();
		expect(result.trace).toMatchObject({ runId: "run-1", instanceId: "attempt-1" });
		expect(result.trace.sessionFile && existsSync(result.trace.sessionFile)).toBe(true);
		expect(result.trace.usage.toolCalls).toBe(1);
	});

	it("fails when the model only claims completion in natural language", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([fauxAssistantMessage("Done")]);
		const result = await fixture.runner.runExecutionNode(fixture.execution);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure.code).toBe("missing_submission");
	});

	it("rejects a structured Artifact submission with duplicate file paths", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("submit_artifact", {
					summary: "Duplicate paths",
					files: [
						{ path: "outputs/result.bin", mimeType: "application/octet-stream" },
						{ path: "outputs/result.bin", mimeType: "application/octet-stream" },
					],
					metadata: {},
				}),
				{ stopReason: "toolUse" },
			),
		]);
		const result = await fixture.runner.runExecutionNode(fixture.execution);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure.code).toBe("invalid_submission");
		expect(result.failure.message).toContain("duplicate file paths");
	});

	it("blocks raw binary reads while preserving the native text workflow", async () => {
		const fixture = await createFixture();
		await mkdir(join(fixture.root, "outputs"), { recursive: true });
		await writeFile(join(fixture.root, "opaque.bin"), Buffer.from([0, 1, 2, 3]));
		await writeFile(join(fixture.root, "outputs", "result.txt"), "primary");
		await writeFile(join(fixture.root, "outputs", "review.txt"), "review");
		let binaryErrorObserved = false;
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "opaque.bin" }), { stopReason: "toolUse" }),
			(context) => {
				binaryErrorObserved = JSON.stringify(context.messages).includes("cannot be read as text");
				return fauxAssistantMessage(
					fauxToolCall("submit_artifact", {
						summary: "Submitted without injecting binary bytes into context",
						files: [
							{ path: "outputs/result.txt", mimeType: "text/plain" },
							{ path: "outputs/review.txt", mimeType: "text/plain" },
						],
						metadata: {},
					}),
					{ stopReason: "toolUse" },
				);
			},
		]);
		const result = await fixture.runner.runExecutionNode(fixture.execution);
		expect(result.ok).toBe(true);
		expect(binaryErrorObserved).toBe(true);
	});

	it("fails before model execution when tools exceed the AgentCard", async () => {
		const fixture = await createFixture();
		fixture.execution.node.tools.push("bash");
		const result = await fixture.runner.runExecutionNode(fixture.execution);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure).toMatchObject({ code: "configuration_error" });
		expect(result.trace.sessionId).toBeUndefined();
		expect(fixture.faux.state.callCount).toBe(0);
	});

	it("fails before model execution when capabilities or knowledge bases do not match the AgentCard", async () => {
		const capabilityFixture = await createFixture();
		capabilityFixture.execution.node.requiredCapabilities.push("missing-capability");
		const missingCapability = await capabilityFixture.runner.runExecutionNode(capabilityFixture.execution);
		expect(missingCapability.ok).toBe(false);
		if (!missingCapability.ok) expect(missingCapability.failure.code).toBe("configuration_error");
		expect(capabilityFixture.faux.state.callCount).toBe(0);

		const knowledgeFixture = await createFixture();
		knowledgeFixture.execution.node.knowledgeBaseRefs = ["missing-knowledge"];
		const missingKnowledge = await knowledgeFixture.runner.runExecutionNode(knowledgeFixture.execution);
		expect(missingKnowledge.ok).toBe(false);
		if (!missingKnowledge.ok) expect(missingKnowledge.failure.code).toBe("configuration_error");
		expect(knowledgeFixture.faux.state.callCount).toBe(0);
	});

	it("runs Workflow, Review, and Staff Decision Nodes with dedicated submission tools", async () => {
		const fixture = await createFixture();
		const plannerInput: WorkflowPlannerRunInput = {
			...fixture.common,
			kind: "workflow_planner",
			instanceId: "planner-1",
			agentCard: fixture.cards.staff,
			context: { agentCards: ["executor", "reviewer"] },
			workflowConstraints: plannerConstraints(fixture.workflow),
			checks: [
				{
					id: "artifact-exists",
					parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
				},
			],
		};
		const plannerResponses = createWorkflowSubmissionMessages(fixture.workflow);
		let plannerToolNames: string[] = [];
		let headerPropertyNames: string[] = [];
		fixture.faux.setResponses([
			(context) => {
				plannerToolNames = context.tools?.map((tool) => tool.name) ?? [];
				const header = context.tools?.find((tool) => tool.name === WORKFLOW_HEADER_TOOL_NAME);
				headerPropertyNames = Object.keys((header?.parameters as { properties?: object })?.properties ?? {});
				return plannerResponses[0];
			},
			...plannerResponses.slice(1),
		]);
		const planned = await fixture.runner.runDecisionNode(plannerInput);
		expect(planned.ok && planned.kind === "workflow_planner" ? planned.submission.id : undefined).toBe(
			"test-workflow",
		);
		expect(plannerToolNames).toContain("submit_workflow_acceptance");
		expect(headerPropertyNames).not.toContain("skill");
		expect(headerPropertyNames).not.toContain("globalBudget");
		expect(headerPropertyNames).not.toContain("staff");

		const reviewerInput: ReviewerRunInput = {
			...fixture.common,
			kind: "reviewer",
			instanceId: "reviewer-1",
			agentCard: fixture.cards.reviewer,
			gate: fixture.workflow.nodes[0].gate,
			reviewBundle: {
				artifactId: "artifact-1",
				generatedAt: 1,
				materials: [
					{
						kind: "text",
						providerId: "builtin-text",
						path: "review.txt",
						mimeType: "text/plain",
						sha256: "2".repeat(64),
						text: "review content",
						truncated: false,
					},
				],
			},
			context: {},
		};
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("submit_review", {
					decision: "PASS",
					criteria: [
						{
							criterionId: "produce-gate-semantic",
							result: "PASS",
							evidence: { path: "review.txt" },
							rationale: "Content meets the objective",
							requiredRework: [],
						},
					],
					unresolvedRisks: [],
				}),
				{ stopReason: "toolUse" },
			),
		]);
		const reviewed = await fixture.runner.runDecisionNode(reviewerInput);
		expect(reviewed.ok && reviewed.kind === "reviewer" ? reviewed.submission.decision : undefined).toBe("PASS");

		const staffInput: StaffDecisionRunInput = {
			...fixture.common,
			kind: "staff",
			instanceId: "staff-1",
			agentCard: fixture.cards.staff,
			allowedActions: ["retry_node"],
			context: { failure: "temporary" },
		};
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("submit_decision", {
					action: "retry_node",
					rationale: "Retry is allowed",
					evidence: { attempt: 1 },
				}),
				{ stopReason: "toolUse" },
			),
		]);
		const decided = await fixture.runner.runDecisionNode(staffInput);
		expect(decided.ok && decided.kind === "staff" ? decided.submission.action : undefined).toBe("retry_node");
	});

	it("rejects a Staff action outside the supplied legal action set", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("submit_decision", {
					action: "rewrite_workflow",
					rationale: "Attempted illegal action",
					evidence: {},
				}),
				{ stopReason: "toolUse" },
			),
		]);
		const result = await fixture.runner.runDecisionNode({
			...fixture.common,
			kind: "staff",
			instanceId: "staff-1",
			agentCard: fixture.cards.staff,
			allowedActions: ["retry_node"],
			context: {},
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure.code).toBe("invalid_submission");
	});

	it("aborts a Planner after ten invalid structured-submission turns", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses(
			Array.from({ length: 10 }, () =>
				fauxAssistantMessage(fauxToolCall(WORKFLOW_HEADER_TOOL_NAME, {}), { stopReason: "toolUse" }),
			),
		);
		const result = await fixture.runner.runDecisionNode({
			...fixture.common,
			kind: "workflow_planner",
			instanceId: "planner-invalid",
			agentCard: fixture.cards.staff,
			context: {},
			workflowConstraints: plannerConstraints(fixture.workflow),
			checks: [],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure).toMatchObject({
			code: "invalid_submission",
			message: expect.stringContaining("10 consecutive assistant turns"),
		});
		expect(fixture.faux.state.callCount).toBe(10);
	});

	it("counts multiple invalid submissions in one assistant turn once and exposes every error for correction", async () => {
		const fixture = await createFixture();
		const valid = createWorkflowSubmissionMessages(fixture.workflow);
		let validationErrorsObserved = false;
		fixture.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(WORKFLOW_HEADER_TOOL_NAME, {}),
					fauxToolCall(WORKFLOW_NODE_TOOL_NAME, {}),
					fauxToolCall(WORKFLOW_NODE_TOOL_NAME, {}),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				validationErrorsObserved =
					context.messages.filter((message) => message.role === "toolResult" && message.isError).length === 3;
				return valid[0];
			},
			...valid.slice(1),
		]);
		const result = await fixture.runner.runDecisionNode({
			...fixture.common,
			kind: "workflow_planner",
			instanceId: "planner-batch-recovery",
			agentCard: fixture.cards.staff,
			context: {},
			workflowConstraints: plannerConstraints(fixture.workflow),
			checks: [
				{
					id: "artifact-exists",
					parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
				},
			],
		});
		expect(result.ok).toBe(true);
		expect(validationErrorsObserved).toBe(true);
	});

	it("resets the malformed-submission counter after a valid Planner section", async () => {
		const fixture = await createFixture();
		const valid = createWorkflowSubmissionMessages(fixture.workflow);
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall(WORKFLOW_HEADER_TOOL_NAME, {}), { stopReason: "toolUse" }),
			valid[0],
			valid[1],
			fauxAssistantMessage(fauxToolCall(WORKFLOW_NODE_TOOL_NAME, {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall(WORKFLOW_NODE_TOOL_NAME, {}), { stopReason: "toolUse" }),
			...valid.slice(2),
		]);
		const result = await fixture.runner.runDecisionNode({
			...fixture.common,
			kind: "workflow_planner",
			instanceId: "planner-recovered",
			agentCard: fixture.cards.staff,
			context: {},
			workflowConstraints: plannerConstraints(fixture.workflow),
			checks: [
				{
					id: "artifact-exists",
					parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
				},
			],
		});
		expect(result.ok).toBe(true);
	});

	it("enforces a cumulative Planner generation budget", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([fauxAssistantMessage("This response exceeds a one-token generation budget")]);
		const result = await fixture.runner.runDecisionNode({
			...fixture.common,
			kind: "workflow_planner",
			instanceId: "planner-budget",
			agentCard: fixture.cards.staff,
			context: {},
			workflowConstraints: plannerConstraints(fixture.workflow),
			checks: [],
			tokenBudget: 1,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure.code).toBe("budget_exceeded");
	});

	it("does not apply token or time limits to an explicitly unbounded Node", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return fauxAssistantMessage(
					fauxToolCall("submit_artifact", {
						summary: "Completed without an IPD budget limit",
						files: [
							{ path: "outputs/result.txt", mimeType: "text/plain" },
							{ path: "outputs/review.txt", mimeType: "text/plain" },
						],
						metadata: {},
					}),
					{ stopReason: "toolUse" },
				);
			},
		]);
		const result = await fixture.runner.runExecutionNode({
			...fixture.execution,
			budgetMode: "unbounded",
			tokenBudget: 1,
			timeoutMs: 1,
		});
		expect(result.ok).toBe(true);
	});

	it("enforces cumulative generation limits and reserves finalization after the Execution Tool limit", async () => {
		const tokenFixture = await createFixture();
		tokenFixture.faux.setResponses([fauxAssistantMessage("This response exceeds a one-token generation budget")]);
		const tokenResult = await tokenFixture.runner.runExecutionNode({
			...tokenFixture.execution,
			tokenBudget: 1,
		});
		expect(tokenResult.ok).toBe(false);
		if (!tokenResult.ok) expect(tokenResult.failure.code).toBe("budget_exceeded");

		const toolFixture = await createFixture({ maxExecutionToolCalls: 2 });
		await writeFile(join(toolFixture.root, "input.txt"), "bounded input");
		let warningObserved = false;
		let finalizationTools: string[] = [];
		toolFixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), { stopReason: "toolUse" }),
			(context) => {
				warningObserved = JSON.stringify(context.messages).includes("Runtime Tool budget is exhausted");
				finalizationTools = context.tools?.map((tool) => tool.name) ?? [];
				return fauxAssistantMessage(
					fauxToolCall("submit_artifact", {
						summary: "Submit after the Tool budget is exhausted",
						files: [{ path: "outputs/result.txt", mimeType: "text/plain" }],
						metadata: {},
					}),
					{ stopReason: "toolUse" },
				);
			},
		]);
		const toolResult = await toolFixture.runner.runExecutionNode(toolFixture.execution);
		expect(toolResult.ok).toBe(true);
		expect(warningObserved).toBe(true);
		expect(finalizationTools).toEqual(["submit_artifact"]);

		const overflowFixture = await createFixture({ maxExecutionToolCalls: 2 });
		await writeFile(join(overflowFixture.root, "input.txt"), "bounded input");
		overflowFixture.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("read", { path: "input.txt" }),
					fauxToolCall("read", { path: "input.txt" }),
					fauxToolCall("read", { path: "input.txt" }),
				],
				{ stopReason: "toolUse" },
			),
		]);
		const overflowResult = await overflowFixture.runner.runExecutionNode(overflowFixture.execution);
		expect(overflowResult.ok).toBe(false);
		if (!overflowResult.ok) expect(overflowResult.failure.code).toBe("tool_limit_exceeded");
	});

	it("supports timeout and explicit abort", async () => {
		const timeoutFixture = await createFixture();
		timeoutFixture.faux.setResponses([
			async (_context, options) =>
				await new Promise((resolve) => {
					const finish = () => resolve(fauxAssistantMessage(fauxText("aborted"), { stopReason: "aborted" }));
					if (options?.signal?.aborted) finish();
					else options?.signal?.addEventListener("abort", finish, { once: true });
				}),
		]);
		const timedOut = await timeoutFixture.runner.runExecutionNode({ ...timeoutFixture.execution, timeoutMs: 5 });
		expect(timedOut.ok).toBe(false);
		if (!timedOut.ok) expect(timedOut.failure.code).toBe("timeout");

		const abortFixture = await createFixture();
		abortFixture.faux.setResponses([
			async (_context, options) =>
				await new Promise((resolve) => {
					const finish = () => resolve(fauxAssistantMessage(fauxText("aborted"), { stopReason: "aborted" }));
					if (options?.signal?.aborted) finish();
					else options?.signal?.addEventListener("abort", finish, { once: true });
				}),
		]);
		const running = abortFixture.runner.runExecutionNode(abortFixture.execution);
		await waitForCondition(() => abortFixture.faux.state.callCount > 0);
		await abortFixture.runner.abort("attempt-1");
		const aborted = await running;
		expect(aborted.ok).toBe(false);
		if (!aborted.ok) expect(aborted.failure.code).toBe("aborted");
	});
});
