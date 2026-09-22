// Missing design choices are diagnostics, never invented executable defaults.
import type { AuthoringDraft, DraftDiagnostic } from "./workflow-draft-model.ts";
import { outputKey } from "./workflow-draft-model.ts";

export function draftCompleteness(draft: AuthoringDraft): DraftDiagnostic[] {
	const diagnostics: DraftDiagnostic[] = [];
	const need = (value: unknown, path: string, tool: string, nonempty = false) => {
		if (value === undefined || (nonempty && (value === "" || (Array.isArray(value) && !value.length))))
			diagnostics.push({
				code: "draft_field_missing",
				category: "incomplete",
				path,
				authoringPath: path,
				message: `Specify ${path} before compilation.`,
				suggestedTool: `workflow_draft_${tool}`,
			});
	};
	need(draft.metadata.workflow_id, "metadata.workflow_id", "governance", true);
	need(draft.metadata.workflow_version, "metadata.workflow_version", "governance", true);
	need(draft.metadata.name, "metadata.name", "governance", true);
	need(draft.nodes, "nodes", "topology", true);
	need(draft.criteria, "criteria", "criteria", true);
	for (const node of draft.nodes) {
		const path = `node:${node.node_id}`;
		for (const key of [
			"objective",
			"responsibilities",
			"non_responsibilities",
			"work_requirements",
			"constraints",
		] as const)
			need(
				node.contract?.[key],
				`${path}.contract.${key}`,
				"configure_nodes",
				["objective", "responsibilities", "work_requirements"].includes(key),
			);
		for (const key of [
			"agent_ref",
			"participant_id",
			"tools",
			"skills",
			"knowledge_bases",
			"required_capabilities",
		] as const)
			need(node.agent?.[key], `${path}.agent.${key}`, "configure_nodes");
		for (const key of ["read_paths", "write_paths", "external_actions"] as const)
			need(node.agent?.permissions?.[key], `${path}.agent.permissions.${key}`, "configure_nodes");
		for (const input of node.inputs) {
			need(input.required, `${path}.inputs[${input.input_id}].required`, "inputs");
			if (input.kind === "node_output") {
				need(input.purpose, `${path}.inputs[${input.input_id}].purpose`, "inputs");
				need(input.access, `${path}.inputs[${input.input_id}].access`, "inputs");
			}
		}
		if (node.kind === "execution") {
			need(node.outputs, `${path}.outputs`, "outputs", true);
			for (const output of node.outputs) {
				for (const key of [
					"artifact_type",
					"description",
					"business_purpose",
					"path_prefix",
					"evidence_requirements",
					"process_evidence_requirement_refs",
				] as const)
					need(
						output[key],
						`${path}.outputs[${output.output_id}].${key}`,
						"outputs",
						typeof output[key] === "string",
					);
				need(
					draft.criteria.filter((criterion) =>
						criterion.output_bindings.some((ref) => outputKey(ref) === `${node.node_id}/${output.output_id}`),
					),
					`${path}.outputs[${output.output_id}].criterion_refs`,
					"criteria",
					true,
				);
			}
		} else {
			need(node.review_plan?.assignments, `${path}.review.assignments`, "reviews", true);
			need(node.review_plan?.allowed_rework_node_ids, `${path}.review.allowed_rework_node_ids`, "reviews", true);
		}
	}
	for (const criterion of draft.criteria) {
		const path = `criterion:${criterion.criterion_id}`;
		const definition = criterion.definition;
		need(definition.kind, `${path}.kind`, "criteria");
		need(definition.description, `${path}.description`, "criteria", true);
		need(
			definition.evidence_requirements,
			`${path}.evidence_requirements`,
			"criteria",
			definition.kind === "semantic",
		);
		if (definition.kind === "mechanical") {
			need(definition.check_id, `${path}.check_id`, "criteria", true);
			need(definition.parameters, `${path}.parameters`, "criteria");
		} else if (definition.kind === "semantic")
			need(definition.process_criterion_refs, `${path}.process_criterion_refs`, "criteria");
	}
	for (const stage of draft.stage_plans) {
		need(stage.member_node_ids, `stage:${stage.stage_id}.member_node_ids`, "stages", true);
		need(stage.exits, `stage:${stage.stage_id}.exits`, "stages", true);
	}
	for (const key of ["required_node_ids", "required_review_node_ids", "final_outputs", "delivery_outputs"] as const)
		need(draft.completion?.[key], `completion.${key}`, "completion", true);
	return diagnostics;
}
