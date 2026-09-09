// 提供测试和最小启动场景使用的固定选规与设计角色。
import type { VersionedAssetRef } from "../contracts/primitives.ts";
import type { ProcessSelection, ProcessSpec } from "../contracts/process-spec.ts";
import type { TaskInput } from "../contracts/task-input.ts";
import type { WorkflowDefinition } from "../contracts/workflow.ts";
import { hashJson } from "../ir/hash.ts";
import type { ProcessSelector, WorkflowDesigner } from "./control-plane.ts";

export class BootstrapProcessSelector implements ProcessSelector {
	async select(runId: string, task: TaskInput, specs: readonly ProcessSpec[]): Promise<ProcessSelection> {
		const spec = specs[0];
		if (!spec) throw new Error("No ProcessSpec is registered");
		return {
			schema_version: 1,
			process_selection_id: `${runId}:selection`,
			run_id: runId,
			task_input_ref: { id: task.task_input_id, hash: hashJson(task) },
			process_spec_ref: { id: spec.process_spec_id, version: spec.version, hash: hashJson(spec) },
			rationale: "Bootstrap selector chose the registered minimal reviewed-delivery specification.",
			task_requirement_refs: task.requirements.map((item) => item.requirement_id),
			process_requirement_refs: [
				...spec.required_activities.map((item) => item.activity_id),
				...spec.required_deliverables.map((item) => item.deliverable_id),
				...spec.required_reviews.map((item) => item.review_id),
				...spec.workflow_rules.map((item) => item.rule_id),
			],
			unresolved_fact_refs: task.unresolved_facts.map((item) => item.fact_id),
		};
	}
}

export class BootstrapWorkflowDesigner implements WorkflowDesigner {
	private readonly producer: VersionedAssetRef;
	private readonly reviewer: VersionedAssetRef;

	constructor(producer: VersionedAssetRef, reviewer: VersionedAssetRef) {
		this.producer = producer;
		this.reviewer = reviewer;
	}

	async design(
		_runId: string,
		task: TaskInput,
		selection: ProcessSelection,
		spec: ProcessSpec,
	): Promise<WorkflowDefinition> {
		const activity = spec.required_activities[0];
		const deliverable = spec.required_deliverables[0];
		const review = spec.required_reviews[0];
		if (!activity || !deliverable || !review) throw new Error("Bootstrap ProcessSpec is incomplete");
		const output = { node_id: "produce", output_id: "result" };
		return {
			schema_version: 2,
			workflow_id: `task-${hashJson(task).slice(0, 12)}`,
			workflow_version: "1.0.0",
			name: "Bootstrap reviewed delivery",
			task_input_ref: { id: task.task_input_id, hash: hashJson(task) },
			process_selection_ref: { id: selection.process_selection_id, hash: hashJson(selection) },
			nodes: [
				this.executionNode(task, activity.required_capabilities, deliverable),
				this.reviewNode(review.reviewer_capabilities),
			],
			criteria: [
				{
					kind: "mechanical",
					criterion_id: "integrity",
					description: "Submitted files match their manifest",
					check_id: "artifact-integrity",
					parameters: {},
					evidence_requirements: [],
				},
				{
					kind: "semantic",
					criterion_id: "quality",
					description: review.criteria.map((criterion) => criterion.description).join("\n"),
					evidence_requirements: ["Specific review findings"],
					process_criterion_refs: review.criteria.map((criterion) => criterion.process_criterion_id),
				},
			],
			requirement_coverage: [
				...task.requirements.map((item) => ({
					source: "task_requirement" as const,
					requirement_id: item.requirement_id,
					responsible_node_ids: ["produce", "review"],
					output_refs: [output],
					criterion_refs: ["quality"],
				})),
				{
					source: "process_activity",
					requirement_id: activity.activity_id,
					responsible_node_ids: ["produce"],
					output_refs: [output],
					criterion_refs: [],
				},
				{
					source: "process_deliverable",
					requirement_id: deliverable.deliverable_id,
					responsible_node_ids: ["produce"],
					output_refs: [output],
					criterion_refs: ["integrity", "quality"],
				},
				{
					source: "process_review",
					requirement_id: review.review_id,
					responsible_node_ids: ["review"],
					output_refs: [output],
					criterion_refs: ["quality"],
				},
			],
			completion: {
				required_node_ids: ["produce", "review"],
				final_outputs: [output],
				delivery_outputs: [output],
				required_review_node_ids: ["review"],
			},
		};
	}

	private executionNode(
		task: TaskInput,
		capabilities: string[],
		deliverable: ProcessSpec["required_deliverables"][number],
	): WorkflowDefinition["nodes"][number] {
		return {
			kind: "execution",
			node_id: "produce",
			name: "Produce deliverable",
			agents: [
				{
					participant_id: "producer",
					agent_ref: this.producer,
					required_capabilities: capabilities,
					skills: [],
					tools: [],
					knowledge_bases: [],
					permissions: { read_paths: ["."], write_paths: ["outputs/produce"], external_actions: false },
				},
			],
			contract: {
				objective: task.raw_task.text,
				responsibilities: ["Produce the requested deliverable"],
				non_responsibilities: ["Approve the deliverable"],
				work_requirements: task.requirements.map((item) => item.statement.text).concat("Submit a complete result"),
				constraints: [],
			},
			inputs: task.materials.map((item) => ({
				kind: "task_material" as const,
				input_id: item.material_id,
				material_id: item.material_id,
				required: true,
			})),
			outputs: [
				{
					output_id: "result",
					artifact_type: deliverable.artifact_type ?? "deliverable",
					description: "Requested deliverable",
					business_purpose: task.raw_task.text,
					path_prefix: "outputs/produce",
					evidence_requirements: deliverable.evidence_requirements.map((item) => item.description),
					process_evidence_requirement_refs: deliverable.evidence_requirements.map(
						(item) => item.evidence_requirement_id,
					),
					criterion_refs: ["integrity", "quality"],
				},
			],
		};
	}

	private reviewNode(capabilities: string[]): WorkflowDefinition["nodes"][number] {
		return {
			kind: "review",
			node_id: "review",
			name: "Review deliverable",
			agents: [
				{
					participant_id: "reviewer",
					agent_ref: this.reviewer,
					required_capabilities: capabilities,
					skills: [],
					tools: [],
					knowledge_bases: [],
					permissions: { read_paths: ["outputs/produce"], write_paths: [], external_actions: false },
				},
			],
			contract: {
				objective: "Independently review the sealed deliverable",
				responsibilities: ["Evaluate every assigned criterion"],
				non_responsibilities: ["Modify the deliverable"],
				work_requirements: ["Cite evidence"],
				constraints: ["Do not add criteria"],
			},
			inputs: [
				{
					kind: "node_output",
					input_id: "candidate",
					source: { node_id: "produce", output_id: "result" },
					required: true,
					availability: "submitted",
					approval_review_node_ids: [],
				},
			],
			targets: [{ node_id: "produce", output_id: "result", criterion_refs: ["quality"] }],
			allowed_rework_node_ids: ["produce"],
		};
	}
}
