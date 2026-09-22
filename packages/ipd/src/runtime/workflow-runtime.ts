// 调度冻结工作流并实施提交、检查、评审、返工和收口。
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ReportNodeBlocked, SubmitReview } from "../adapter/structured-submissions.ts";
import { ArtifactValidationError } from "../artifact/manifest.ts";
import { baselineIndex } from "../compiler/baseline-index.ts";
import type { EffectiveNode, ExecutionBaseline } from "../contracts/baseline.ts";
import type { EvidenceRecord } from "../contracts/governance.ts";
import { emptyGovernanceState } from "../contracts/governance.ts";
import type { MechanicalCheckRecord, RunControllerRecord, RunState, SubmissionRecord } from "../contracts/runtime.ts";
import type { TaskInput } from "../contracts/task-input.ts";
import type { ExecutionNode, ReviewNode } from "../contracts/workflow.ts";
import type { MechanicalChecker } from "../gate/mechanical-checker.ts";
import { hashJson, toJsonValue } from "../ir/hash.ts";
import { validateCandidateEvidence, validateReviewEvidence } from "./evidence-validation.ts";
import {
	claimExecution,
	claimRunController,
	type ExecutionStamp,
	executionIsCurrent,
	finishExecution,
	incrementScopeEpoch,
	interruptActiveExecution,
	markDispatchDelivering,
	markDispatchStarted,
	recordFailure,
	registerExternalOperation,
	registerNodeWait,
	requireCurrentController,
	settleExternalOperation,
} from "./execution-control.ts";
import type { materializeFinalSubmission } from "./final-submission.ts";
import { RunFinalizer } from "./finalization-coordinator.ts";
import { applyCandidateSubmission, applyReviewDecision } from "./governance-transitions.ts";
import { bounded, isTerminal } from "./lifecycle.ts";
import { dispatchKindFor } from "./node-prompts.ts";
import { type NodeRoundWork, NodeSubmissionProtocolError, type NodeWorker, NodeWorkerError } from "./node-worker.ts";
import { assignedFindings, validateFindingResolutions } from "./quality-findings.ts";
import type { ResourceAdmission } from "./resource-admission.ts";
import { buildReviewBundle } from "./review-bundle.ts";
import { sealReviewEvidence } from "./review-evidence-store.ts";
import { validateReviewSubmission } from "./review-validation.ts";
import type { RunDirectory } from "./run-directory.ts";
import { classifyRunRecovery } from "./run-recovery.ts";
import type { RunStore } from "./run-store.ts";
import {
	completionProblems,
	markRunCancelled,
	nodeIsReady,
	nodeWaitConditions,
	projectInputSubmissions,
	readyNodes,
	requireBaseline,
	resolveInputBindings,
	reworkFeedback,
	roundInputsAreValid,
	runIsComplete,
	taskContextForNode,
} from "./runtime-state.ts";
import { preservableOutputs, preservedOutputsFor } from "./submission-governance.ts";
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
	admission?: ResourceAdmission;
	controller?: Pick<RunControllerRecord, "controllerId" | "term">;
	finalizer?: typeof materializeFinalSubmission;
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
	private readonly finalizer: RunFinalizer;
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
	private controllerId?: string;
	private controllerTerm?: number;
	private recoveryValidated = false;
	private readonly admission?: ResourceAdmission;

	constructor(
		store: RunStore,
		directory: RunDirectory,
		worker: NodeWorker,
		submissions: SubmissionStore,
		mechanical: MechanicalChecker,
		options: WorkflowRuntimeOptions = {},
	) {
		this.store = store;
		this.admission = options.admission;
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
		this.finalizer = new RunFinalizer(store, directory, { materialize: options.finalizer });
		this.controllerId = options.controller?.controllerId;
		this.controllerTerm = options.controller?.term;
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
			runtimeSchemaVersion: 3,
			governance: emptyGovernanceState(),
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
				scopeEpoch: 1,
				nextRound: 1,
			})),
			rounds: [],
			submissions: [],
			reviews: [],
			approvals: [],
			mechanicalChecks: [],
			attempts: [],
			dispatchIntents: [],
			waits: [],
			failures: [],
			externalOperations: [],
			providerRequests: [],
			completionCandidates: [],
			activeResources: [],
			events: [],
			operations: {},
		};
		try {
			const existing = await this.store.read(baseline.runId);
			const controllerId = this.controllerId ?? existing.controller?.controllerId ?? randomUUID();
			const controller = await this.store.mutate(
				baseline.runId,
				`activate:${baseline.baselineId}`,
				{ baselineId: baseline.baselineId, controllerId, controllerTerm: this.controllerTerm ?? null },
				(draft, event) => {
					if (draft.status !== "running") throw new Error("Run is not active during Baseline activation");
					const claimed = claimRunController(draft, controllerId, { expectedTerm: this.controllerTerm });
					draft.phase = "execute";
					draft.baseline = baseline;
					draft.nodes = state.nodes;
					event.emit("baseline_activated", {
						baselineId: baseline.baselineId,
						controllerId: claimed.controllerId,
						controllerTerm: claimed.term,
					});
					return { controllerId: claimed.controllerId, term: claimed.term };
				},
			);
			this.controllerId = controller.controllerId;
			this.controllerTerm = controller.term;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (!taskInput) throw new Error("Cannot activate a new Run without its TaskInput");
			const claimed = claimRunController(state, this.controllerId ?? randomUUID(), {
				expectedTerm: this.controllerTerm,
			});
			this.controllerId = claimed.controllerId;
			this.controllerTerm = claimed.term;
			await this.store.create(state);
		}
	}

	async recover(): Promise<void> {
		let state = await this.store.read(this.directory.runId);
		let boundary = classifyRunRecovery(state);
		if (boundary.kind === "unsupported") throw new Error(boundary.reason);
		if (boundary.kind === "pending_dispatch")
			throw new Error("Pending dispatches must be fenced by the service controller before Runtime recovery");
		if (boundary.kind === "interrupted_execution") {
			await this.recoverInterruptedExecution(state);
			state = await this.store.read(this.directory.runId);
			boundary = { kind: "paused_execution" };
		}
		const recoverableFinalization = boundary.kind === "finalization";
		if (!state.baseline) throw new Error("Cannot recover a Run without its frozen Baseline");
		for (const resource of state.activeResources)
			this.admission?.retain(state.runId, `${resource.nodeId}/${resource.participantId}`);
		const controller = state.controller;
		if (!controller || controller.status !== "active") throw new Error("Recovered Run has no active controller");
		if (this.controllerId && this.controllerId !== controller.controllerId)
			throw new Error("Recovered Runtime controller identity does not match the Run");
		if (this.controllerTerm !== undefined && this.controllerTerm !== controller.term)
			throw new Error("Recovered Runtime controller term does not match the Run");
		this.controllerId = controller.controllerId;
		this.controllerTerm = controller.term;
		this.baselineHash = hashJson(state.baseline);
		if (!recoverableFinalization) {
			await this.worker.validateResume?.(state);
			this.recoveryValidated = true;
		}
	}

	private async recoverInterruptedExecution(state: RunState): Promise<void> {
		const controller = this.controller();
		requireCurrentController(state, controller.controllerId, controller.term);
		if (!this.worker.recoverInterrupted)
			throw new Error("Node Worker cannot quarantine resources from an interrupted execution");
		const progress = await this.worker.recoverInterrupted(state);
		await this.store.mutate(
			state.runId,
			`interrupted-execution-recovered:${controller.term}`,
			toJsonValue(progress),
			(draft, event) => {
				requireCurrentController(draft, controller.controllerId, controller.term);
				if (draft.status !== "running") throw new Error("Interrupted Run changed before recovery was committed");
				const activeAttemptIds = new Set(
					draft.attempts
						.filter((attempt) => ["claimed", "dispatching", "active"].includes(attempt.status))
						.map((attempt) => attempt.attemptId),
				);
				for (const operation of draft.externalOperations) {
					if (operation.outcome !== "pending" || !activeAttemptIds.has(operation.attemptId)) continue;
					operation.outcome = "unknown";
					operation.updatedAt = Date.now();
				}
				for (const node of draft.nodes.filter((candidate) => candidate.activeAttemptId)) {
					const attemptId = node.activeAttemptId!;
					const attempt = draft.attempts.find((candidate) => candidate.attemptId === attemptId);
					if (!attempt) throw new Error(`Interrupted Attempt record is missing: ${attemptId}`);
					const roundId = attempt.roundId;
					interruptActiveExecution(draft, node.nodeId, "paused", "outcome_unknown");
					incrementScopeEpoch(draft, node.nodeId);
					node.resumeRoundId = roundId;
					node.activeRoundId = undefined;
					node.status = "paused";
					const round = draft.rounds.find((candidate) => candidate.roundId === roundId);
					if (round) round.status = "paused";
					if (
						draft.externalOperations.some(
							(operation) => operation.attemptId === attemptId && operation.outcome === "unknown",
						)
					)
						registerNodeWait({
							state: draft,
							nodeId: node.nodeId,
							participantId: attempt.participantId,
							roundId,
							attemptId,
							kind: "external_operation",
							reason: "A network-capable tool was interrupted before its outcome receipt was durable",
							missingConditions: ["Reconcile every unknown external operation outcome"],
							wakeEvents: ["external_operation_reconciled"],
						});
				}
				draft.generation = (draft.generation ?? 0) + 1;
				draft.status = "paused";
				draft.cleanup = { status: "complete", resources: structuredClone(draft.activeResources) };
				draft.workProgress = progress.map((reference) => structuredClone(reference));
				draft.interruption = {
					reason: "Recovered after the previous execution controller stopped unexpectedly",
					timestamp: Date.now(),
					baselineHash: this.baselineHash,
				};
				if (draft.externalOperations.some((operation) => operation.outcome === "unknown"))
					draft.failure = {
						code: "external_outcome_unknown",
						message: "Interrupted external operations require reconciliation before execution can resume",
					};
				event.emit("interrupted_execution_recovered", {
					controllerTerm: controller.term,
					progressCount: progress.length,
					unknownExternalOperations: draft.externalOperations.filter(
						(operation) => operation.outcome === "unknown",
					).length,
				});
				return true;
			},
		);
	}

	private controller(): Pick<RunControllerRecord, "controllerId" | "term"> {
		if (!this.controllerId || this.controllerTerm === undefined)
			throw new Error("Workflow Runtime has not acquired execution control");
		return { controllerId: this.controllerId, term: this.controllerTerm };
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
			const controller = this.controller();
			requireCurrentController(state, controller.controllerId, controller.term);
			if (this.running.size === 0 && runIsComplete(state)) {
				const committed = await this.finalizer.finalize(state, controller, this.abortController.signal);
				if (!committed) continue;
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
				const operation = this.runAdmittedNode(state.runId, node).finally(() => this.running.delete(nodeId));
				this.running.set(nodeId, operation);
			}
			if (this.running.size === 0) {
				await this.recordDependencyWaits(state);
				const current = await this.store.read(state.runId);
				const blockedNode = current.nodes.find((node) => node.status === "blocked" && node.block);
				return this.suspend(
					current.nodes.some((node) => node.status === "paused") ? "paused" : "blocked",
					current.failure?.message ?? blockedNode?.block?.reason ?? completionProblems(current).join("; "),
				);
			}
			await Promise.race(this.running.values());
		}
	}

	private async runAdmittedNode(runId: string, node: EffectiveNode): Promise<void> {
		if (!this.admission) return this.runNode(runId, node);
		const signal = this.abortController.signal;
		const state = await this.store.read(runId);
		const nodeId = node.definition.node_id;
		const current = state.nodes.find((item) => item.nodeId === nodeId)!;
		const key = `${runId}:${nodeId}:${current.scopeEpoch}:${current.nextRound}`;
		if (!this.admission.isAvailable(runId))
			await this.store.mutate(runId, `resource-wait:${key}`, { key }, (draft, event) => {
				registerNodeWait({
					state: draft,
					nodeId,
					participantId: node.agents[0].participantId,
					roundId: `admission:${key}`,
					kind: "resource",
					reason: "Shared execution capacity is occupied",
					missingConditions: ["execution_slot"],
					wakeEvents: ["resource_released"],
				});
				event.emit("resource_waiting", { nodeId });
				return true;
			});
		let release: (() => void) | undefined;
		try {
			release = await this.admission.acquire(runId, key, signal);
			this.admission.retain(runId, `${nodeId}/${node.agents[0].participantId}`);
			await this.runNode(runId, node);
			// A timeout only ends the waiter; the slot remains owned until the real operation settles.
			const running = [...this.inFlight.values()].filter((item) => item.work.node.definition.node_id === nodeId);
			if (running.length) {
				const eventualRelease = release;
				release = undefined;
				void Promise.allSettled(running.map((item) => item.operation)).then(() => eventualRelease());
			}
		} catch (error) {
			if (signal.aborted) return;
			if (error instanceof NodeWorkerError && error.kind === "resource_capacity") {
				await this.store.mutate(
					runId,
					`resource-capacity:${key}`,
					{ key, message: error.message },
					(draft, event) => {
						const runtime = draft.nodes.find((item) => item.nodeId === nodeId)!;
						runtime.status = "blocked";
						registerNodeWait({
							state: draft,
							nodeId,
							participantId: node.agents[0].participantId,
							roundId: `capacity:${key}`,
							kind: "resource",
							reason: error.message,
							missingConditions: ["retained_capacity"],
							wakeEvents: ["resource_released"],
						});
						recordFailure(draft, undefined, {
							nodeId,
							phase: "prepare",
							classification: "resource_capacity",
							message: error.message,
							retryUnchanged: false,
							affectedScope: "node",
						});
						event.emit("resource_capacity_exceeded", { nodeId, message: error.message });
						return true;
					},
				);
				return;
			}
			throw error;
		} finally {
			release?.();
		}
	}

	private async recordDependencyWaits(state: RunState): Promise<void> {
		const baseline = requireBaseline(state);
		await this.store.mutate(
			state.runId,
			`wait-snapshot:${state.revision}`,
			{ revision: state.revision },
			(draft, event) => {
				let count = 0;
				for (const node of baseline.nodes) {
					const runtime = draft.nodes.find((item) => item.nodeId === node.definition.node_id);
					if (
						!runtime ||
						["active", "succeeded", "cancelled"].includes(runtime.status) ||
						nodeIsReady(node, draft)
					)
						continue;
					if (draft.waits.some((wait) => wait.nodeId === runtime.nodeId && wait.state === "waiting")) continue;
					registerNodeWait({
						state: draft,
						nodeId: runtime.nodeId,
						participantId: node.agents[0].participantId,
						roundId: runtime.activeRoundId ?? runtime.resumeRoundId,
						attemptId: runtime.activeAttemptId,
						kind: runtime.status === "blocked" ? "business_condition" : "dependency",
						reason: runtime.block?.reason ?? "Node readiness conditions are not satisfied",
						missingConditions: nodeWaitConditions(node, draft),
						wakeEvents: ["submission_recorded", "review_recorded", "run_resumed"],
					});
					count++;
				}
				event.emit("run_waiting", { count });
				return count;
			},
		);
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
		const controller = this.controller();
		requireCurrentController(before, controller.controllerId, controller.term);
		await this.store.mutate(before.runId, `suspend:${before.revision}`, { status, reason }, (draft, event) => {
			if (isTerminal(draft.status)) return false;
			requireCurrentController(draft, controller.controllerId, controller.term);
			if (draft.status === "running") draft.generation = (draft.generation ?? 0) + 1;
			draft.status = status;
			draft.cleanup = { status: "pending", resources: this.inspectResources() };
			if (code) draft.failure = { code, message: reason };
			draft.interruption = { reason, timestamp: Date.now(), baselineHash: this.baselineHash };
			for (const node of draft.nodes) {
				if (node.status !== "active") continue;
				interruptActiveExecution(draft, node.nodeId, "paused", "cancelled");
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
		const controller = this.controller();
		requireCurrentController(state, controller.controllerId, controller.term);
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
		if (state.externalOperations.some((operation) => operation.outcome === "unknown"))
			throw new Error("An external operation outcome requires explicit reconciliation before resume");
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
		if (!this.recoveryValidated) await this.worker.validateResume?.(state);
		await this.store.mutate(
			state.runId,
			`resume:${state.revision}`,
			{ generation: state.generation ?? 0 },
			(draft, event) => {
				if (draft.revision !== state.revision || !["paused", "blocked"].includes(draft.status))
					throw new Error("Run changed during resume validation");
				requireCurrentController(draft, controller.controllerId, controller.term);
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
		this.recoveryValidated = false;
	}

	async cancel(reason = "Run cancelled"): Promise<RunState> {
		const state = await this.store.read(this.directory.runId);
		if (!isTerminal(state.status))
			await this.store.mutate(state.runId, `cancel:${state.revision}`, { reason }, (draft, event) => {
				if (isTerminal(draft.status)) return false;
				const controller = this.controller();
				requireCurrentController(draft, controller.controllerId, controller.term);
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
				await Promise.allSettled(this.running.values());
				await this.cleanupUnregistered();
				this.admission?.releaseRoot(this.directory.runId);
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
		if (work.signal?.aborted || !executionIsCurrent(state, work.node.definition.node_id, work.roundId, work.stamp)) {
			if (lateEvent)
				await this.store.mutate(
					work.runId,
					`${lateEvent}:${work.stamp.attemptId}`,
					{ attemptId: work.stamp.attemptId, commandId: work.stamp.commandId },
					(_draft, event) => {
						event.emit(
							lateEvent,
							{
								attemptId: work.stamp.attemptId,
								controllerTerm: work.stamp.controllerTerm,
								scopeEpoch: work.stamp.scopeEpoch,
							},
							work.node.definition.node_id,
							work.roundId,
						);
						return false;
					},
				);
			throw new NodeWorkerError("cancelled", "Execution Attempt is no longer eligible to submit");
		}
	}

	private async runNode(runId: string, node: EffectiveNode): Promise<void> {
		const state = await this.store.read(runId);
		const controller = this.controller();
		requireCurrentController(state, controller.controllerId, controller.term);
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
					recordFailure(draft, undefined, {
						nodeId: current.nodeId,
						phase: "runtime",
						classification: "quality_rework_exhausted",
						message: "Quality rework limit reached",
						retryUnchanged: false,
						affectedScope: "node",
					});
					registerNodeWait({
						state: draft,
						nodeId: current.nodeId,
						participantId: node.agents[0].participantId,
						kind: "business_condition",
						reason: "Quality rework limit reached",
						missingConditions: ["Explicit quality-policy reconciliation"],
						wakeEvents: ["quality_policy_reconciled"],
					});
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
		const resuming = record.resumeRoundId !== undefined;
		const proposedAttempt = state.attempts.filter((attempt) => attempt.roundId === roundId).length + 1;
		const claim = await this.store.mutate(
			runId,
			`claim:${roundId}:${controller.term}:${record.scopeEpoch}:${proposedAttempt}`,
			{ roundId, controllerTerm: controller.term, scopeEpoch: record.scopeEpoch, attempt: proposedAttempt },
			(draft, event) => {
				requireCurrentController(draft, controller.controllerId, controller.term);
				if (draft.status !== "running" || (draft.generation ?? 0) !== generation || !nodeIsReady(node, draft))
					return { started: false as const, stamp: null, bindings: [] };
				const current = draft.nodes.find((item) => item.nodeId === node.definition.node_id)!;
				if (current.scopeEpoch !== record.scopeEpoch) return { started: false as const, stamp: null, bindings: [] };
				const bindings = resolveInputBindings(node, draft);
				const bindingRecords = bindings.map(({ submission: _submission, ...binding }) => structuredClone(binding));
				const submissionIds = [...new Set(bindings.map((item) => item.submissionId))];
				delete current.block;
				current.status = "active";
				current.activeRoundId = roundId;
				const continuing = draft.rounds.find((round) => round.roundId === current.resumeRoundId);
				delete current.resumeRoundId;
				if (continuing) {
					continuing.status = "active";
					continuing.generation = generation;
					continuing.attempt = proposedAttempt;
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
						inputBindings: bindingRecords,
						startedAt: Date.now(),
					});
				}
				const feedback = reworkFeedback(node, draft);
				const stamp = claimExecution({
					state: draft,
					controllerId: controller.controllerId,
					controllerTerm: controller.term,
					nodeId: current.nodeId,
					participantId: node.agents[0].participantId,
					roundId,
					operation: dispatchKindFor(node.definition.kind, resuming, feedback),
					inputBindings: bindingRecords,
					inputBindingHash: hashJson(bindingRecords),
				});
				if (node.definition.kind === "review") {
					const bundle = buildReviewBundle(draft, node, stamp.attemptId, bindingRecords);
					draft.governance.reviewBundles.push(bundle);
					draft.rounds.find((round) => round.roundId === roundId)!.reviewBundleId = bundle.bundleId;
				}
				event.emit(
					"round_started",
					{
						generation,
						attempt: stamp.attemptIndex,
						attemptId: stamp.attemptId,
						commandId: stamp.commandId,
						controllerTerm: stamp.controllerTerm,
						scopeEpoch: stamp.scopeEpoch,
						executionPolicy: {
							roundTimeoutMs: this.roundTimeoutMs,
							softRoundTimeoutMs: this.softRoundTimeoutMs ?? 0,
							stopTimeoutMs: this.stopTimeoutMs,
						},
					},
					current.nodeId,
					roundId,
				);
				return { started: true as const, stamp, bindings: bindingRecords };
			},
		);
		if (!claim.started) return;
		const claimedState = await this.store.read(runId);
		const bindings = claim.bindings.map((binding) => {
			const submission = claimedState.submissions.find(
				(candidate) => candidate.submissionId === binding.submissionId,
			);
			if (!submission) throw new Error(`Claimed input Submission is unavailable: ${binding.submissionId}`);
			return { ...structuredClone(binding), submission };
		});
		const inputs = projectInputSubmissions(bindings);
		const work: NodeRoundWork = {
			stamp: claim.stamp,
			generation,
			resuming,
			signal,
			onDispatchDelivering: () => this.recordDispatchDelivering(work),
			onDispatchStarted: () => this.recordDispatchStarted(runId, node.definition.node_id, roundId, claim.stamp),
			onProviderRequest: (observation) =>
				this.recordProviderRequest(runId, node.definition.node_id, roundId, claim.stamp, observation),
			externalOperations: {
				begin: (intent) =>
					this.recordExternalOperationStart(
						runId,
						node.definition.node_id,
						node.agents[0].participantId,
						roundId,
						claim.stamp,
						intent,
					),
				settle: (operationId, outcome, receiptRef) =>
					this.recordExternalOperationOutcome(
						runId,
						node.definition.node_id,
						roundId,
						operationId,
						outcome,
						receiptRef,
					),
			},
			onResourcesChanged: (resources) =>
				this.recordActiveResources(runId, node.definition.node_id, roundId, claim.stamp, resources),
			runId,
			roundId,
			node,
			inputSubmissions: inputs,
			inputBindings: bindings.map(({ submission: _submission, ...binding }) => structuredClone(binding)),
			taskContext: taskContextForNode(node, claimedState),
			forbiddenMutableReadPaths: requireBaseline(claimedState)
				.nodes.filter(
					(candidate) =>
						candidate.definition.kind === "execution" && candidate.definition.node_id !== node.definition.node_id,
				)
				.flatMap((candidate) =>
					candidate.definition.kind === "execution"
						? candidate.definition.outputs.map((output) => output.path_prefix)
						: [],
				),
			feedback: reworkFeedback(node, claimedState),
			findings: assignedFindings(claimedState, node.definition.node_id),
			reviewBundle: claimedState.governance.reviewBundles.find(
				(bundle) => bundle.attemptId === claim.stamp.attemptId,
			),
			preservableOutputs: preservableOutputs(claimedState, node.definition.node_id),
			governanceContract: {
				requirements: requireBaseline(claimedState).workflow.requirements,
				decisions: requireBaseline(claimedState).workflow.decisions,
				stages: requireBaseline(claimedState).workflow.stages?.filter(
					(stage) =>
						stage.member_node_ids.includes(node.definition.node_id) ||
						stage.exits.some((exit) => exit.gate_node_ids.includes(node.definition.node_id)),
				),
			},
			environmentBinding: requireBaseline(claimedState).environmentBindings.find(
				(binding) =>
					binding.nodeId === node.definition.node_id && binding.participantId === node.agents[0].participantId,
			),
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

	private async recordDispatchDelivering(work: NodeRoundWork): Promise<void> {
		const applied = await this.store.mutate(
			work.runId,
			`dispatch-delivering:${work.stamp.commandId}`,
			{ attemptId: work.stamp.attemptId, commandId: work.stamp.commandId },
			(draft, event) => {
				if (!executionIsCurrent(draft, work.node.definition.node_id, work.roundId, work.stamp)) return false;
				markDispatchDelivering(draft, work.node.definition.node_id, work.roundId, work.stamp);
				event.emit(
					"dispatch_delivering",
					{ attemptId: work.stamp.attemptId, commandId: work.stamp.commandId },
					work.node.definition.node_id,
					work.roundId,
				);
				return true;
			},
		);
		if (!applied) throw new NodeWorkerError("cancelled", `Dispatch is no longer current: ${work.stamp.commandId}`);
	}

	private async recordActiveResources(
		runId: string,
		nodeId: string,
		roundId: string,
		stamp: ExecutionStamp,
		resources: readonly RunState["activeResources"][number][],
	): Promise<boolean> {
		const snapshot = resources.map((resource) => structuredClone(resource));
		return this.store.mutate(
			runId,
			`active-resources:${stamp.attemptId}:${hashJson(snapshot)}`,
			toJsonValue(snapshot),
			(draft, event) => {
				if (!executionIsCurrent(draft, nodeId, roundId, stamp)) return false;
				draft.activeResources = [
					...draft.activeResources.filter((resource) => resource.nodeId !== nodeId),
					...snapshot.filter((resource) => resource.nodeId === nodeId),
				];
				event.emit(
					"active_resources_recorded",
					{ attemptId: stamp.attemptId, count: snapshot.length },
					nodeId,
					roundId,
				);
				return true;
			},
		);
	}

	private async recordDispatchStarted(
		runId: string,
		nodeId: string,
		roundId: string,
		stamp: ExecutionStamp,
	): Promise<void> {
		const applied = await this.store.mutate(
			runId,
			`dispatch-started:${stamp.commandId}`,
			{ attemptId: stamp.attemptId, commandId: stamp.commandId },
			(draft, event) => {
				if (!executionIsCurrent(draft, nodeId, roundId, stamp)) return false;
				markDispatchStarted(draft, nodeId, roundId, stamp);
				event.emit("dispatch_started", { attemptId: stamp.attemptId, commandId: stamp.commandId }, nodeId, roundId);
				return true;
			},
		);
		if (!applied) throw new NodeWorkerError("cancelled", `Dispatch is no longer current: ${stamp.commandId}`);
	}

	private async recordProviderRequest(
		runId: string,
		nodeId: string,
		roundId: string,
		stamp: ExecutionStamp,
		observation: Parameters<NonNullable<NodeRoundWork["onProviderRequest"]>>[0],
	): Promise<boolean> {
		return this.store.mutate(
			runId,
			`provider-request:${observation.requestId}`,
			toJsonValue(observation),
			(draft, event) => {
				const current = executionIsCurrent(draft, nodeId, roundId, stamp);
				const record = {
					...structuredClone(observation),
					attemptId: stamp.attemptId,
					commandId: stamp.commandId,
					nodeId,
					createdAt: Date.now(),
					...(current ? {} : { status: "rejected" as const, reasonCode: "stale_dispatch" as const }),
				};
				draft.providerRequests.push(record);
				event.emit(
					current && record.status === "admitted" ? "provider_request_admitted" : "provider_request_rejected",
					{
						requestId: record.requestId,
						attemptId: record.attemptId,
						serializedBytes: record.serializedBytes,
						imageCount: record.imageCount,
						reasonCode: record.reasonCode ?? null,
					},
					nodeId,
					roundId,
				);
				return current;
			},
		);
	}

	private async recordExternalOperationStart(
		runId: string,
		nodeId: string,
		participantId: string,
		roundId: string,
		stamp: ExecutionStamp,
		intent: Parameters<NonNullable<NodeRoundWork["externalOperations"]>["begin"]>[0],
	): Promise<string> {
		const operationId = `${stamp.attemptId}:external:${intent.operationKey}`;
		const registered = await this.store.mutate(
			runId,
			`external-operation-start:${operationId}`,
			toJsonValue(intent),
			(draft, event) => {
				if (!executionIsCurrent(draft, nodeId, roundId, stamp)) return false;
				registerExternalOperation({
					state: draft,
					stamp,
					nodeId,
					participantId,
					operationId,
					intentRef: intent.intentRef,
					requestHash: intent.requestHash,
					authorizationRef: intent.authorizationRef,
					targetRef: intent.targetRef,
				});
				event.emit(
					"external_operation_started",
					{ operationId, attemptId: stamp.attemptId, intentRef: intent.intentRef },
					nodeId,
					roundId,
				);
				return true;
			},
		);
		if (!registered)
			throw new NodeWorkerError("cancelled", `External operation is no longer authorized: ${operationId}`);
		return operationId;
	}

	private async recordExternalOperationOutcome(
		runId: string,
		nodeId: string,
		roundId: string,
		operationId: string,
		outcome: Parameters<NonNullable<NodeRoundWork["externalOperations"]>["settle"]>[1],
		receiptRef?: string,
	): Promise<void> {
		await this.store.mutate(
			runId,
			`external-operation-outcome:${operationId}:${outcome}`,
			{ operationId, outcome, receiptRef: receiptRef ?? null },
			(draft, event) => {
				settleExternalOperation(draft, operationId, outcome, receiptRef);
				event.emit(
					"external_operation_settled",
					{ operationId, outcome, receiptRef: receiptRef ?? null },
					nodeId,
					roundId,
				);
				return true;
			},
		);
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
		} finally {
			if (timeout) clearTimeout(timeout);
			if (soft) clearTimeout(soft);
			work.signal?.removeEventListener("abort", abort);
		}
	}

	private async recordExecutionBlock(work: NodeRoundWork, report: ReportNodeBlocked): Promise<void> {
		const blockId = `${work.stamp.attemptId}:block`;
		await this.store.mutate(
			work.runId,
			`business-blocked:${work.stamp.attemptId}`,
			toJsonValue(report),
			(draft, event) => {
				const node = draft.nodes.find((item) => item.nodeId === work.node.definition.node_id)!;
				const round = draft.rounds.find((item) => item.roundId === work.roundId)!;
				if (
					!executionIsCurrent(draft, work.node.definition.node_id, work.roundId, work.stamp) ||
					!roundInputsAreValid(work.node, round, draft)
				) {
					event.emit("late_block_ignored", { blockId }, node.nodeId, work.roundId);
					return false;
				}
				node.status = "blocked";
				node.block = {
					blockId,
					roundId: work.roundId,
					attemptId: work.stamp.attemptId,
					reason: report.reason,
					missingConditions: [...report.missing_conditions],
					attemptedActions: [...report.attempted_actions],
					evidence: toJsonValue(report.evidence),
					neededToResume: [...report.needed_to_resume],
					createdAt: Date.now(),
				};
				finishExecution(draft, node.nodeId, work.roundId, work.stamp, "completed", "completed");
				node.activeRoundId = undefined;
				round.status = "blocked";
				round.finishedAt = Date.now();
				registerNodeWait({
					state: draft,
					nodeId: node.nodeId,
					participantId: work.node.agents[0].participantId,
					roundId: work.roundId,
					attemptId: work.stamp.attemptId,
					kind: "business_condition",
					reason: report.reason,
					missingConditions: report.missing_conditions,
					wakeEvents: ["business_condition_updated", "run_resumed"],
				});
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
		const execution = this.inFlight.get(work.roundId);
		const phase = execution?.phase ?? "runtime";
		const applied = await this.store.mutate(
			work.runId,
			`round-failed:${work.stamp.attemptId}`,
			{ kind: failure.kind, message: failure.message, attemptId: work.stamp.attemptId },
			(draft, event) => {
				const node = draft.nodes.find((item) => item.nodeId === work.node.definition.node_id)!;
				if (!executionIsCurrent(draft, work.node.definition.node_id, work.roundId, work.stamp)) {
					event.emit(
						"late_failure_ignored",
						{ kind: failure.kind, message: failure.message },
						node.nodeId,
						work.roundId,
					);
					return false;
				}
				const paused = ["transient", "timeout", "cancelled", "request_capacity"].includes(failure.kind);
				node.status = paused ? "paused" : "blocked";
				draft.failure = { code: failure.kind, message: failure.message };
				node.resumeRoundId = work.roundId;
				const round = draft.rounds.find((item) => item.roundId === work.roundId)!;
				const failureRecord = recordFailure(draft, work.stamp, {
					nodeId: node.nodeId,
					roundId: work.roundId,
					phase,
					classification: failure.kind,
					message: failure.message,
					retryUnchanged: failure.retryable,
					affectedScope: "node",
					details: failure.details ?? { retryable: failure.retryable },
				});
				finishExecution(
					draft,
					node.nodeId,
					work.roundId,
					work.stamp,
					paused ? "paused" : "failed",
					failure.kind === "external_outcome_unknown" ? "outcome_unknown" : "failed",
				);
				node.activeRoundId = undefined;
				incrementScopeEpoch(draft, node.nodeId);
				round.status = paused ? "paused" : "failed";
				round.finishedAt = Date.now();
				registerNodeWait({
					state: draft,
					nodeId: node.nodeId,
					participantId: work.node.agents[0].participantId,
					roundId: work.roundId,
					attemptId: work.stamp.attemptId,
					kind: failure.kind === "external_outcome_unknown" ? "external_operation" : "technical_recovery",
					reason: failure.message,
					missingConditions: [
						failure.kind === "external_outcome_unknown"
							? "Reconcile the external operation outcome"
							: "Repair or verify the failed execution condition",
					],
					wakeEvents: ["run_resumed", "recovery_condition_updated"],
				});
				event.emit(
					"round_blocked",
					{ kind: failure.kind, message: failure.message, failureId: failureRecord.failureId },
					node.nodeId,
					work.roundId,
				);
				return true;
			},
		);
		if (!applied) return;
		execution?.controller.abort(failure.message);
		try {
			await bounded(
				Promise.all([
					this.worker.stopRound?.(
						work.runId,
						work.node.definition.node_id,
						work.node.agents[0].participantId,
						work.roundId,
					),
					execution?.operation.catch(() => {}),
				]),
				this.stopTimeoutMs,
				`Stopping failed Attempt ${work.stamp.attemptId}`,
			);
		} catch (stopError) {
			await this.store.mutate(
				work.runId,
				`attempt-stop-failed:${work.stamp.attemptId}`,
				{ message: stopError instanceof Error ? stopError.message : String(stopError) },
				(draft, event) => {
					registerNodeWait({
						state: draft,
						nodeId: work.node.definition.node_id,
						participantId: work.node.agents[0].participantId,
						roundId: work.roundId,
						attemptId: work.stamp.attemptId,
						kind: "cleanup",
						reason: stopError instanceof Error ? stopError.message : String(stopError),
						missingConditions: ["Confirm the previous Attempt has stopped or is isolated"],
						wakeEvents: ["attempt_stop_confirmed"],
					});
					event.emit(
						"attempt_stop_failed",
						{ attemptId: work.stamp.attemptId },
						work.node.definition.node_id,
						work.roundId,
					);
					return true;
				},
			);
		}
	}

	private async runExecution(work: NodeRoundWork, node: ExecutionNode): Promise<void> {
		let record: SubmissionRecord | undefined;
		let evidence: EvidenceRecord[] = [];
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
					const preservedOutputs = preservedOutputsFor(await this.store.read(work.runId), work, submitted);
					this.inFlight.get(work.roundId)!.phase = "export";
					sourceWorkspace = await this.worker.exportSubmission?.(work, submitted, work.signal);
					await this.assertCurrent(work);
					record = await this.submissions.seal({
						run: this.directory,
						runId: work.runId,
						node,
						roundId: work.roundId,
						attemptId: work.stamp.attemptId,
						submissionId: `${work.stamp.attemptId}:submission`,
						inputSubmissionIds: work.inputSubmissions.map((item) => item.submissionId),
						submission: submitted,
						sourceWorkspace,
						signal: work.signal,
						preservedOutputs,
					});
					this.unregisteredSubmissions.add(record.submissionId);
					evidence = await validateCandidateEvidence(record, work);
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
				if (record && this.unregisteredSubmissions.has(record.submissionId)) {
					await rm(join(this.directory.submissions, record.submissionId), { recursive: true, force: true });
					this.unregisteredSubmissions.delete(record.submissionId);
					record = undefined;
				}
				correctionWork = {
					...work,
					feedback: [
						...correctionWork.feedback,
						{
							type: "submission_correction",
							issue: error instanceof Error ? error.message : String(error),
							...(error instanceof ArtifactValidationError
								? { outputId: error.outputId, diagnostics: structuredClone(error.diagnostics) }
								: {}),
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
		this.admission?.checkSealedBytes(
			work.runId,
			state.submissions.reduce(
				(total, submission) =>
					total +
					submission.outputs.reduce(
						(sum, output) => sum + output.manifest.files.reduce((bytes, file) => bytes + file.size, 0),
						0,
					),
				0,
			),
			record.outputs.reduce(
				(total, output) => total + output.manifest.files.reduce((bytes, file) => bytes + file.size, 0),
				0,
			),
		);
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
				attemptId: work.stamp.attemptId,
				submissionId: record.submissionId,
				outputId: output.outputId,
				result: outcome.result,
				feedback: outcome.criteria
					.filter((criterion) => criterion.result !== "PASS")
					.map((criterion) => `${criterion.criterionId}: ${criterion.message}`),
				outcome: toJsonValue(outcome),
				createdAt: Date.now(),
			});
			for (const criterion of outcome.criteria)
				evidence.push({
					evidenceId: `${work.stamp.attemptId}:check:${output.outputId}:${criterion.criterionId}`,
					attemptId: work.stamp.attemptId,
					participantId: "runtime-checker",
					criterionId: criterion.criterionId,
					subjects: [output.revisionId!],
					provenance: "mechanical_execution",
					method: criterion.checkId,
					environmentRef: work.environmentBinding?.bindingId,
					observation: toJsonValue(criterion),
					rawRef: `mechanical:${record.submissionId}:${output.outputId}:${criterion.criterionId}`,
					limitations: ["Only the declared deterministic check was executed; this is not semantic approval."],
					createdAt: Date.now(),
				});
			if (outcome.result === "ERROR") result = "ERROR";
			else if (outcome.result === "FAIL" && result === "PASS") result = "FAIL";
		}
		const accepted = await this.store.mutate(
			work.runId,
			`submit:${work.stamp.attemptId}`,
			{ submissionId: record.submissionId },
			(draft, event) => applyCandidateSubmission(draft, event, work, record, mechanicalChecks, result, evidence),
		);
		if (accepted) this.unregisteredSubmissions.delete(record.submissionId);
	}

	private async runReview(work: NodeRoundWork): Promise<void> {
		let report: SubmitReview | undefined;
		let evidence: EvidenceRecord[] = [];
		let correctionWork = work;
		for (let correction = 0; correction < 10; correction++) {
			try {
				await this.assertCurrent(work);
				report = validateReviewSubmission(
					work.node,
					await this.worker.runReview(correctionWork),
					work.inputSubmissions,
				);
				validateFindingResolutions(await this.store.read(work.runId), work, report);
				const verification = await sealReviewEvidence(this.directory, this.worker, work, report);
				evidence = await validateReviewEvidence(work, report, verification);
				break;
			} catch (error) {
				if (error instanceof NodeWorkerError) throw error;
				report = undefined;
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
			`review:${work.stamp.attemptId}`,
			{ decision: report.decision },
			(draft, event) => applyReviewDecision(draft, event, work, report, evidence),
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
