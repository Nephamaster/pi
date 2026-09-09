import { describe, expect, it } from "vitest";
import { compileWorkflow, validateReviewSubmission } from "../src/index.ts";
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
		criterion_id: "quality",
		output_id: "content-output",
	},
];

describe("validateReviewSubmission", () => {
	it("requires evidence and consistent rework routing", () => {
		const node = reviewNode();
		expect(() =>
			validateReviewSubmission(node, {
				decision: "PASS",
				criteria: [{ criterion_id: "quality", result: "PASS", evidence: [], rationale: "ok", required_rework: [] }],
				rework_node_ids: [],
				unresolved_issues: [],
			}),
		).toThrow("requires evidence");
		expect(() =>
			validateReviewSubmission(node, {
				decision: "REWORK",
				criteria: [
					{
						criterion_id: "quality",
						result: "FAIL",
						evidence,
						rationale: "not ready",
						required_rework: ["Revise the result"],
					},
				],
				rework_node_ids: [],
				unresolved_issues: [],
			}),
		).toThrow("requires at least one authorized rework target");
	});

	it("accepts a fully bound PASS result", () => {
		const report = {
			decision: "PASS" as const,
			criteria: [
				{ criterion_id: "quality", result: "PASS" as const, evidence, rationale: "accepted", required_rework: [] },
			],
			rework_node_ids: [],
			unresolved_issues: [],
		};
		expect(validateReviewSubmission(reviewNode(), report)).toEqual(report);
	});
});
