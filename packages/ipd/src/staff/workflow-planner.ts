import { createHash } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { NodeRunner, NodeRunTrace, SkillSnapshot } from "../adapter/node-runner.ts";
import { compileWorkflow } from "../ir/compiler.ts";
import { hashJson, toJsonValue } from "../ir/hash.ts";
import type { WorkflowDefinition } from "../ir/schemas.ts";
import type {
	CheckDefinition,
	CompiledAgentCard,
	CompiledWorkflow,
	IpdDiagnostic,
	WorkflowAssetRecord,
} from "../ir/types.ts";
import type { SqliteIpdLedger } from "../ledger/sqlite-ledger.ts";
import type { WorkflowVersionRecord } from "../ledger/types.ts";
import type { WorkflowAssetStore } from "../registry/workflow-asset-store.ts";
import { createIpdFailure, type IpdFailureCategory } from "../runtime/failure.ts";

export type WorkflowPlanningFailureCode =
	| "missing_skill"
	| "invalid_skill"
	| "invalid_agent_pool"
	| "planner_failed"
	| "compiler_exhausted"
	| "asset_write_failed"
	| "ledger_failed";

export interface WorkflowPlanningFailure {
	code: WorkflowPlanningFailureCode;
	message: string;
	diagnostics: IpdDiagnostic[];
}

export type PlanAndFreezeWorkflowResult =
	| {
			ok: true;
			compiled: CompiledWorkflow;
			asset: WorkflowAssetRecord;
			workflowVersion: WorkflowVersionRecord;
			traces: NodeRunTrace[];
			revisions: number;
	  }
	| { ok: false; failure: WorkflowPlanningFailure; traces: NodeRunTrace[]; revisions: number };

export interface PlanAndFreezeWorkflowRequest {
	runId: string;
	traceId: string;
	task: string;
	skill?: SkillSnapshot;
	agentCards: readonly CompiledAgentCard[];
	plannerCard: CompiledAgentCard;
	templates: readonly WorkflowAssetRecord[];
	globalBudget: WorkflowDefinition["globalBudget"];
	cwd: string;
	runDefaultModel: Model<Api>;
	runDefaultThinkingLevel: ThinkingLevel;
	maxRevisions?: number;
	signal?: AbortSignal;
}

export interface WorkflowPlannerOptions {
	ledger: SqliteIpdLedger;
	nodeRunner: NodeRunner;
	assetStore: WorkflowAssetStore;
	toolNames: ReadonlySet<string>;
	checks: readonly CheckDefinition[];
}

function cardIdentity(card: CompiledAgentCard): string {
	return `${card.id}@${card.version}#${card.hash}`;
}

function planningFailure(
	code: WorkflowPlanningFailureCode,
	message: string,
	diagnostics: IpdDiagnostic[] = [],
): WorkflowPlanningFailure {
	return { code, message, diagnostics };
}

function planningFailureCategory(code: WorkflowPlanningFailureCode): IpdFailureCategory {
	if (code === "compiler_exhausted") return "compile_error";
	if (code === "asset_write_failed") return "artifact_error";
	if (code === "planner_failed") return "provider_error";
	if (["missing_skill", "invalid_skill", "invalid_agent_pool"].includes(code)) return "validation_error";
	return "internal_error";
}

export class WorkflowPlanner {
	private readonly ledger: SqliteIpdLedger;
	private readonly nodeRunner: NodeRunner;
	private readonly assetStore: WorkflowAssetStore;
	private readonly toolNames: ReadonlySet<string>;
	private readonly checks: readonly CheckDefinition[];

	constructor(options: WorkflowPlannerOptions) {
		this.ledger = options.ledger;
		this.nodeRunner = options.nodeRunner;
		this.assetStore = options.assetStore;
		this.toolNames = options.toolNames;
		this.checks = options.checks;
	}

