import type {
	CompilerDiagnostic,
	CompilerReport,
	ExecutionBaseline,
	LockedSkill,
	LockedTool,
} from "../contracts/baseline.ts";
import type { JsonValue, LockedAssetRef, ResourceRef } from "../contracts/primitives.ts";
import {
	type ProcessSelection,
	ProcessSelectionSchema,
	type ProcessSpec,
	ProcessSpecSchema,
} from "../contracts/process-spec.ts";
import { type TaskInput, TaskInputSchema } from "../contracts/task-input.ts";
import { type WorkflowDefinition, WorkflowDefinitionSchema } from "../contracts/workflow.ts";
import { freezeDeep, hashJson } from "../ir/hash.ts";
import { validateSchema } from "../ir/validation.ts";
import type { CompilerAssetCatalog } from "./types.ts";
import { validateProcessCoverage } from "./validate-process-coverage.ts";
import { validateWorkflowRelations } from "./validate-workflow.ts";

export interface CompileWorkflowInput {
	runId: string;
	workflow: unknown;
	taskInput: unknown;
	processSelection: unknown;
	processSpec: unknown;
	assets: CompilerAssetCatalog;
	executionIdentity?: JsonValue;
	rulesVersion?: string;
}

export type CompileWorkflowResult = { ok: true; baseline: ExecutionBaseline } | { ok: false; report: CompilerReport };

function schemaDiagnostics(source: string, value: ReturnType<typeof validateSchema>): CompilerDiagnostic[] {
	if (value.ok) return [];
	return value.diagnostics.map((item) => ({
		code: item.code,
		severity: "error",
		path: item.path,
		message: `${source}: ${item.message}`,
	}));
}

function lockedResources(
	refs: readonly { id: string; version: string }[],
	assets: readonly LockedAssetRef[],
): LockedAssetRef[] {
	return refs.flatMap((ref) => {
		const asset = assets.find((candidate) => candidate.id === ref.id && candidate.version === ref.version);
		return asset ? [structuredClone(asset)] : [];
	});
}

function lockedNamedResources<T extends LockedSkill | LockedTool>(
	refs: readonly ResourceRef[],
	assets: readonly T[],
): T[] {
	return refs.flatMap((ref) => {
		const asset = assets.find((candidate) => candidate.id === ref.id);
		return asset ? [structuredClone(asset)] : [];
	});
}

function contentHash(value: unknown): string | undefined {
	try {
		return hashJson(value);
	} catch {
		return undefined;
	}
}

