// 计算节点就绪、完整批准、返工失效和 Run 完成状态。

import { baselineIndex } from "../compiler/baseline-index.ts";
import type { EffectiveNode, ExecutionBaseline } from "../contracts/baseline.ts";
import type {
	ApprovalRecord,
	RoundInputBindingRecord,
	RoundRecord,
	RunState,
	SubmissionRecord,
} from "../contracts/runtime.ts";
import type { NodeInput, NodeOutputRef } from "../contracts/workflow.ts";
import {
	adoptionUsable,
	artifactRef,
	outputUsable,
	releaseIsCurrent,
	versionRelationsSatisfied,
} from "./artifact-governance.ts";
import { cancelNodeWaits, interruptActiveExecution } from "./execution-control.ts";
import type { NodeTaskContext, RoundFeedback } from "./node-worker.ts";
import { findingFeedback } from "./quality-findings.ts";

type NodeOutputInput = Extract<NodeInput, { kind: "node_output" }>;
const graphOutputKey = (nodeId: string, outputId: string) => `${nodeId}/${outputId}`;

export interface ResolvedInputBinding extends RoundInputBindingRecord {
	submission: SubmissionRecord;
}

export type InvalidatedRound = {
	nodeId: string;
	roundId: string;
};

export function markRunCancelled(state: RunState): void {
	state.status = "cancelled";
	state.phase = "closed";
	if (state.controller?.status === "active") {
		state.controller.status = "released";
		state.controller.releasedAt = Date.now();
	}
	for (const round of state.rounds) {
		if (round.status !== "active" && round.status !== "paused") continue;
		round.status = "cancelled";
		round.finishedAt = Date.now();
	}
	for (const node of state.nodes) {
		if (node.status === "succeeded") continue;
		interruptActiveExecution(state, node.nodeId, "cancelled", "cancelled");
		cancelNodeWaits(state, node.nodeId);
		node.status = "cancelled";
		delete node.activeRoundId;
		delete node.resumeRoundId;
	}
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

function outputIsFullyApproved(
	state: RunState,
	nodeId: string,
	submissionId: string,
	outputId: string,
	reviewNodeIds: readonly string[],
): boolean {
	if (reviewNodeIds.length === 0) return false;
	if (
		state.governance.findings.some(
			(finding) =>
				finding.blocking &&
				reviewNodeIds.includes(finding.reviewNodeId) &&
				["open", "addressed"].includes(finding.status) &&
				finding.owner.node_id === nodeId &&
				finding.owner.output_id === outputId,
		)
	)
		return false;
	const approvals = reviewNodeIds.map((reviewNodeId) =>
		state.approvals.find(
			(approval) =>
				approval.status === "active" &&
				approval.reviewNodeId === reviewNodeId &&
				approval.submissionId === submissionId &&
				approval.outputId === outputId &&
				state.governance.releases.some(
					(release) =>
						release.decisionId === `${approval.reviewId}:decision` && releaseIsCurrent(state, release.releaseId),
				) &&
				state.reviews.some(
					(review) =>
						review.status === "active" &&
						review.reviewId === approval.reviewId &&
						review.reviewNodeId === approval.reviewNodeId &&
						review.submissionIds.includes(submissionId),
				),
		),
	);
	if (approvals.some((approval) => approval === undefined)) return false;
	const baseline = requireBaseline(state);
	const index = baselineIndex(baseline);
	const output = index.outputs.get(graphOutputKey(nodeId, outputId));
	if (!output) return false;
	const semanticCriteria = output.criterion_refs.filter(
		(criterionId) =>
			index.criteria.get(criterionId)?.kind === "semantic" && index.criteria.get(criterionId)?.blocking !== false,
	);
	const approvedCriteria = new Set(approvals.flatMap((approval) => approval?.criterionIds ?? []));
	return semanticCriteria.every((criterionId) => approvedCriteria.has(criterionId));
}

function submissionSatisfiesInput(input: NodeOutputInput, submission: SubmissionRecord, state: RunState): boolean {
	if (
		submission.nodeId !== input.source.node_id ||
		!adoptionUsable(state, submission.submissionId) ||
		!outputUsable(state, submission, input.source.output_id) ||
		!submissionHasOutput(submission, input.source.output_id)
	)
		return false;
	return (
		input.availability === "submitted" ||
		outputIsFullyApproved(
			state,
			input.source.node_id,
			submission.submissionId,
			input.source.output_id,
			input.approval_review_node_ids,
		)
	);
}

function resolveNodeOutputInput(input: NodeOutputInput, state: RunState): ResolvedInputBinding | undefined {
	const latest = findLatestSubmission(
		state,
		(candidate) =>
			candidate.nodeId === input.source.node_id && submissionHasOutput(candidate, input.source.output_id),
	);
	const submission = latest && submissionSatisfiesInput(input, latest, state) ? latest : undefined;
	if (!submission) return undefined;
	const revisionId = artifactRef(
		submission,
		submission.outputs.find((output) => output.outputId === input.source.output_id)!,
	).revisionId;
	return {
		inputId: input.input_id,
		submissionId: submission.submissionId,
		outputId: input.source.output_id,
		approvalReviewNodeIds: [...input.approval_review_node_ids],
		revisionId,
		purpose: input.purpose ?? "content_basis",
		releaseIds: state.governance.releases
			.filter(
				(release) =>
					releaseIsCurrent(state, release.releaseId) &&
					input.approval_review_node_ids.includes(release.reviewNodeId) &&
					release.subjectRevisionIds.includes(revisionId),
			)
			.map((release) => release.releaseId),
		submission,
	};
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
		evidence: Array.isArray(submission.evidence)
			? submission.evidence.filter(
					(item) =>
						item !== null &&
						typeof item === "object" &&
						!Array.isArray(item) &&
						(typeof item.output_id === "string"
							? outputIds.has(item.output_id)
							: submission.outputs.length === 1),
				)
			: [],
		resolutionClaims: submission.resolutionClaims?.filter((claim) => outputIds.has(claim.outputId)),
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
	if (!task) return { materials: [], unresolvedFacts: [] };
	const materialIds = new Set(
		node.definition.inputs.flatMap((input) => (input.kind === "task_material" ? [input.material_id] : [])),
	);
	return {
		rawTask: task.raw_task,
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
	if (!requiredInputsResolved(node, bindings, state) || !versionRelationsSatisfied(state, bindings)) return false;
	if (node.definition.kind === "execution") return true;
	return node.definition.targets.every((target) =>
		bindings.some((binding) => binding.submission.nodeId === target.node_id && binding.outputId === target.output_id),
	);
}

export function nodeWaitConditions(node: EffectiveNode, state: RunState): string[] {
	const runtime = state.nodes.find((item) => item.nodeId === node.definition.node_id);
	if (!runtime) return ["Runtime node state is missing"];
	if (runtime.status === "waiting_review") return ["Required review approval is pending"];
	if (runtime.status === "paused") return [state.failure?.message ?? "Technical recovery is required"];
	if (runtime.status === "blocked")
		return runtime.block?.missingConditions ?? [state.failure?.message ?? "Node is blocked"];
	if (!["waiting", "waiting_rework"].includes(runtime.status)) return [];
	const bindings = resolveInputBindings(node, state);
	if (!versionRelationsSatisfied(state, bindings)) return ["Input versions have incompatible content provenance"];
	const resolved = new Set(bindings.map((binding) => binding.inputId));
	const missing = node.definition.inputs.flatMap((input) => {
		if (!input.required) return [];
		if (input.kind === "task_material")
			return state.taskInput?.materials.some((material) => material.material_id === input.material_id)
				? []
				: [`Task material ${input.material_id} is unavailable`];
		return resolved.has(input.input_id)
			? []
			: [
					`Input ${input.input_id} is waiting for ${input.source.node_id}/${input.source.output_id} (${input.availability})`,
				];
	});
	if (node.definition.kind === "review") {
		for (const target of node.definition.targets) {
			if (
				bindings.some(
					(binding) => binding.submission.nodeId === target.node_id && binding.outputId === target.output_id,
				)
			)
				continue;
			missing.push(`Review target ${target.node_id}/${target.output_id} is unavailable`);
		}
	}
	return missing.length > 0 ? missing : ["Node readiness conditions are not satisfied"];
}

export function readyNodes(state: RunState): EffectiveNode[] {
	return [...baselineIndex(requireBaseline(state)).nodes.values()].filter((node) => nodeIsReady(node, state));
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

export function reworkFeedback(node: EffectiveNode, state: RunState): RoundFeedback[] {
	const latestReviewFeedback = findingFeedback(state, node.definition.node_id);
	const previous = state.submissions.filter((submission) => submission.nodeId === node.definition.node_id).at(-1);
	const changedBases: RoundFeedback[] = previous
		? previous.outputs.flatMap((output) => {
				const artifact = state.governance.artifacts.find(
					(item) => item.revisionId === artifactRef(previous, output).revisionId,
				);
				const affected =
					artifact?.bases.filter(
						(basis) =>
							basis.purpose === "content_basis" &&
							state.governance.artifacts.some(
								(item) => item.revisionId === basis.revisionId && item.status === "invalidated",
							),
					) ?? [];
				return affected.length
					? [
							{
								type: "quality_rework" as const,
								sourceId: previous.submissionId,
								outputId: output.outputId,
								issue: `The prior output depended on invalidated input versions: ${affected.map((basis) => basis.revisionId).join(", ")}. Revalidate or revise this output against the current bindings.`,
								expectedCorrection:
									"Preserve independent outputs; update the affected derivation and its evidence.",
							},
						]
					: [];
			})
		: [];
	let latestMechanicalRound: string | undefined;
	for (let index = state.mechanicalChecks.length - 1; index >= 0; index--) {
		const check = state.mechanicalChecks[index];
		if (check?.nodeId === node.definition.node_id) {
			latestMechanicalRound = check.roundId;
			break;
		}
	}
	const mechanicalFeedback = latestMechanicalRound
		? state.mechanicalChecks
				.filter((check) => check.roundId === latestMechanicalRound && check.result === "FAIL")
				.flatMap((check) =>
					check.feedback.map((feedback) => {
						const separator = feedback.indexOf(": ");
						const criterionId = separator < 0 ? undefined : feedback.slice(0, separator);
						const issue = separator < 0 ? feedback : feedback.slice(separator + 2);
						return {
							type: "mechanical_failure" as const,
							sourceId: check.submissionId,
							criterionId,
							outputId: check.outputId,
							issue,
							evidenceRef: `mechanical:${check.roundId}:${check.outputId}${criterionId ? `:${criterionId}` : ""}`,
							expectedCorrection: "Correct the output and rerun the required mechanical check.",
						};
					}),
				)
		: [];
	return [...latestReviewFeedback, ...changedBases, ...mechanicalFeedback];
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
	if (!submission || !submission.outputs.every((output) => outputUsable(state, submission, output.outputId))) return;
	const baseline = requireBaseline(state);
	const fullyApproved = submission.outputs.every((output) => {
		const reviewers = baseline.graph.reviewsByOutput[graphOutputKey(submission.nodeId, output.outputId)] ?? [];
		return outputIsFullyApproved(state, submission.nodeId, submission.submissionId, output.outputId, reviewers);
	});
	submission.status = fullyApproved ? "approved" : "candidate";
	const producer = state.nodes.find((item) => item.nodeId === submission.nodeId);
	if (
		producer &&
		state.submissions.filter((item) => item.nodeId === submission.nodeId).at(-1) === submission &&
		!["active", "waiting_rework"].includes(producer.status)
	)
		producer.status = fullyApproved ? "succeeded" : "waiting_review";
}

export function approvedSubmissionForOutput(
	state: RunState,
	ref: NodeOutputRef,
	requiredReviewNodeIds: readonly string[],
): SubmissionRecord | undefined {
	const reviewers = requiredReviewNodeIds.filter((id) =>
		(requireBaseline(state).graph.reviewsByOutput[graphOutputKey(ref.node_id, ref.output_id)] ?? []).includes(id),
	);
	const latest = findLatestSubmission(
		state,
		(item) => item.nodeId === ref.node_id && submissionHasOutput(item, ref.output_id),
	);
	if (!latest || !outputUsable(state, latest, ref.output_id) || !adoptionUsable(state, latest.submissionId))
		return undefined;
	return outputIsFullyApproved(state, ref.node_id, latest.submissionId, ref.output_id, reviewers) ? latest : undefined;
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

export function completionProblems(state: RunState): string[] {
	const completion = requireBaseline(state).workflow.completion;
	const problems: string[] = [];
	for (const id of completion.required_node_ids)
		if (state.nodes.find((node) => node.nodeId === id)?.status !== "succeeded")
			problems.push(`Required node ${id} has not completed its governed responsibility`);
	for (const id of completion.required_review_node_ids)
		if (state.nodes.find((node) => node.nodeId === id && node.kind === "review")?.status !== "succeeded")
			problems.push(`Required Gate ${id} has not passed`);
	for (const ref of completion.final_outputs)
		if (!approvedSubmissionForOutput(state, ref, completion.required_review_node_ids))
			problems.push(`Final output ${ref.node_id}/${ref.output_id} lacks current release authority`);
	for (const stage of state.baseline!.workflow.stages ?? [])
		for (const exit of stage.exits) {
			const submission = approvedSubmissionForOutput(state, exit.output, exit.gate_node_ids);
			const output = submission?.outputs.find((item) => item.outputId === exit.output.output_id);
			if (
				!submission ||
				!output ||
				!exit.gate_node_ids.every((id) =>
					state.governance.releases.some(
						(release) =>
							release.reviewNodeId === id &&
							release.stageIds.includes(stage.stage_id) &&
							release.subjectRevisionIds.includes(artifactRef(submission, output).revisionId) &&
							releaseIsCurrent(state, release.releaseId),
					),
				)
			)
				problems.push(
					`Stage ${stage.stage_id} exit ${exit.output.node_id}/${exit.output.output_id} is not released`,
				);
		}
	for (const finding of state.governance.findings)
		if (finding.blocking && ["open", "addressed"].includes(finding.status))
			problems.push(`Finding ${finding.findingId} remains ${finding.status}`);
	const latest = new Map(state.submissions.map((submission) => [submission.nodeId, submission.submissionId]));
	for (const adoption of state.governance.adoptions) {
		const submission = state.submissions.find((item) => item.submissionId === adoption.submissionId);
		if (adoption.status === "held" && submission && latest.get(submission.nodeId) === submission.submissionId)
			problems.push(`Adoption ${adoption.adoptionId} requires revalidation`);
	}
	if (
		state.rounds.some((round) => round.status === "active") ||
		state.attempts.some((attempt) => ["claimed", "dispatching", "active"].includes(attempt.status))
	)
		problems.push("Active execution remains");
	for (const dispatch of state.dispatchIntents)
		if (["pending", "delivering", "started", "outcome_unknown"].includes(dispatch.status))
			problems.push(`Dispatch ${dispatch.commandId} remains ${dispatch.status}`);
	for (const operation of state.externalOperations)
		if (["pending", "unknown"].includes(operation.outcome))
			problems.push(`External operation ${operation.operationId} remains ${operation.outcome}`);
	return problems;
}

export function runIsComplete(state: RunState): boolean {
	return completionProblems(state).length === 0;
}
