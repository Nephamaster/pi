import { describe, expect, it } from "vitest";
import {
	compileWorkflow,
	type EffectiveNode,
	invalidateFromNode,
	nodeIsReady,
	projectInputSubmissions,
	type ReviewRecord,
	type RunState,
	resolveInputBindings,
	runIsComplete,
	type SubmissionRecord,
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

function activeReview(
	reviewId: string,
	reviewNodeId: string,
	submissionIds: string[],
	criterionId = "quality",
): ReviewRecord {
	return {
		reviewId,
		reviewNodeId,
		roundId: `${reviewNodeId}:round:1`,
		submissionIds,
		decision: "PASS",
		criteria: [
			{
				criterionId,
				result: "PASS",
				evidence: [],
				rationale: "approved",
				requiredRework: [],
				reworkTargets: [],
			},
		],
		status: "active",
		createdAt: 1,
	};
}

function fixtureState() {
	const fixture = createCompilerFixture();
	const compiled = compileWorkflow(fixture);
	if (!compiled.ok) throw new Error("Fixture did not compile");
	const submission: SubmissionRecord = {
		submissionId: "produce:round:1:submission",
		contentHash: "a".repeat(64),
		nodeId: "produce",
		roundId: "produce:round:1",
		status: "candidate",
		inputSubmissionIds: [],
		outputs: [
			{
				outputId: "content-output",
				sealedRoot: "/sealed",
				manifest: {
					id: "content",
					runId: "run-1",
					nodeId: "produce",
					attemptId: "produce:round:1",
					contractId: "content-output",
					createdAt: 1,
					inputs: [],
					files: [],
					metadata: {},
				},
			},
			{
				outputId: "private-output",
				sealedRoot: "/sealed",
				manifest: {
					id: "private",
					runId: "run-1",
					nodeId: "produce",
					attemptId: "produce:round:1",
					contractId: "private-output",
					createdAt: 1,
					inputs: [],
					files: [],
					metadata: {},
				},
			},
		],
		evidence: [],
		createdAt: 1,
	};
	const state: RunState = {
		runId: "run-1",
		revision: 1,
		phase: "execute",
		status: "running",
		taskInput: fixture.taskInput,
		baseline: compiled.baseline,
		nodes: compiled.baseline.nodes.map((node) => ({
			nodeId: node.definition.node_id,
			kind: node.definition.kind,
			status: "waiting",
			nextRound: 1,
		})),
		rounds: [],
		submissions: [submission],
		reviews: [],
		approvals: [],
		mechanicalChecks: [],
		events: [],
		operations: {},
	};
	return { compiled, state, submission };
}

function consumerNode(sourceNodeId: string, requiredReviewNodeIds: string[]): EffectiveNode {
	const compiled = compileWorkflow(createCompilerFixture());
	if (!compiled.ok) throw new Error("Fixture did not compile");
	const source = structuredClone(compiled.baseline.nodes.find((node) => node.definition.kind === "execution")!);
	source.definition.node_id = "consumer";
	source.definition.inputs = [
		{
			kind: "node_output",
			input_id: "required",
			source: { node_id: sourceNodeId, output_id: "content-output" },
			required: true,
			availability: "approved",
			approval_review_node_ids: requiredReviewNodeIds,
		},
	];
	return source;
}

describe("runtime input and approval semantics", () => {
	it("requires the specifically configured Gate and projects only the bound output", () => {
		const { state, submission } = fixtureState();
		state.nodes.push({ nodeId: "consumer", kind: "execution", status: "waiting", nextRound: 1 });
		const consumer = consumerNode("produce", ["review-produce"]);
		expect(nodeIsReady(consumer, state)).toBe(false);
		state.approvals.push({
			approvalId: "other-approval",
			reviewId: "other:review",
			reviewNodeId: "other-review",
			submissionId: submission.submissionId,
			outputId: "content-output",
			criterionIds: ["quality"],
			status: "active",
			createdAt: 1,
		});
		expect(nodeIsReady(consumer, state)).toBe(false);
		state.approvals.push({
			approvalId: "required-approval",
			reviewId: "review-produce:review",
			reviewNodeId: "review-produce",
			submissionId: submission.submissionId,
			outputId: "content-output",
			criterionIds: [],
			status: "active",
			createdAt: 1,
		});
		expect(nodeIsReady(consumer, state)).toBe(false);
		state.approvals.at(-1)!.criterionIds = ["quality"];
		state.reviews.push(activeReview("review-produce:review", "review-produce", [submission.submissionId]));
		expect(nodeIsReady(consumer, state)).toBe(true);
		const projected = projectInputSubmissions(resolveInputBindings(consumer, state));
		expect(projected).toHaveLength(1);
		expect(projected[0].outputs.map((output) => output.outputId)).toEqual(["content-output"]);
	});

	it("does not let an optional input replace a missing required input", () => {
		const { state } = fixtureState();
		state.nodes.push({ nodeId: "consumer", kind: "execution", status: "waiting", nextRound: 1 });
		const consumer = consumerNode("missing", []);
		consumer.definition.inputs.push({
			kind: "node_output",
			input_id: "optional",
			source: { node_id: "produce", output_id: "content-output" },
			required: false,
			availability: "submitted",
			approval_review_node_ids: [],
		});
		expect(nodeIsReady(consumer, state)).toBe(false);
		const required = consumer.definition.inputs[0];
		if (required?.kind !== "node_output") throw new Error("Missing required input");
		required.source.node_id = "produce";
		required.availability = "submitted";
		expect(nodeIsReady(consumer, state)).toBe(true);
	});

	it("requires every required node to succeed before Run completion", () => {
		const { state, submission } = fixtureState();
		state.approvals.push({
			approvalId: "approval",
			reviewId: "review",
			reviewNodeId: "review-produce",
			submissionId: submission.submissionId,
			outputId: "content-output",
			criterionIds: ["quality"],
			status: "active",
			createdAt: 1,
		});
		state.reviews.push(activeReview("review", "review-produce", [submission.submissionId]));
		state.nodes.find((node) => node.nodeId === "review-produce")!.status = "succeeded";
		state.nodes.find((node) => node.nodeId === "produce")!.status = "blocked";
		expect(runIsComplete(state)).toBe(false);
		state.nodes.find((node) => node.nodeId === "produce")!.status = "succeeded";
		expect(runIsComplete(state)).toBe(true);
	});

	it("invalidates active consumers without rejecting unrelated submissions", () => {
		const { state, submission } = fixtureState();
		state.approvals.push({
			approvalId: "approval",
			reviewId: "review",
			reviewNodeId: "review-produce",
			submissionId: submission.submissionId,
			outputId: "content-output",
			criterionIds: ["quality"],
			status: "active",
			createdAt: 1,
		});
		state.reviews.push(activeReview("review", "review-produce", [submission.submissionId]));
		state.submissions.push({ ...structuredClone(submission), submissionId: "other:submission", nodeId: "other" });
		state.nodes.push({
			nodeId: "consumer",
			kind: "execution",
			status: "active",
			nextRound: 2,
			activeRoundId: "consumer:round:1",
		});
		state.rounds.push({
			roundId: "consumer:round:1",
			nodeId: "consumer",
			index: 1,
			status: "active",
			inputSubmissionIds: [submission.submissionId],
			inputBindings: [
				{
					inputId: "required",
					submissionId: submission.submissionId,
					outputId: "content-output",
					approvalReviewNodeIds: ["review-produce"],
				},
			],
			startedAt: 1,
		});
		const invalidated = invalidateFromNode(state, "produce");
		expect(invalidated).toEqual([{ nodeId: "consumer", roundId: "consumer:round:1" }]);
		expect(state.rounds[0].status).toBe("invalidated");
		expect(state.nodes.find((node) => node.nodeId === "consumer")?.activeRoundId).toBeUndefined();
		expect(state.approvals[0].status).toBe("stale");
		expect(state.submissions.find((item) => item.submissionId === "other:submission")?.status).toBe("candidate");
	});

	it("invalidates every approval issued by a stale multi-target review", () => {
		const { state, submission } = fixtureState();
		const baseline = structuredClone(state.baseline);
		if (!baseline) throw new Error("Missing baseline");
		state.baseline = baseline;
		const producer = baseline.workflow.nodes.find((node) => node.kind === "execution");
		if (!producer || producer.kind !== "execution") throw new Error("Missing producer");
		const otherNode = structuredClone(producer);
		otherNode.node_id = "other";
		otherNode.outputs[0].output_id = "other-output";
		otherNode.outputs[0].criterion_refs = ["other-quality"];
		baseline.workflow.nodes.push(otherNode);
		baseline.workflow.criteria.push({
			kind: "semantic",
			criterion_id: "other-quality",
			description: "Other output quality",
			evidence_requirements: ["Independent evidence"],
			process_criterion_refs: [],
		});
		baseline.graph.reviewsByOutput["other/other-output"] = ["joint-review"];
		const otherSubmission = structuredClone(submission);
		otherSubmission.submissionId = "other:submission";
		otherSubmission.nodeId = "other";
		otherSubmission.status = "approved";
		otherSubmission.outputs = [{ ...otherSubmission.outputs[0], outputId: "other-output" }];
		state.submissions.push(otherSubmission);
		state.nodes.push({ nodeId: "other", kind: "execution", status: "succeeded", nextRound: 2 });
		state.nodes.push({ nodeId: "joint-review", kind: "review", status: "succeeded", nextRound: 2 });
		state.reviews.push(
			activeReview("joint-review:round:1:review", "joint-review", [
				submission.submissionId,
				otherSubmission.submissionId,
			]),
		);
		state.approvals.push(
			{
				approvalId: "joint-a",
				reviewId: "joint-review:round:1:review",
				reviewNodeId: "joint-review",
				submissionId: submission.submissionId,
				outputId: "content-output",
				criterionIds: ["quality"],
				status: "active",
				createdAt: 1,
			},
			{
				approvalId: "joint-b",
				reviewId: "joint-review:round:1:review",
				reviewNodeId: "joint-review",
				submissionId: otherSubmission.submissionId,
				outputId: "other-output",
				criterionIds: ["other-quality"],
				status: "active",
				createdAt: 1,
			},
		);

		invalidateFromNode(state, "produce");

		expect(state.reviews[0].status).toBe("stale");
		expect(state.approvals.map((approval) => approval.status)).toEqual(["stale", "stale"]);
		expect(otherSubmission.status).toBe("candidate");
		expect(state.nodes.find((node) => node.nodeId === "other")?.status).toBe("waiting_review");
	});

	it("requires every explicitly required review to succeed", () => {
		const { state, submission } = fixtureState();
		const baseline = structuredClone(state.baseline);
		if (!baseline) throw new Error("Missing baseline");
		state.baseline = baseline;
		baseline.workflow.completion.required_node_ids = ["produce"];
		state.nodes.find((node) => node.nodeId === "produce")!.status = "succeeded";
		state.nodes.find((node) => node.nodeId === "review-produce")!.status = "waiting";
		state.reviews.push(activeReview("review", "review-produce", [submission.submissionId]));
		state.approvals.push({
			approvalId: "approval",
			reviewId: "review",
			reviewNodeId: "review-produce",
			submissionId: submission.submissionId,
			outputId: "content-output",
			criterionIds: ["quality"],
			status: "active",
			createdAt: 1,
		});
		expect(runIsComplete(state)).toBe(false);
	});
});
