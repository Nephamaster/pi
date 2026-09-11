import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessSpec } from "../contracts/process-spec.ts";
import type { RunEvent, RunState } from "../contracts/runtime.ts";
import type { WorkflowNode } from "../contracts/workflow.ts";
import type { WorkflowDraftState } from "../control/workflow-draft.ts";

export type DashboardWorkflowSource = "none" | "draft" | "candidate" | "compiled";

export interface DashboardNode {
	id: string;
	name: string;
	kind: "execution" | "review";
	status: string;
	agent: string;
	objective: string;
	responsibilities: string[];
	inputs: string[];
	outputs: string[];
	activeRoundId?: string;
	roundCount: number;
}

export interface DashboardEdge {
	from: string;
	to: string;
	kind: "dependency" | "rework";
	label?: string;
}

export interface DashboardSnapshot {
	schemaVersion: 1;
	generatedAt: number;
	run: {
		id: string;
		phase: RunState["phase"];
		status: RunState["status"];
		revision: number;
		failure?: RunState["failure"];
	};
	task?: {
		text: string;
		/** Compatibility-only presentation field; TaskInput v2 no longer models formal objectives. */
		objectives: string[];
		/** Compatibility-only presentation field; TaskInput v2 no longer models formal requirements. */
		requirements: Array<{ id: string; text: string }>;
		materials: Array<{ id: string; description: string; reference: string }>;
		unresolvedFacts: Array<{ id: string; description: string }>;
	};
	selection: {
		status: "pending" | "selected" | "blocked";
		processSpec?: {
			id: string;
			version: string;
			name: string;
			description: string;
			applicableWhen: string[];
			notApplicableWhen: string[];
			requiredActivityCount: number;
			requiredDeliverableCount: number;
			requiredReviewCount: number;
		};
		rationale?: string;
		/** Compatibility-only presentation field; ProcessSelection v2 no longer carries task requirement refs. */
		taskRequirementRefs: string[];
		processRequirementRefs: string[];
		unresolvedFactRefs: string[];
	};
	workflow: {
		source: DashboardWorkflowSource;
		name?: string;
		id?: string;
		version?: string;
		draftRevision?: number;
		criteriaCount: number;
		coverageCount: number;
		completionDefined: boolean;
		nodes: DashboardNode[];
		edges: DashboardEdge[];
	};
	events: RunEvent[];
}

