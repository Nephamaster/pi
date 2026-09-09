import type { EffectiveNode, ExecutionBaseline } from "../contracts/baseline.ts";
import type {
	ApprovalRecord,
	RoundInputBindingRecord,
	RoundRecord,
	RunState,
	SubmissionRecord,
} from "../contracts/runtime.ts";
import type { NodeInput, NodeOutputRef } from "../contracts/workflow.ts";
import type { NodeTaskContext } from "./node-worker.ts";

type NodeOutputInput = Extract<NodeInput, { kind: "node_output" }>;
const graphOutputKey = (nodeId: string, outputId: string) => `${nodeId}/${outputId}`;

export interface ResolvedInputBinding extends RoundInputBindingRecord {
	submission: SubmissionRecord;
}

export interface InvalidatedRound {
	nodeId: string;
	roundId: string;
}

export function requireBaseline(state: RunState): ExecutionBaseline {
	if (!state.baseline) throw new Error(`Run ${state.runId} has no Baseline`);
	return state.baseline;
}

function submissionHasOutput(submission: SubmissionRecord, outputId: string): boolean {
	return submission.outputs.some((output) => output.outputId === outputId);
}

function findLatestSubmission(
	state: RunState,
	predicate: (submission: SubmissionRecord) => boolean,
): SubmissionRecord | undefined {
	for (let index = state.submissions.length - 1; index >= 0; index--) {
		const submission = state.submissions[index];
		if (submission && predicate(submission)) return submission;
	}
	return undefined;
}

function hasApproval(state: RunState, reviewNodeId: string, submissionId: string, outputId: string): boolean {
	return state.approvals.some(
		(approval) =>
			approval.status === "active" &&
			approval.reviewNodeId === reviewNodeId &&
			approval.submissionId === submissionId &&
			approval.outputId === outputId,
	);
}

function submissionSatisfiesInput(input: NodeOutputInput, submission: SubmissionRecord, state: RunState): boolean {
	if (
		submission.nodeId !== input.source.node_id ||
		!["candidate", "approved"].includes(submission.status) ||
		!submissionHasOutput(submission, input.source.output_id)
	)
		return false;
	return (
		input.availability === "submitted" ||
		input.approval_review_node_ids.every((reviewId) =>
			hasApproval(state, reviewId, submission.submissionId, input.source.output_id),
		)
	);
}

function resolveNodeOutputInput(input: NodeOutputInput, state: RunState): ResolvedInputBinding | undefined {
	const submission = findLatestSubmission(state, (candidate) => submissionSatisfiesInput(input, candidate, state));
	return submission
		? {
				inputId: input.input_id,
				submissionId: submission.submissionId,
				outputId: input.source.output_id,
				approvalReviewNodeIds: [...input.approval_review_node_ids],
				submission,
			}
		: undefined;
}

export function resolveInputBindings(node: EffectiveNode, state: RunState): ResolvedInputBinding[] {
	return node.definition.inputs.flatMap((input) => {
		if (input.kind === "task_material") return [];
		const resolved = resolveNodeOutputInput(input, state);
		return resolved ? [resolved] : [];
	});
}

export function projectInputSubmissions(bindings: readonly ResolvedInputBinding[]): SubmissionRecord[] {
	const grouped = new Map<string, { submission: SubmissionRecord; outputIds: Set<string> }>();
	for (const binding of bindings) {
		const existing = grouped.get(binding.submissionId) ?? {
			submission: binding.submission,
			outputIds: new Set<string>(),
		};
		existing.outputIds.add(binding.outputId);
		grouped.set(binding.submissionId, existing);
	}
	return [...grouped.values()].map(({ submission, outputIds }) => ({
		...structuredClone(submission),
		outputs: submission.outputs
			.filter((output) => outputIds.has(output.outputId))
			.map((output) => structuredClone(output)),
	}));
}

function requiredInputsResolved(
	node: EffectiveNode,
	bindings: readonly ResolvedInputBinding[],
	state: RunState,
): boolean {
	const resolved = new Set(bindings.map((binding) => binding.inputId));
	return node.definition.inputs.every((input) => {
		if (!input.required) return true;
		if (input.kind === "node_output") return resolved.has(input.input_id);
		return state.taskInput?.materials.some((material) => material.material_id === input.material_id) === true;
	});
}

