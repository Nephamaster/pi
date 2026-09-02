import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SkillSnapshot } from "../adapter/node-runner.ts";
import { type ArtifactManifest, ArtifactManifestSchema } from "../artifact/manifest.ts";
import type { WorkflowDefinition } from "../ir/schemas.ts";
import type { CompiledAgentCard, IpdDiagnostic, WorkflowAssetRecord } from "../ir/types.ts";
import { validateSchema } from "../ir/validation.ts";
import type { SqliteIpdLedger } from "../ledger/sqlite-ledger.ts";
import type { RunSnapshot, RunStatus } from "../ledger/types.ts";
import type { PlanAndFreezeWorkflowRequest, PlanAndFreezeWorkflowResult } from "../staff/workflow-planner.ts";
import type { IpdToolResult, IpdToolResultDetails, IpdToolStatus } from "../tool/ipd-result.ts";
import type { IpdFailure } from "./failure.ts";
import { GraphEngineError, type GraphRunContext, type GraphRunResult } from "./graph-engine.ts";

export interface IpdWorkflowPlanningService {
	planAndFreeze(request: PlanAndFreezeWorkflowRequest): Promise<PlanAndFreezeWorkflowResult>;
}

export interface IpdGraphExecutionService {
	run(runId: string, context: GraphRunContext): Promise<GraphRunResult>;
	resume(runId: string, escalationId: string, answer: string, context: GraphRunContext): Promise<GraphRunResult>;
	cancel(runId: string, reason?: string): Promise<GraphRunResult>;
}

export interface IpdRuntimeAssetContext {
	cwd: string;
	projectTrusted: boolean;
	availableSkills: readonly SkillSnapshot[];
	runDefaultModel: Model<Api>;
}

export interface PreparedIpdRuntimeAssets {
	agentCards: readonly CompiledAgentCard[];
	plannerCard: CompiledAgentCard;
	staffCoreCards: readonly CompiledAgentCard[];
	workflowAssets: readonly WorkflowAssetRecord[];
	planner: IpdWorkflowPlanningService;
}

export interface IpdRuntimeAssetProvider {
	prepare(context: IpdRuntimeAssetContext): Promise<PreparedIpdRuntimeAssets>;
}

export interface IpdRuntimeOptions {
	ledger: SqliteIpdLedger;
	graphEngine: IpdGraphExecutionService;
	assetProvider: IpdRuntimeAssetProvider;
	idFactory?: () => string;
	defaultTokenBudget?: number;
	defaultDurationMs?: number;
}

export interface IpdRuntimeExecutionContext {
	cwd: string;
	projectTrusted: boolean;
	availableSkills: readonly SkillSnapshot[];
	runDefaultModel: Model<Api>;
	runDefaultThinkingLevel: ThinkingLevel;
	signal?: AbortSignal;
}

export interface IpdRuntimeStartInput {
	task: string;
	skill: SkillSnapshot;
	workflowTemplateId?: string;
	tokenBudget?: number;
	expectedDurationMs?: number;
	hardTokenLimit?: number;
	context: IpdRuntimeExecutionContext;
}

export class IpdRuntimeError extends Error {
	readonly code: string;
	readonly diagnostics?: IpdDiagnostic[];

	constructor(code: string, message: string, diagnostics?: IpdDiagnostic[]) {
		super(message);
		this.name = "IpdRuntimeError";
		this.code = code;
		this.diagnostics = diagnostics;
	}
}

function publicStatus(status: RunStatus): IpdToolStatus {
	if (status === "planning" || status === "compiling" || status === "ready" || status === "running") {
		return "running";
	}
	return status;
}

function globalBudget(tokens: number, timeoutMs: number, hardTokenLimit?: number): WorkflowDefinition["globalBudget"] {
	const staffTokens = Math.max(1, Math.floor(tokens * 0.15));
	const reviewerTokens = Math.max(1, Math.floor(tokens * 0.2));
	const reworkTokens = Math.max(1, Math.floor(tokens * 0.15));
	return { tokens, timeoutMs, staffTokens, reviewerTokens, reworkTokens, hardTokenLimit };
}

