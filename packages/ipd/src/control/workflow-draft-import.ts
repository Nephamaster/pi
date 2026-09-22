// Explicit legacy conversion. Frozen Workflows/Baselines are never rewritten.
import type { WorkflowDefinition, WorkflowNode } from "../contracts/workflow.ts";
import { hashJson } from "../ir/hash.ts";
import { AUTHORING_POLICY, type AuthoringDraft, type DraftInput, type DraftNode, type DraftTrustedReferences, DraftError, outputKey } from "./workflow-draft-model.ts";

export interface LegacyDraft {
	draftId: string;
	runId: string;
	revision: number;
	trustedReferences: DraftTrustedReferences;
	header?: Partial<Omit<WorkflowDefinition, "nodes" | "criteria" | "requirement_coverage" | "completion" | "task_input_ref" | "process_selection_ref">>;
	nodes: WorkflowNode[];
	criteria: WorkflowDefinition["criteria"];
	requirementCoverage: WorkflowDefinition["requirement_coverage"];
	completion?: WorkflowDefinition["completion"];
	operations: Record<string, { requestHash: string; revision: number }>;
	lastValidation?: unknown;
}
export function newAuthoringDraft(runId: string, references: DraftTrustedReferences): AuthoringDraft {
	return {
		draft_schema_version: 2, authoringPolicy: AUTHORING_POLICY, draftId: `${runId}:workflow-draft`, runId, revision: 0,
		trustedReferences: structuredClone(references), metadata: { workflow_id: `wf-${hashJson(runId).slice(0, 24)}`, workflow_version: "1.0.0" },
		nodes: [], criteria: [], stage_plans: [], requirements: [], decisions: [], process_coverage: [], editing: true, operations: {},
	};
}
export function importLegacyDraft(legacy: LegacyDraft): AuthoringDraft {
	const criterionIds = new Set(legacy.criteria.map((criterion) => criterion.criterion_id));
	for (const node of legacy.nodes) {
		if (node.kind === "execution" && node.outputs.some((output) => output.criterion_refs.some((id) => !criterionIds.has(id)))) throw new DraftError("legacy_migration_unsupported", `node:${node.node_id}.outputs`, "Resolve unknown criterion references before migration; they must not be discarded.");
		if (node.kind === "review") for (const target of node.targets) {
			if (!node.inputs.some((input) => input.kind === "node_output" && outputKey(input.source) === outputKey(target) && input.availability === "submitted" && input.required)) throw new DraftError("legacy_migration_unsupported", `node:${node.node_id}.inputs`, "A legacy review must already have its required candidate binding; migration cannot invent one.");
		}
	}
	for (const stage of legacy.header?.stages ?? []) for (const use of stage.internal_uses) {
		const consumer = legacy.nodes.find((node) => node.node_id === use.consumer_node_id);
		if (consumer?.kind !== "execution" || !consumer.inputs.some((input) => input.input_id === use.input_id && input.kind === "node_output" && input.availability === "submitted")) throw new DraftError("legacy_migration_unsupported", `stage:${stage.stage_id}`, "Resolve unused or invalid legacy internal_uses before migration.");
	}
	const draft = newAuthoringDraft(legacy.runId, legacy.trustedReferences);
	draft.draftId = legacy.draftId;
	draft.revision = legacy.revision;
	// Preserve missing legacy header fields as missing; do not apply new-run defaults.
	draft.metadata = { ...(legacy.header?.workflow_id ? { workflow_id: legacy.header.workflow_id } : {}), ...(legacy.header?.workflow_version ? { workflow_version: legacy.header.workflow_version } : {}), ...(legacy.header?.name ? { name: legacy.header.name } : {}) };
	if (legacy.header?.prerequisites) draft.prerequisites = structuredClone(legacy.header.prerequisites);
	draft.requirements = structuredClone(legacy.header?.requirements ?? []);
	draft.decisions = structuredClone(legacy.header?.decisions ?? []);
	draft.emptyOptionalSections = (["stages", "requirements", "decisions"] as const).filter((field) => legacy.header?.[field] !== undefined);
	draft.stage_plans = (legacy.header?.stages ?? []).map(({ internal_uses: _uses, ...stage }) => structuredClone(stage));
	draft.process_coverage = structuredClone(legacy.requirementCoverage);
	if (legacy.completion) draft.completion = structuredClone(legacy.completion);
	draft.legacyOperations = structuredClone(legacy.operations);
	draft.nodes = legacy.nodes.map((node): DraftNode => {
		if (node.agents.length !== 1) throw new DraftError("legacy_migration_unsupported", `node:${node.node_id}.agents`, "Cannot silently collapse a legacy multi-member node.");
		const inputs = node.inputs.map((input): DraftInput => {
			if (input.kind === "task_material") return structuredClone(input);
			const { availability, approval_review_node_ids, ...record } = input;
			if (availability === "submitted" && approval_review_node_ids.length) throw new DraftError("legacy_migration_unsupported", `node:${node.node_id}.inputs[${input.input_id}]`, "Submitted input has approval metadata that cannot be discarded.");
			let access: Extract<DraftInput, { kind: "node_output" }>["access"];
			if (availability === "approved") access = { mode: "approved", review_node_ids: structuredClone(approval_review_node_ids) };
			else if (node.kind === "review") access = { mode: "review_candidate" };
			else {
				const stages = (legacy.header?.stages ?? []).filter((stage) => stage.internal_uses.some((use) => use.consumer_node_id === node.node_id && use.input_id === input.input_id));
				if (stages.length !== 1) throw new DraftError("legacy_migration_unsupported", `node:${node.node_id}.inputs[${input.input_id}]`, "Execution candidate input needs one explicit legacy stage use.");
				access = { mode: "stage_candidate", stage_id: stages[0].stage_id };
			}
			return { ...structuredClone(record), purpose: input.purpose ?? "content_basis", ...(input.purpose === undefined ? { omit_default_purpose: true as const } : {}), access };
		});
		const result: DraftNode = { node_id: node.node_id, kind: node.kind, name: node.name, contract: structuredClone(node.contract), agent: structuredClone(node.agents[0]), inputs, outputs: [], ...(node.environment_ref ? { environment_ref: structuredClone(node.environment_ref) } : {}) };
		if (node.kind === "execution") result.outputs = node.outputs.map(({ criterion_refs: _refs, ...output }) => structuredClone(output));
		else {
			const ids = [...new Set(node.targets.flatMap((target) => target.criterion_refs))];
			const assignments = ids.map((id) => {
				const refs = node.targets.filter((target) => target.criterion_refs.includes(id)).map(({ criterion_refs: _criteria, ...ref }) => ref);
				const explicit = node.criterion_subjects?.find((subject) => subject.criterion_id === id);
				if ((refs.length > 1 && !explicit) || (explicit && hashJson(explicit.targets.map(outputKey).sort()) !== hashJson(refs.map(outputKey).sort()))) throw new DraftError("legacy_migration_ambiguous", `review:${node.node_id}.${id}`, "Cannot infer or change legacy composite subjects.");
				return { criterion_id: id, mode: refs.length > 1 ? "composite" as const : "single" as const, subjects: structuredClone(refs) };
			});
			if (node.criterion_subjects?.some((subject) => !ids.includes(subject.criterion_id))) throw new DraftError("legacy_migration_ambiguous", `review:${node.node_id}`, "Legacy subject has no corresponding target assignment.");
			result.review_plan = { assignments, allowed_rework_node_ids: structuredClone(node.allowed_rework_node_ids),
				...(node.criterion_subjects ? { explicit_subject_criteria: node.criterion_subjects.map((subject) => subject.criterion_id) } : {}),
				...(node.required_relations ? { required_relations: structuredClone(node.required_relations) } : {}),
				...(node.remediation_mappings ? { remediation_mappings: structuredClone(node.remediation_mappings) } : {}),
				...(node.decision_policy ? { decision_policy: structuredClone(node.decision_policy) } : {}),
			};
		}
		return result;
	});
	draft.criteria = legacy.criteria.map(({ criterion_id, ...definition }) => ({ criterion_id, definition: structuredClone(definition), output_bindings: legacy.nodes.flatMap((node) => node.kind === "execution" ? node.outputs.filter((output) => output.criterion_refs.includes(criterion_id)).map((output) => ({ node_id: node.node_id, output_id: output.output_id })) : []) }));
	return draft;
}