export async function readWorkflowDraft(projectRoot: string, runId: string): Promise<WorkflowDraftState | undefined> {
	try {
		return JSON.parse(
			await readFile(join(projectRoot, ".pi", "ipd", "runs", runId, "workflow-draft.json"), "utf8"),
		) as WorkflowDraftState;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function buildDashboardSnapshot(
	state: RunState,
	processSpecs: readonly ProcessSpec[],
	draft?: WorkflowDraftState,
): DashboardSnapshot {
	const workflow = state.baseline?.workflow ?? state.workflowCandidate;
	const source: DashboardWorkflowSource = state.baseline
		? "compiled"
		: state.workflowCandidate
			? "candidate"
			: draft && (draft.header || draft.nodes.length > 0 || draft.criteria.length > 0)
				? "draft"
				: "none";
	const workflowNodes = workflow?.nodes ?? draft?.nodes ?? [];
	const workflowCriteria = workflow?.criteria ?? draft?.criteria ?? [];
	const runtimeNodes = new Map(state.nodes.map((node) => [node.nodeId, node]));
	const effectiveNodes = new Map(state.baseline?.nodes.map((node) => [node.definition.node_id, node]) ?? []);
	const nodes = workflowNodes.map((node): DashboardNode => {
		const runtime = runtimeNodes.get(node.node_id);
		const effective = effectiveNodes.get(node.node_id);
		return {
			id: node.node_id,
			name: node.name,
			kind: node.kind,
			status: runtime?.status ?? "planned",
			agent: effective?.agents[0]?.agentCard.name ?? node.agents[0]?.agent_ref.id ?? "Unassigned",
			objective: node.contract.objective,
			responsibilities: [...node.contract.responsibilities],
			inputs: node.inputs.map(inputLabel),
			outputs: node.kind === "execution" ? node.outputs.map((output) => output.output_id) : node.targets.map(targetLabel),
			...(runtime?.activeRoundId ? { activeRoundId: runtime.activeRoundId } : {}),
			roundCount: state.rounds.filter((round) => round.nodeId === node.node_id).length,
		};
	});
	return {
		schemaVersion: 1,
		generatedAt: Date.now(),
		run: {
			id: state.runId,
			phase: state.phase,
			status: state.status,
			revision: state.revision,
			...(state.failure ? { failure: structuredClone(state.failure) } : {}),
		},
		...(state.taskInput
			? {
					task: {
						text: state.taskInput.raw_task.text,
						objectives: [],
						requirements: [],
						materials: state.taskInput.materials.map((item) => ({
							id: item.material_id,
							description: item.description,
							reference: item.reference,
						})),
						unresolvedFacts: state.taskInput.unresolved_facts.map((item) => ({
							id: item.fact_id,
							description: item.description,
						})),
					},
				}
			: {}),
		selection: selectionView(state, processSpecs),
		workflow: {
			source,
			name: workflow?.name ?? draft?.header?.name,
			id: workflow?.workflow_id ?? draft?.header?.workflow_id,
			version: workflow?.workflow_version ?? draft?.header?.workflow_version,
			...(draft ? { draftRevision: draft.revision } : {}),
			criteriaCount: workflowCriteria.length,
			coverageCount: workflow?.requirement_coverage.length ?? draft?.requirementCoverage.length ?? 0,
			completionDefined: Boolean(workflow?.completion ?? draft?.completion),
			nodes,
			edges: workflowEdges(workflowNodes),
		},
		events: state.events.slice(-80).map((event) => structuredClone(event)),
	};
}

function selectionView(state: RunState, processSpecs: readonly ProcessSpec[]): DashboardSnapshot["selection"] {
	const selection = state.processSelection;
	if (!selection) {
		return {
			status: state.status === "blocked" && state.phase === "selection" ? "blocked" : "pending",
			taskRequirementRefs: [],
			processRequirementRefs: [],
			unresolvedFactRefs: [],
		};
	}
	const spec =
		state.selectedProcessSpec ??
		processSpecs.find(
			(item) => item.process_spec_id === selection.process_spec_ref.id && item.version === selection.process_spec_ref.version,
		);
	return {
		status: "selected",
		...(spec
			? {
					processSpec: {
						id: spec.process_spec_id,
						version: spec.version,
						name: spec.name,
						description: spec.description,
						applicableWhen: [...spec.applicable_when],
						notApplicableWhen: [...spec.not_applicable_when],
						requiredActivityCount: spec.required_activities.length,
						requiredDeliverableCount: spec.required_deliverables.length,
						requiredReviewCount: spec.required_reviews.length,
					},
				}
			: {}),
		rationale: selection.rationale,
		taskRequirementRefs: [],
		processRequirementRefs: [...selection.process_requirement_refs],
		unresolvedFactRefs: [...selection.unresolved_fact_refs],
	};
}

function workflowEdges(nodes: readonly WorkflowNode[]): DashboardEdge[] {
	const edges = new Map<string, DashboardEdge>();
	for (const node of nodes) {
		for (const input of node.inputs) {
			if (input.kind !== "node_output") continue;
			const key = `dependency:${input.source.node_id}:${node.node_id}`;
			if (!edges.has(key)) {
				edges.set(key, {
					from: input.source.node_id,
					to: node.node_id,
					kind: "dependency",
					label: input.availability,
				});
			}
		}
		if (node.kind === "review") {
			for (const target of node.allowed_rework_node_ids) {
				const key = `rework:${node.node_id}:${target}`;
				edges.set(key, { from: node.node_id, to: target, kind: "rework", label: "rework" });
			}
	}
	return [...edges.values()];
}

function inputLabel(input: WorkflowNode["inputs"][number]): string {
	if (input.kind === "task_material") return `material:${input.material_id}`;
	return `${input.source.node_id}.${input.source.output_id} (${input.availability})`;
}

function targetLabel(target: Extract<WorkflowNode, { kind: "review" }>["targets"][number]): string {
	return `${target.node_id}.${target.output_id}`;
}
