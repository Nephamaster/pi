// Atomic domain reductions: callers validate the command before applying this pure function.
import { hashJson } from "../ir/hash.ts";
import { checkDraftLinks } from "./workflow-draft-links.ts";
import {
	type AuthoringDraft, type DraftCommand, type DraftExternalViews, type DraftInput,
	type DraftNode, type DraftOutput, type InputEdit, DraftError, outputKey,
} from "./workflow-draft-model.ts";

function unique<T>(items: readonly T[], key: (item: T) => string, path: string): void {
	const seen = new Set<string>();
	for (const item of items) {
		const id = key(item);
		if (seen.has(id)) throw new DraftError("duplicate_entity", path, `Duplicate key ${id} in the same batch.`);
		seen.add(id);
	}
}
function upsert<T>(items: T[], value: T, key: (item: T) => string): void {
	const index = items.findIndex((item) => key(item) === key(value));
	if (index < 0) items.push(value); else items[index] = value;
}
function requireNode(draft: AuthoringDraft, id: string, kind?: DraftNode["kind"]): DraftNode {
	const node = draft.nodes.find((item) => item.node_id === id);
	if (!node || (kind && node.kind !== kind)) throw new DraftError("node_unknown_or_wrong_kind", `node:${id}`, `Expected a declared ${kind ?? "workflow"} node: ${id}`);
	return node;
}
function addPort(node: DraftNode, id: string, defaults: string[]): DraftOutput {
	if (node.kind !== "execution") throw new DraftError("review_output_forbidden", `node:${node.node_id}`, "Only execution nodes own output ports.");
	const existing = node.outputs.find((output) => output.output_id === id);
	if (existing) return existing;
	const output = { output_id: id, path_prefix: `outputs/${node.node_id}/${id}` };
	node.outputs.push(output);
	defaults.push(`node:${node.node_id}.outputs[${id}].path_prefix=${output.path_prefix}`);
	return output;
}
function editInput(draft: AuthoringDraft, edit: InputEdit, declaration: boolean): void {
	const node = requireNode(draft, edit.consumer_node_id);
	const existing = node.inputs.find((item) => item.input_id === edit.input_id);
	if (!existing && !edit.source) throw new DraftError("input_source_missing", `node:${node.node_id}.inputs`, "A new input needs a source.");
	if (edit.input_id.startsWith("reviewin-") && !existing) throw new DraftError("reserved_input_id", `node:${node.node_id}.inputs`, "reviewin- IDs are derived. Use a distinct explicit target input ID.");
	if (declaration && existing) {
		const source = existing.kind === "task_material" ? { kind: existing.kind, material_id: existing.material_id } : { kind: existing.kind, ...existing.source };
		if (hashJson(source) !== hashJson(edit.source)) throw new DraftError("explicit_reconnect_required", `node:${node.node_id}.inputs[${edit.input_id}]`, "Use workflow_draft_inputs to reconnect an existing input.");
		return;
	}
	const source = edit.source;
	let input: DraftInput;
	if (source) {
		const sameKind = existing?.kind === source.kind;
		input = source.kind === "task_material"
			? { kind: "task_material", input_id: edit.input_id, material_id: source.material_id, ...(sameKind && existing ? { required: existing.required } : {}) }
			: { ...(sameKind && existing ? existing : {}), kind: "node_output", input_id: edit.input_id, source: { node_id: source.node_id, output_id: source.output_id } };
	} else input = structuredClone(existing!);
	if (edit.required !== undefined) input.required = edit.required;
	if (input.kind === "task_material") {
		if (edit.access !== undefined || edit.purpose !== undefined) throw new DraftError("material_policy_invalid", `node:${node.node_id}.inputs[${edit.input_id}]`, "Task materials have no node-output access or provenance purpose.");
	} else {
		if (edit.access !== undefined) input.access = structuredClone(edit.access);
		if (edit.purpose !== undefined) { input.purpose = edit.purpose; delete input.omit_default_purpose; }
	}
	upsert(node.inputs, input, (item) => item.input_id);
}