export function taskContextForNode(node: EffectiveNode, state: RunState): NodeTaskContext {
	const task = state.taskInput;
	if (!task) return { objectives: [], requirements: [], materials: [], unresolvedFacts: [] };
	const responsibleRequirements = new Set(
		requireBaseline(state)
			.workflow.requirement_coverage.filter((coverage) =>
				coverage.responsible_node_ids.includes(node.definition.node_id),
			)
			.filter((coverage) => coverage.source === "task_requirement")
			.map((coverage) => coverage.requirement_id),
	);
	const materialIds = new Set(
		node.definition.inputs.flatMap((input) => (input.kind === "task_material" ? [input.material_id] : [])),
	);
	return {
		rawTask: task.raw_task,
		objectives: structuredClone(task.objectives),
		requirements: task.requirements
			.filter((requirement) => responsibleRequirements.has(requirement.requirement_id))
			.map((requirement) => structuredClone(requirement)),
		materials: task.materials
			.filter((material) => materialIds.has(material.material_id))
			.map((material) => structuredClone(material)),
		unresolvedFacts: structuredClone(task.unresolved_facts),
	};
}

export function nodeIsReady(node: EffectiveNode, state: RunState): boolean {
	const status = state.nodes.find((item) => item.nodeId === node.definition.node_id)?.status;
	if (!status || !["waiting", "waiting_rework"].includes(status)) return false;
	const bindings = resolveInputBindings(node, state);
	if (!requiredInputsResolved(node, bindings, state)) return false;
	if (node.definition.kind === "execution") return true;
	return node.definition.targets.every((target) =>
		bindings.some((binding) => binding.submission.nodeId === target.node_id && binding.outputId === target.output_id),
	);
}

export function readyNodes(state: RunState): EffectiveNode[] {
	return requireBaseline(state).nodes.filter((node) => nodeIsReady(node, state));
}

export function roundInputsAreValid(node: EffectiveNode, round: RoundRecord, state: RunState): boolean {
	const bindings = new Map(round.inputBindings.map((binding) => [binding.inputId, binding]));
	for (const input of node.definition.inputs) {
		if (input.kind === "task_material") continue;
		const binding = bindings.get(input.input_id);
		if (!binding) {
			if (input.required) return false;
			continue;
		}
		const submission = state.submissions.find((item) => item.submissionId === binding.submissionId);
		if (
			!submission ||
			binding.outputId !== input.source.output_id ||
			!submissionSatisfiesInput(input, submission, state)
		)
			return false;
	}
	return true;
}

export function reworkFeedback(node: EffectiveNode, state: RunState): string[] {
	let latestReviewFeedback: string[] = [];
	for (let index = state.reviews.length - 1; index >= 0; index--) {
		const review = state.reviews[index];
		if (review?.decision === "REWORK" && review.reworkNodeIds.includes(node.definition.node_id)) {
			latestReviewFeedback = review.criteria.flatMap((item) => item.requiredRework);
			break;
		}
	}
	let latestMechanicalRound: string | undefined;
	for (let index = state.mechanicalChecks.length - 1; index >= 0; index--) {
		const check = state.mechanicalChecks[index];
		if (check?.nodeId === node.definition.node_id && check.result === "FAIL") {
			latestMechanicalRound = check.roundId;
			break;
		}
	}
	const mechanicalFeedback = latestMechanicalRound
		? state.mechanicalChecks
				.filter((check) => check.roundId === latestMechanicalRound)
				.flatMap((check) => check.feedback)
		: [];
	return [...latestReviewFeedback, ...mechanicalFeedback];
}

