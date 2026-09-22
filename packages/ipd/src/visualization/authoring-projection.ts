// A display projection is not an executable Workflow with invented defaults.
import { draftTopology } from "../control/workflow-draft-links.ts";
import type { AuthoringDraft } from "../control/workflow-draft-model.ts";
import type { DashboardSnapshot } from "./dashboard-model.ts";

export function projectAuthoringDraft(draft: AuthoringDraft): DashboardSnapshot["workflow"] {
	const topology = draftTopology(draft);
	return {
		source: "draft",
		name: draft.metadata.name,
		id: draft.metadata.workflow_id,
		version: draft.metadata.workflow_version,
		draftRevision: draft.revision,
		criteriaCount: draft.criteria.length,
		coverageCount: draft.process_coverage.length,
		completionDefined: Boolean(draft.completion),
		nodes: draft.nodes.map((node) => ({
			id: node.node_id,
			name: node.name,
			kind: node.kind,
			status: "planned",
			agent: node.agent?.agent_ref?.id ?? "Unassigned",
			objective: node.contract?.objective ?? "",
			responsibilities: [...(node.contract?.responsibilities ?? [])],
			workRequirements: [...(node.contract?.work_requirements ?? [])],
			nonResponsibilities: [...(node.contract?.non_responsibilities ?? [])],
			constraints: [...(node.contract?.constraints ?? [])],
			requiredCapabilities: [...(node.agent?.required_capabilities ?? [])],
			tools: node.agent?.tools?.map((tool) => tool.id) ?? [],
			skills: node.agent?.skills?.map((skill) => skill.id) ?? [],
			permissions: {
				readPaths: [...(node.agent?.permissions?.read_paths ?? [])],
				writePaths: [...(node.agent?.permissions?.write_paths ?? [])],
				externalActions: node.agent?.permissions?.external_actions ?? false,
			},
			inputs: node.inputs.map((input) => input.kind === "task_material"
				? `任务材料：${input.material_id}`
				: `${input.source.node_id}.${input.source.output_id}（${input.access?.mode ?? "待配置使用条件"}）`),
			outputs: node.kind === "execution"
				? node.outputs.map((output) => output.output_id)
				: [...new Set((node.review_plan?.assignments ?? []).flatMap((assignment) => assignment.subjects.map((subject) => `${subject.node_id}.${subject.output_id}`)))],
			roundCount: 0,
		})),
		edges: [
			...topology.edges.map((edge) => ({ from: edge.from, to: edge.to, kind: "dependency" as const, label: edge.reason })),
			...draft.nodes.flatMap((node) => (node.review_plan?.allowed_rework_node_ids ?? []).map((owner) => ({
				from: node.node_id, to: owner, kind: "rework" as const, label: "rework",
			}))),
		],
	};
}
