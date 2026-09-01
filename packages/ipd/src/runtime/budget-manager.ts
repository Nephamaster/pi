import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { NodeRunner, NodeRunTrace, SkillSnapshot } from "../adapter/node-runner.ts";
import { toJsonValue } from "../ir/hash.ts";
import type { WorkflowDefinition } from "../ir/schemas.ts";
import type { CompiledAgentCard, JsonValue } from "../ir/types.ts";
import type { SqliteIpdLedger } from "../ledger/sqlite-ledger.ts";
import type { RunSnapshot } from "../ledger/types.ts";
import { createIpdFailure } from "./failure.ts";

export interface BudgetRunContext {
	cwd: string;
	skill: SkillSnapshot;
	runDefaultModel: Model<Api>;
	runDefaultThinkingLevel: ThinkingLevel;
	signal?: AbortSignal;
}

export interface BudgetAssessment {
	action: "continue" | "waiting_user" | "failed";
	totalTokens: number;
	softLimit: number;
	hardLimit?: number;
	reviewerTokenBudget?: number;
}

export interface BudgetController {
	assess(
		runId: string,
		workflow: WorkflowDefinition,
		snapshot: RunSnapshot,
		staffAgentCards: readonly CompiledAgentCard[],
		context: BudgetRunContext,
	): Promise<BudgetAssessment>;
	reviewerTokenBudget(workflow: WorkflowDefinition, snapshot: RunSnapshot): number | undefined;
}

export class NoopBudgetController implements BudgetController {
	async assess(
		_runId: string,
		workflow: WorkflowDefinition,
		snapshot: RunSnapshot,
		_staffAgentCards: readonly CompiledAgentCard[],
		_context: BudgetRunContext,
	): Promise<BudgetAssessment> {
		return {
			action: "continue",
			totalTokens: snapshot.budgetUsage.reduce((total, usage) => total + usage.totalTokens, 0),
			softLimit: workflow.globalBudget.tokens,
		};
	}

	reviewerTokenBudget(): number | undefined {
		return undefined;
	}
}

export interface StaffBudgetControllerOptions {
	ledger: SqliteIpdLedger;
	nodeRunner: NodeRunner;
}

function numericProperty(value: JsonValue, property: string): number | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const candidate = value[property];
	return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0 ? candidate : undefined;
}

export class StaffBudgetController implements BudgetController {
	private readonly ledger: SqliteIpdLedger;
	private readonly nodeRunner: NodeRunner;

	constructor(options: StaffBudgetControllerOptions) {
		this.ledger = options.ledger;
		this.nodeRunner = options.nodeRunner;
	}

