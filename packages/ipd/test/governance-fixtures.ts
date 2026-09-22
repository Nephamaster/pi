import type { NodeRoundWork, SubmitReview } from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

export function stageFixture() {
	const fixture = createCompilerFixture();
	fixture.assets.agentCards = fixture.assets.agentCards.map((card) => ({
		...structuredClone(card),
		permissions: { ...card.permissions, readScopes: ["."], writeScopes: card.id === "producer" ? ["outputs"] : [] },
	}));
	const producer = fixture.workflow.nodes[0];
	const review = fixture.workflow.nodes[1];
	if (producer.kind !== "execution" || review.kind !== "review") throw new Error("Invalid fixture");
	const analysis = structuredClone(producer);
	analysis.node_id = "analysis";
	analysis.agents[0].participant_id = "analyst";
	analysis.agents[0].permissions.write_paths = ["outputs/analysis"];
	analysis.inputs = [
		{
			kind: "node_output",
			input_id: "basis",
			source: { node_id: "produce", output_id: "content-output" },
			required: true,
			availability: "submitted",
			approval_review_node_ids: [],
		},
	];
	analysis.outputs[0].output_id = "analysis-output";
	analysis.outputs[0].path_prefix = "outputs/analysis";
	const independent = structuredClone(producer);
	independent.node_id = "independent";
	independent.agents[0].participant_id = "writer";
	independent.agents[0].permissions.write_paths = ["outputs/independent"];
	independent.outputs[0].output_id = "independent-output";
	independent.outputs[0].path_prefix = "outputs/independent";
	independent.outputs[0].criterion_refs = ["integrity", "independent-quality"];
	fixture.workflow.criteria.push({
		kind: "semantic",
		criterion_id: "independent-quality",
		description: "Independent instructions are complete",
		evidence_requirements: ["Instructions"],
		process_criterion_refs: [],
	});
	for (const node of [analysis, independent]) {
		review.inputs.push({
			kind: "node_output",
			input_id: node.node_id,
			source: { node_id: node.node_id, output_id: node.outputs[0].output_id },
			required: true,
			availability: "submitted",
			approval_review_node_ids: [],
		});
		review.targets.push({
			node_id: node.node_id,
			output_id: node.outputs[0].output_id,
			criterion_refs: [node === analysis ? "quality" : "independent-quality"],
		});
		review.allowed_rework_node_ids.push(node.node_id);
	}
	review.criterion_subjects = [
		{
			criterion_id: "quality",
			targets: [
				{ node_id: "produce", output_id: "content-output" },
				{ node_id: "analysis", output_id: "analysis-output" },
			],
		},
	];
	review.required_relations = [
		{
			consumer: { node_id: "analysis", output_id: "analysis-output" },
			basis: { node_id: "produce", output_id: "content-output" },
		},
	];
	fixture.workflow.nodes.push(analysis, independent);
	fixture.workflow.stages = [
		{
			stage_id: "research",
			member_node_ids: ["produce", "analysis", "independent", "review-produce"],
			internal_uses: [{ consumer_node_id: "analysis", input_id: "basis" }],
			exits: [producer, analysis, independent].map((node) => ({
				output: { node_id: node.node_id, output_id: node.outputs[0].output_id },
				gate_node_ids: ["review-produce"],
			})),
		},
	];
	fixture.workflow.completion.required_node_ids.push("analysis", "independent");
	fixture.workflow.completion.final_outputs.push(
		{ node_id: "analysis", output_id: "analysis-output" },
		{ node_id: "independent", output_id: "independent-output" },
	);
	fixture.workflow.completion.delivery_outputs = [{ node_id: "analysis", output_id: "analysis-output" }];
	return fixture;
}

export function passReport(work: NodeRoundWork): SubmitReview {
	if (work.node.definition.kind !== "review") throw new Error("Expected Review");
	const review = work.node.definition;
	return {
		decision: "PASS",
		criteria: [...new Set(review.targets.flatMap((target) => target.criterion_refs))].map((criterionId) => ({
			criterion_id: criterionId,
			result: "PASS",
			rationale: "Inspected exact sealed versions",
			required_rework: [],
			rework_targets: [],
			evidence: review.targets
				.filter((target) => target.criterion_refs.includes(criterionId))
				.map((target) => {
					const submission = work.inputSubmissions.find(
						(item) =>
							item.nodeId === target.node_id &&
							item.outputs.some((output) => output.outputId === target.output_id),
					)!;
					const output = submission.outputs.find((item) => item.outputId === target.output_id)!;
					return {
						description: "Observed actual output",
						reference: output.manifest.files[0].path,
						submission_id: submission.submissionId,
						node_id: submission.nodeId,
						output_id: output.outputId,
						criterion_id: criterionId,
					};
				}),
			finding_resolutions: (work.findings ?? [])
				.filter((finding) => finding.reviewNodeId === review.node_id && finding.criterionId === criterionId)
				.map((finding) => ({
					finding_id: finding.findingId,
					result: "resolved",
					reason: "Verified the exact revised candidate and repair evidence",
				})),
		})),
		unresolved_issues: [],
	};
}
