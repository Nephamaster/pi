// 调度冻结工作流并实施提交、检查、评审、返工和收口。
import type { ReportNodeBlocked, SubmitReview } from "../adapter/structured-submissions.ts";
import { ArtifactValidationError } from "../artifact/manifest.ts";
import type { EffectiveNode, ExecutionBaseline } from "../contracts/baseline.ts";
import type { JsonValue } from "../contracts/primitives.ts";
import type { MechanicalCheckRecord, RunState, SubmissionRecord } from "../contracts/runtime.ts";
import type { TaskInput } from "../contracts/task-input.ts";
import type { ExecutionNode, ReviewNode } from "../contracts/workflow.ts";
import type { MechanicalChecker } from "../gate/mechanical-checker.ts";
import { toJsonValue } from "../ir/hash.ts";
import { materializeFinalSubmission } from "./final-submission.ts";
import { type NodeRoundWork, NodeSubmissionProtocolError, type NodeWorker, NodeWorkerError } from "./node-worker.ts";
import { validateReviewSubmission } from "./review-validation.ts";
import type { RunDirectory } from "./run-directory.ts";
import type { RunStore } from "./run-store.ts";
import {
	addApprovals,
	invalidateFromNode,
	markReworkAddressed,
	markRunCancelled,
	nodeIsReady,
	projectInputSubmissions,
	readyNodes,
	refreshSubmissionStatus,
	requireBaseline,
	resolveInputBindings,
	resolveReworkForTargets,
	reworkFeedback,
	roundInputsAreValid,
	runIsComplete,
	supersedePendingRework,
	taskContextForNode,
} from "./runtime-state.ts";
import { type SubmissionStore, SubmissionValidationError } from "./submission-store.ts";

export interface WorkflowRuntimeMetric {
	type: "round_duration";
	runId: string;
	nodeId: string;
	roundId: string;
	durationMs: number;
}

export interface WorkflowRuntimeOptions {
	maxConcurrentNodes?: number;
	maxQualityReworkRounds?: number;
	roundTimeoutMs?: number;
	onMetric?: (metric: WorkflowRuntimeMetric) => void;
}

export class WorkflowRuntime {
	private readonly store: RunStore;
	private readonly directory: RunDirectory;
	private readonly worker: NodeWorker;
	private readonly submissions: SubmissionStore;
	private readonly mechanical: MechanicalChecker;
	private readonly maxConcurrentNodes: number;
	private readonly maxQualityReworkRounds: number;
	private readonly roundTimeoutMs: number;
	private readonly onMetric: NonNullable<WorkflowRuntimeOptions["onMetric"]>;
	private readonly abortController = new AbortController();
	private readonly running = new Map<string, Promise<void>>();
	private stopping?: Promise<void>;

	constructor(
		store: RunStore,
		directory: RunDirectory,
		worker: NodeWorker,
		submissions: SubmissionStore,
		mechanical: MechanicalChecker,
		options: WorkflowRuntimeOptions = {},
	) {
		this.store = store;
		this.directory = directory;
		this.worker = worker;
		this.submissions = submissions;
		this.mechanical = mechanical;
		this.maxConcurrentNodes = options.maxConcurrentNodes ?? 4;
		this.maxQualityReworkRounds = options.maxQualityReworkRounds ?? 10;
		this.roundTimeoutMs = options.roundTimeoutMs ?? 30 * 60 * 1000;
		this.onMetric = options.onMetric ?? (() => {});
		if (!Number.isInteger(this.maxConcurrentNodes) || this.maxConcurrentNodes < 1)
			throw new Error("maxConcurrentNodes must be a positive integer");
		if (!Number.isInteger(this.maxQualityReworkRounds) || this.maxQualityReworkRounds < 0)
			throw new Error("maxQualityReworkRounds must be a non-negative integer");
		if (!Number.isFinite(this.roundTimeoutMs) || this.roundTimeoutMs <= 0)
			throw new Error("roundTimeoutMs must be positive");
	}

