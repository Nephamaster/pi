import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { NodeRunFailure, NodeRunner, NodeRunTrace, SkillSnapshot } from "../adapter/node-runner.ts";
import {
	type ArtifactManifest,
	ArtifactManifestSchema,
	artifactManifestToJson,
	createArtifactManifest,
} from "../artifact/manifest.ts";
import type { GateCriterionEvaluation, GateEvaluationResult, GateEvaluator } from "../gate/gate-evaluator.ts";
import type { ExecutionNodeDefinition, GateDefinition, WorkflowDefinition } from "../ir/schemas.ts";
import type { CompiledAgentCard, JsonValue } from "../ir/types.ts";
import { validateSchema } from "../ir/validation.ts";
import type { SqliteIpdLedger } from "../ledger/sqlite-ledger.ts";
import type { ArtifactRecord, NodeInstanceRecord, RunSnapshot, RunStatus } from "../ledger/types.ts";
import { type BudgetController, NoopBudgetController } from "./budget-manager.ts";
import { createIpdFailure, type IpdFailure, type IpdFailureCategory, normalizeNodeRunFailure } from "./failure.ts";
import { WorkspaceLockManager } from "./workspace-locks.ts";

export interface GraphRunContext {
	cwd: string;
	skill: SkillSnapshot;
	availableSkills?: readonly SkillSnapshot[];
	runDefaultModel: Model<Api>;
	runDefaultThinkingLevel: ThinkingLevel;
	signal?: AbortSignal;
}

export interface GraphRunResult {
	runId: string;
	status: RunStatus;
	snapshot: RunSnapshot;
}

export class GraphEngineError extends Error {
	readonly code: "invalid_resume";

	constructor(message: string) {
		super(message);
		this.name = "GraphEngineError";
		this.code = "invalid_resume";
	}
}

export interface GraphEngineOptions {
	ledger: SqliteIpdLedger;
	nodeRunner: NodeRunner;
	gateEvaluator: GateEvaluator;
	workspaceLocks?: WorkspaceLockManager;
	budgetController?: BudgetController;
}

interface ActiveRun {
	controller: AbortController;
	promise: Promise<GraphRunResult>;
	attemptIds: Set<string>;
	gateRunIds: Set<string>;
	cancelReason?: string;
}

interface ReadyAttempt {
	node: ExecutionNodeDefinition;
	attempt: NodeInstanceRecord;
}

function cardKey(card: { id: string; version: string; hash: string }): string {
	return `${card.id}@${card.version}#${card.hash}`;
}

function latestAttempts(snapshot: RunSnapshot): Map<string, NodeInstanceRecord> {
	const latest = new Map<string, NodeInstanceRecord>();
	for (const attempt of snapshot.nodes) {
		const current = latest.get(attempt.nodeId);
		if (!current || attempt.attemptNumber > current.attemptNumber) latest.set(attempt.nodeId, attempt);
	}
	return latest;
}

export class GraphEngine {
	private readonly ledger: SqliteIpdLedger;
	private readonly nodeRunner: NodeRunner;
	private readonly gateEvaluator: GateEvaluator;
	private readonly workspaceLocks: WorkspaceLockManager;
	private readonly budgetController: BudgetController;
	private readonly activeRuns = new Map<string, ActiveRun>();

	constructor(options: GraphEngineOptions) {
		this.ledger = options.ledger;
		this.nodeRunner = options.nodeRunner;
		this.gateEvaluator = options.gateEvaluator;
		this.workspaceLocks = options.workspaceLocks ?? new WorkspaceLockManager();
		this.budgetController = options.budgetController ?? new NoopBudgetController();
	}

	run(runId: string, context: GraphRunContext): Promise<GraphRunResult> {
		const existing = this.activeRuns.get(runId);
		if (existing) return existing.promise;
		const controller = new AbortController();
		const active: ActiveRun = {
			controller,
			promise: Promise.resolve(undefined as never),
			attemptIds: new Set(),
			gateRunIds: new Set(),
		};
		const onAbort = () => controller.abort();
		context.signal?.addEventListener("abort", onAbort, { once: true });
		active.promise = this.runInternal(runId, { ...context, signal: controller.signal }, active).finally(() => {
			context.signal?.removeEventListener("abort", onAbort);
			this.activeRuns.delete(runId);
		});
		this.activeRuns.set(runId, active);
		return active.promise;
	}

	async cancel(runId: string, reason = "Cancelled by caller"): Promise<GraphRunResult> {
		const active = this.activeRuns.get(runId);
		if (active) {
			active.cancelReason = reason;
			active.controller.abort();
			await Promise.all([
				...Array.from(active.attemptIds, (attemptId) => this.nodeRunner.abort(attemptId)),
				...Array.from(active.gateRunIds, (gateRunId) => this.gateEvaluator.abort(gateRunId)),
			]);
			return active.promise;
		}
		const snapshot = this.ledger.getRunSnapshot(runId);
		if (["succeeded", "failed", "cancelled"].includes(snapshot.run.status)) {
			return { runId, status: snapshot.run.status, snapshot };
		}
		this.ledger.transitionRun({
			runId,
			idempotencyKey: `graph:${runId}:cancel`,
			status: "cancelled",
			failure: this.failure(runId, "cancelled", "cancelled", reason, false),
		});
		const cancelled = this.ledger.getRunSnapshot(runId);
		return { runId, status: cancelled.run.status, snapshot: cancelled };
	}

