// References and topology are derived from authoring records, never persisted as another graph.

import type { NodeOutputRef } from "../contracts/workflow.ts";
import { topologicalSort } from "../ir/graph.ts";
import {
	type AuthoringDraft,
	type DraftDiagnostic,
	DraftError,
	type DraftExternalViews,
	outputKey,
} from "./workflow-draft-model.ts";

interface Reference {
	target: string;
	path: string;
}
const nodeKey = (id: string) => `node:${id}`;
const portKey = (ref: NodeOutputRef) => `output:${outputKey(ref)}`;
export function declaredEntities(draft: AuthoringDraft): Set<string> {
	return new Set([
		...draft.nodes.flatMap((node) => [
			nodeKey(node.node_id),
			...node.outputs.map((output) => portKey({ node_id: node.node_id, output_id: output.output_id })),
		]),
		...draft.criteria.map((item) => `criterion:${item.criterion_id}`),
		...draft.stage_plans.map((item) => `stage:${item.stage_id}`),
		...draft.requirements.map((item) => `requirement:${item.requirement_id}`),
		...draft.decisions.map((item) => `decision:${item.decision_id}`),
	]);
}
export function draftReferences(draft: AuthoringDraft): Reference[] {
	const result: Reference[] = [];
	const add = (target: string, path: string) => result.push({ target, path });
	const outputs = (refs: readonly NodeOutputRef[], path: string) =>
		refs.forEach((ref, i) => add(portKey(ref), `${path}/${i}`));
	for (const node of draft.nodes) {
		const path = `node:${node.node_id}`;
		for (const input of node.inputs) {
			if (input.kind !== "node_output") continue;
			add(portKey(input.source), `${path}.inputs[${input.input_id}].source`);
			if (input.access?.mode === "approved")
				for (const id of input.access.review_node_ids) add(nodeKey(id), `${path}.inputs[${input.input_id}].access`);
			if (input.access?.mode === "stage_candidate")
				add(`stage:${input.access.stage_id}`, `${path}.inputs[${input.input_id}].access`);
		}
		for (const id of node.contract?.requirement_refs ?? [])
			add(`requirement:${id}`, `${path}.contract.requirement_refs`);
		for (const id of node.contract?.decision_refs ?? []) add(`decision:${id}`, `${path}.contract.decision_refs`);
		for (const assignment of node.review_plan?.assignments ?? []) {
			add(`criterion:${assignment.criterion_id}`, `${path}.review.assignments`);
			outputs(assignment.subjects, `${path}.review.assignments[${assignment.criterion_id}].subjects`);
		}
		for (const id of node.review_plan?.allowed_rework_node_ids ?? [])
			add(nodeKey(id), `${path}.review.allowed_rework_node_ids`);
		for (const relation of node.review_plan?.required_relations ?? [])
			outputs([relation.consumer, relation.basis], `${path}.review.required_relations`);
		for (const mapping of node.review_plan?.remediation_mappings ?? []) {
			add(`criterion:${mapping.criterion_id}`, `${path}.review.remediation_mappings`);
			outputs([mapping.observed, mapping.owner], `${path}.review.remediation_mappings`);
		}
	}
	for (const criterion of draft.criteria) {
		outputs(criterion.output_bindings, `criterion:${criterion.criterion_id}.output_bindings`);
		for (const id of criterion.definition.requirement_refs ?? [])
			add(`requirement:${id}`, `criterion:${criterion.criterion_id}.requirement_refs`);
	}
	for (const stage of draft.stage_plans) {
		for (const id of stage.member_node_ids ?? []) add(nodeKey(id), `stage:${stage.stage_id}.member_node_ids`);
		for (const exit of stage.exits ?? []) {
			add(portKey(exit.output), `stage:${stage.stage_id}.exits`);
			for (const id of exit.gate_node_ids) add(nodeKey(id), `stage:${stage.stage_id}.exits.gate_node_ids`);
		}
	}
	for (const decision of draft.decisions)
		for (const id of decision.requirement_refs)
			add(`requirement:${id}`, `decision:${decision.decision_id}.requirement_refs`);
	for (const coverage of draft.process_coverage) {
		const path = `coverage:${coverage.source}/${coverage.requirement_id}`;
		for (const id of coverage.responsible_node_ids) add(nodeKey(id), path);
		for (const id of coverage.criterion_refs) add(`criterion:${id}`, path);
		outputs(coverage.output_refs, path);
	}
	for (const id of draft.completion?.required_node_ids ?? []) add(nodeKey(id), "completion.required_node_ids");
	for (const id of draft.completion?.required_review_node_ids ?? [])
		add(nodeKey(id), "completion.required_review_node_ids");
	outputs(draft.completion?.final_outputs ?? [], "completion.final_outputs");
	outputs(draft.completion?.delivery_outputs ?? [], "completion.delivery_outputs");
	return result;
}
export function draftTopology(draft: AuthoringDraft) {
	const edges: { from: string; to: string; reason: string }[] = [];
	for (const node of draft.nodes) {
		for (const input of node.inputs)
			if (input.kind === "node_output") {
				edges.push({ from: input.source.node_id, to: node.node_id, reason: `input:${input.input_id}` });
				if (input.access?.mode === "approved")
					for (const id of input.access.review_node_ids)
						edges.push({ from: id, to: node.node_id, reason: `approval:${input.input_id}` });
			}
		for (const assignment of node.review_plan?.assignments ?? [])
			for (const ref of assignment.subjects)
				edges.push({ from: ref.node_id, to: node.node_id, reason: `review:${assignment.criterion_id}` });
	}
	return {
		nodes: draft.nodes.map((node) => ({
			node_id: node.node_id,
			name: node.name,
			kind: node.kind,
			output_ids: node.outputs.map((output) => output.output_id),
		})),
		edges,
	};
}
export function checkDraftLinks(
	before: AuthoringDraft,
	after: AuthoringDraft,
	external: DraftExternalViews = {},
): void {
	const unique = (ids: string[], path: string) => {
		if (new Set(ids).size !== ids.length)
			throw new DraftError("duplicate_identity", path, "Duplicate authoring identity.");
	};
	unique(
		after.nodes.map((node) => node.node_id),
		"nodes",
	);
	unique(
		after.criteria.map((item) => item.criterion_id),
		"criteria",
	);
	unique(
		after.stage_plans.map((item) => item.stage_id),
		"stages",
	);
	unique(
		after.requirements.map((item) => item.requirement_id),
		"requirements",
	);
	unique(
		after.decisions.map((item) => item.decision_id),
		"decisions",
	);
	unique(
		after.process_coverage.map((item) => `${item.source}/${item.requirement_id}`),
		"coverage",
	);
	for (const node of after.nodes) {
		unique(
			node.inputs.map((item) => item.input_id),
			`node:${node.node_id}.inputs`,
		);
		unique(
			node.outputs.map((item) => item.output_id),
			`node:${node.node_id}.outputs`,
		);
		unique(
			(node.review_plan?.assignments ?? []).map((item) => item.criterion_id),
			`node:${node.node_id}.review`,
		);
		if ((node.kind === "review" && node.outputs.length) || (node.kind === "execution" && node.review_plan))
			throw new DraftError(
				"node_kind_content",
				`node:${node.node_id}`,
				"Execution outputs and review plans belong to their declared node kind.",
			);
	}
	const declared = declaredEntities(after);
	const previous = declaredEntities(before);
	const diagnostics: DraftDiagnostic[] = draftReferences(after)
		.filter((ref) => !declared.has(ref.target))
		.map((ref) => ({
			code: previous.has(ref.target) ? "referenced_entity" : "unknown_reference",
			path: ref.path,
			message: `${ref.target} is referenced here. Declare it or explicitly remove this reference.`,
			category: "error",
		}));
	if (diagnostics.length)
		throw new DraftError(
			"references_invalid",
			"/",
			"Draft references are invalid; no edits were saved.",
			diagnostics,
		);
	const nodes = new Map(after.nodes.map((node) => [node.node_id, node]));
	for (const node of after.nodes) {
		for (const input of node.inputs) {
			const path = `node:${node.node_id}.inputs[${input.input_id}]`;
			if (input.kind === "task_material") {
				if (external.materialIds && !external.materialIds.includes(input.material_id))
					throw new DraftError("material_unknown", path, `Unknown task material ${input.material_id}`);
				continue;
			}
			if (input.access?.mode === "review_candidate" && node.kind !== "review")
				throw new DraftError(
					"candidate_use_invalid",
					path,
					"Execution candidate use must explicitly select a declared stage.",
				);
			if (input.access?.mode === "approved")
				for (const id of input.access.review_node_ids)
					if (nodes.get(id)?.kind !== "review")
						throw new DraftError("approval_owner_invalid", path, `${id} is not a review node.`);
			if (input.access?.mode === "stage_candidate") {
				const stageId = input.access.stage_id;
				const members = after.stage_plans.find((stage) => stage.stage_id === stageId)?.member_node_ids;
				if (members && (!members.includes(node.node_id) || !members.includes(input.source.node_id)))
					throw new DraftError(
						"stage_use_outside_members",
						path,
						"Both candidate producer and consumer must be declared stage members.",
					);
			}
		}
		for (const assignment of node.review_plan?.assignments ?? []) {
			const path = `node:${node.node_id}.review.assignments[${assignment.criterion_id}]`;
			if (
				after.criteria.find((item) => item.criterion_id === assignment.criterion_id)?.definition.kind !== "semantic"
			)
				throw new DraftError(
					"review_criterion_invalid",
					path,
					"A review assignment must use a declared semantic criterion.",
				);
			if (
				(assignment.mode === "single" && assignment.subjects.length !== 1) ||
				(assignment.mode === "composite" && assignment.subjects.length < 2)
			)
				throw new DraftError(
					"review_subject_count",
					path,
					"single requires one subject; composite requires at least two.",
				);
		}
		for (const id of node.review_plan?.allowed_rework_node_ids ?? [])
			if (nodes.get(id)?.kind !== "execution")
				throw new DraftError(
					"rework_owner_invalid",
					`node:${node.node_id}.review`,
					`${id} is not an execution owner.`,
				);
	}
	const graph = draftTopology(after);
	const sorted = topologicalSort(
		after.nodes.map((node) => ({
			id: node.node_id,
			dependsOn: [...new Set(graph.edges.filter((edge) => edge.to === node.node_id).map((edge) => edge.from))],
		})),
	);
	if (sorted.cycle.length)
		throw new DraftError(
			"draft_cycle",
			"topology",
			`Forward cycle: ${sorted.cycle.join(" -> ")}. Declare genuine stage-internal candidate use, not a false approval dependency.`,
		);
}
