// Resolve frozen stage membership and criterion subjects without a second workflow graph.
import type { NodeInput, NodeOutputRef, ReviewNode, WorkflowDefinition } from "../contracts/workflow.ts";

export const outputRefKey = (ref: NodeOutputRef): string => `${ref.node_id}/${ref.output_id}`;

export function criterionSubjects(review: ReviewNode, criterionId: string): NodeOutputRef[] {
	return (
		review.criterion_subjects?.find((subject) => subject.criterion_id === criterionId)?.targets ??
		review.targets
			.filter((target) => target.criterion_refs.includes(criterionId))
			.map(({ node_id, output_id }) => ({ node_id, output_id }))
	);
}

export function candidateUseAllowed(workflow: WorkflowDefinition, consumerId: string, input: NodeInput): boolean {
	if (input.kind !== "node_output" || input.availability !== "submitted") return false;
	return (workflow.stages ?? []).some(
		(stage) =>
			stage.member_node_ids.includes(input.source.node_id) &&
			stage.member_node_ids.includes(consumerId) &&
			stage.internal_uses.some((use) => use.consumer_node_id === consumerId && use.input_id === input.input_id),
	);
}
