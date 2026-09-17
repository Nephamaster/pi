// 调度冻结工作流并实施提交、检查、评审、返工和收口。
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ReportNodeBlocked, SubmitReview } from "../adapter/structured-submissions.ts";
import { ArtifactValidationError } from "../artifact/manifest.ts";
import { baselineIndex } from "../compiler/baseline-index.ts";
import type { EffectiveNode, ExecutionBaseline } from "../contracts/baseline.ts";
import type { MechanicalCheckRecord, RunState, SubmissionRecord } from "../contracts/runtime.ts";
import type { TaskInput } from "../contracts/task-input.ts";
import type { ExecutionNode, ReviewNode } from "../contracts/workflow.ts";
import type { MechanicalChecker } from "../gate/mechanical-checker.ts";
import { hashJson, toJsonValue } from "../ir/hash.ts";
import { materializeFinalSubmission } from "./final-submission.ts";
import { applyCandidateSubmission, applyReviewDecision } from "./governance-transitions.ts";
import { bounded, isTerminal } from "./lifecycle.ts";
import { type NodeRoundWork, NodeSubmissionProtocolError, type NodeWorker, NodeWorkerError } from "./node-worker.ts";
import { validateReviewSubmission } from "./review-validation.ts";
import type { RunDirectory } from "./run-directory.ts";
import type { RunStore } from "./run-store.ts";
import {
	markRunCancelled,
	nodeIsReady,
	projectInputSubmissions,
	readyNodes,
	requireBaseline,
	resolveInputBindings,
	reworkFeedback,
	roundInputsAreValid,
	runIsComplete,
	taskContextForNode,
} from "./runtime-state.ts";
import { type SubmissionStore, SubmissionValidationError } from "./submission-store.ts";

export const DEFAULT_ROUND_TIMEOUT_MS = 0;

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
	/** Disabled by default (0); a positive value explicitly opts into a whole-round deadline. */
	roundTimeoutMs?: number;
	softRoundTimeoutMs?: number;
	stopTimeoutMs?: number;
	onMetric?: (metric: WorkflowRuntimeMetric) => void;
}