	async assess(
		runId: string,
		workflow: WorkflowDefinition,
		snapshot: RunSnapshot,
		staffAgentCards: readonly CompiledAgentCard[],
		context: BudgetRunContext,
	): Promise<BudgetAssessment> {
		const totalTokens = snapshot.budgetUsage.reduce((total, usage) => total + usage.totalTokens, 0);
		const softLimit = workflow.globalBudget.tokens;
		const hardLimit = workflow.globalBudget.hardTokenLimit;
		if (hardLimit !== undefined && totalTokens >= hardLimit) {
			const hardLimitFailure = createIpdFailure({
				code: "hard_limit_reached",
				category: "budget_exceeded",
				message: `Hard token limit ${hardLimit} has been reached`,
				retryable: false,
				runId,
				traceId: snapshot.run.traceId,
			});
			this.ledger.recordBudgetSignal({
				runId,
				idempotencyKey: `budget:${runId}:hard-limit:signal`,
				type: "hard_limit_reached",
				payload: { totalTokens, softLimit, hardLimit },
			});
			const escalationPrefix = `${runId}:budget:hard-limit`;
			const escalationOrdinal =
				snapshot.escalations.filter((item) => item.id.startsWith(escalationPrefix)).length + 1;
			const escalationId = `${escalationPrefix}:${escalationOrdinal}`;
			this.ledger.createEscalation({
				runId,
				idempotencyKey: `budget:${runId}:hard-limit:escalation:${escalationOrdinal}`,
				escalationId,
				target: "user",
				question: `Hard token limit ${hardLimit} has been reached. Increase the external limit or terminate the Run.`,
				context: { totalTokens, hardLimit, failure: toJsonValue(hardLimitFailure) },
			});
			if (snapshot.run.status === "running") {
				this.ledger.transitionRun({
					runId,
					idempotencyKey: `budget:${runId}:hard-limit:waiting:${escalationOrdinal}`,
					status: "waiting_user",
				});
			}
			return { action: "waiting_user", totalTokens, softLimit, hardLimit };
		}

		const threshold = totalTokens >= softLimit ? 100 : totalTokens >= softLimit * 0.8 ? 80 : undefined;
		if (threshold === undefined) {
			return {
				action: "continue",
				totalTokens,
				softLimit,
				hardLimit,
				reviewerTokenBudget: this.reviewerTokenBudget(workflow, snapshot),
			};
		}
		const decisionType = `budget_control_${threshold}`;
		this.ledger.recordBudgetSignal({
			runId,
			idempotencyKey: `budget:${runId}:soft-limit:${threshold}:signal`,
			type: threshold === 100 ? "budget_reached" : "budget_warning",
			payload: { threshold, totalTokens, softLimit, hardLimit: hardLimit ?? null },
		});
		if (snapshot.decisions.some((decision) => decision.type === decisionType)) {
			return {
				action: "continue",
				totalTokens,
				softLimit,
				hardLimit,
				reviewerTokenBudget: this.reviewerTokenBudget(workflow, snapshot),
			};
		}

		const staff = [...staffAgentCards].sort((left, right) => left.id.localeCompare(right.id))[0];
		if (!staff) {
			return this.waitForUser(
				runId,
				totalTokens,
				softLimit,
				hardLimit,
				threshold,
				"No Staff Core AgentCard is available",
			);
		}
		const instanceId = `${runId}:budget:staff:${threshold}`;
		const result = await this.nodeRunner.runDecisionNode({
			kind: "staff",
			runId,
			instanceId,
			task: snapshot.run.task,
			workflowHash: snapshot.workflow?.hash ?? "",
			cwd: context.cwd,
			agentCard: staff,
			skills: [context.skill],
			runDefaultModel: context.runDefaultModel,
			runDefaultThinkingLevel: context.runDefaultThinkingLevel,
			tokenBudget: workflow.globalBudget.staffTokens,
			allowedActions: ["continue_over_budget", "reduce_future_budget", "ask_user", "fail_run"],
			context: {
				threshold,
				totalTokens,
				softLimit,
				hardLimit: hardLimit ?? null,
				currentReviewerTokenBudget: this.reviewerTokenBudget(workflow, snapshot) ?? null,
			},
			signal: context.signal,
		});
		if (!result.ok || result.kind !== "staff") {
			const message = !result.ok ? result.failure.message : "Unexpected Staff Decision kind";
			return this.waitForUser(runId, totalTokens, softLimit, hardLimit, threshold, message);
		}
		this.recordStaffUsage(runId, instanceId, result.trace);
		const decision = result.submission;
		if (
			decision.action === "reduce_future_budget" &&
			numericProperty(decision.evidence, "reviewerTokenBudget") === undefined
		) {
			return this.waitForUser(
				runId,
				totalTokens,
				softLimit,
				hardLimit,
				threshold,
				"Staff requested a Reviewer budget reduction without reviewerTokenBudget evidence",
			);
		}
		this.ledger.recordDecision({
			runId,
			idempotencyKey: `budget:${runId}:decision:${threshold}`,
			decisionId: `${runId}:budget:decision:${threshold}`,
			type: decisionType,
			action: decision.action,
			rationale: decision.rationale,
			evidence: decision.evidence,
		});
		if (decision.action === "fail_run") {
			this.ledger.transitionRun({
				runId,
				idempotencyKey: `budget:${runId}:failed:${threshold}`,
				status: "failed",
				failure: toJsonValue(
					createIpdFailure({
						code: "budget_rejected",
						category: "budget_exceeded",
						message: decision.rationale,
						retryable: false,
						runId,
						traceId: snapshot.run.traceId,
					}),
				),
			});
			return { action: "failed", totalTokens, softLimit, hardLimit };
		}
		if (decision.action === "ask_user") {
			return this.waitForUser(runId, totalTokens, softLimit, hardLimit, threshold, decision.rationale);
		}
		if (decision.action === "reduce_future_budget") {
			const reviewerTokenBudget = numericProperty(decision.evidence, "reviewerTokenBudget");
			if (reviewerTokenBudget === undefined) throw new Error("Validated Reviewer budget disappeared");
			return { action: "continue", totalTokens, softLimit, hardLimit, reviewerTokenBudget };
		}
		return {
			action: "continue",
			totalTokens,
			softLimit,
			hardLimit,
			reviewerTokenBudget: this.reviewerTokenBudget(workflow, this.ledger.getRunSnapshot(runId)),
		};
	}

	reviewerTokenBudget(workflow: WorkflowDefinition, snapshot: RunSnapshot): number | undefined {
		for (const decision of [...snapshot.decisions].reverse()) {
			if (decision.action !== "reduce_future_budget") continue;
			const configured = numericProperty(decision.evidence, "reviewerTokenBudget");
			if (configured !== undefined) return Math.min(configured, workflow.globalBudget.reviewerTokens);
		}
		return undefined;
	}

	private waitForUser(
		runId: string,
		totalTokens: number,
		softLimit: number,
		hardLimit: number | undefined,
		threshold: number,
		message: string,
	): BudgetAssessment {
		const escalationPrefix = `${runId}:budget:soft-limit:${threshold}`;
		const escalationOrdinal =
			this.ledger.getRunSnapshot(runId).escalations.filter((item) => item.id.startsWith(escalationPrefix)).length +
			1;
		const escalationId = `${escalationPrefix}:${escalationOrdinal}`;
		this.ledger.createEscalation({
			runId,
			idempotencyKey: `budget:${runId}:soft-limit:${threshold}:escalation:${escalationOrdinal}`,
			escalationId,
			target: "user",
			question: message,
			context: { threshold, totalTokens, softLimit, hardLimit: hardLimit ?? null },
		});
		if (this.ledger.getRun(runId)?.status === "running") {
			this.ledger.transitionRun({
				runId,
				idempotencyKey: `budget:${runId}:soft-limit:${threshold}:waiting:${escalationOrdinal}`,
				status: "waiting_user",
			});
		}
		return { action: "waiting_user", totalTokens, softLimit, hardLimit };
	}

	private recordStaffUsage(runId: string, instanceId: string, trace: NodeRunTrace): void {
		this.ledger.recordBudgetUsage({
			runId,
			idempotencyKey: `budget:${runId}:usage:${instanceId}`,
			usageId: `usage:${instanceId}`,
			category: "staff",
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
}
