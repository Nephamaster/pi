import { describe, expect, it } from "vitest";
import {
	compileWorkflow,
	invalidateFromNode,
	nodeIsReady,
	type ReviewRecord,
	type RunState,
	type SubmissionRecord,
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

const submission = (
	id: string,
	nodeId: string,
	roundId: string,
	status: SubmissionRecord["status"],
	inputSubmissionIds: string[] = [],
): SubmissionRecord => ({
	submissionId: id,
	contentHash: "b".repeat(64),
	nodeId,
	roundId,
	status,
	inputSubmissionIds,
	outputs: [
		{
			outputId: "content-output",
			sealedRoot: `/sealed/${id}`,
			manifest: {
				id,
				runId: "run-1",
				nodeId,
				attemptId: roundId,
				contractId: "content-output",
				createdAt: 1,
				inputs: [],
				files: [],
				metadata: {},
			},
		},
	],
	evidence: [],
	createdAt: 1,
});

const review = (reviewId: string, reviewNodeId: string, submissionIds: string[]): ReviewRecord => ({
	reviewId,
	reviewNodeId,
	roundId: `${reviewNodeId}:round:1`,
	submissionIds,
	decision: "PASS",
	criteria: [
		{
			criterionId: "quality",
			result: "PASS",
			evidence: [],
			rationale: "approved",
			requiredRework: [],
			reworkTargets: [],
		},
	],
	status: "active",
	createdAt: 1,
});

describe("approval invalidation closure", () => {
	it("invalidates downstream submissions that consumed an approval later revoked by a joint review", () => {
		const compiled = compileWorkflow(createCompilerFixture());
		if (!compiled.ok) throw new Error("Fixture did not compile");
		const baseline = structuredClone(compiled.baseline);
		const producer = baseline.nodes.find((node) => node.definition.kind === "execution");
		if (!producer || producer.definition.kind !== "execution") throw new Error("Missing producer");

		const b = structuredClone(producer);
		b.definition.node_id = "b";
		b.definition.name = "B";
		b.definition.inputs = [];
		b.definition.agents[0].participant_id = "b-producer";
		const c = structuredClone(producer);
		c.definition.node_id = "c";
		c.definition.name = "C";
		c.definition.inputs = [
			{
				kind: "node_output",
				input_id: "b-approved",
				source: { node_id: "b", output_id: "content-output" },
				required: true,
				availability: "approved",
				approval_review_node_ids: ["joint-review"],
			},
		];
		c.definition.agents[0].participant_id = "c-producer";
		const d = structuredClone(producer);
		d.definition.node_id = "d";
		d.definition.name = "D";
		d.definition.inputs = [
			{
				kind: "node_output",
				input_id: "c-approved",
				source: { node_id: "c", output_id: "content-output" },
				required: true,
				availability: "approved",
				approval_review_node_ids: ["review-c"],
			},
		];
		d.definition.agents[0].participant_id = "d-producer";
		baseline.nodes.push(b, c, d);
		baseline.graph.reviewsByOutput["b/content-output"] = ["joint-review"];
		baseline.graph.reviewsByOutput["c/content-output"] = ["review-c"];

		const aSubmission = submission("a:submission", "produce", "produce:round:1", "approved");
		const bSubmission = submission("b:submission", "b", "b:round:1", "approved");
		const cSubmission = submission("c:submission", "c", "c:round:1", "approved", [bSubmission.submissionId]);
		const state: RunState = {
			runId: "run-1",
			revision: 1,
			phase: "execute",
			status: "running",
			taskInput: createCompilerFixture().taskInput,
			baseline,
			nodes: [
				{ nodeId: "produce", kind: "execution", status: "succeeded", nextRound: 2 },
				{ nodeId: "b", kind: "execution", status: "succeeded", nextRound: 2 },
				{ nodeId: "c", kind: "execution", status: "succeeded", nextRound: 2 },
				{ nodeId: "d", kind: "execution", status: "waiting", nextRound: 1 },
				{ nodeId: "joint-review", kind: "review", status: "succeeded", nextRound: 2 },
				{ nodeId: "review-c", kind: "review", status: "succeeded", nextRound: 2 },
			],
			rounds: [
				{
					roundId: "c:round:1",
					nodeId: "c",
					index: 1,
					status: "completed",
					inputSubmissionIds: [bSubmission.submissionId],
					inputBindings: [
						{
							inputId: "b-approved",
							submissionId: bSubmission.submissionId,
							outputId: "content-output",
							approvalReviewNodeIds: ["joint-review"],
						},
					],
					startedAt: 1,
					finishedAt: 2,
				},
			],
			submissions: [aSubmission, bSubmission, cSubmission],
			reviews: [
				review("joint-review:review", "joint-review", [aSubmission.submissionId, bSubmission.submissionId]),
				review("review-c:review", "review-c", [cSubmission.submissionId]),
			],
			approvals: [
				{
					approvalId: "joint-a",
					reviewId: "joint-review:review",
					reviewNodeId: "joint-review",
					submissionId: aSubmission.submissionId,
					outputId: "content-output",
					criterionIds: ["quality"],
					status: "active",
					createdAt: 1,
				},
				{
					approvalId: "joint-b",
					reviewId: "joint-review:review",
					reviewNodeId: "joint-review",
					submissionId: bSubmission.submissionId,
					outputId: "content-output",
					criterionIds: ["quality"],
					status: "active",
					createdAt: 1,
				},
				{
					approvalId: "c-approval",
					reviewId: "review-c:review",
					reviewNodeId: "review-c",
					submissionId: cSubmission.submissionId,
					outputId: "content-output",
					criterionIds: ["quality"],
					status: "active",
					createdAt: 1,
				},
			],
			mechanicalChecks: [],
			events: [],
			operations: {},
		};

		expect(nodeIsReady(d, state)).toBe(true);
		invalidateFromNode(state, "produce");

		expect(state.reviews.find((item) => item.reviewNodeId === "joint-review")?.status).toBe("stale");
		expect(state.approvals.find((item) => item.approvalId === "joint-b")?.status).toBe("stale");
		expect(bSubmission.status).toBe("candidate");
		expect(cSubmission.status).toBe("stale");
		expect(state.approvals.find((item) => item.approvalId === "c-approval")?.status).toBe("stale");
		expect(state.reviews.find((item) => item.reviewNodeId === "review-c")?.status).toBe("stale");
		expect(nodeIsReady(d, state)).toBe(false);
	});
});