	async planAndFreeze(request: PlanAndFreezeWorkflowRequest): Promise<PlanAndFreezeWorkflowResult> {
		const traces: NodeRunTrace[] = [];
		if (!request.skill) {
			return {
				ok: false,
				failure: planningFailure("missing_skill", "Workflow planning requires a Skill Snapshot"),
				traces,
				revisions: 0,
			};
		}
		const skillHash = createHash("sha256").update(request.skill.content).digest("hex");
		if (skillHash !== request.skill.hash) {
			return {
				ok: false,
				failure: planningFailure("invalid_skill", `Skill Snapshot Hash mismatch: ${request.skill.name}`),
				traces,
				revisions: 0,
			};
		}
		const plannerIdentity = cardIdentity(request.plannerCard);
		if (!request.agentCards.some((card) => cardIdentity(card) === plannerIdentity)) {
			return {
				ok: false,
				failure: planningFailure(
					"invalid_agent_pool",
					"Planner AgentCard is not part of the loaded AgentCard Pool",
				),
				traces,
				revisions: 0,
			};
		}

		const maxRevisions = request.maxRevisions ?? 3;
		if (!Number.isInteger(maxRevisions) || maxRevisions < 1) {
			return {
				ok: false,
				failure: planningFailure("invalid_agent_pool", "maxRevisions must be a positive integer"),
				traces,
				revisions: 0,
			};
		}

		try {
			this.ledger.createRun({
				runId: request.runId,
				traceId: request.traceId,
				idempotencyKey: `workflow-planner:${request.runId}:create`,
				task: request.task,
				skill: { name: request.skill.name, hash: request.skill.hash },
				globalBudget: toJsonValue(request.globalBudget),
			});
			this.ledger.transitionRun({
				runId: request.runId,
				idempotencyKey: `workflow-planner:${request.runId}:compiling`,
				status: "compiling",
			});
		} catch (error) {
			return {
				ok: false,
				failure: planningFailure("ledger_failed", error instanceof Error ? error.message : String(error)),
				traces,
				revisions: 0,
			};
		}

		let previousCandidate: WorkflowDefinition | undefined;
		let previousDiagnostics: IpdDiagnostic[] = [];
		for (let revision = 1; revision <= maxRevisions; revision++) {
			const result = await this.nodeRunner.runDecisionNode({
				kind: "workflow_planner",
				runId: request.runId,
				instanceId: `workflow-planner:${request.runId}:${revision}`,
				task: request.task,
				workflowHash: request.skill.hash,
				cwd: request.cwd,
				agentCard: request.plannerCard,
				skills: [request.skill],
				runDefaultModel: request.runDefaultModel,
				runDefaultThinkingLevel: request.runDefaultThinkingLevel,
				tokenBudget: request.globalBudget.staffTokens,
				context: this.createPlannerContext(request, revision, previousCandidate, previousDiagnostics),
				signal: request.signal,
			});
			traces.push(result.trace);
			this.recordPlannerUsage(request.runId, result.trace);
			if (!result.ok || result.kind !== "workflow_planner") {
				const message = !result.ok ? result.failure.message : "Planner returned an unexpected Decision kind";
				await this.failRun(request.runId, revision, "planner_failed", message, [], traces);
				return {
					ok: false,
					failure: planningFailure("planner_failed", message),
					traces,
					revisions: revision,
				};
			}

			const candidate = result.submission;
			const planningDiagnostics: IpdDiagnostic[] = [];
			if (hashJson(candidate.globalBudget) !== hashJson(request.globalBudget)) {
				planningDiagnostics.push({
					code: "budget_invalid",
					path: "/globalBudget",
					message: "Workflow must preserve the global budget supplied to ST",
				});
			}
			const compiled = compileWorkflow(candidate, {
				agentCards: request.agentCards,
				runSkill: { name: request.skill.name, hash: request.skill.hash },
				skillNames: new Set([request.skill.name, ...request.agentCards.flatMap((card) => card.skills)]),
				toolNames: this.toolNames,
				checks: this.checks,
				workflowAssetIds: new Set(request.templates.map((template) => template.workflow.id)),
			});
			if (!compiled.ok) planningDiagnostics.push(...compiled.diagnostics);
			if (!compiled.ok || planningDiagnostics.length > 0) {
				previousCandidate = candidate;
				previousDiagnostics = planningDiagnostics;
				this.ledger.recordDecision({
					runId: request.runId,
					idempotencyKey: `workflow-planner:${request.runId}:rejected:${revision}`,
					decisionId: `workflow-candidate-rejected:${request.runId}:${revision}`,
					type: "workflow_candidate",
					action: "reject",
					rationale: "Workflow Compiler rejected the candidate",
					evidence: toJsonValue({ candidate, diagnostics: planningDiagnostics, trace: result.trace }),
				});
				continue;
			}

			let asset: WorkflowAssetRecord;
			try {
				asset = (await this.assetStore.save(compiled.value.definition, compiled.value.hash)).record;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await this.failRun(request.runId, revision, "asset_write_failed", message, [], traces);
				return {
					ok: false,
					failure: planningFailure("asset_write_failed", message),
					traces,
					revisions: revision,
				};
			}

			try {
				const workflowVersion = this.ledger.freezeWorkflow({
					runId: request.runId,
					idempotencyKey: `workflow-planner:${request.runId}:freeze`,
					workflow: compiled.value,
				});
				this.ledger.recordDecision({
					runId: request.runId,
					idempotencyKey: `workflow-planner:${request.runId}:accepted`,
					decisionId: `workflow-candidate-accepted:${request.runId}`,
					type: "workflow_candidate",
					action: "accept",
					rationale: "Workflow passed deterministic compilation and was frozen",
					evidence: toJsonValue({
						workflow: {
							id: compiled.value.definition.id,
							version: compiled.value.definition.version,
							hash: compiled.value.hash,
						},
						assetSource: asset.source,
						trace: result.trace,
					}),
				});
				return {
					ok: true,
					compiled: compiled.value,
					asset,
					workflowVersion,
					traces,
					revisions: revision,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await this.failRun(request.runId, revision, "ledger_failed", message, [], traces);
				return {
					ok: false,
					failure: planningFailure("ledger_failed", message),
					traces,
					revisions: revision,
				};
			}
		}

		const message = `Workflow Compiler rejected all ${maxRevisions} candidate revisions`;
		await this.failRun(request.runId, maxRevisions, "compiler_exhausted", message, previousDiagnostics, traces);
		return {
			ok: false,
			failure: planningFailure("compiler_exhausted", message, previousDiagnostics),
			traces,
			revisions: maxRevisions,
		};
	}

	private createPlannerContext(
		request: PlanAndFreezeWorkflowRequest,
		revision: number,
		previousCandidate: WorkflowDefinition | undefined,
		previousDiagnostics: readonly IpdDiagnostic[],
	) {
		return toJsonValue({
			revision,
			globalBudget: request.globalBudget,
			agentCards: request.agentCards.map((card) => ({
				ref: { id: card.id, version: card.version, hash: card.hash },
				name: card.name,
				description: card.description,
				capabilities: card.capabilities,
				model: card.model,
				skills: card.skills,
				tools: card.tools,
				permissions: card.permissions,
				defaultBudget: card.defaultBudget,
			})),
			workflowAssets: request.templates.map((template) => ({
				id: template.workflow.id,
				version: template.workflow.version,
				hash: template.hash,
				definition: template.workflow,
			})),
			compilerRules: {
				onlyExecutionNodes: true,
				everyNodeRequiresMechanicalAndSemanticGate: true,
				artifactSuccessPathMustBeDag: true,
				workflowMustReferenceLoadedAgentCards: true,
			},
			previousCandidate: previousCandidate ?? null,
			previousDiagnostics,
		});
	}

	private async failRun(
		runId: string,
		revision: number,
		code: WorkflowPlanningFailureCode,
		message: string,
		diagnostics: readonly IpdDiagnostic[],
		traces: readonly NodeRunTrace[],
	): Promise<void> {
		try {
			this.ledger.recordDecision({
				runId,
				idempotencyKey: `workflow-planner:${runId}:failed-decision:${revision}`,
				decisionId: `workflow-planning-failed:${runId}:${revision}`,
				type: "workflow_planning",
				action: "fail",
				rationale: message,
				evidence: toJsonValue({ code, diagnostics, traces }),
			});
			this.ledger.transitionRun({
				runId,
				idempotencyKey: `workflow-planner:${runId}:failed:${revision}`,
				status: "failed",
				failure: toJsonValue(
					createIpdFailure({
						code,
						category: planningFailureCategory(code),
						message,
						retryable: code === "planner_failed",
						runId,
						traceId: this.ledger.getRun(runId)?.traceId ?? "",
						cause: toJsonValue({ diagnostics }),
					}),
				),
			});
		} catch {
			// Preserve the original planning failure returned to the caller.
		}
	}

	private recordPlannerUsage(runId: string, trace: NodeRunTrace): void {
		this.ledger.recordBudgetUsage({
			runId,
			idempotencyKey: `workflow-planner:${runId}:usage:${trace.instanceId}`,
			usageId: `usage:${trace.instanceId}`,
			category: "staff",
			inputTokens: trace.usage.inputTokens,
			outputTokens: trace.usage.outputTokens,
			cacheReadTokens: trace.usage.cacheReadTokens,
			cacheWriteTokens: trace.usage.cacheWriteTokens,
			totalTokens: trace.usage.totalTokens,
			costUsd: trace.usage.costUsd,
			durationMs: trace.durationMs,
			details: { provider: trace.provider, model: trace.model, instanceId: trace.instanceId, phase: "planning" },
		});
	}
}
