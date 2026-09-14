import { describe, expect, it } from "vitest";
import { compileWorkflow, type SubmissionRecord, validateReviewSubmission } from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

function reviewNode() {
	const compiled = compileWorkflow(createCompilerFixture());
	if (!compiled.ok) throw new Error("Fixture did not compile");
	const node = compiled.baseline.nodes.find((item) => item.definition.kind === "review");
	if (!node) throw new Error("Missing review node");
	return node;
}

const evidence = [
	{
		description: "Observed the sealed output",
		reference: "outputs/produce/result.txt",
		submission_id: "produce:round:1:submission",
		node_id: "produce",
		criterion_id: "quality",
		output_id: "content-output",
	},
];

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
			sealedRoot: "/sealed/content-output",
			manifest: {
				id: "content-output",
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
	],
	evidence: [],
	createdAt: 1,
};

describe("validateReviewSubmission", () => {
	it("requires evidence and consistent rework routing", () => {
		const node = reviewNode();
		expect(() =>
			validateReviewSubmission(
				node,
				{
					decision: "PASS",
					criteria: [
						{
							criterion_id: "quality",
							result: "PASS",
							evidence: [],
							rationale: "ok",
							required_rework: [],
							rework_targets: [],
						},
					],
					unresolved_issues: [],
				},
				[submission],
			),
		).toThrow("requires evidence");
		expect(() =>
			validateReviewSubmission(
				node,
				{
					decision: "REWORK",
					criteria: [
						{
							criterion_id: "quality",
							result: "FAIL",
							evidence,
							rationale: "not ready",
							required_rework: ["Revise the result"],
							rework_targets: [],
						},
					],
					unresolved_issues: [],
				},
				[submission],
			),
		).toThrow("requires an affected rework target");
	});

	it("accepts a fully bound PASS result", () => {
		const report = {
			decision: "PASS" as const,
			criteria: [
				{
					criterion_id: "quality",
					result: "PASS" as const,
					evidence,
					rationale: "accepted",
					required_rework: [],
					rework_targets: [],
				},
			],
			unresolved_issues: [],
		};
		expect(validateReviewSubmission(reviewNode(), report, [submission])).toEqual(report);
	});

	it("rejects rework routed to a different criterion target", () => {
		const node = structuredClone(reviewNode());
		if (node.definition.kind !== "review") throw new Error("Missing review definition");
		node.definition.targets.push({ node_id: "other", output_id: "other-output", criterion_refs: ["other-quality"] });
		node.definition.allowed_rework_node_ids.push("other");
		const otherSubmission = structuredClone(submission);
		otherSubmission.submissionId = "other:round:1:submission";
		otherSubmission.nodeId = "other";
		otherSubmission.outputs[0].outputId = "other-output";
		expect(() =>
			validateReviewSubmission(
				node,
				{
					decision: "REWORK",
					criteria: [
						{
							criterion_id: "quality",
							result: "FAIL",
							evidence,
							rationale: "Primary output failed",
							required_rework: ["Fix the primary output"],
							rework_targets: [{ node_id: "other", output_id: "other-output" }],
						},
						{
							criterion_id: "other-quality",
							result: "PASS",
							evidence: [
								{
									description: "Other output passed",
									reference: "other.txt",
									submission_id: otherSubmission.submissionId,
									node_id: "other",
									output_id: "other-output",
									criterion_id: "other-quality",
								},
							],
							rationale: "Other output passed",
							required_rework: [],
							rework_targets: [],
						},
					],
					unresolved_issues: [],
				},
				[submission, otherSubmission],
			),
		).toThrow("selected an unrelated rework target");
	});
});
