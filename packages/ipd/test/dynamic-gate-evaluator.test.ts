import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	CheckExecutorRegistry,
	createArtifactIntegrityCheckExecutor,
	createArtifactManifest,
	createDefaultArtifactViewRegistry,
	createSkillSnapshot,
	type DecisionNodeRunInput,
	type DecisionNodeRunResult,
	DynamicGateEvaluator,
	type ExecutionNodeRunInput,
	type ExecutionNodeRunResult,
	type GateEvaluationInput,
	MechanicalChecker,
	type NodeRunner,
	type ReviewSubmission,
} from "../src/index.ts";
import { cardRef, compileCard, createTestCards, createValidWorkflow, TEST_SKILL } from "./fixtures.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class DecisionNodeRunner implements NodeRunner {
	readonly calls: DecisionNodeRunInput[] = [];
	reviewerResults: Array<ReviewSubmission["criteria"][number]["result"]> = [];
	staffAction = "route_rework";

	async runExecutionNode(input: ExecutionNodeRunInput): Promise<ExecutionNodeRunResult> {
		return {
			ok: false,
			failure: { code: "configuration_error", message: "Execution is not used in Gate tests" },
			trace: this.trace(input),
		};
	}

	async runDecisionNode(input: DecisionNodeRunInput): Promise<DecisionNodeRunResult> {
		this.calls.push(input);
		if (input.kind === "reviewer") {
			const result = this.reviewerResults.shift() ?? "PASS";
			return {
				ok: true,
				kind: input.kind,
				submission: {
					decision: result,
					criteria: input.gate.semanticCriteria.map((criterion) => ({
						criterionId: criterion.id,
						result,
						evidence: { materialCount: input.reviewBundle.materials.length },
						rationale: `Reviewer returned ${result}`,
						requiredRework: result === "FAIL" ? ["Revise the Artifact"] : [],
					})),
					unresolvedRisks: result === "INCONCLUSIVE" ? ["Insufficient evidence"] : [],
				},
				trace: this.trace(input),
			};
		}
		if (input.kind === "staff") {
			return {
				ok: true,
				kind: input.kind,
				submission: {
					action: this.staffAction,
					rationale: "Resolve the Reviewer conflict without voting",
					evidence: { action: this.staffAction },
				},
				trace: this.trace(input),
			};
		}
		return {
			ok: false,
			kind: input.kind,
			failure: { code: "configuration_error", message: "Planner is not used in Gate tests" },
			trace: this.trace(input),
		};
	}

	async abort(): Promise<void> {}

	private trace(input: ExecutionNodeRunInput | DecisionNodeRunInput) {
		return {
			runId: input.runId,
			instanceId: input.instanceId,
			provider: input.runDefaultModel.provider,
			model: input.runDefaultModel.id,
			startedAt: 1,
			endedAt: 2,
			durationMs: 1,
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 0,
				costUsd: 0,
				toolCalls: 1,
			},
		};
	}
}

async function createFixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-ipd-dynamic-gate-"));
	roots.push(root);
	await mkdir(join(root, "outputs"));
	await writeFile(join(root, "outputs", "primary.txt"), "primary content");
	await writeFile(join(root, "outputs", "review.txt"), "actual review content");
	const cards = createTestCards();
	const workflow = createValidWorkflow(cards);
	workflow.nodes[0].gate.mechanicalCriteria[0].checkId = "artifact-integrity";
	workflow.nodes[0].gate.mechanicalCriteria[0].parameters = {};
	const contract = workflow.nodes[0].output;
	const manifest = await createArtifactManifest({
		workspace: root,
		contract,
		submission: {
			id: "artifact-1",
			runId: "run-1",
			nodeId: "produce",
			attemptId: "attempt-1",
			contractId: contract.id,
			createdAt: 1,
			inputs: [],
			files: [
				{ role: "primary", path: "outputs/primary.txt", mimeType: "text/plain" },
				{ role: "review", path: "outputs/review.txt", mimeType: "text/plain" },
			],
			metadata: {},
		},
	});
	const checks = new CheckExecutorRegistry();
	checks.add(createArtifactIntegrityCheckExecutor());
	const nodeRunner = new DecisionNodeRunner();
	const evaluator = new DynamicGateEvaluator({
		mechanicalChecker: new MechanicalChecker(checks),
		artifactViews: createDefaultArtifactViewRegistry(),
		nodeRunner,
	});
	const skill = createSkillSnapshot({
		name: TEST_SKILL,
		path: join(root, "SKILL.md"),
		baseDir: root,
		content: "Evaluate the controlled Artifact.",
	});
	const input: GateEvaluationInput = {
		runId: "run-1",
		gateRunId: "gate-run-1",
		gate: workflow.nodes[0].gate,
		node: workflow.nodes[0],
		artifacts: [{ manifest, contract }],
		final: false,
		task: "Evaluate the Artifact",
		workflowHash: "1".repeat(64),
		cwd: root,
		skill,
		agentCards: [cards.executor, cards.reviewer, cards.staff],
		staffAgentCards: [cards.staff],
		executorAgentCardRefs: [cardRef(cards.executor)],
		runDefaultModel: fauxProvider().getModel(),
		runDefaultThinkingLevel: "off",
	};
	return { root, cards, workflow, manifest, nodeRunner, evaluator, input };
}