export function invalidateFromNode(state: RunState, nodeId: string, excludeRoundId?: string): InvalidatedRound[] {
	const root = state.submissions
		.filter((item) => item.nodeId === nodeId && ["candidate", "approved"].includes(item.status))
		.at(-1);
	const affected = new Set<string>();
	if (root) {
		root.status = "rejected";
		affected.add(root.submissionId);
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const submission of state.submissions) {
			if (submission.status === "stale" || !submission.inputSubmissionIds.some((id) => affected.has(id))) continue;
			submission.status = "stale";
			affected.add(submission.submissionId);
			const consumer = state.nodes.find((item) => item.nodeId === submission.nodeId);
			if (consumer) consumer.status = "waiting_rework";
			changed = true;
		}
	}
	for (const approval of state.approvals) {
		if (affected.has(approval.submissionId)) approval.status = "stale";
	}
	for (const review of state.reviews) {
		if (!review.submissionIds.some((id) => affected.has(id))) continue;
		review.status = "stale";
		const reviewer = state.nodes.find((item) => item.nodeId === review.reviewNodeId);
		if (reviewer) reviewer.status = "waiting";
	}
	const invalidated: InvalidatedRound[] = [];
	for (const round of state.rounds) {
		if (
			round.status !== "active" ||
			round.roundId === excludeRoundId ||
			!round.inputSubmissionIds.some((id) => affected.has(id))
		)
			continue;
		round.status = "invalidated";
		round.finishedAt = Date.now();
		const consumer = state.nodes.find((item) => item.nodeId === round.nodeId);
		if (consumer?.activeRoundId === round.roundId) {
			consumer.activeRoundId = undefined;
			consumer.status = consumer.kind === "execution" ? "waiting_rework" : "waiting";
		}
		invalidated.push({ nodeId: round.nodeId, roundId: round.roundId });
	}
	const target = state.nodes.find((item) => item.nodeId === nodeId);
	if (target) target.status = "waiting_rework";
	return invalidated;
}

export function addApprovals(
	state: RunState,
	reviewId: string,
	reviewNodeId: string,
	targets: ReadonlyArray<{ submissionId: string; outputId: string; criterionIds: string[] }>,
): void {
	for (const target of targets) {
		const approval: ApprovalRecord = {
			approvalId: `${reviewId}:${target.submissionId}:${target.outputId}`,
			reviewId,
			reviewNodeId,
			submissionId: target.submissionId,
			outputId: target.outputId,
			criterionIds: [...target.criterionIds],
			status: "active",
			createdAt: Date.now(),
		};
		state.approvals.push(approval);
	}
}

export function refreshSubmissionStatus(state: RunState, submissionId: string): void {
	const submission = state.submissions.find((item) => item.submissionId === submissionId);
	if (!submission || ["rejected", "stale"].includes(submission.status)) return;
	const baseline = requireBaseline(state);
	const fullyApproved = submission.outputs.every((output) => {
		const reviewers = baseline.graph.reviewsByOutput[graphOutputKey(submission.nodeId, output.outputId)] ?? [];
		return (
			reviewers.length > 0 &&
			reviewers.every((reviewer) => hasApproval(state, reviewer, submission.submissionId, output.outputId))
		);
	});
	submission.status = fullyApproved ? "approved" : "candidate";
	const producer = state.nodes.find((item) => item.nodeId === submission.nodeId);
	if (producer) producer.status = fullyApproved ? "succeeded" : "waiting_review";
}

export function approvedSubmissionForOutput(
	state: RunState,
	ref: NodeOutputRef,
	requiredReviewNodeIds: readonly string[],
): SubmissionRecord | undefined {
	const reviewers = requiredReviewNodeIds.filter((id) =>
		(requireBaseline(state).graph.reviewsByOutput[graphOutputKey(ref.node_id, ref.output_id)] ?? []).includes(id),
	);
	return findLatestSubmission(
		state,
		(submission) =>
			submission.nodeId === ref.node_id &&
			["candidate", "approved"].includes(submission.status) &&
			submissionHasOutput(submission, ref.output_id) &&
			reviewers.length > 0 &&
			reviewers.every((reviewer) => hasApproval(state, reviewer, submission.submissionId, ref.output_id)),
	);
}

export function finalApprovedSubmissionIds(state: RunState): string[] {
	const completion = requireBaseline(state).workflow.completion;
	return [
		...new Set(
			(completion.delivery_outputs ?? completion.final_outputs).flatMap((ref) => {
				const submission = approvedSubmissionForOutput(state, ref, completion.required_review_node_ids);
				return submission ? [submission.submissionId] : [];
			}),
		),
	];
}

export function runIsComplete(state: RunState): boolean {
	const completion = requireBaseline(state).workflow.completion;
	return (
		completion.required_node_ids.every(
			(id) => state.nodes.find((item) => item.nodeId === id)?.status === "succeeded",
		) &&
		completion.final_outputs.every(
			(ref) => approvedSubmissionForOutput(state, ref, completion.required_review_node_ids) !== undefined,
		) &&
		!state.rounds.some((round) => round.status === "active")
	);
}
