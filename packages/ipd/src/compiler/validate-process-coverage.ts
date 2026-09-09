import type { CompiledAgentCard } from "../contracts/agent-card.ts";
import type { CompilerDiagnostic } from "../contracts/baseline.ts";
import type { ProcessSpec } from "../contracts/process-spec.ts";
import type { TaskInput } from "../contracts/task-input.ts";
import type { NodeOutputRef, ReviewNode, WorkflowDefinition, WorkflowNode } from "../contracts/workflow.ts";
import { addDiagnostic, outputKey } from "./diagnostics.ts";

const coverageKey = (source: string, requirementId: string) => `${source}:${requirementId}`;

export function validateCoverageReferences(
	workflow: WorkflowDefinition,
	task: TaskInput,
	spec: ProcessSpec,
	nodes: ReadonlyMap<string, WorkflowNode>,
	outputs: ReadonlySet<string>,
	criteria: ReadonlySet<string>,
	diagnostics: CompilerDiagnostic[],
): void {
	const expected = new Set<string>();
	for (const item of task.requirements) expected.add(coverageKey("task_requirement", item.requirement_id));
	for (const item of spec.required_activities) expected.add(coverageKey("process_activity", item.activity_id));
	for (const item of spec.required_deliverables) expected.add(coverageKey("process_deliverable", item.deliverable_id));
	for (const item of spec.required_reviews) expected.add(coverageKey("process_review", item.review_id));
	for (const item of spec.workflow_rules) expected.add(coverageKey("process_rule", item.rule_id));
	const covered = new Set<string>();
	for (const [index, item] of workflow.requirement_coverage.entries()) {
		const key = coverageKey(item.source, item.requirement_id);
		if (!expected.has(key))
			addDiagnostic(
				diagnostics,
				"coverage_source_unknown",
				`/requirement_coverage/${index}`,
				`Unknown requirement ${key}`,
			);
		covered.add(key);
		for (const nodeId of item.responsible_node_ids) {
			if (!nodes.has(nodeId))
				addDiagnostic(
					diagnostics,
					"node_unknown",
					`/requirement_coverage/${index}/responsible_node_ids`,
					`Unknown node ${nodeId}`,
				);
		}
		for (const ref of item.output_refs) {
			if (!outputs.has(outputKey(ref)))
				addDiagnostic(
					diagnostics,
					"output_unknown",
					`/requirement_coverage/${index}/output_refs`,
					`Unknown output ${outputKey(ref)}`,
				);
		}
		for (const criterionId of item.criterion_refs) {
			if (!criteria.has(criterionId))
				addDiagnostic(
					diagnostics,
					"criterion_unknown",
					`/requirement_coverage/${index}/criterion_refs`,
					`Unknown criterion ${criterionId}`,
				);
		}
	}
	for (const key of expected) {
		if (!covered.has(key))
			addDiagnostic(
				diagnostics,
				"requirement_uncovered",
				"/requirement_coverage",
				`Required coverage is missing for ${key}`,
			);
	}
}

function error(
	diagnostics: CompilerDiagnostic[],
	code: string,
	path: string,
	message: string,
	processRequirementId: string,
): void {
	diagnostics.push({ code, severity: "error", path, message, processRequirementId });
}

export function validateProcessCoverage(
	workflow: WorkflowDefinition,
	spec: ProcessSpec,
	agentByNode: ReadonlyMap<string, CompiledAgentCard>,
	diagnostics: CompilerDiagnostic[],
): void {
	const coverage = new Map(
		workflow.requirement_coverage.map((item) => [coverageKey(item.source, item.requirement_id), item]),
	);
	const executionNodes = new Map(
		workflow.nodes.filter((node) => node.kind === "execution").map((node) => [node.node_id, node]),
	);
	const reviewNodes = new Map(
		workflow.nodes.filter((node): node is ReviewNode => node.kind === "review").map((node) => [node.node_id, node]),
	);

	for (const activity of spec.required_activities) {
		const item = coverage.get(coverageKey("process_activity", activity.activity_id));
		if (!item) continue;
		const satisfies = item.responsible_node_ids.some((nodeId) => {
			const card = agentByNode.get(nodeId);
			return (
				executionNodes.has(nodeId) &&
				activity.required_capabilities.every((value) => card?.capabilities.includes(value))
			);
		});
		if (!satisfies) {
			error(
				diagnostics,
				"process_activity_unsatisfied",
				"/requirement_coverage",
				`Activity ${activity.activity_id} lacks an execution node with capabilities: ${activity.required_capabilities.join(", ")}`,
				activity.activity_id,
			);
		}
	}

	const deliverableOutputs = new Map<string, NodeOutputRef[]>();
	for (const deliverable of spec.required_deliverables) {
		const item = coverage.get(coverageKey("process_deliverable", deliverable.deliverable_id));
		if (!item) continue;
		const matching = item.output_refs.filter((ref) => {
			const node = executionNodes.get(ref.node_id);
			return node?.outputs.some(
				(output) =>
					output.output_id === ref.output_id &&
					(deliverable.artifact_type === undefined || output.artifact_type === deliverable.artifact_type),
			);
		});
		deliverableOutputs.set(deliverable.deliverable_id, matching);
		if (matching.length === 0) {
			error(
				diagnostics,
				"process_deliverable_unsatisfied",
				"/requirement_coverage",
				`Deliverable ${deliverable.deliverable_id} lacks a matching output${deliverable.artifact_type ? ` of type ${deliverable.artifact_type}` : ""}`,
				deliverable.deliverable_id,
			);
		}
	}

	for (const requiredReview of spec.required_reviews) {
		const item = coverage.get(coverageKey("process_review", requiredReview.review_id));
		if (!item) continue;
		const expectedTargets = new Set((deliverableOutputs.get(requiredReview.deliverable_id) ?? []).map(outputKey));
		const satisfyingReviews = item.responsible_node_ids.filter((nodeId) => {
			const review = reviewNodes.get(nodeId);
			const card = agentByNode.get(nodeId);
			return (
				review !== undefined &&
				requiredReview.reviewer_capabilities.every((value) => card?.capabilities.includes(value)) &&
				review.targets.some((target) => expectedTargets.has(outputKey(target)))
			);
		});
		if (satisfyingReviews.length === 0) {
			error(
				diagnostics,
				"process_review_unsatisfied",
				"/requirement_coverage",
				`Review ${requiredReview.review_id} lacks a capable review node for ${requiredReview.deliverable_id}`,
				requiredReview.review_id,
			);
			continue;
		}
		if (!requiredReview.independent_agent) continue;
		for (const reviewId of satisfyingReviews) {
			const review = reviewNodes.get(reviewId);
			const reviewer = agentByNode.get(reviewId);
			for (const target of review?.targets ?? []) {
				if (!expectedTargets.has(outputKey(target))) continue;
				const producer = agentByNode.get(target.node_id);
				if (producer && reviewer && producer.id === reviewer.id && producer.version === reviewer.version) {
					error(
						diagnostics,
						"reviewer_not_independent",
						"/nodes",
						`Review ${reviewId} uses the same AgentCard as producer ${target.node_id}`,
						requiredReview.review_id,
					);
				}
			}
		}
	}

	for (const rule of spec.workflow_rules) {
		if (rule.enforced_by !== "review") {
			error(
				diagnostics,
				"process_rule_unsupported",
				"/workflow_rules",
				`${rule.enforced_by} rule ${rule.rule_id} has no registered deterministic implementation`,
				rule.rule_id,
			);
		}
	}
}