function isIpdFailure(value: unknown): value is IpdFailure {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.code === "string" &&
		typeof record.category === "string" &&
		typeof record.message === "string" &&
		typeof record.retryable === "boolean" &&
		typeof record.runId === "string" &&
		typeof record.traceId === "string"
	);
}

export class IpdRuntime implements Disposable {
	private readonly ledger: SqliteIpdLedger;
	private readonly graphEngine: IpdGraphExecutionService;
	private readonly assetProvider: IpdRuntimeAssetProvider;
	private readonly idFactory: () => string;
	private readonly defaultTokenBudget: number;
	private readonly defaultDurationMs: number;

	constructor(options: IpdRuntimeOptions) {
		this.ledger = options.ledger;
		this.graphEngine = options.graphEngine;
		this.assetProvider = options.assetProvider;
		this.idFactory = options.idFactory ?? randomUUID;
		this.defaultTokenBudget = options.defaultTokenBudget ?? 100_000;
		this.defaultDurationMs = options.defaultDurationMs ?? 3_600_000;
	}

	[Symbol.dispose](): void {
		this.close();
	}

	close(): void {
		this.ledger.close();
	}

	async start(input: IpdRuntimeStartInput): Promise<IpdToolResult> {
		const tokenBudget = input.tokenBudget ?? this.defaultTokenBudget;
		const expectedDurationMs = input.expectedDurationMs ?? this.defaultDurationMs;
		if (tokenBudget < 4) throw new IpdRuntimeError("budget_invalid", "Token budget must be at least 4");
		if (input.hardTokenLimit !== undefined && input.hardTokenLimit < tokenBudget) {
			throw new IpdRuntimeError("budget_invalid", "Hard token limit cannot be lower than the soft token budget");
		}
		const runId = this.idFactory();
		const assets = await this.assetProvider.prepare({
			cwd: input.context.cwd,
			projectTrusted: input.context.projectTrusted,
			availableSkills: input.context.availableSkills,
			runDefaultModel: input.context.runDefaultModel,
		});
		const templates = input.workflowTemplateId
			? assets.workflowAssets.filter((asset) => asset.workflow.id === input.workflowTemplateId)
			: assets.workflowAssets;
		if (input.workflowTemplateId && templates.length === 0) {
			throw new IpdRuntimeError(
				"unknown_workflow_template",
				`Unknown Workflow Template: ${input.workflowTemplateId}`,
			);
		}
		const planning = await assets.planner.planAndFreeze({
			runId,
			traceId: this.idFactory(),
			task: input.task,
			skill: input.skill,
			agentCards: assets.agentCards,
			plannerCard: assets.plannerCard,
			staffCoreCards: assets.staffCoreCards,
			templates,
			workflowTemplateId: input.workflowTemplateId,
			globalBudget: globalBudget(tokenBudget, expectedDurationMs, input.hardTokenLimit),
			cwd: input.context.cwd,
			runDefaultModel: input.context.runDefaultModel,
			runDefaultThinkingLevel: input.context.runDefaultThinkingLevel,
			signal: input.context.signal,
		});
		if (!planning.ok) return this.result(runId, "full");
		await this.graphEngine.run(runId, this.graphContext(input.skill, input.context));
		return this.result(runId, "full");
	}

	async resume(
		runId: string,
		escalationId: string,
		answer: string,
		context: IpdRuntimeExecutionContext,
	): Promise<IpdToolResult> {
		const run = this.ledger.getRun(runId);
		if (!run) throw new IpdRuntimeError("run_not_found", `Run not found: ${runId}`);
		const skill = context.availableSkills.find(
			(candidate) => candidate.name === run.skill.name && candidate.hash === run.skill.hash,
		);
		if (!skill) {
			throw new IpdRuntimeError(
				"skill_unavailable",
				`The frozen Skill Snapshot is not available in the current Pi context: ${run.skill.name}`,
			);
		}
		try {
			await this.graphEngine.resume(runId, escalationId, answer, this.graphContext(skill, context));
		} catch (error) {
			if (error instanceof GraphEngineError) throw new IpdRuntimeError(error.code, error.message);
			throw error;
		}
		return this.result(runId, "full");
	}

