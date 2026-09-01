import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentSessionNodeRunner,
	createSkillSnapshot,
	type ExecutionNodeRunInput,
	type ReviewerRunInput,
	type StaffDecisionRunInput,
	type WorkflowPlannerRunInput,
} from "../src/index.ts";
import { createTestCards, createValidWorkflow, TEST_SKILL } from "./fixtures.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixture() {
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
							{ role: "primary", path: "outputs/result.bin", mimeType: "application/octet-stream" },
							{ role: "review", path: "outputs/review.txt", mimeType: "text/plain" },
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

	it("rejects a structured Artifact submission that violates the Node contract", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("submit_artifact", {
					summary: "Missing review derivative",
					files: [{ role: "primary", path: "outputs/result.bin", mimeType: "application/octet-stream" }],
					metadata: {},
				}),
				{ stopReason: "toolUse" },
			),
		]);
		const result = await fixture.runner.runExecutionNode(fixture.execution);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure.code).toBe("invalid_submission");
		expect(result.failure.message).toContain("review");
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

	it("runs Workflow, Review, and Staff Decision Nodes with dedicated submission tools", async () => {
		const fixture = await createFixture();
		const plannerInput: WorkflowPlannerRunInput = {
			...fixture.common,
			kind: "workflow_planner",
			instanceId: "planner-1",
			agentCard: fixture.cards.staff,
			context: { agentCards: ["executor", "reviewer"] },
		};
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("submit_workflow", fixture.workflow), { stopReason: "toolUse" }),
		]);
		const planned = await fixture.runner.runDecisionNode(plannerInput);
		expect(planned.ok && planned.kind === "workflow_planner" ? planned.submission.id : undefined).toBe(
			"test-workflow",
		);

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
						role: "review",
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
