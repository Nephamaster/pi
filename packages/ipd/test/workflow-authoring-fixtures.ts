import type { WorkflowDefinition } from "../src/contracts/workflow.ts";
import { newAuthoringDraft } from "../src/control/workflow-draft-import.ts";
import type { AuthoringDraft, DraftCommand } from "../src/control/workflow-draft-model.ts";
import { applyDraftCommand } from "../src/control/workflow-draft-operations.ts";

/** Drive the same domain payloads accepted by the Designer tools. */
export function authoringCommands(workflow: WorkflowDefinition): DraftCommand[] {
	return [
		{
			domain: "topology",
			data: {
				nodes: workflow.nodes.map((node) => ({
					node_id: node.node_id,
					kind: node.kind,
					name: node.name,
					...(node.kind === "execution" ? { output_ids: node.outputs.map((output) => output.output_id) } : {}),
				})),
			},
		},
		{
			domain: "configure_nodes",
			data: {
				nodes: workflow.nodes.map((node) => {
					const { participant_id, agent_ref, ...resources } = node.agents[0];
					return {
						node_id: node.node_id,
						contract: node.contract,
						employee: { participant_id, agent_ref },
						resources,
					};
				}),
			},
		},
		{
			domain: "outputs",
			data: {
				upsert: workflow.nodes.flatMap((node) =>
					node.kind === "execution"
						? node.outputs.map(({ criterion_refs: _refs, ...output }) => ({ node_id: node.node_id, ...output }))
						: [],
				),
			},
		},
		{
			domain: "criteria",
			data: {
				upsert: workflow.criteria.map(({ criterion_id, ...definition }) => ({
					criterion_id,
					definition,
					output_bindings: workflow.nodes.flatMap((node) =>
						node.kind === "execution"
							? node.outputs
									.filter((output) => output.criterion_refs.includes(criterion_id))
									.map((output) => ({ node_id: node.node_id, output_id: output.output_id }))
							: [],
					),
				})),
			},
		},
		{
			domain: "reviews",
			data: {
				upsert: workflow.nodes.flatMap((node) =>
					node.kind === "review"
						? [
								{
									review_node_id: node.node_id,
									assignments: [...new Set(node.targets.flatMap((target) => target.criterion_refs))].map(
										(criterion_id) => {
											const subjects = node.targets
												.filter((target) => target.criterion_refs.includes(criterion_id))
												.map(({ criterion_refs: _refs, ...ref }) => ref);
											return {
												criterion_id,
												mode: subjects.length > 1 ? ("composite" as const) : ("single" as const),
												subjects,
											};
										},
									),
									allowed_rework_node_ids: node.allowed_rework_node_ids,
								},
							]
						: [],
				),
			},
		},
		{
			domain: "inputs",
			data: {
				upsert: workflow.nodes.flatMap((node) =>
					node.inputs.flatMap((input) =>
						input.kind === "task_material"
							? [
									{
										consumer_node_id: node.node_id,
										input_id: input.input_id,
										source: { kind: "task_material" as const, material_id: input.material_id },
										required: input.required,
									},
								]
							: [],
					),
				),
			},
		},
		{
			domain: "governance",
			data: {
				metadata: {
					workflow_id: workflow.workflow_id,
					workflow_version: workflow.workflow_version,
					name: workflow.name,
				},
			},
		},
		{ domain: "coverage", data: { upsert: workflow.requirement_coverage } },
		{ domain: "completion", data: workflow.completion },
	];
}

export function authorFixture(workflow: WorkflowDefinition): AuthoringDraft {
	let state = newAuthoringDraft("run-1", {
		task_input_ref: workflow.task_input_ref,
		process_selection_ref: workflow.process_selection_ref,
	});
	for (const command of authoringCommands(workflow)) state = applyDraftCommand(state, command).draft;
	return state;
}