	async activate(baseline: ExecutionBaseline, taskInput?: TaskInput): Promise<void> {
		const state: RunState = {
			runId: baseline.runId,
			revision: 0,
			phase: "execute",
			status: "running",
			...(taskInput ? { taskInput } : {}),
			baseline,
			nodes: baseline.workflow.nodes.map((node) => ({
				nodeId: node.node_id,
				kind: node.kind,
				status: "waiting",
				nextRound: 1,
			})),
			rounds: [],
			submissions: [],
			reviews: [],
			approvals: [],
			mechanicalChecks: [],
			events: [],
			operations: {},
		};
		try {
			await this.store.read(baseline.runId);
			await this.store.mutate(
				baseline.runId,
				`activate:${baseline.baselineId}`,
				{ baselineId: baseline.baselineId },
				(draft, event) => {
					if (draft.status !== "running") return false;
					draft.phase = "execute";
					draft.baseline = baseline;
					draft.nodes = state.nodes;
					event.emit("baseline_activated", { baselineId: baseline.baselineId });
					return true;
				},
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (!taskInput) throw new Error("Cannot activate a new Run without its TaskInput");
			await this.store.create(state);
		}
	}

	async run(): Promise<RunState> {
		while (true) {
			const state = await this.store.read(this.directory.runId);
			if (state.status !== "running") return state;
			if (this.running.size === 0 && runIsComplete(state)) {
				const finalSubmission = await materializeFinalSubmission(
					this.directory,
					state,
					this.abortController.signal,
				);
				await this.store.mutate(
					state.runId,
					`complete:${state.revision}`,
					toJsonValue({ action: "complete", files: finalSubmission.files }),
					(draft, event) => {
						if (draft.status !== "running" || !runIsComplete(draft))
							throw new Error("Run changed before final delivery projection completed");
						draft.finalSubmission = finalSubmission;
						draft.status = "succeeded";
						draft.phase = "closed";
						event.emit("final_submission_materialized", {
							directory: finalSubmission.directory,
							files: finalSubmission.files.map((file) => file.path),
						});
						event.emit("run_succeeded");
						return true;
					},
				);
				await this.worker.releaseRun?.(state.runId);
				return this.store.read(state.runId);
			}
			for (const node of readyNodes(state)) {
				if (this.running.size >= this.maxConcurrentNodes) break;
				const nodeId = node.definition.node_id;
				if (this.running.has(nodeId)) continue;
				const operation = this.runNode(state.runId, node).finally(() => this.running.delete(nodeId));
				this.running.set(nodeId, operation);
			}
			if (this.running.size === 0) {
				await this.store.mutate(state.runId, `blocked:${state.revision}`, { action: "blocked" }, (draft, event) => {
					if (draft.status !== "running") return false;
					draft.status = "blocked";
					event.emit("run_blocked", { reason: "no_ready_nodes" });
					return true;
				});
				return this.store.read(state.runId);
			}
			await Promise.race(this.running.values());
		}
	}

	async cancel(reason = "Run cancelled"): Promise<RunState> {
		if (!this.stopping) {
			this.stopping = (async () => {
				this.abortController.abort(reason);
				const state = await this.store.read(this.directory.runId);
				if (state.status === "running") {
					await this.store.mutate(state.runId, `cancel:${state.revision}`, { reason }, (draft, event) => {
						if (draft.status !== "running") return false;
						markRunCancelled(draft);
						event.emit("run_cancelled", { reason });
						return true;
					});
				}
				await this.worker.releaseRun?.(this.directory.runId);
				await Promise.allSettled(this.running.values());
			})();
		}
		await this.stopping;
		return this.store.read(this.directory.runId);
	}

	private async runNode(runId: string, node: EffectiveNode): Promise<void> {
		const state = await this.store.read(runId);
		const record = state.nodes.find((item) => item.nodeId === node.definition.node_id)!;
		if (record.status === "waiting_rework" && record.nextRound > this.maxQualityReworkRounds + 1) {
			await this.store.mutate(
				runId,
				`rework-exhausted:${node.definition.node_id}:${record.nextRound}`,
				{ maxQualityReworkRounds: this.maxQualityReworkRounds },
				(draft, event) => {
					if (draft.status !== "running") return false;
					const current = draft.nodes.find((item) => item.nodeId === node.definition.node_id);
					if (!current || current.status !== "waiting_rework") return false;
					current.status = "blocked";
					event.emit(
						"quality_rework_exhausted",
						{ maxQualityReworkRounds: this.maxQualityReworkRounds },
						current.nodeId,
					);
					return true;
				},
			);
			return;
		}
		const roundId = `${node.definition.node_id}:round:${record.nextRound}`;
		const startedAt = Date.now();
		let started = false;
		let bindings = resolveInputBindings(node, state);
		await this.store.mutate(runId, `start:${roundId}`, { roundId }, (draft, event) => {
			if (draft.status !== "running" || !nodeIsReady(node, draft)) return false;
			const current = draft.nodes.find((item) => item.nodeId === node.definition.node_id)!;
			bindings = resolveInputBindings(node, draft);
			const submissionIds = [...new Set(bindings.map((item) => item.submissionId))];
			delete current.block;
			current.status = "active";
			current.activeRoundId = roundId;
			current.nextRound++;
			draft.rounds.push({
				roundId,
				nodeId: current.nodeId,
				index: current.nextRound - 1,
				status: "active",
				inputSubmissionIds: submissionIds,
				inputBindings: bindings.map(({ submission: _submission, ...binding }) => structuredClone(binding)),
				startedAt: Date.now(),
			});
			event.emit("round_started", null, current.nodeId, roundId);
			started = true;
			return true;
		});
		if (!started) return;
		const inputs = projectInputSubmissions(bindings);
		const work: NodeRoundWork = {
			runId,
			roundId,
			node,
			inputSubmissions: inputs,
			inputBindings: bindings.map(({ submission: _submission, ...binding }) => structuredClone(binding)),
			taskContext: taskContextForNode(node, state),
			forbiddenMutableReadPaths: requireBaseline(state)
				.nodes.filter(
					(candidate) =>
						candidate.definition.kind === "execution" && candidate.definition.node_id !== node.definition.node_id,
				)
				.flatMap((candidate) =>
					candidate.definition.kind === "execution"
						? candidate.definition.outputs.map((output) => output.path_prefix)
						: [],
				),
			feedback: reworkFeedback(node, state),
		};
		try {
			await this.runRoundWithTimeout(work, node.definition);
		} catch (error) {
			await this.blockRound(work, error);
		} finally {
			try {
				this.onMetric({
					type: "round_duration",
					runId,
					nodeId: node.definition.node_id,
					roundId,
					durationMs: Date.now() - startedAt,
				});
			} catch {
				// Telemetry cannot affect Runtime state.
			}
		}
	}

	private async runRoundWithTimeout(work: NodeRoundWork, node: ExecutionNode | ReviewNode): Promise<void> {
		let timeout: NodeJS.Timeout | undefined;
		let timedOut = false;
		const operation = node.kind === "execution" ? this.runExecution(work, node) : this.runReview(work, node);
		try {
			await Promise.race([
				operation,
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(() => {
						timedOut = true;
						reject(new NodeWorkerError("timeout", `Round timed out: ${work.roundId}`, false));
					}, this.roundTimeoutMs);
				}),
			]);
		} catch (error) {
			if (timedOut) {
				const participant = work.node.agents[0];
				if (this.worker.stopRound) {
					await this.worker
						.stopRound(work.runId, work.node.definition.node_id, participant.participantId, work.roundId)
						.catch(() => {});
					await operation.catch(() => {});
				} else {
					void operation.catch(() => {});
				}
			}
			throw error;
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	private async recordExecutionBlock(work: NodeRoundWork, report: ReportNodeBlocked): Promise<void> {
		const blockId = `${work.roundId}:block`;
		await this.store.mutate(work.runId, `business-blocked:${work.roundId}`, toJsonValue(report), (draft, event) => {
			const node = draft.nodes.find((item) => item.nodeId === work.node.definition.node_id)!;
			const round = draft.rounds.find((item) => item.roundId === work.roundId)!;
			if (
				draft.status !== "running" ||
				node.activeRoundId !== work.roundId ||
				!roundInputsAreValid(work.node, round, draft)
			) {
				event.emit("late_block_ignored", { blockId }, node.nodeId, work.roundId);
				return false;
			}
			node.status = "blocked";
			node.activeRoundId = undefined;
			node.block = {
				blockId,
				roundId: work.roundId,
				reason: report.reason,
				missingConditions: [...report.missing_conditions],
				attemptedActions: [...report.attempted_actions],
				evidence: toJsonValue(report.evidence),
				neededToResume: [...report.needed_to_resume],
				createdAt: Date.now(),
			};
			round.status = "blocked";
			round.finishedAt = Date.now();
			event.emit("node_blocked", toJsonValue({ blockId, ...report }), node.nodeId, work.roundId);
			return true;
		});
	}

	private async blockRound(work: NodeRoundWork, error: unknown): Promise<void> {
		const failure =
			error instanceof NodeWorkerError
				? error
				: new NodeWorkerError("configuration", error instanceof Error ? error.message : String(error), false);
		await this.store.mutate(
			work.runId,
			`round-failed:${work.roundId}`,
			{ kind: failure.kind, message: failure.message },
			(draft, event) => {
				const node = draft.nodes.find((item) => item.nodeId === work.node.definition.node_id)!;
				if (draft.status !== "running" || node.activeRoundId !== work.roundId) {
					event.emit(
						"late_failure_ignored",
						{ kind: failure.kind, message: failure.message },
						node.nodeId,
						work.roundId,
					);
					return false;
				}
				node.status = "blocked";
				node.activeRoundId = undefined;
				const round = draft.rounds.find((item) => item.roundId === work.roundId)!;
				round.status = "failed";
				round.finishedAt = Date.now();
				event.emit("round_blocked", { kind: failure.kind, message: failure.message }, node.nodeId, work.roundId);
				return true;
			},
		);
	}

	private async runExecution(work: NodeRoundWork, node: ExecutionNode): Promise<void> {
		let record: SubmissionRecord | undefined;
		let correctionWork = work;
		for (let correction = 0; correction < 10; correction++) {
			try {
				const submitted = await this.worker.runExecution(correctionWork);
				if ("report" in submitted) {
					await this.recordExecutionBlock(work, submitted.report);
					return;
				}
				record = await this.submissions.seal({
					run: this.directory,
					runId: work.runId,
					node,
					roundId: work.roundId,
					submissionId: `${work.roundId}:submission`,
					inputSubmissionIds: work.inputSubmissions.map((item) => item.submissionId),
					submission: submitted,
					signal: this.abortController.signal,
				});
				break;
			} catch (error) {
				if (error instanceof NodeWorkerError) throw error;
				if (
					!(error instanceof NodeSubmissionProtocolError) &&
					!(error instanceof SubmissionValidationError) &&
					!(error instanceof ArtifactValidationError)
				) {
					throw new NodeWorkerError("transient", error instanceof Error ? error.message : String(error), true, {
						cause: error,
					});
				}
				correctionWork = {
					...work,
					feedback: [
						...correctionWork.feedback,
						{
							type: "submission_correction",
							issue: error instanceof Error ? error.message : String(error),
							expectedCorrection: "Submit a candidate that satisfies the declared submission contract.",
						},
					],
				};
			}
		}
		if (!record) throw new NodeWorkerError("configuration", "Execution submission correction limit reached", false);
		let result: "PASS" | "FAIL" | "ERROR" = "PASS";
		const mechanicalChecks: MechanicalCheckRecord[] = [];
		const state = await this.store.read(work.runId);
		const workflowCriteria = requireBaseline(state).workflow.criteria;
		for (const output of record.outputs) {
			const definition = node.outputs.find((item) => item.output_id === output.outputId)!;
			const mechanicalCriteria = workflowCriteria.filter(
				(item): item is Extract<(typeof workflowCriteria)[number], { kind: "mechanical" }> =>
					item.kind === "mechanical" && definition.criterion_refs.includes(item.criterion_id),
			);
			const outcome = await this.mechanical.evaluate(
				mechanicalCriteria,
				{
					workspace: output.sealedRoot,
					contract: {
						id: definition.output_id,
						artifactType: definition.artifact_type,
						description: definition.description,
						businessPurpose: definition.business_purpose,
					},
					manifest: output.manifest,
					artifacts: record.outputs.map((item) => {
						const value = node.outputs.find((candidate) => candidate.output_id === item.outputId)!;
						return {
							workspace: item.sealedRoot,
							contract: {
								id: value.output_id,
								artifactType: value.artifact_type,
								description: value.description,
								businessPurpose: value.business_purpose,
							},
							manifest: item.manifest,
						};
					}),
				},
				this.abortController.signal,
			);
			mechanicalChecks.push({
				nodeId: node.node_id,
				roundId: work.roundId,
				submissionId: record.submissionId,
				outputId: output.outputId,
				result: outcome.result,
				feedback: outcome.criteria
					.filter((criterion) => criterion.result !== "PASS")
					.map((criterion) => `${criterion.criterionId}: ${criterion.message}`),
				outcome: toJsonValue(outcome),
				createdAt: Date.now(),
			});
			if (outcome.result === "ERROR") result = "ERROR";
			else if (outcome.result === "FAIL" && result === "PASS") result = "FAIL";
		}
		await this.store.mutate(
			work.runId,
			`submit:${work.roundId}`,
			{ submissionId: record.submissionId },
			(draft, event) => {
				const current = draft.nodes.find((item) => item.nodeId === node.node_id)!;
				const round = draft.rounds.find((item) => item.roundId === work.roundId)!;
				if (
					draft.status !== "running" ||
					current.activeRoundId !== work.roundId ||
					!roundInputsAreValid(work.node, round, draft)
				) {
					event.emit("late_submission_ignored", { submissionId: record.submissionId }, node.node_id, work.roundId);
					return false;
				}
				record.status = result === "PASS" ? "candidate" : "rejected";
				draft.submissions.push(record);
				draft.mechanicalChecks.push(...mechanicalChecks);
				if (result === "PASS") markReworkAddressed(draft, node.node_id);
				current.activeRoundId = undefined;
				current.status = result === "PASS" ? "waiting_review" : result === "FAIL" ? "waiting_rework" : "blocked";
				round.status = "submitted";
				round.finishedAt = Date.now();
				event.emit("submission_recorded", { result }, node.node_id, work.roundId);
				return true;
			},
		);
	}

	private async runReview(work: NodeRoundWork, node: ReviewNode): Promise<void> {
		let report: SubmitReview | undefined;
		let correctionWork = work;
		for (let correction = 0; correction < 10; correction++) {
			try {
				report = validateReviewSubmission(
					work.node,
					await this.worker.runReview(correctionWork),
					work.inputSubmissions,
				);
				break;
			} catch (error) {
				if (error instanceof NodeWorkerError) throw error;
				correctionWork = {
					...work,
					feedback: [
						...correctionWork.feedback,
						{
							type: "submission_correction",
							issue: error instanceof Error ? error.message : String(error),
							expectedCorrection: "Submit a review report that satisfies the review submission contract.",
						},
					],
				};
			}
		}
		if (!report) throw new NodeWorkerError("configuration", "Review submission correction limit reached", false);
		const invalidatedRounds: Array<{ nodeId: string; roundId: string }> = [];
		await this.store.mutate(work.runId, `review:${work.roundId}`, { decision: report.decision }, (draft, event) => {
			const current = draft.nodes.find((item) => item.nodeId === node.node_id)!;
			const round = draft.rounds.find((item) => item.roundId === work.roundId)!;
			if (
				draft.status !== "running" ||
				current.activeRoundId !== work.roundId ||
				!roundInputsAreValid(work.node, round, draft)
			) {
				event.emit("late_review_ignored", { decision: report.decision }, node.node_id, work.roundId);
				return false;
			}
			const reviewId = `${work.roundId}:review`;
			const submissionIds = [...new Set(work.inputSubmissions.map((item) => item.submissionId))];
			const reworkNodeIds = [
				...new Set(
					report.criteria.flatMap((criterion) => criterion.rework_targets.map((target) => target.node_id)),
				),
			];
			if (report.decision === "REWORK") supersedePendingRework(draft, reworkNodeIds);
			draft.reviews.push({
				reviewId,
				reviewNodeId: node.node_id,
				roundId: work.roundId,
				submissionIds,
				decision: report.decision,
				criteria: report.criteria.map((item) => ({
					criterionId: item.criterion_id,
					result: item.result,
					evidence: item.evidence as JsonValue,
					rationale: item.rationale,
					requiredRework: item.required_rework,
					reworkTargets: item.rework_targets.map((target) => ({
						nodeId: target.node_id,
						outputId: target.output_id,
						status: "pending",
					})),
				})),
				status: "active",
				createdAt: Date.now(),
			});
			if (report.decision === "PASS") {
				addApprovals(
					draft,
					reviewId,
					node.node_id,
					node.targets.map((target) => {
						const binding = work.inputBindings.find((item) => {
							const submission = draft.submissions.find(
								(candidate) => candidate.submissionId === item.submissionId,
							);
							return submission?.nodeId === target.node_id && item.outputId === target.output_id;
						});
						if (!binding)
							throw new Error(`Review target has no bound Submission: ${target.node_id}:${target.output_id}`);
						return {
							submissionId: binding.submissionId,
							outputId: target.output_id,
							criterionIds: [...target.criterion_refs],
						};
					}),
				);
				resolveReworkForTargets(draft, node.targets);
				for (const submissionId of submissionIds) refreshSubmissionStatus(draft, submissionId);
			} else if (report.decision === "REWORK") {
				for (const targetId of reworkNodeIds)
					invalidatedRounds.push(...invalidateFromNode(draft, targetId, work.roundId));
			}
			current.activeRoundId = undefined;
			current.status =
				report.decision === "PASS" ? "succeeded" : report.decision === "REWORK" ? "waiting" : "blocked";
			round.status = "completed";
			round.finishedAt = Date.now();
			event.emit("review_recorded", { decision: report.decision }, node.node_id, work.roundId);
			return true;
		});
		if (invalidatedRounds.length > 0) {
			const state = await this.store.read(work.runId);
			const baseline = requireBaseline(state);
			await Promise.all(
				invalidatedRounds.map((invalidated) => {
					const affected = baseline.nodes.find((item) => item.definition.node_id === invalidated.nodeId);
					const participant = affected?.agents[0];
					return participant
						? (this.worker.stopRound?.(
								work.runId,
								invalidated.nodeId,
								participant.participantId,
								invalidated.roundId,
							) ?? Promise.resolve())
						: Promise.resolve();
				}),
			);
		}
	}
}