	status(runId: string, detail: "summary" | "nodes" | "full" = "summary"): IpdToolResult {
		return this.result(runId, detail);
	}

	async cancel(runId: string, reason?: string): Promise<IpdToolResult> {
		await this.graphEngine.cancel(runId, reason);
		return this.result(runId, "full");
	}

	private graphContext(skill: SkillSnapshot, context: IpdRuntimeExecutionContext): GraphRunContext {
		return {
			cwd: context.cwd,
			skill,
			availableSkills: context.availableSkills,
			runDefaultModel: context.runDefaultModel,
			runDefaultThinkingLevel: context.runDefaultThinkingLevel,
			signal: context.signal,
		};
	}

	private result(runId: string, detail: "summary" | "nodes" | "full"): IpdToolResult {
		let snapshot: RunSnapshot;
		try {
			snapshot = this.ledger.getRunSnapshot(runId);
		} catch (error) {
			throw new IpdRuntimeError("run_not_found", error instanceof Error ? error.message : String(error));
		}
		const openEscalation = [...snapshot.escalations]
			.reverse()
			.find((item) => item.status === "open" && item.target === "user");
		const artifacts = snapshot.artifacts
			.filter((artifact) => artifact.status === "accepted")
			.map((artifact) => {
				const parsed = validateSchema<ArtifactManifest>(ArtifactManifestSchema, artifact.manifest);
				if (!parsed.ok) throw new IpdRuntimeError("artifact_error", `Invalid Artifact in Ledger: ${artifact.id}`);
				return parsed.value;
			});
		const byCategory = { staff: 0, execution: 0, review: 0, rework: 0 };
		for (const usage of snapshot.budgetUsage) byCategory[usage.category] += usage.totalTokens;
		const usage = {
			inputTokens: snapshot.budgetUsage.reduce((total, item) => total + item.inputTokens, 0),
			outputTokens: snapshot.budgetUsage.reduce((total, item) => total + item.outputTokens, 0),
			cacheReadTokens: snapshot.budgetUsage.reduce((total, item) => total + item.cacheReadTokens, 0),
			cacheWriteTokens: snapshot.budgetUsage.reduce((total, item) => total + item.cacheWriteTokens, 0),
			totalTokens: snapshot.budgetUsage.reduce((total, item) => total + item.totalTokens, 0),
			costUsd: snapshot.budgetUsage.reduce((total, item) => total + item.costUsd, 0),
			durationMs: snapshot.budgetUsage.reduce((total, item) => total + item.durationMs, 0),
			softTokenLimit: snapshot.workflow?.definition.globalBudget.tokens ?? 0,
			hardTokenLimit: snapshot.workflow?.definition.globalBudget.hardTokenLimit,
			byCategory,
		};
		const status = publicStatus(snapshot.run.status);
		const summaries: Record<IpdToolStatus, string> = {
			running: "IPD 任务正在执行",
			waiting_user: "IPD 任务等待用户补充信息",
			succeeded: "IPD 任务已完成并通过最终质量门",
			failed: "IPD 任务执行失败",
			cancelled: "IPD 任务已取消",
		};
		let details: IpdToolResultDetails;
		if (detail === "full") details = { detail, snapshot };
		else if (detail === "nodes") {
			details = {
				detail,
				run: snapshot.run,
				nodes: snapshot.nodes,
				gates: snapshot.gates,
				escalations: snapshot.escalations,
			};
		} else details = { detail, run: snapshot.run, escalations: snapshot.escalations };
		return {
			runId,
			status,
			summary: `${summaries[status]}（Run: ${runId}）`,
			question:
				status === "waiting_user" && openEscalation
					? {
							escalationId: openEscalation.id,
							prompt: openEscalation.question,
							context: JSON.stringify(openEscalation.context),
						}
					: undefined,
			artifacts: artifacts.length > 0 ? artifacts : undefined,
			failure: isIpdFailure(snapshot.run.failure) ? snapshot.run.failure : undefined,
			usage,
			details,
		};
	}
}