export function applyDraftCommand(before: AuthoringDraft, command: DraftCommand, external: DraftExternalViews = {}) {
	const draft = structuredClone(before);
	const defaults: string[] = [];
	const changed: string[] = [];
	switch (command.domain) {
		case "topology": {
			const data = command.data;
			unique(data.nodes ?? [], (item) => item.node_id, "topology.nodes");
			unique(data.connections ?? [], (item) => `${item.consumer_node_id}/${item.input_id}`, "topology.connections");
			for (const item of data.nodes ?? []) {
				let node = draft.nodes.find((candidate) => candidate.node_id === item.node_id);
				if (node && node.kind !== item.kind) throw new DraftError("immutable_node_kind", `node:${item.node_id}`, "Node kind cannot be changed in place.");
				if (!node) { node = { node_id: item.node_id, kind: item.kind, name: item.name, inputs: [], outputs: [] }; draft.nodes.push(node); }
				for (const id of item.output_ids ?? []) addPort(node, id, defaults);
				changed.push(`node:${item.node_id}.identity`);
			}
			for (const item of data.connections ?? []) { editInput(draft, item, true); changed.push(`node:${item.consumer_node_id}.inputs[${item.input_id}]`); }
			for (const id of data.remove_node_ids ?? []) { requireNode(draft, id); draft.nodes = draft.nodes.filter((node) => node.node_id !== id); changed.push(`node:${id}`); }
			break;
		}
		case "configure_nodes": {
			unique(command.data.nodes, (item) => item.node_id, "configure_nodes.nodes");
			for (const item of command.data.nodes) {
				const node = requireNode(draft, item.node_id);
				if (item.name !== undefined) node.name = item.name;
				if (item.contract) node.contract = { ...node.contract, ...item.contract };
				if (item.employee || item.resources) {
					if (!node.agent) { node.agent = { participant_id: "main", required_capabilities: [], skills: [], knowledge_bases: [] }; defaults.push(`node:${node.node_id}.agent=main; empty optional resource lists`); }
					node.agent = { ...node.agent, ...item.employee, ...item.resources, permissions: { external_actions: false, ...node.agent.permissions, ...item.resources?.permissions } };
				}
				if (item.environment_ref === null) delete node.environment_ref;
				else if (item.environment_ref !== undefined) node.environment_ref = item.environment_ref;
				for (const key of Object.keys(item).filter((key) => key !== "node_id")) changed.push(`node:${node.node_id}.${key}`);
			}
			break;
		}
		case "outputs": {
			unique(command.data.upsert ?? [], outputKey, "outputs.upsert");
			for (const item of command.data.upsert ?? []) {
				const node = requireNode(draft, item.node_id, "execution");
				const output = addPort(node, item.output_id, defaults);
				const { node_id: _owner, ...fields } = item;
				Object.assign(output, fields);
				changed.push(`output:${outputKey(item)}`);
			}
			for (const item of command.data.remove ?? []) {
				const node = requireNode(draft, item.node_id, "execution");
				if (!node.outputs.some((output) => output.output_id === item.output_id)) throw new DraftError("output_unknown", outputKey(item), "Cannot delete an unknown output.");
				node.outputs = node.outputs.filter((output) => output.output_id !== item.output_id);
				changed.push(`output:${outputKey(item)}`);
			}
			break;
		}
		case "criteria": {
			unique(command.data.upsert ?? [], (item) => item.criterion_id, "criteria.upsert");
			for (const item of command.data.upsert ?? []) {
				const existing = draft.criteria.find((candidate) => candidate.criterion_id === item.criterion_id);
				const kind = item.definition?.kind ?? existing?.definition.kind;
				if (!kind) throw new DraftError("criterion_kind_missing", `criterion:${item.criterion_id}`, "Declare mechanical or semantic when creating a criterion.");
				if (existing?.definition.kind && existing.definition.kind !== kind) throw new DraftError("immutable_criterion_kind", `criterion:${item.criterion_id}`, "Criterion kind cannot be changed in place.");
				upsert(draft.criteria, { criterion_id: item.criterion_id, definition: { ...existing?.definition, ...item.definition }, output_bindings: item.output_bindings ?? existing?.output_bindings ?? [] }, (value) => value.criterion_id);
				changed.push(`criterion:${item.criterion_id}`);
			}
			for (const id of command.data.remove_ids ?? []) { if (!draft.criteria.some((item) => item.criterion_id === id)) throw new DraftError("criterion_unknown", id, "Cannot delete an unknown criterion."); draft.criteria = draft.criteria.filter((item) => item.criterion_id !== id); changed.push(`criterion:${id}`); }
			break;
		}
		case "inputs": {
			unique(command.data.upsert ?? [], (item) => `${item.consumer_node_id}/${item.input_id}`, "inputs.upsert");
			for (const item of command.data.upsert ?? []) { editInput(draft, item, false); changed.push(`node:${item.consumer_node_id}.inputs[${item.input_id}]`); }
			for (const item of command.data.remove ?? []) {
				const node = requireNode(draft, item.consumer_node_id);
				if (!node.inputs.some((input) => input.input_id === item.input_id)) throw new DraftError("input_unknown_or_derived", item.input_id, "Only explicit inputs can be removed; derived review inputs follow assignments.");
				node.inputs = node.inputs.filter((input) => input.input_id !== item.input_id);
				changed.push(`node:${node.node_id}.inputs[${item.input_id}]`);
			}
			break;
		}
		case "reviews": {
			unique(command.data.upsert, (item) => item.review_node_id, "reviews.upsert");
			for (const item of command.data.upsert) {
				const node = requireNode(draft, item.review_node_id, "review");
				if (item.assignments) unique(item.assignments, (assignment) => assignment.criterion_id, `review:${node.node_id}.assignments`);
				const { review_node_id: _owner, decision_policy, ...fields } = item;
				node.review_plan = { ...node.review_plan, ...fields };
				if (decision_policy === null) delete node.review_plan.decision_policy;
				else if (decision_policy !== undefined) node.review_plan.decision_policy = decision_policy;
				changed.push(`review:${node.node_id}`);
			}
			break;
		}
		case "stages": {
			unique(command.data.upsert ?? [], (item) => item.stage_id, "stages.upsert");
			for (const item of command.data.upsert ?? []) { const current = draft.stage_plans.find((stage) => stage.stage_id === item.stage_id); upsert(draft.stage_plans, { ...current, ...item }, (stage) => stage.stage_id); changed.push(`stage:${item.stage_id}`); }
			for (const id of command.data.remove_ids ?? []) { if (!draft.stage_plans.some((stage) => stage.stage_id === id)) throw new DraftError("stage_unknown", id, "Cannot delete an unknown stage."); draft.stage_plans = draft.stage_plans.filter((stage) => stage.stage_id !== id); changed.push(`stage:${id}`); }
			break;
		}
		case "governance": {
			const data = command.data;
			if (data.metadata) { draft.metadata = { ...draft.metadata, ...data.metadata }; changed.push("metadata"); }
			if (data.prerequisites === null) { delete draft.prerequisites; changed.push("prerequisites"); }
			else if (data.prerequisites !== undefined) { draft.prerequisites = data.prerequisites; changed.push("prerequisites"); }
			unique(data.requirements?.upsert ?? [], (item) => item.requirement_id, "governance.requirements");
			unique(data.decisions?.upsert ?? [], (item) => item.decision_id, "governance.decisions");
			for (const item of data.requirements?.upsert ?? []) { upsert(draft.requirements, item, (value) => value.requirement_id); changed.push(`requirement:${item.requirement_id}`); }
			for (const item of data.decisions?.upsert ?? []) { upsert(draft.decisions, item, (value) => value.decision_id); changed.push(`decision:${item.decision_id}`); }
			for (const id of data.requirements?.remove_ids ?? []) { if (!draft.requirements.some((item) => item.requirement_id === id)) throw new DraftError("requirement_unknown", id, "Cannot delete an unknown requirement."); draft.requirements = draft.requirements.filter((item) => item.requirement_id !== id); changed.push(`requirement:${id}`); }
			for (const id of data.decisions?.remove_ids ?? []) { if (!draft.decisions.some((item) => item.decision_id === id)) throw new DraftError("decision_unknown", id, "Cannot delete an unknown decision."); draft.decisions = draft.decisions.filter((item) => item.decision_id !== id); changed.push(`decision:${id}`); }
			break;
		}
		case "coverage": {
			const key = (item: { source: string; requirement_id: string }) => `${item.source}/${item.requirement_id}`;
			unique(command.data.upsert ?? [], key, "coverage.upsert");
			for (const item of command.data.upsert ?? []) { upsert(draft.process_coverage, item, key); changed.push(`coverage:${key(item)}`); }
			for (const item of command.data.remove ?? []) { if (!draft.process_coverage.some((value) => key(value) === key(item))) throw new DraftError("coverage_unknown", key(item), "Cannot delete an unknown coverage row."); draft.process_coverage = draft.process_coverage.filter((value) => key(value) !== key(item)); changed.push(`coverage:${key(item)}`); }
			break;
		}
		case "completion": draft.completion = { ...draft.completion, ...command.data }; changed.push("completion"); break;
	}
	if (!changed.length) throw new DraftError("empty_edit", "/", "Provide at least one domain edit.");
	checkDraftLinks(before, draft, external);
	delete draft.lastValidation;
	return { draft, changed: [...new Set(changed)], defaults_applied: defaults };
}