describe("DynamicGateEvaluator", () => {
	it("does not start a Reviewer when mechanical integrity fails", async () => {
		const fixture = await createFixture();
		await writeFile(join(fixture.root, "outputs", "primary.txt"), "changed after Manifest");
		const result = await fixture.evaluator.evaluate(fixture.input);
		expect(result.decision).toBe("REWORK");
		expect(result.mechanical.some((criterion) => criterion.result === "FAIL")).toBe(true);
		expect(result.semantic).toEqual([]);
		expect(fixture.nodeRunner.calls).toEqual([]);
	});

	it("starts an independent Reviewer with the actual Review Bundle after mechanical PASS", async () => {
		const fixture = await createFixture();
		const result = await fixture.evaluator.evaluate({
			...fixture.input,
			reviewerTokenBudget: 1_234,
			reviewerTimeoutMs: 7_200_000,
			previousEvaluations: [{ criterionId: "produce-gate-semantic", result: "PASS" }],
		});
		expect(result.decision).toBe("PASS");
		const reviewerCall = fixture.nodeRunner.calls.find((call) => call.kind === "reviewer");
		expect(reviewerCall?.agentCard.id).toBe("reviewer");
		if (reviewerCall?.kind === "reviewer") {
			expect(reviewerCall.tokenBudget).toBe(1_234);
			expect(reviewerCall.timeoutMs).toBe(7_200_000);
			expect(reviewerCall.context).toMatchObject({
				previousEvaluations: [{ criterionId: "produce-gate-semantic", result: "PASS" }],
			});
			const text = reviewerCall.reviewBundle.materials.find(
				(material) => material.kind === "text" && material.role === "review",
			);
			expect(text?.kind === "text" ? text.text : undefined).toContain("actual review content");
		}
		expect(result.semantic[0]).toMatchObject({
			result: "PASS",
			reviewerAgentCardRef: cardRef(fixture.cards.reviewer),
		});
	});

	it("does not let the producing Agent be its own Reviewer", async () => {
		const fixture = await createFixture();
		const selfReviewingExecutor = compileCard({
			id: "executor",
			name: "Executor",
			description: "Executor with review capability",
			responsibilities: ["Produce content"],
			nonResponsibilities: [],
			capabilities: ["content", "review"],
			tools: ["read", "write"],
			permissions: {
				workspace: "write",
				readScopes: ["."],
				writeScopes: ["outputs"],
			},
		});
		const result = await fixture.evaluator.evaluate({
			...fixture.input,
			agentCards: [selfReviewingExecutor, fixture.cards.staff],
			executorAgentCardRefs: [cardRef(selfReviewingExecutor)],
		});
		expect(result.decision).toBe("BLOCKED");
		expect(result.semantic).toEqual([]);
		expect(fixture.nodeRunner.calls).toEqual([]);
	});

	it("cannot PASS when a required semantic Criterion fails", async () => {
		const fixture = await createFixture();
		fixture.nodeRunner.reviewerResults = ["FAIL"];
		const result = await fixture.evaluator.evaluate(fixture.input);
		expect(result.decision).toBe("REWORK");
		expect(result.semantic[0].result).toBe("FAIL");
	});

	it("routes conflicting or inconclusive reviews through Staff arbitration", async () => {
		const fixture = await createFixture();
		const qualityGovernor = compileCard({
			id: "quality-governor",
			name: "Quality Governor",
			description: "Arbitrates evidence conflicts",
			responsibilities: ["Resolve Gate evidence conflicts"],
			nonResponsibilities: ["Produce business Artifacts"],
			capabilities: ["staff", "quality-governance"],
		});
		const secondReviewer = compileCard({
			id: "reviewer-two",
			name: "Second Reviewer",
			description: "Independent second Reviewer",
			responsibilities: ["Review content"],
			nonResponsibilities: [],
			capabilities: ["review"],
		});
		const gate = structuredClone(fixture.input.gate);
		gate.reviewers[0].minCount = 2;
		fixture.nodeRunner.reviewerResults = ["PASS", "INCONCLUSIVE"];
		fixture.nodeRunner.staffAction = "route_rework";
		const result = await fixture.evaluator.evaluate({
			...fixture.input,
			gate,
			agentCards: [...fixture.input.agentCards, secondReviewer],
			staffAgentCards: [fixture.cards.staff, qualityGovernor],
		});
		expect(result.decision).toBe("REWORK");
		expect(result.staffDecision?.action).toBe("route_rework");
		expect(fixture.nodeRunner.calls.filter((call) => call.kind === "reviewer")).toHaveLength(2);
		expect(fixture.nodeRunner.calls.filter((call) => call.kind === "staff")).toHaveLength(1);
		expect(fixture.nodeRunner.calls.find((call) => call.kind === "staff")?.agentCard.id).toBe("quality-governor");
	});
});