interface RoundExecution {
	work: NodeRoundWork;
	controller: AbortController;
	phase: "prepare" | "model" | "export" | "check" | "review";
	operation: Promise<void>;
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
	private abortController = new AbortController();
	private readonly stopTimeoutMs: number;
	private readonly softRoundTimeoutMs?: number;
	private readonly inFlight = new Map<string, RoundExecution>();
	private readonly unregisteredSubmissions = new Set<string>();
	private runPromise?: Promise<RunState>;
	private baselineHash?: string;
	private progressOperation?: Promise<void>;
	private suspension?: Promise<RunState>;
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
		this.roundTimeoutMs = options.roundTimeoutMs ?? DEFAULT_ROUND_TIMEOUT_MS;
		this.stopTimeoutMs = options.stopTimeoutMs ?? 5000;
		this.softRoundTimeoutMs = options.softRoundTimeoutMs;
		if (!Number.isFinite(this.stopTimeoutMs) || this.stopTimeoutMs <= 0)
			throw new Error("stopTimeoutMs must be positive");
		if (
			this.softRoundTimeoutMs !== undefined &&
			(!Number.isFinite(this.softRoundTimeoutMs) ||
				this.softRoundTimeoutMs <= 0 ||
				(this.roundTimeoutMs > 0 && this.softRoundTimeoutMs >= this.roundTimeoutMs))
		)
			throw new Error("softRoundTimeoutMs must be positive and less than roundTimeoutMs");
		this.onMetric = options.onMetric ?? (() => {});
		if (!Number.isInteger(this.maxConcurrentNodes) || this.maxConcurrentNodes < 1)
			throw new Error("maxConcurrentNodes must be a positive integer");
		if (!Number.isInteger(this.maxQualityReworkRounds) || this.maxQualityReworkRounds < 0)
			throw new Error("maxQualityReworkRounds must be a non-negative integer");
		if (!Number.isSafeInteger(this.roundTimeoutMs) || this.roundTimeoutMs < 0 || this.roundTimeoutMs > 2_147_483_647)
			throw new Error("roundTimeoutMs must be 0 (disabled) or a positive timer-safe integer");
	}

	async activate(baseline: ExecutionBaseline, taskInput?: TaskInput): Promise<void> {
		this.baselineHash = hashJson(baseline);
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

	run(): Promise<RunState> {
		this.runPromise ??= this.drive().finally(() => {
			this.runPromise = undefined;
		});
		return this.runPromise;
	}

	private async drive(): Promise<RunState> {
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
						if (
							draft.status !== "running" ||
							(draft.generation ?? 0) !== (state.generation ?? 0) ||
							!runIsComplete(draft)
						)
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
				return this.store.read(state.runId);
			}
			for (const node of readyNodes(state)) {
				if (this.running.size >= this.maxConcurrentNodes) break;
				const nodeId = node.definition.node_id;
				if (
					this.running.has(nodeId) ||
					[...this.inFlight.values()].some((round) => round.work.node.definition.node_id === nodeId)
				)
					continue;
				const operation = this.runNode(state.runId, node).finally(() => this.running.delete(nodeId));
				this.running.set(nodeId, operation);
			}
			if (this.running.size === 0) {
				const current = await this.store.read(state.runId);
				return this.suspend(
					current.nodes.some((node) => node.status === "paused") ? "paused" : "blocked",
					current.failure?.message ?? "No ready nodes",
				);
			}
			await Promise.race(this.running.values());
		}
	}

	async pause(reason = "Paused by user"): Promise<RunState> {
		return this.suspend("paused", reason);
	}

	private suspend(status: "paused" | "blocked", reason: string, code?: string): Promise<RunState> {
		this.suspension ??= this.performSuspend(status, reason, code).finally(() => {
			this.suspension = undefined;
		});
		return this.suspension;
	}

	private async performSuspend(status: "paused" | "blocked", reason: string, code?: string): Promise<RunState> {
		const before = await this.store.read(this.directory.runId);
		if (isTerminal(before.status)) return before;
		await this.store.mutate(before.runId, `suspend:${before.revision}`, { status, reason }, (draft, event) => {
			if (isTerminal(draft.status)) return false;
			if (draft.status === "running") draft.generation = (draft.generation ?? 0) + 1;
			draft.status = status;
			draft.cleanup = { status: "pending", resources: this.inspectResources() };
			if (code) draft.failure = { code, message: reason };
			draft.interruption = { reason, timestamp: Date.now(), baselineHash: this.baselineHash };
			for (const node of draft.nodes) {
				if (node.status !== "active") continue;
				node.resumeRoundId = node.activeRoundId;
				const round = draft.rounds.find((item) => item.roundId === node.activeRoundId);
				if (round) round.status = "paused";
				node.status = "paused";
				node.activeRoundId = undefined;
			}
			event.emit(status === "paused" ? "run_paused" : "run_blocked", { reason, generation: draft.generation ?? 0 });
			return true;
		});
		this.abortController.abort(reason);
		if (!this.progressOperation) {
			const operation = (async () => {
				const state = await this.store.read(before.runId);
				const progress = this.worker.pauseRun ? await this.worker.pauseRun(before.runId) : [];
				if (!this.worker.pauseRun)
					await Promise.all(
						state.rounds
							.filter((round) => round.status === "paused")
							.map((round) => {
								const node = baselineIndex(requireBaseline(state)).nodes.get(round.nodeId)!;
								return this.worker.stopRound?.(
									state.runId,
									round.nodeId,
									node.agents[0].participantId,
									round.roundId,
								);
							}),
					);
				await Promise.allSettled([...this.inFlight.values()].map((round) => round.operation));
				await this.cleanupUnregistered();
				await this.store.mutate(
					state.runId,
					`progress:${state.generation ?? 0}:${state.revision}`,
					toJsonValue(progress),
					(draft, event) => {
						if (isTerminal(draft.status) || draft.generation !== state.generation) return false;
						draft.workProgress = progress;
						draft.cleanup = { status: "complete" };
						event.emit("work_progress_saved", { count: progress.length, approved: false });
						return true;
					},
				);
			})();
			this.progressOperation = operation;
			void operation
				.finally(() => {
					if (this.progressOperation === operation) this.progressOperation = undefined;
				})
				.catch(() => {});
		}
		try {
			await bounded(this.progressOperation, this.stopTimeoutMs, "Pause cleanup");
		} catch (error) {
			const current = await this.store.read(before.runId);
			if (!isTerminal(current.status) && current.cleanup?.status !== "complete")
				await this.recordCleanupFailure(error, true);
		}
		return this.store.read(before.runId);
	}

	async resume(): Promise<void> {
		if (this.progressOperation || this.inFlight.size || this.running.size || this.stopping)
			throw new Error("Previous execution or cleanup has not settled");
		const state = await this.store.read(this.directory.runId);
		if (!["paused", "blocked"].includes(state.status)) throw new Error("Only paused or blocked Runs can resume");
		if (!this.baselineHash || hashJson(requireBaseline(state)) !== this.baselineHash)
			throw new Error("Frozen Baseline changed or execution ownership was lost");
		if (
			requireBaseline(state).report.taskInputHash &&
			hashJson(state.taskInput) !== requireBaseline(state).report.taskInputHash
		)
			throw new Error("Frozen task input changed");
		if (state.cleanup?.status !== "complete") throw new Error("Work preservation has not completed");
		if (["external_outcome_unknown", "quality_rework_exhausted"].includes(state.failure?.code ?? ""))
			throw new Error("The recorded failure requires explicit reconciliation before resume");
		for (const node of state.nodes.filter((item) => ["paused", "blocked"].includes(item.status))) {
			const round = state.rounds.filter((item) => item.nodeId === node.nodeId).at(-1);
			const effective = baselineIndex(requireBaseline(state)).nodes.get(node.nodeId)!;
			if (
				round &&
				(!roundInputsAreValid(effective, round, state) ||
					hashJson(round.inputBindings) !==
						hashJson(
							resolveInputBindings(effective, state).map(({ submission: _submission, ...binding }) => binding),
						))
			)
				throw new Error(`Inputs or approvals changed for ${node.nodeId}`);
		}
		await this.worker.validateResume?.(state.runId, state.workProgress ?? []);
		await this.store.mutate(
			state.runId,
			`resume:${state.revision}`,
			{ generation: state.generation ?? 0 },
			(draft, event) => {
				if (draft.revision !== state.revision || !["paused", "blocked"].includes(draft.status))
					throw new Error("Run changed during resume validation");
				draft.generation = (draft.generation ?? 0) + 1;
				draft.status = "running";
				delete draft.interruption;
				delete draft.failure;
				for (const node of draft.nodes)
					if (["paused", "blocked"].includes(node.status)) {
						node.resumeRoundId = draft.rounds.filter((round) => round.nodeId === node.nodeId).at(-1)?.roundId;
						node.status = "waiting";
					}
				event.emit("run_resumed", { generation: draft.generation });
				return true;
			},
		);
		this.abortController = new AbortController();
	}

	async cancel(reason = "Run cancelled"): Promise<RunState> {
		const state = await this.store.read(this.directory.runId);
		if (!isTerminal(state.status))
			await this.store.mutate(state.runId, `cancel:${state.revision}`, { reason }, (draft, event) => {
				if (isTerminal(draft.status)) return false;
				draft.generation = (draft.generation ?? 0) + 1;
				markRunCancelled(draft);
				event.emit("run_cancelled", { reason });
				return true;
			});
		this.abortController.abort(reason);
		await this.release();
		return this.store.read(state.runId);
	}

	async release(): Promise<void> {
		this.abortController.abort("Run resources released");
		if (!this.stopping) {
			const operation = (async () => {
				await this.worker.releaseRun?.(this.directory.runId);
				await Promise.allSettled([...this.inFlight.values()].map((round) => round.operation));
				await this.cleanupUnregistered();
			})();
			this.stopping = operation;
			void operation
				.finally(() => {
					if (this.stopping === operation) this.stopping = undefined;
				})
				.catch(() => {});
		}
		try {
			await bounded(this.stopping, this.stopTimeoutMs, "Run cleanup");
		} catch (error) {
			await this.recordCleanupFailure(error);
			throw error;
		}
	}

	inspectResources() {
		return this.worker.inspectRun?.(this.directory.runId) ?? [];
	}

	private async recordCleanupFailure(error: unknown, onlyIfPending = false): Promise<void> {
		const state = await this.store.read(this.directory.runId);
		const message = error instanceof Error ? error.message : String(error);
		await this.store.mutate(state.runId, `cleanup-failed:${state.revision}`, { message }, (draft, event) => {
			if (onlyIfPending && (isTerminal(draft.status) || draft.cleanup?.status === "complete")) return false;
			draft.cleanup = { status: "failed", message, resources: this.inspectResources() };
			event.emit("cleanup_failed", { message });
			return true;
		});
	}

	private async cleanupUnregistered(): Promise<void> {
		const state = await this.store.read(this.directory.runId);
		for (const id of this.unregisteredSubmissions) {
			if (!state.submissions.some((record) => record.submissionId === id))
				await rm(join(this.directory.submissions, id), { recursive: true, force: true });
			this.unregisteredSubmissions.delete(id);
		}
	}

	private async assertCurrent(work: NodeRoundWork, lateEvent?: string): Promise<void> {
		const state = await this.store.read(work.runId);
		if (
			work.signal?.aborted ||
			state.status !== "running" ||
			(state.generation ?? 0) !== (work.generation ?? 0) ||
			state.nodes.find((node) => node.nodeId === work.node.definition.node_id)?.activeRoundId !== work.roundId
		) {
			if (lateEvent)
				await this.store.mutate(
					work.runId,
					`${lateEvent}:${work.roundId}:${work.generation ?? 0}`,
					{ generation: work.generation ?? 0 },
					(_draft, event) => {
						event.emit(
							lateEvent,
							{ generation: work.generation ?? 0 },
							work.node.definition.node_id,
							work.roundId,
						);
						return false;
					},
				);
			throw new NodeWorkerError("cancelled", "Execution generation is no longer eligible to submit");
		}
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
					draft.failure = { code: "quality_rework_exhausted", message: "Quality rework limit reached" };
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
		const roundId = record.resumeRoundId ?? `${node.definition.node_id}:round:${record.nextRound}`;
		const generation = state.generation ?? 0;
		const signal = this.abortController.signal;
		const startedAt = Date.now();
		let started = false;
		let bindings = resolveInputBindings(node, state);
		await this.store.mutate(runId, `start:${roundId}:${generation}`, { roundId }, (draft, event) => {
			if (draft.status !== "running" || (draft.generation ?? 0) !== generation || !nodeIsReady(node, draft))
				return false;
			const current = draft.nodes.find((item) => item.nodeId === node.definition.node_id)!;
			bindings = resolveInputBindings(node, draft);
			const submissionIds = [...new Set(bindings.map((item) => item.submissionId))];
			delete current.block;
			current.status = "active";
			current.activeRoundId = roundId;
			const continuing = draft.rounds.find((round) => round.roundId === current.resumeRoundId);
			delete current.resumeRoundId;
			if (continuing) {
				continuing.status = "active";
				continuing.generation = generation;
				continuing.attempt = (continuing.attempt ?? 1) + 1;
				delete continuing.finishedAt;
			} else {
				current.nextRound++;
				draft.rounds.push({
					generation,
					attempt: 1,
					roundId,
					nodeId: current.nodeId,
					index: current.nextRound - 1,
					status: "active",
					inputSubmissionIds: submissionIds,
					inputBindings: bindings.map(({ submission: _submission, ...binding }) => structuredClone(binding)),
					startedAt: Date.now(),
				});
			}
			event.emit(
				"round_started",
				{
					generation,
					attempt: continuing?.attempt ?? 1,
					executionPolicy: {
						roundTimeoutMs: this.roundTimeoutMs,
						softRoundTimeoutMs: this.softRoundTimeoutMs ?? 0,
						stopTimeoutMs: this.stopTimeoutMs,
					},
				},
				current.nodeId,
				roundId,
			);
			started = true;
			return true;
		});
		if (!started) return;
		const inputs = projectInputSubmissions(bindings);
		const work: NodeRoundWork = {
			generation,
			resuming: record.resumeRoundId !== undefined,
			signal,
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
			environmentBinding: requireBaseline(state).environmentBindings.find(
				(binding) =>
					binding.nodeId === node.definition.node_id && binding.participantId === node.agents[0].participantId,
			),
		};
		try {
			await this.runRoundWithTimeout(work, node.definition);
			const current = await this.store.read(runId);
			const completedNode = current.nodes.find((item) => item.nodeId === node.definition.node_id);
			if (current.status === "running" && completedNode?.status === "blocked")
				await this.suspend("blocked", completedNode.block?.reason ?? "Node requires an external condition");
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
		const controller = new AbortController();
		work = { ...work, signal: AbortSignal.any([controller.signal, this.abortController.signal]) };
		const execution: RoundExecution = { work, controller, phase: "prepare", operation: Promise.resolve() };
		this.inFlight.set(work.roundId, execution);
		let timeout: NodeJS.Timeout | undefined;
		let soft: NodeJS.Timeout | undefined;
		let abort: () => void = () => {};
		const operation = (async () => {
			await this.assertCurrent(work);
			await this.worker.prepareRound?.(work, work.signal);
			await this.assertCurrent(work);
			execution.phase = node.kind === "execution" ? "model" : "review";
			await (node.kind === "execution" ? this.runExecution(work, node) : this.runReview(work));
		})();
		execution.operation = operation;
		void operation.finally(() => this.inFlight.delete(work.roundId)).catch(() => {});
		try {
			if (this.softRoundTimeoutMs !== undefined)
				soft = setTimeout(() => {
					void this.worker.requestCheckpoint?.(work).catch(() => {});
				}, this.softRoundTimeoutMs);
			await Promise.race([
				operation,
				new Promise<never>((_resolve, reject) => {
					abort = () => reject(new NodeWorkerError("cancelled", "Run execution interrupted"));
					if (work.signal?.aborted) abort();
					else work.signal?.addEventListener("abort", abort, { once: true });
					if (this.roundTimeoutMs > 0)
						timeout = setTimeout(
							() => reject(new NodeWorkerError("timeout", `Round timed out: ${work.roundId}`)),
							this.roundTimeoutMs,
						);
				}),
			]);
		} catch (error) {
			if (error instanceof NodeWorkerError && error.kind === "timeout")
				await this.suspend("paused", error.message, "timeout");
			throw error;
		} finally {
			if (timeout) clearTimeout(timeout);
			if (soft) clearTimeout(soft);
			work.signal?.removeEventListener("abort", abort);
		}
	}

	private async recordExecutionBlock(work: NodeRoundWork, report: ReportNodeBlocked): Promise<void> {
		const blockId = `${work.roundId}:block`;
		await this.store.mutate(
			work.runId,
			`business-blocked:${work.roundId}:${work.generation ?? 0}`,
			toJsonValue(report),
			(draft, event) => {
				const node = draft.nodes.find((item) => item.nodeId === work.node.definition.node_id)!;
				const round = draft.rounds.find((item) => item.roundId === work.roundId)!;
				if (
					draft.status !== "running" ||
					(draft.generation ?? 0) !== (work.generation ?? 0) ||
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
			},
		);
	}

	private async blockRound(work: NodeRoundWork, error: unknown): Promise<void> {
		const failure =
			error instanceof NodeWorkerError
				? error
				: new NodeWorkerError("configuration", error instanceof Error ? error.message : String(error), false);
		const applied = await this.store.mutate(
			work.runId,
			`round-failed:${work.roundId}:${work.generation ?? 0}`,
			{ kind: failure.kind, message: failure.message },
			(draft, event) => {
				const node = draft.nodes.find((item) => item.nodeId === work.node.definition.node_id)!;
				if (
					draft.status !== "running" ||
					(draft.generation ?? 0) !== (work.generation ?? 0) ||
					node.activeRoundId !== work.roundId
				) {
					event.emit(
						"late_failure_ignored",
						{ kind: failure.kind, message: failure.message },
						node.nodeId,
						work.roundId,
					);
					return false;
				}
				node.status = ["transient", "timeout", "cancelled"].includes(failure.kind) ? "paused" : "blocked";
				draft.failure = { code: failure.kind, message: failure.message };
				node.resumeRoundId = work.roundId;
				node.activeRoundId = undefined;
				const round = draft.rounds.find((item) => item.roundId === work.roundId)!;
				round.status = node.status === "paused" ? "paused" : "failed";
				round.finishedAt = Date.now();
				event.emit("round_blocked", { kind: failure.kind, message: failure.message }, node.nodeId, work.roundId);
				return true;
			},
		);
		if (applied)
			await this.suspend(
				["transient", "timeout", "cancelled"].includes(failure.kind) ? "paused" : "blocked",
				failure.message,
				failure.kind,
			);
	}

	private async runExecution(work: NodeRoundWork, node: ExecutionNode): Promise<void> {
		let record: SubmissionRecord | undefined;
		let correctionWork = work;
		for (let correction = 0; correction < 10; correction++) {
			try {
				await this.assertCurrent(work);
				this.inFlight.get(work.roundId)!.phase = "model";
				const submitted = await this.worker.runExecution(correctionWork);
				await this.assertCurrent(work, "late_submission_ignored");
				if ("report" in submitted) {
					await this.recordExecutionBlock(work, submitted.report);
					return;
				}
				let sourceWorkspace: string | undefined;
				try {
					this.inFlight.get(work.roundId)!.phase = "export";
					sourceWorkspace = await this.worker.exportSubmission?.(work, submitted, work.signal);
					await this.assertCurrent(work);
					record = await this.submissions.seal({
						run: this.directory,
						runId: work.runId,
						node,
						roundId: work.roundId,
						submissionId: `${work.roundId}:generation:${work.generation ?? 0}:submission`,
						inputSubmissionIds: work.inputSubmissions.map((item) => item.submissionId),
						submission: submitted,
						sourceWorkspace,
						signal: work.signal,
					});
					this.unregisteredSubmissions.add(record.submissionId);
				} finally {
					if (sourceWorkspace) await rm(sourceWorkspace, { recursive: true, force: true });
				}
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
		this.inFlight.get(work.roundId)!.phase = "check";
		for (const output of record.outputs) {
			await this.assertCurrent(work);
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
				work.signal,
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
		const accepted = await this.store.mutate(
			work.runId,
			`submit:${work.roundId}:${work.generation ?? 0}`,
			{ submissionId: record.submissionId },
			(draft, event) => applyCandidateSubmission(draft, event, work, record, mechanicalChecks, result),
		);
		if (accepted) this.unregisteredSubmissions.delete(record.submissionId);
	}

	private async runReview(work: NodeRoundWork): Promise<void> {
		let report: SubmitReview | undefined;
		let correctionWork = work;
		for (let correction = 0; correction < 10; correction++) {
			try {
				await this.assertCurrent(work);
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
		const invalidatedRounds = await this.store.mutate(
			work.runId,
			`review:${work.roundId}:${work.generation ?? 0}`,
			{ decision: report.decision },
			(draft, event) => applyReviewDecision(draft, event, work, report),
		);
		if (invalidatedRounds.length > 0) {
			const state = await this.store.read(work.runId);
			const baseline = requireBaseline(state);
			try {
				await bounded(
					Promise.all(
						invalidatedRounds.map(async (invalidated) => {
							const execution = this.inFlight.get(invalidated.roundId);
							execution?.controller.abort("Input submission or approval invalidated");
							const affected = baselineIndex(baseline).nodes.get(invalidated.nodeId);
							const participant = affected?.agents[0];
							try {
								if (participant)
									await this.worker.stopRound?.(
										work.runId,
										invalidated.nodeId,
										participant.participantId,
										invalidated.roundId,
									);
							} catch (error) {
								throw new Error(
									`Stopping ${invalidated.roundId} during ${execution?.phase ?? "settled"} failed`,
									{ cause: error },
								);
							}
							await execution?.operation.catch(() => {});
						}),
					),
					this.stopTimeoutMs,
					"Invalidated round cleanup",
				);
			} catch (error) {
				await this.recordCleanupFailure(error);
				await this.suspend(
					"paused",
					`Invalidated round cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
					"cleanup_failed",
				);
			}
		}
	}
}