	async resume(
		runId: string,
		escalationId: string,
		answer: string,
		context: GraphRunContext,
	): Promise<GraphRunResult> {
		if (answer.trim().length === 0) throw new GraphEngineError("Escalation answer must not be empty");
		const snapshot = this.ledger.getRunSnapshot(runId);
		if (snapshot.run.status !== "waiting_user") {
			throw new GraphEngineError(`Run is not waiting for user input: ${runId}`);
		}
		const escalation = snapshot.escalations.find((item) => item.id === escalationId && item.status === "open");
		if (!escalation) throw new GraphEngineError(`Open Escalation not found: ${escalationId}`);
		this.ledger.answerEscalation({
			runId,
			idempotencyKey: `graph:${runId}:resume:${escalationId}:answer`,
			escalationId,
			answer,
		});
		if (escalation.nodeId) {
			this.ledger.recordDecision({
				runId,
				idempotencyKey: `graph:${runId}:resume:${escalationId}:decision`,
				decisionId: `${escalationId}:user-answer`,
				type: "user_answer",
				action: "retry_node",
				rationale: answer,
				nodeId: escalation.nodeId,
				evidence: { escalationId, answer },
			});
		}
		this.ledger.transitionRun({
			runId,
			idempotencyKey: `graph:${runId}:resume:${escalationId}:running`,
			status: "running",
		});
		return this.run(runId, context);
	}

	private async runInternal(runId: string, context: GraphRunContext, active: ActiveRun): Promise<GraphRunResult> {
		let snapshot = this.ledger.getRunSnapshot(runId);
		if (!snapshot.workflow) throw new Error(`Run has no frozen Workflow: ${runId}`);
		if (snapshot.run.status === "ready") {
			this.ledger.transitionRun({ runId, idempotencyKey: `graph:${runId}:start`, status: "running" });
			snapshot = this.ledger.getRunSnapshot(runId);
		} else if (snapshot.run.status === "running") {
			const recovered = await this.recoverInterruptedWork(runId, snapshot, active);
			if (!recovered) return this.stableResult(runId);
			snapshot = this.ledger.getRunSnapshot(runId);
		} else if (["waiting_user", "succeeded", "failed", "cancelled"].includes(snapshot.run.status)) {
			return { runId, status: snapshot.run.status, snapshot };
		} else {
			throw new Error(`Run cannot execute from ${snapshot.run.status}`);
		}

		while (true) {
			if (active.controller.signal.aborted) return this.finishCancelledRun(runId, active.cancelReason);
			snapshot = this.ledger.getRunSnapshot(runId);
			const workflow = snapshot.workflow?.definition;
			if (!workflow) throw new Error(`Frozen Workflow disappeared: ${runId}`);
			const budget = await this.budgetController.assess(
				runId,
				workflow,
				snapshot,
				workflow.staff.core.map((ref) => this.findAgentCard(snapshot, ref)),
				context,
			);
			if (budget.action !== "continue") return this.stableResult(runId);
			if (this.allNodesSucceeded(workflow, snapshot)) {
				await this.evaluateFinalGate(runId, workflow, snapshot, context, active);
				return this.stableResult(runId);
			}

			const ready = this.createReadyAttempts(runId, workflow, snapshot);
			const afterScheduling = this.ledger.getRunSnapshot(runId);
			if (["waiting_user", "failed", "cancelled"].includes(afterScheduling.run.status)) {
				return { runId, status: afterScheduling.run.status, snapshot: afterScheduling };
			}
			if (ready.length === 0) {
				return this.finishStalledRun(runId, workflow, snapshot);
			}
			await Promise.all(ready.map((item) => this.executeAttempt(runId, item, context, active)));
			const current = this.ledger.getRunSnapshot(runId);
			if (["waiting_user", "failed", "cancelled"].includes(current.run.status)) {
				return { runId, status: current.run.status, snapshot: current };
			}
		}
	}

	private createReadyAttempts(runId: string, workflow: WorkflowDefinition, snapshot: RunSnapshot): ReadyAttempt[] {
		const latest = latestAttempts(snapshot);
		const ready: ReadyAttempt[] = [];
		for (const node of workflow.nodes) {
			const previous = latest.get(node.id);
			if (previous && !["rework_pending", "blocked", "interrupted"].includes(previous.status)) continue;
			if (!node.dependsOn.every((dependency) => latest.get(dependency)?.status === "succeeded")) continue;
			if (!this.dependenciesHaveAcceptedArtifacts(node, snapshot)) continue;
			const attemptNumber = (previous?.attemptNumber ?? 0) + 1;
			if (attemptNumber > node.rework.maxAttempts) {
				this.routeExhausted(runId, node, previous?.attemptId, `Node exhausted ${node.rework.maxAttempts} Attempts`);
				continue;
			}
			const attemptId = `${runId}:node:${node.id}:attempt:${attemptNumber}`;
			this.ledger.createNodeAttempt({
				runId,
				idempotencyKey: `graph:${runId}:node:${node.id}:attempt:${attemptNumber}:create`,
				attemptId,
				nodeId: node.id,
				attemptNumber,
				agentCardRef: node.agentCardRef,
			});
			const readyAttempt = this.ledger.transitionNode({
				runId,
				idempotencyKey: `graph:${runId}:attempt:${attemptId}:ready`,
				attemptId,
				status: "ready",
			});
			ready.push({ node, attempt: readyAttempt });
		}
		return ready;
	}