export function compileWorkflow(input: CompileWorkflowInput): CompileWorkflowResult {
	const workflowResult = validateSchema<WorkflowDefinition>(WorkflowDefinitionSchema, input.workflow, "workflow");
	const taskResult = validateSchema<TaskInput>(TaskInputSchema, input.taskInput, "task-input");
	const selectionResult = validateSchema<ProcessSelection>(
		ProcessSelectionSchema,
		input.processSelection,
		"process-selection",
	);
	const specResult = validateSchema<ProcessSpec>(ProcessSpecSchema, input.processSpec, "process-spec");
	const diagnostics = [
		...schemaDiagnostics("Workflow", workflowResult),
		...schemaDiagnostics("TaskInput", taskResult),
		...schemaDiagnostics("ProcessSelection", selectionResult),
		...schemaDiagnostics("ProcessSpec", specResult),
	];
	const rulesVersion = input.rulesVersion ?? "1";
	const reportHashes = {
		workflowHash: contentHash(input.workflow),
		taskInputHash: contentHash(input.taskInput),
		processSelectionHash: contentHash(input.processSelection),
		processSpecHash: contentHash(input.processSpec),
	};
	if (!workflowResult.ok || !taskResult.ok || !selectionResult.ok || !specResult.ok) {
		return { ok: false, report: { runId: input.runId, rulesVersion, complete: true, ...reportHashes, diagnostics } };
	}
	const workflow = workflowResult.value;
	const task = taskResult.value;
	const selection = selectionResult.value;
	const spec = specResult.value;
	const taskHash = hashJson(task);
	const selectionHash = hashJson(selection);
	const specHash = hashJson(spec);
	if (selection.run_id !== input.runId)
		diagnostics.push({
			code: "run_mismatch",
			severity: "error",
			path: "/run_id",
			message: "ProcessSelection belongs to another Run",
		});
	if (workflow.task_input_ref.id !== task.task_input_id || workflow.task_input_ref.hash !== taskHash)
		diagnostics.push({
			code: "task_input_mismatch",
			severity: "error",
			path: "/task_input_ref",
			message: "Workflow does not reference the supplied TaskInput content",
		});
	if (selection.task_input_ref.id !== task.task_input_id || selection.task_input_ref.hash !== taskHash)
		diagnostics.push({
			code: "task_input_mismatch",
			severity: "error",
			path: "/task_input_ref",
			message: "ProcessSelection does not reference the supplied TaskInput content",
		});
	if (
		workflow.process_selection_ref.id !== selection.process_selection_id ||
		workflow.process_selection_ref.hash !== selectionHash
	)
		diagnostics.push({
			code: "process_selection_mismatch",
			severity: "error",
			path: "/process_selection_ref",
			message: "Workflow does not reference the supplied ProcessSelection content",
		});
	const taskRequirementIds = new Set(task.requirements.map((item) => item.requirement_id));
	const unresolvedFactIds = new Set(task.unresolved_facts.map((item) => item.fact_id));
	const processRequirementIds = new Set([
		...spec.required_activities.map((item) => item.activity_id),
		...spec.required_deliverables.map((item) => item.deliverable_id),
		...spec.required_reviews.map((item) => item.review_id),
		...spec.workflow_rules.map((item) => item.rule_id),
	]);
	for (const id of selection.task_requirement_refs) {
		if (!taskRequirementIds.has(id))
			diagnostics.push({
				code: "selection_reference_unknown",
				severity: "error",
				path: "/task_requirement_refs",
				message: `Unknown task requirement ${id}`,
			});
	}
	for (const id of selection.unresolved_fact_refs) {
		if (!unresolvedFactIds.has(id))
			diagnostics.push({
				code: "selection_reference_unknown",
				severity: "error",
				path: "/unresolved_fact_refs",
				message: `Unknown unresolved fact ${id}`,
			});
	}
	for (const id of selection.process_requirement_refs) {
		if (!processRequirementIds.has(id))
			diagnostics.push({
				code: "selection_reference_unknown",
				severity: "error",
				path: "/process_requirement_refs",
				message: `Unknown process requirement ${id}`,
			});
	}
	if (
		selection.process_spec_ref.id !== spec.process_spec_id ||
		selection.process_spec_ref.version !== spec.version ||
		selection.process_spec_ref.hash !== specHash
	)
		diagnostics.push({
			code: "process_spec_mismatch",
			severity: "error",
			path: "/process_spec_ref",
			message: "ProcessSelection does not lock the supplied ProcessSpec",
		});

	const validated = validateWorkflowRelations(workflow, task, spec, input.assets);
	diagnostics.push(...validated.diagnostics);
	validateProcessCoverage(workflow, spec, validated.agentByNode, diagnostics);
	const report: CompilerReport = {
		runId: input.runId,
		rulesVersion,
		complete: true,
		...reportHashes,
		diagnostics,
	};
	if (diagnostics.some((item) => item.severity === "error")) return { ok: false, report };

	const workflowHash = hashJson(workflow);
	const nodes = workflow.nodes.map((node) => ({
		definition: node,
		criteria: workflow.criteria.filter((criterion) => {
			const refs =
				node.kind === "execution"
					? node.outputs.flatMap((output) => output.criterion_refs)
					: node.targets.flatMap((target) => target.criterion_refs);
			return refs.includes(criterion.criterion_id);
		}),
		agents: node.agents.map((agent) => ({
			participantId: agent.participant_id,
			agentCard: validated.agentByNode.get(node.node_id)!,
			lockedSkills: lockedNamedResources(agent.skills, input.assets.skills),
			lockedTools: lockedNamedResources(agent.tools, input.assets.tools),
			lockedKnowledgeBases: lockedResources(agent.knowledge_bases, input.assets.knowledgeBases),
		})),
	}));
	const baseline: ExecutionBaseline = {
		baselineId: hashJson({
			runId: input.runId,
			workflowHash,
			specHash,
			rulesVersion,
			executionIdentity: input.executionIdentity ?? null,
			resources: nodes.map((node) =>
				node.agents.map((agent) => ({
					participantId: agent.participantId,
					agentCardHash: agent.agentCard.hash,
					skills: agent.lockedSkills.map((item) => ({ id: item.id, hash: item.hash })),
					tools: agent.lockedTools.map((item) => ({ id: item.id, hash: item.hash })),
					knowledgeBases: agent.lockedKnowledgeBases.map((item) => ({ id: item.id, hash: item.hash })),
					model: agent.agentCard.model,
				})),
			),
		}),
		runId: input.runId,
		workflow,
		workflowHash,
		processSpecRef: { ...selection.process_spec_ref },
		nodes,
		graph: validated.graph,
		report,
	};
	return { ok: true, baseline: freezeDeep(baseline) };
}