	private async executeAttempt(
		runId: string,
		item: ReadyAttempt,
		context: GraphRunContext,
		active: ActiveRun,
	): Promise<void> {
		const lock = await this.workspaceLocks
			.acquire(
				{
					ownerId: item.attempt.attemptId,
					readScopes: item.node.permissions.readScopes,
					writeScopes: item.node.permissions.writeScopes,
					usesBash: item.node.tools.includes("bash"),
				},
				active.controller.signal,
			)
			.catch(() => undefined);
		if (!lock || active.controller.signal.aborted) {
			this.cancelAttempt(runId, item.attempt);
			return;
		}
		active.attemptIds.add(item.attempt.attemptId);
		try {
			this.ledger.transitionNode({
				runId,
				idempotencyKey: `graph:${runId}:attempt:${item.attempt.attemptId}:running`,
				attemptId: item.attempt.attemptId,
				status: "running",
			});
			const snapshot = this.ledger.getRunSnapshot(runId);
			const card = this.findAgentCard(snapshot, item.node.agentCardRef);
			const result = await this.nodeRunner.runExecutionNode({
				kind: "execution",
				runId,
				instanceId: item.attempt.attemptId,
				attemptId: item.attempt.attemptId,
				task: snapshot.run.task,
				workflowHash: snapshot.workflow?.hash ?? "",
				cwd: context.cwd,
				agentCard: card,
				skills: item.node.skills.map((name) => {
					const skill = (context.availableSkills ?? [context.skill]).find((candidate) => candidate.name === name);
					if (!skill) throw new Error(`Execution Node Skill Snapshot is unavailable: ${name}`);
					return skill;
				}),
				runDefaultModel: context.runDefaultModel,
				runDefaultThinkingLevel: context.runDefaultThinkingLevel,
				node: item.node,
				inputArtifacts: this.inputArtifacts(item.node, snapshot),
				reworkInstructions: this.reworkInstructions(item.node.id, snapshot),
				timeoutMs: item.node.budget.timeoutMs,
				tokenBudget: item.node.budget.tokens,
				signal: active.controller.signal,
			});
			this.recordUsage(
				runId,
				item.attempt.attemptId,
				item.attempt.attemptNumber > 1 ? "rework" : "execution",
				result.trace,
				item.node.id,
			);
			if (!result.ok) {
				if (active.controller.signal.aborted || result.failure.code === "aborted") {
					this.cancelAttempt(runId, item.attempt, result.trace.sessionId, result.trace.sessionFile);
					return;
				}
				if (result.failure.code === "blocked") {
					await this.routeBlocked(runId, item.node, item.attempt, result.failure.message, context);
					return;
				}
				this.handleAttemptFailure(
					runId,
					item.node,
					item.attempt,
					this.nodeFailure(runId, item.node.id, item.attempt.attemptId, result.failure),
					result.trace,
				);
				return;
			}

			let manifest: ArtifactManifest;
			try {
				manifest = await createArtifactManifest({
					workspace: context.cwd,
					contract: item.node.output,
					submission: { ...result.submission, id: `${item.attempt.attemptId}:artifact` },
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.handleAttemptFailure(
					runId,
					item.node,
					item.attempt,
					createIpdFailure({
						code: "artifact_error",
						category: "artifact_error",
						message,
						retryable: true,
						runId,
						traceId: this.ledger.getRun(runId)?.traceId ?? "",
						nodeId: item.node.id,
						attemptId: item.attempt.attemptId,
					}),
					result.trace,
				);
				return;
			}

			this.ledger.recordArtifact({
				runId,
				idempotencyKey: `graph:${runId}:artifact:${manifest.id}:record`,
				artifactId: manifest.id,
				nodeId: item.node.id,
				attemptId: item.attempt.attemptId,
				contractId: manifest.contractId,
				manifest: artifactManifestToJson(manifest),
			});
			this.ledger.transitionNode({
				runId,
				idempotencyKey: `graph:${runId}:attempt:${item.attempt.attemptId}:gate-checking`,
				attemptId: item.attempt.attemptId,
				status: "gate_checking",
				sessionId: result.trace.sessionId,
				sessionFile: result.trace.sessionFile,
			});
			await this.evaluateNodeGate(runId, item.node, item.attempt, manifest, context, active);
		} finally {
			active.attemptIds.delete(item.attempt.attemptId);
			lock.release();
		}
	}

	private async evaluateNodeGate(
		runId: string,
		node: ExecutionNodeDefinition,
		attempt: NodeInstanceRecord,
		manifest: ArtifactManifest,
		context: GraphRunContext,
		active: ActiveRun,
	): Promise<void> {
		const gateRunId = `${attempt.attemptId}:gate`;
		this.ledger.createGateRun({
			runId,
			idempotencyKey: `graph:${runId}:attempt:${attempt.attemptId}:gate:create`,
			gateRunId,
			gateId: node.gate.id,
			nodeId: node.id,
			attemptId: attempt.attemptId,
			artifactId: manifest.id,
		});
		this.ledger.transitionGate({
			runId,
			idempotencyKey: `graph:${runId}:gate:${gateRunId}:mechanical`,
			gateRunId,
			status: "mechanical_checking",
		});
		active.gateRunIds.add(gateRunId);
		let result: GateEvaluationResult;
		try {
			const snapshot = this.ledger.getRunSnapshot(runId);
			const workflowRecord = snapshot.workflow;
			if (!workflowRecord) throw new Error(`Frozen Workflow disappeared: ${runId}`);
			const workflow = workflowRecord.definition;
			result = await this.gateEvaluator.evaluate({
				runId,
				gateRunId,
				gate: node.gate,
				node,
				artifacts: [{ manifest, contract: node.output }],
				final: false,
				task: snapshot.run.task,
				workflowHash: workflowRecord.hash,
				cwd: context.cwd,
				skill: context.skill,
				agentCards: snapshot.agentCards.map((record) => record.card),
				staffAgentCards: workflow.staff.core.map((ref) => this.findAgentCard(snapshot, ref)),
				executorAgentCardRefs: [node.agentCardRef],
				runDefaultModel: context.runDefaultModel,
				runDefaultThinkingLevel: context.runDefaultThinkingLevel,
				reviewerTokenBudget: this.budgetController.reviewerTokenBudget(workflow, snapshot),
				signal: active.controller.signal,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (active.controller.signal.aborted) {
				this.ledger.transitionGate({
					runId,
					idempotencyKey: `graph:${runId}:gate:${gateRunId}:interrupted`,
					gateRunId,
					status: "interrupted",
					decision: this.failure(runId, "interrupted", "internal_error", message, true, { gateRunId }),
				});
				this.cancelAttempt(runId, attempt);
			} else {
				this.ledger.transitionGate({
					runId,
					idempotencyKey: `graph:${runId}:gate:${gateRunId}:blocked`,
					gateRunId,
					status: "blocked",
					decision: this.failure(runId, "gate_evaluator_failed", "internal_error", message, false, {
						gateRunId,
					}),
				});
				this.rejectArtifact(runId, manifest.id);
				this.handleAttemptFailure(
					runId,
					node,
					attempt,
					createIpdFailure({
						code: "gate_evaluator_failed",
						category: "internal_error",
						message,
						retryable: false,
						runId,
						traceId: this.ledger.getRun(runId)?.traceId ?? "",
						nodeId: node.id,
						attemptId: attempt.attemptId,
						gateRunId,
					}),
					{},
				);
			}
			return;
		} finally {
			active.gateRunIds.delete(gateRunId);
		}
		try {
			await this.applyGateResult(runId, gateRunId, node.gate, result, node, attempt, manifest.id, context);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.ledger.transitionGate({
				runId,
				idempotencyKey: `graph:${runId}:gate:${gateRunId}:invalid-result`,
				gateRunId,
				status: "blocked",
				decision: this.failure(runId, "invalid_gate_result", "validation_error", message, false, {
					gateRunId,
				}),
			});
			this.rejectArtifact(runId, manifest.id);
			this.handleAttemptFailure(
				runId,
				node,
				attempt,
				createIpdFailure({
					code: "invalid_gate_result",
					category: "validation_error",
					message,
					retryable: false,
					runId,
					traceId: this.ledger.getRun(runId)?.traceId ?? "",
					nodeId: node.id,
					attemptId: attempt.attemptId,
					gateRunId,
				}),
				{},
			);
		}
	}

	private async applyGateResult(
		runId: string,
		gateRunId: string,
		gate: GateDefinition,
		result: GateEvaluationResult,
		node?: ExecutionNodeDefinition,
		attempt?: NodeInstanceRecord,
		artifactId?: string,
		context?: GraphRunContext,
	): Promise<void> {
		this.validateGateEvaluation(gate, result);
		if (result.staffDecision) {
			this.ledger.recordDecision({
				runId,
				idempotencyKey: `graph:${runId}:gate:${gateRunId}:staff-arbitration`,
				decisionId: `${gateRunId}:staff-arbitration`,
				type: "gate_arbitration",
				action: result.staffDecision.action,
				rationale: result.staffDecision.rationale,
				gateRunId,
				evidence: {
					value: result.staffDecision.evidence,
					trace: toJson(result.staffDecision.trace),
					agentCardRef: result.staffDecision.agentCardRef,
				},
			});
			this.recordUsage(
				runId,
				result.staffDecision.instanceId,
				"staff",
				result.staffDecision.trace,
				undefined,
				undefined,
			);
		}
		this.recordCriteria(runId, gateRunId, "mechanical", result.mechanical);
		const mechanicalPass = result.mechanical.every((criterion) => criterion.result === "PASS");
		if (!mechanicalPass) {
			this.ledger.transitionGate({
				runId,
				idempotencyKey: `graph:${runId}:gate:${gateRunId}:mechanical-failed`,
				gateRunId,
				status: "mechanical_failed",
				decision: result.evidence,
			});
			if (artifactId) this.rejectArtifact(runId, artifactId);
			if (node && attempt) this.routeRework(runId, node, attempt, result.feedback);
			else this.failRun(runId, "final_gate_failed", "Final Gate mechanical checks failed");
			return;
		}

		this.ledger.transitionGate({
			runId,
			idempotencyKey: `graph:${runId}:gate:${gateRunId}:semantic`,
			gateRunId,
			status: "semantic_reviewing",
		});
		this.recordCriteria(runId, gateRunId, "semantic", result.semantic);
		if (result.decision === "PASS") {
			this.ledger.transitionGate({
				runId,
				idempotencyKey: `graph:${runId}:gate:${gateRunId}:passed`,
				gateRunId,
				status: "passed",
				decision: result.evidence,
			});
			if (artifactId) {
				this.ledger.transitionArtifact({
					runId,
					idempotencyKey: `graph:${runId}:artifact:${artifactId}:accepted`,
					artifactId,
					status: "accepted",
				});
			}
			if (attempt) {
				this.ledger.transitionNode({
					runId,
					idempotencyKey: `graph:${runId}:attempt:${attempt.attemptId}:gate-reviewing`,
					attemptId: attempt.attemptId,
					status: "gate_reviewing",
				});
				this.ledger.transitionNode({
					runId,
					idempotencyKey: `graph:${runId}:attempt:${attempt.attemptId}:succeeded`,
					attemptId: attempt.attemptId,
					status: "succeeded",
				});
			}
			return;
		}

		const gateStatus =
			result.decision === "BLOCKED" ? "blocked" : result.decision === "INCONCLUSIVE" ? "inconclusive" : "failed";
		this.ledger.transitionGate({
			runId,
			idempotencyKey: `graph:${runId}:gate:${gateRunId}:${gateStatus}`,
			gateRunId,
			status: gateStatus,
			decision: result.evidence,
		});
		if (artifactId) this.rejectArtifact(runId, artifactId);
		if (node && attempt && result.decision === "REWORK") {
			this.routeRework(runId, node, attempt, result.feedback);
		} else if (node && attempt && result.decision === "BLOCKED") {
			if (!context) throw new Error(`Blocked Node Gate has no Graph Run Context: ${gate.id}`);
			await this.routeBlocked(runId, node, attempt, result.feedback.join("\n") || "Gate blocked", context);
		} else {
			this.failRun(runId, "gate_failed", `Gate ${gate.id} returned ${result.decision}`);
		}
	}

	private recordCriteria(
		runId: string,
		gateRunId: string,
		kind: "mechanical" | "semantic",
		criteria: readonly GateCriterionEvaluation[],
	): void {
		if (kind === "mechanical") {
			for (const criterion of criteria) {
				this.ledger.recordCriterionResult({
					runId,
					idempotencyKey: `graph:${runId}:gate:${gateRunId}:${kind}:${criterion.criterionId}`,
					criterionResultId: `${gateRunId}:${kind}:${criterion.criterionId}`,
					gateRunId,
					criterionId: criterion.criterionId,
					kind,
					result: criterion.result,
					evidence: criterion.evidence,
					rationale: criterion.rationale,
				});
			}
			return;
		}

		const reviewers = new Map<
			string,
			{
				ref: NonNullable<GateCriterionEvaluation["reviewerAgentCardRef"]>;
				trace?: GateCriterionEvaluation["reviewerTrace"];
				result: JsonValue;
			}
		>();
		for (const criterion of criteria) {
			if (!criterion.reviewerAgentCardRef || !criterion.reviewerInstanceId) {
				throw new Error(`Semantic Criterion has no Reviewer identity: ${criterion.criterionId}`);
			}
			const existing = reviewers.get(criterion.reviewerInstanceId);
			if (existing && cardKey(existing.ref) !== cardKey(criterion.reviewerAgentCardRef)) {
				throw new Error(`Reviewer Instance maps to multiple AgentCards: ${criterion.reviewerInstanceId}`);
			}
			reviewers.set(criterion.reviewerInstanceId, {
				ref: criterion.reviewerAgentCardRef,
				trace: criterion.reviewerTrace,
				result: criterion.reviewerResult ?? {
					criterionId: criterion.criterionId,
					result: criterion.result,
				},
			});
		}
		for (const [reviewerInstanceId, reviewer] of reviewers) {
			this.ledger.createReviewer({
				runId,
				idempotencyKey: `graph:${runId}:gate:${gateRunId}:reviewer:${reviewerInstanceId}:create`,
				reviewerInstanceId,
				gateRunId,
				agentCardRef: reviewer.ref,
				sessionId: reviewer.trace?.sessionId,
				sessionFile: reviewer.trace?.sessionFile,
			});
			this.ledger.transitionReviewer({
				runId,
				idempotencyKey: `graph:${runId}:gate:${gateRunId}:reviewer:${reviewerInstanceId}:running`,
				reviewerInstanceId,
				status: "running",
			});
		}
		for (const criterion of criteria) {
			this.ledger.recordCriterionResult({
				runId,
				idempotencyKey: `graph:${runId}:gate:${gateRunId}:${kind}:${criterion.criterionId}:${criterion.reviewerInstanceId}`,
				criterionResultId: `${gateRunId}:${kind}:${criterion.criterionId}:${criterion.reviewerInstanceId}`,
				gateRunId,
				criterionId: criterion.criterionId,
				kind,
				result: criterion.result,
				reviewerInstanceId: criterion.reviewerInstanceId,
				evidence: criterion.evidence,
				rationale: criterion.rationale,
			});
		}
		for (const [reviewerInstanceId, reviewer] of reviewers) {
			this.ledger.transitionReviewer({
				runId,
				idempotencyKey: `graph:${runId}:gate:${gateRunId}:reviewer:${reviewerInstanceId}:completed`,
				reviewerInstanceId,
				status: "completed",
				result: reviewer.result,
				sessionId: reviewer.trace?.sessionId,
				sessionFile: reviewer.trace?.sessionFile,
			});
			if (reviewer.trace) {
				this.recordUsage(runId, reviewerInstanceId, "review", reviewer.trace, undefined, reviewerInstanceId);
			}
		}
	}

	private validateGateEvaluation(gate: GateDefinition, result: GateEvaluationResult): void {
		const mechanical = new Set(result.mechanical.map((criterion) => criterion.criterionId));
		const semantic = new Set(result.semantic.map((criterion) => criterion.criterionId));
		const expectedMechanical = new Set(gate.mechanicalCriteria.map((criterion) => criterion.id));
		const expectedSemantic = new Set(gate.semanticCriteria.map((criterion) => criterion.id));
		if (
			mechanical.size !== result.mechanical.length ||
			result.mechanical.some((criterion) => !expectedMechanical.has(criterion.criterionId)) ||
			gate.mechanicalCriteria.some((criterion) => !mechanical.has(criterion.id))
		) {
			throw new Error(`Gate Evaluator omitted a mechanical Criterion: ${gate.id}`);
		}
		if (
			result.mechanical.every((criterion) => criterion.result === "PASS") &&
			!(result.decision === "BLOCKED" && result.semantic.length === 0)
		) {
			if (
				result.semantic.some((criterion) => !expectedSemantic.has(criterion.criterionId)) ||
				gate.semanticCriteria.some((criterion) => !semantic.has(criterion.id))
			) {
				throw new Error(`Gate Evaluator omitted a semantic Criterion: ${gate.id}`);
			}
			if (result.semantic.some((criterion) => !criterion.reviewerAgentCardRef || !criterion.reviewerInstanceId)) {
				throw new Error(`Gate Evaluator returned semantic evidence without Reviewer identity: ${gate.id}`);
			}
		} else if (result.semantic.length > 0) {
			throw new Error(`Gate Evaluator returned semantic results after mechanical failure: ${gate.id}`);
		}
		if (
			result.decision === "PASS" &&
			(result.mechanical.some((criterion) => criterion.result !== "PASS") ||
				result.semantic.some((criterion) => criterion.result !== "PASS"))
		) {
			throw new Error(`Gate Evaluator returned PASS with non-passing semantic evidence: ${gate.id}`);
		}
	}

	private async evaluateFinalGate(
		runId: string,
		workflow: WorkflowDefinition,
		snapshot: RunSnapshot,
		context: GraphRunContext,
		active: ActiveRun,
	): Promise<void> {
		const existing = snapshot.gates.find(
			(gate) => gate.nodeId === undefined && gate.gateId === workflow.finalGate.id,
		);
		if (existing?.status === "passed") {
			this.ledger.transitionRun({ runId, idempotencyKey: `graph:${runId}:succeeded`, status: "succeeded" });
			return;
		}
		if (existing) {
			this.failRun(runId, "final_gate_failed", `Final Gate is ${existing.status}`);
			return;
		}
		const gateRunId = `${runId}:final-gate`;
		this.ledger.createGateRun({
			runId,
			idempotencyKey: `graph:${runId}:final-gate:create`,
			gateRunId,
			gateId: workflow.finalGate.id,
		});
		this.ledger.transitionGate({
			runId,
			idempotencyKey: `graph:${runId}:final-gate:mechanical`,
			gateRunId,
			status: "mechanical_checking",
		});
		active.gateRunIds.add(gateRunId);
		let result: GateEvaluationResult;
		try {
			result = await this.gateEvaluator.evaluate({
				runId,
				gateRunId,
				gate: workflow.finalGate,
				artifacts: workflow.finalArtifactNodeIds.flatMap((nodeId) => {
					const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
					if (!node) return [];
					return this.acceptedArtifacts(nodeId, snapshot).map((artifact) => ({
						manifest: this.decodeManifest(artifact),
						contract: node.output,
					}));
				}),
				final: true,
				task: snapshot.run.task,
				workflowHash: snapshot.workflow?.hash ?? "",
				cwd: context.cwd,
				skill: context.skill,
				agentCards: snapshot.agentCards.map((record) => record.card),
				staffAgentCards: workflow.staff.core.map((ref) => this.findAgentCard(snapshot, ref)),
				executorAgentCardRefs: workflow.nodes.map((node) => node.agentCardRef),
				runDefaultModel: context.runDefaultModel,
				runDefaultThinkingLevel: context.runDefaultThinkingLevel,
				reviewerTokenBudget: this.budgetController.reviewerTokenBudget(workflow, snapshot),
				signal: context.signal,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.ledger.transitionGate({
				runId,
				idempotencyKey: `graph:${runId}:final-gate:blocked`,
				gateRunId,
				status: active.controller.signal.aborted ? "interrupted" : "blocked",
				decision: this.failure(runId, "gate_evaluator_failed", "internal_error", message, false, {
					gateRunId,
				}),
			});
			if (!active.controller.signal.aborted) this.failRun(runId, "final_gate_failed", message);
			return;
		} finally {
			active.gateRunIds.delete(gateRunId);
		}
		try {
			await this.applyGateResult(runId, gateRunId, workflow.finalGate, result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.ledger.transitionGate({
				runId,
				idempotencyKey: `graph:${runId}:final-gate:invalid-result`,
				gateRunId,
				status: "blocked",
				decision: this.failure(runId, "invalid_gate_result", "validation_error", message, false, {
					gateRunId,
				}),
			});
			this.failRun(runId, "final_gate_failed", message);
			return;
		}
		const current = this.ledger.getRunSnapshot(runId);
		if (current.gates.some((gate) => gate.id === gateRunId && gate.status === "passed")) {
			this.ledger.transitionRun({ runId, idempotencyKey: `graph:${runId}:succeeded`, status: "succeeded" });
		}
	}

	private recoverInterruptedWork(runId: string, snapshot: RunSnapshot, active: ActiveRun): Promise<boolean> {
		const workflow = snapshot.workflow?.definition;
		if (!workflow) return Promise.resolve(false);
		let safe = true;
		for (const gate of snapshot.gates) {
			if (["mechanical_checking", "semantic_reviewing"].includes(gate.status)) {
				this.ledger.transitionGate({
					runId,
					idempotencyKey: `graph:${runId}:recovery:gate:${gate.id}`,
					gateRunId: gate.id,
					status: "interrupted",
					decision: this.failure(
						runId,
						"interrupted",
						"internal_error",
						"Process stopped during Gate evaluation",
						true,
						{ gateRunId: gate.id },
					),
				});
			}
		}
		for (const attempt of snapshot.nodes) {
			if (!["running", "gate_checking", "gate_reviewing"].includes(attempt.status)) continue;
			this.ledger.transitionNode({
				runId,
				idempotencyKey: `graph:${runId}:recovery:attempt:${attempt.attemptId}`,
				attemptId: attempt.attemptId,
				status: "interrupted",
				error: this.failure(runId, "interrupted", "internal_error", "Process stopped during Node execution", true, {
					nodeId: attempt.nodeId,
					attemptId: attempt.attemptId,
				}),
			});
			const node = workflow.nodes.find((candidate) => candidate.id === attempt.nodeId);
			if (
				!node ||
				node.permissions.workspace === "write" ||
				node.permissions.externalActions ||
				node.tools.includes("bash")
			) {
				safe = false;
				this.routeWaiting(
					runId,
					node?.routes.blocked ?? "staff",
					node?.id,
					"Interrupted side-effecting Node requires review",
				);
			}
		}
		if (active.controller.signal.aborted) return Promise.resolve(false);
		return Promise.resolve(safe);
	}

	private handleAttemptFailure(
		runId: string,
		node: ExecutionNodeDefinition,
		attempt: NodeInstanceRecord,
		failure: IpdFailure,
		trace: { sessionId?: string; sessionFile?: string },
	): void {
		if (failure.retryable && attempt.attemptNumber < node.rework.maxAttempts) {
			this.ledger.transitionNode({
				runId,
				idempotencyKey: `graph:${runId}:attempt:${attempt.attemptId}:rework`,
				attemptId: attempt.attemptId,
				status: "rework_pending",
				error: toJson(failure),
				sessionId: trace.sessionId,
				sessionFile: trace.sessionFile,
			});
			this.recordReworkDecision(runId, node.id, attempt.attemptId, [failure.message]);
		} else {
			this.ledger.transitionNode({
				runId,
				idempotencyKey: `graph:${runId}:attempt:${attempt.attemptId}:failed`,
				attemptId: attempt.attemptId,
				status: "failed",
				error: toJson(failure),
				sessionId: trace.sessionId,
				sessionFile: trace.sessionFile,
			});
			this.routeExhausted(runId, node, attempt.attemptId, failure.message);
		}
	}

	private routeRework(
		runId: string,
		node: ExecutionNodeDefinition,
		attempt: NodeInstanceRecord,
		feedback: string[],
	): void {
		if (attempt.attemptNumber < node.rework.maxAttempts) {
			this.ledger.transitionNode({
				runId,
				idempotencyKey: `graph:${runId}:attempt:${attempt.attemptId}:rework`,
				attemptId: attempt.attemptId,
				status: "rework_pending",
				error: this.failure(
					runId,
					"quality_failure",
					"quality_failure",
					feedback.join("\n") || "Gate requested rework",
					true,
					{ nodeId: node.id, attemptId: attempt.attemptId },
				),
			});
			this.recordReworkDecision(runId, node.id, attempt.attemptId, feedback);
		} else {
			this.ledger.transitionNode({
				runId,
				idempotencyKey: `graph:${runId}:attempt:${attempt.attemptId}:failed`,
				attemptId: attempt.attemptId,
				status: "failed",
				error: this.failure(runId, "rework_exhausted", "quality_failure", feedback.join("\n"), false, {
					nodeId: node.id,
					attemptId: attempt.attemptId,
				}),
			});
			this.routeExhausted(runId, node, attempt.attemptId, feedback.join("\n"));
		}
	}

	private async routeBlocked(
		runId: string,
		node: ExecutionNodeDefinition,
		attempt: NodeInstanceRecord,
		message: string,
		context: GraphRunContext,
	): Promise<void> {
		this.ledger.transitionNode({
			runId,
			idempotencyKey: `graph:${runId}:attempt:${attempt.attemptId}:blocked`,
			attemptId: attempt.attemptId,
			status: "blocked",
			error: this.failure(runId, "blocked", "blocked", message, false, {
				nodeId: node.id,
				attemptId: attempt.attemptId,
			}),
		});
		if (node.routes.blocked !== "staff") {
			this.routeWaiting(runId, node.routes.blocked, node.id, message, attempt.attemptId);
			return;
		}

		const snapshot = this.ledger.getRunSnapshot(runId);
		const workflow = snapshot.workflow?.definition;
		const staffRef = workflow?.staff.core[0];
		if (!workflow || !staffRef) {
			this.routeWaiting(runId, "user", node.id, `ST is unavailable: ${message}`, attempt.attemptId);
			return;
		}
		const instanceId = `${attempt.attemptId}:blocked:staff`;
		const result = await this.nodeRunner.runDecisionNode({
			kind: "staff",
			runId,
			instanceId,
			task: snapshot.run.task,
			workflowHash: snapshot.workflow?.hash ?? "",
			cwd: context.cwd,
			agentCard: this.findAgentCard(snapshot, staffRef),
			skills: [context.skill],
			runDefaultModel: context.runDefaultModel,
			runDefaultThinkingLevel: context.runDefaultThinkingLevel,
			tokenBudget: workflow.globalBudget.staffTokens,
			allowedActions: ["retry_node", "ask_user", "fail_run"],
			context: { nodeId: node.id, attemptId: attempt.attemptId, blockedReason: message },
			signal: context.signal,
		});
		this.recordUsage(runId, instanceId, "staff", result.trace, node.id);
		if (!result.ok || result.kind !== "staff") {
			const reason = !result.ok ? result.failure.message : "ST returned an unexpected Decision kind";
			this.routeWaiting(
				runId,
				"user",
				node.id,
				`${message}\nST could not resolve the block: ${reason}`,
				attempt.attemptId,
			);
			return;
		}
		this.ledger.recordDecision({
			runId,
			idempotencyKey: `graph:${runId}:attempt:${attempt.attemptId}:blocked:staff-decision`,
			decisionId: `${attempt.attemptId}:blocked:staff-decision`,
			type: "blocked_resolution",
			action: result.submission.action,
			rationale: result.submission.rationale,
			nodeId: node.id,
			evidence: result.submission.evidence,
		});
		if (result.submission.action === "retry_node") return;
		if (result.submission.action === "ask_user") {
			this.routeWaiting(runId, "user", node.id, result.submission.rationale, attempt.attemptId);
			return;
		}
		this.ledger.transitionNode({
			runId,
			idempotencyKey: `graph:${runId}:attempt:${attempt.attemptId}:blocked:failed`,
			attemptId: attempt.attemptId,
			status: "failed",
			error: this.failure(runId, "blocked_rejected", "blocked", result.submission.rationale, false, {
				nodeId: node.id,
				attemptId: attempt.attemptId,
			}),
		});
		this.failRun(runId, "blocked_rejected", result.submission.rationale);
	}

	private routeExhausted(
		runId: string,
		node: ExecutionNodeDefinition,
		attemptId: string | undefined,
		message: string,
	): void {
		if (node.routes.exhausted === "fail") {
			this.failRun(runId, "attempts_exhausted", message);
			return;
		}
		this.routeWaiting(runId, node.routes.exhausted, node.id, message, attemptId);
	}

	private routeWaiting(
		runId: string,
		target: "staff" | "user" | "fail",
		nodeId: string | undefined,
		message: string,
		attemptId?: string,
	): void {
		if (target === "fail") {
			this.failRun(runId, "route_failed", message);
			return;
		}
		const escalationId = `${runId}:escalation:${nodeId ?? "run"}:${attemptId ?? "none"}`;
		this.ledger.createEscalation({
			runId,
			idempotencyKey: `graph:${runId}:escalation:${nodeId ?? "run"}:${attemptId ?? "none"}`,
			escalationId,
			target,
			question: message,
			context: { nodeId: nodeId ?? null, attemptId: attemptId ?? null },
			nodeId,
		});
		const status = this.ledger.getRun(runId)?.status;
		if (status === "running") {
			this.ledger.transitionRun({
				runId,
				idempotencyKey: `graph:${runId}:waiting:${escalationId}`,
				status: "waiting_user",
			});
		}
	}

	private recordReworkDecision(runId: string, nodeId: string, attemptId: string, feedback: string[]): void {
		this.ledger.recordDecision({
			runId,
			idempotencyKey: `graph:${runId}:rework-decision:${attemptId}`,
			decisionId: `rework-decision:${attemptId}`,
			type: "gate_rework",
			action: "retry_node",
			rationale: feedback.join("\n") || "Gate requested rework",
			nodeId,
			evidence: toJson(feedback),
		});
	}

	private recordUsage(
		runId: string,
		instanceId: string,
		category: "staff" | "execution" | "review" | "rework",
		trace: NodeRunTrace,
		nodeId?: string,
		reviewerInstanceId?: string,
	): void {
		this.ledger.recordBudgetUsage({
			runId,
			idempotencyKey: `graph:${runId}:usage:${instanceId}`,
			usageId: `usage:${instanceId}`,
			category,
			nodeId,
			attemptId: category === "execution" || category === "rework" ? instanceId : undefined,
			reviewerInstanceId,
			inputTokens: trace.usage.inputTokens,
			outputTokens: trace.usage.outputTokens,
			cacheReadTokens: trace.usage.cacheReadTokens,
			cacheWriteTokens: trace.usage.cacheWriteTokens,
			totalTokens: trace.usage.totalTokens,
			costUsd: trace.usage.costUsd,
			durationMs: trace.durationMs,
			details: { provider: trace.provider, model: trace.model, instanceId },
		});
	}

	private reworkInstructions(nodeId: string, snapshot: RunSnapshot): string[] {
		return snapshot.decisions
			.filter((decision) => decision.nodeId === nodeId && decision.action === "retry_node")
			.map((decision) => decision.rationale);
	}

	private finishStalledRun(runId: string, workflow: WorkflowDefinition, snapshot: RunSnapshot): GraphRunResult {
		const latest = latestAttempts(snapshot);
		const failed = workflow.nodes.find((node) => latest.get(node.id)?.status === "failed");
		if (failed) this.failRun(runId, "node_failed", `Node failed: ${failed.id}`);
		else this.failRun(runId, "workflow_stalled", "Workflow has no Ready Nodes and is not complete");
		return this.stableResult(runId);
	}

	private finishCancelledRun(runId: string, reason = "Cancelled"): GraphRunResult {
		const snapshot = this.ledger.getRunSnapshot(runId);
		for (const attempt of snapshot.nodes) {
			if (["ready", "running", "gate_checking", "gate_reviewing"].includes(attempt.status)) {
				this.cancelAttempt(runId, attempt);
			}
		}
		if (!["succeeded", "failed", "cancelled"].includes(snapshot.run.status)) {
			this.ledger.transitionRun({
				runId,
				idempotencyKey: `graph:${runId}:cancel`,
				status: "cancelled",
				failure: this.failure(runId, "cancelled", "cancelled", reason, false),
			});
		}
		return this.stableResult(runId);
	}

	private cancelAttempt(runId: string, attempt: NodeInstanceRecord, sessionId?: string, sessionFile?: string): void {
		const current = this.ledger.getRunSnapshot(runId).nodes.find((item) => item.attemptId === attempt.attemptId);
		if (!current || ["succeeded", "failed", "cancelled"].includes(current.status)) return;
		this.ledger.transitionNode({
			runId,
			idempotencyKey: `graph:${runId}:attempt:${attempt.attemptId}:cancelled`,
			attemptId: attempt.attemptId,
			status: "cancelled",
			sessionId,
			sessionFile,
		});
	}

	private rejectArtifact(runId: string, artifactId: string): void {
		this.ledger.transitionArtifact({
			runId,
			idempotencyKey: `graph:${runId}:artifact:${artifactId}:rejected`,
			artifactId,
			status: "rejected",
		});
	}

	private failRun(runId: string, code: string, message: string): void {
		const status = this.ledger.getRun(runId)?.status;
		if (!status || ["succeeded", "failed", "cancelled"].includes(status)) return;
		this.ledger.transitionRun({
			runId,
			idempotencyKey: `graph:${runId}:failed:${code}`,
			status: "failed",
			failure: this.failure(runId, code, "internal_error", message, false),
		});
	}

	private failure(
		runId: string,
		code: string,
		category: IpdFailureCategory,
		message: string,
		retryable: boolean,
		refs: { nodeId?: string; attemptId?: string; gateRunId?: string } = {},
	): JsonValue {
		const run = this.ledger.getRun(runId);
		return toJson(
			createIpdFailure({
				code,
				category,
				message,
				retryable,
				runId,
				traceId: run?.traceId ?? "",
				...refs,
			}),
		);
	}

	private nodeFailure(runId: string, nodeId: string, attemptId: string, failure: NodeRunFailure): IpdFailure {
		return normalizeNodeRunFailure(failure, {
			runId,
			traceId: this.ledger.getRun(runId)?.traceId ?? "",
			nodeId,
			attemptId,
		});
	}

	private dependenciesHaveAcceptedArtifacts(node: ExecutionNodeDefinition, snapshot: RunSnapshot): boolean {
		return node.inputs.every((input) =>
			snapshot.artifacts.some((artifact) => artifact.nodeId === input.fromNodeId && artifact.status === "accepted"),
		);
	}

	private inputArtifacts(node: ExecutionNodeDefinition, snapshot: RunSnapshot): ArtifactManifest[] {
		return node.inputs.flatMap((input) => {
			const artifacts = this.acceptedArtifacts(input.fromNodeId, snapshot);
			const latest = artifacts.at(-1);
			return latest ? [this.decodeManifest(latest)] : [];
		});
	}

	private acceptedArtifacts(nodeId: string, snapshot: RunSnapshot): ArtifactRecord[] {
		return snapshot.artifacts.filter((artifact) => artifact.nodeId === nodeId && artifact.status === "accepted");
	}

	private decodeManifest(record: ArtifactRecord): ArtifactManifest {
		const parsed = validateSchema<ArtifactManifest>(ArtifactManifestSchema, record.manifest);
		if (!parsed.ok) throw new Error(`Ledger Artifact Manifest is invalid: ${record.id}`);
		return parsed.value;
	}

	private findAgentCard(snapshot: RunSnapshot, ref: { id: string; version: string; hash: string }): CompiledAgentCard {
		const record = snapshot.agentCards.find((item) => cardKey(item.ref) === cardKey(ref));
		if (!record) throw new Error(`AgentCard Snapshot not found: ${cardKey(ref)}`);
		return record.card;
	}

	private allNodesSucceeded(workflow: WorkflowDefinition, snapshot: RunSnapshot): boolean {
		const latest = latestAttempts(snapshot);
		return workflow.nodes.every((node) => latest.get(node.id)?.status === "succeeded");
	}

	private stableResult(runId: string): GraphRunResult {
		const snapshot = this.ledger.getRunSnapshot(runId);
		return { runId, status: snapshot.run.status, snapshot };
	}
}

function toJson(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}
