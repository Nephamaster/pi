import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SkillSnapshot } from "../adapter/node-runner.ts";
import { type ArtifactManifest, ArtifactManifestSchema } from "../artifact/manifest.ts";
import { toJsonValue } from "../ir/hash.ts";
import { BudgetDefinitionSchema, type WorkflowDefinition } from "../ir/schemas.ts";
import type { CompiledAgentCard, IpdDiagnostic, WorkflowAssetRecord } from "../ir/types.ts";
import { validateSchema } from "../ir/validation.ts";
import type { SqliteIpdLedger } from "../ledger/sqlite-ledger.ts";
import type { NodeInstanceRecord, RunSnapshot, RunStatus } from "../ledger/types.ts";
import type { PlanAndFreezeWorkflowRequest, PlanAndFreezeWorkflowResult } from "../staff/workflow-planner.ts";
import type { IpdToolResult, IpdToolResultDetails, IpdToolStatus } from "../tool/ipd-result.ts";
import { createIpdFailure, type IpdFailure } from "./failure.ts";
import {
	allowedUserResumeResolutions,
	GraphEngineError,
	type GraphRunContext,
	type GraphRunResult,
	type UserAnswerProvenance,
	type UserResumeResolution,
} from "./graph-engine.ts";

export interface IpdWorkflowPlanningService {
	planAndFreeze(request: PlanAndFreezeWorkflowRequest): Promise<PlanAndFreezeWorkflowResult>;
}

export interface IpdGraphExecutionService {
	run(runId: string, context: GraphRunContext): Promise<GraphRunResult>;
	resume(
		runId: string,
		escalationId: string,
		resolution: UserResumeResolution,
		answer: string,
		context: GraphRunContext,
		provenance?: UserAnswerProvenance,
	): Promise<GraphRunResult>;
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
	workflowTemplateVersion?: string;
	workflowTemplateHash?: string;
	ifBudget?: boolean;
	tokenBudget?: number;
	expectedDurationMs?: number;
	timeBudgetMs?: number;
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
	if (
		status === "planning" ||
		status === "compiling" ||
		status === "replanning" ||
		status === "ready" ||
		status === "running"
	) {
		return "running";
	}
	return status;
}

function boundedBudget(
	tokens: number,
	timeLimitMs: number,
	expectedDurationMs?: number,
	hardTokenLimit?: number,
): WorkflowDefinition["globalBudget"] {
	const staffTokens = Math.max(1, Math.floor(tokens * 0.15));
	const reviewerTokens = Math.max(1, Math.floor(tokens * 0.2));
	const reworkTokens = Math.max(1, Math.floor(tokens * 0.15));
	return {
		mode: "bounded",
		tokens,
		timeLimitMs,
		staffTokens,
		reviewerTokens,
		reworkTokens,
		expectedDurationMs,
		hardTokenLimit,
	};
}

function compareVersions(left: string, right: string): number {
	const parts = (version: string) => version.split(/[.+-]/, 3).map((part) => Number.parseInt(part, 10));
	const leftParts = parts(left);
	const rightParts = parts(right);
	for (let index = 0; index < 3; index++) {
		const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (difference !== 0) return difference;
	}
	const leftPrerelease = left.includes("-");
	const rightPrerelease = right.includes("-");
	if (leftPrerelease !== rightPrerelease) return leftPrerelease ? -1 : 1;
	return left.localeCompare(right);
}

export function selectWorkflowTemplate(
	assets: readonly WorkflowAssetRecord[],
	id: string,
	version?: string,
	hash?: string,
): WorkflowAssetRecord | undefined {
	return assets
		.filter(
			(asset) =>
				asset.workflow.id === id &&
				(version === undefined || asset.workflow.version === version) &&
				(hash === undefined || asset.hash === hash),
		)
		.sort((left, right) => compareVersions(right.workflow.version, left.workflow.version))[0];
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
	private readonly backgroundRuns = new Map<string, Promise<void>>();
	private readonly runRoots = new Map<string, string>();

	constructor(options: IpdRuntimeOptions) {
		this.ledger = options.ledger;
		this.graphEngine = options.graphEngine;
		this.assetProvider = options.assetProvider;
		this.idFactory = options.idFactory ?? randomUUID;
	}

	[Symbol.dispose](): void {
		this.close();
	}

	close(): void {
		this.ledger.close();
	}

	async start(input: IpdRuntimeStartInput): Promise<IpdToolResult> {
		const ifBudget = input.ifBudget ?? false;
		if (
			!ifBudget &&
			(input.tokenBudget !== undefined || input.timeBudgetMs !== undefined || input.hardTokenLimit !== undefined)
		) {
			throw new IpdRuntimeError("budget_invalid", "Budget limits require ifBudget=true");
		}
		if (
			ifBudget &&
			input.hardTokenLimit !== undefined &&
			input.tokenBudget !== undefined &&
			input.hardTokenLimit < input.tokenBudget
		) {
			throw new IpdRuntimeError("budget_invalid", "Hard token limit cannot be lower than the soft token budget");
		}
		let globalBudget: WorkflowDefinition["globalBudget"];
		if (ifBudget) {
			const { tokenBudget, timeBudgetMs } = input;
			if (tokenBudget === undefined || timeBudgetMs === undefined) {
				throw new IpdRuntimeError("budget_invalid", "Bounded Runs require tokenBudget and timeBudgetMs");
			}
			globalBudget = boundedBudget(tokenBudget, timeBudgetMs, input.expectedDurationMs, input.hardTokenLimit);
		} else {
			globalBudget = { mode: "unbounded", expectedDurationMs: input.expectedDurationMs };
		}
		const runId = this.idFactory();
		const assets = await this.assetProvider.prepare({
			cwd: input.context.cwd,
			projectTrusted: input.context.projectTrusted,
			availableSkills: input.context.availableSkills,
			runDefaultModel: input.context.runDefaultModel,
		});
		const selectedTemplate = input.workflowTemplateId
			? selectWorkflowTemplate(
					assets.workflowAssets,
					input.workflowTemplateId,
					input.workflowTemplateVersion,
					input.workflowTemplateHash,
				)
			: undefined;
		const templates = selectedTemplate ? [selectedTemplate] : input.workflowTemplateId ? [] : assets.workflowAssets;
		if (input.workflowTemplateId && !selectedTemplate) {
			throw new IpdRuntimeError(
				"unknown_workflow_template",
				`Unknown Workflow Template: ${input.workflowTemplateId}${input.workflowTemplateVersion ? `@${input.workflowTemplateVersion}` : ""}${input.workflowTemplateHash ? `#${input.workflowTemplateHash}` : ""}`,
			);
		}
		const backgroundContext = { ...input.context, signal: undefined };
		const planning = assets.planner.planAndFreeze({
			runId,
			traceId: this.idFactory(),
			task: input.task,
			skill: input.skill,
			agentCards: assets.agentCards,
			plannerCard: assets.plannerCard,
			staffCoreCards: assets.staffCoreCards,
			templates,
			workflowTemplateId: input.workflowTemplateId,
			workflowTemplateVersion: selectedTemplate?.workflow.version,
			workflowTemplateHash: selectedTemplate?.hash,
			globalBudget,
			cwd: input.context.cwd,
			runDefaultModel: input.context.runDefaultModel,
			runDefaultThinkingLevel: input.context.runDefaultThinkingLevel,
			signal: undefined,
		});
		const execution = planning
			.then(async (result) => {
				if (result.ok) await this.runAndAmend(runId, input.skill, backgroundContext);
			})
			.catch((error: unknown) => this.recordBackgroundFailure(runId, error))
			.finally(() => this.backgroundRuns.delete(runId));
		this.backgroundRuns.set(runId, execution);
		this.runRoots.set(runId, join(input.context.cwd, ".pi", "ipd", "runs", runId));
		await Promise.resolve();
		if (!this.ledger.getRun(runId)) {
			await planning;
			if (!this.ledger.getRun(runId))
				throw new IpdRuntimeError("planner_failed", "Planner failed before creating a Run");
		}
		return this.result(runId, "summary");
	}

	async resume(
		runId: string,
		escalationId: string,
		resolution: UserResumeResolution,
		answer: string,
		context: IpdRuntimeExecutionContext,
		provenance?: UserAnswerProvenance,
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
			const result = await this.graphEngine.resume(
				runId,
				escalationId,
				resolution,
				answer,
				this.graphContext(skill, context),
				provenance,
			);
			if (result.status === "replanning" && !this.backgroundRuns.has(runId)) {
				const backgroundContext = { ...context, signal: undefined };
				const execution = this.runAndAmend(runId, skill, backgroundContext)
					.catch((error: unknown) => this.recordBackgroundFailure(runId, error))
					.finally(() => this.backgroundRuns.delete(runId));
				this.backgroundRuns.set(runId, execution);
			}
		} catch (error) {
			if (error instanceof GraphEngineError) throw new IpdRuntimeError(error.code, error.message);
			throw error;
		}
		return this.result(runId, "full");
	}

	async resumeRun(runId: string, context: IpdRuntimeExecutionContext): Promise<IpdToolResult> {
		const snapshot = this.ledger.getRunSnapshot(runId);
		if (!["planning", "compiling", "replanning", "ready", "running"].includes(snapshot.run.status)) {
			throw new IpdRuntimeError("invalid_resume", `Run cannot resume from ${snapshot.run.status}: ${runId}`);
		}
		const skill = context.availableSkills.find(
			(candidate) => candidate.name === snapshot.run.skill.name && candidate.hash === snapshot.run.skill.hash,
		);
		if (!skill)
			throw new IpdRuntimeError("skill_unavailable", `Frozen Skill is unavailable: ${snapshot.run.skill.name}`);
		if (!this.backgroundRuns.has(runId)) {
			const backgroundContext = { ...context, signal: undefined };
			const execution = (async () => {
				if (!snapshot.workflow) {
					const budget = validateSchema<WorkflowDefinition["globalBudget"]>(
						BudgetDefinitionSchema,
						snapshot.run.globalBudget,
					);
					if (!budget.ok) throw new Error("Persisted Run budget is invalid");
					const assets = await this.assetProvider.prepare({
						cwd: context.cwd,
						projectTrusted: context.projectTrusted,
						availableSkills: context.availableSkills,
						runDefaultModel: context.runDefaultModel,
					});
					const planning = await assets.planner.planAndFreeze({
						runId,
						traceId: snapshot.run.traceId,
						task: snapshot.run.task,
						skill,
						agentCards: assets.agentCards,
						plannerCard: assets.plannerCard,
						staffCoreCards: assets.staffCoreCards,
						templates: assets.workflowAssets,
						globalBudget: budget.value,
						cwd: context.cwd,
						runDefaultModel: context.runDefaultModel,
						runDefaultThinkingLevel: context.runDefaultThinkingLevel,
						resumeExistingRun: true,
					});
					if (!planning.ok) return;
				}
				await this.runAndAmend(runId, skill, backgroundContext);
			})()
				.catch((error: unknown) => this.recordBackgroundFailure(runId, error))
				.finally(() => this.backgroundRuns.delete(runId));
			this.backgroundRuns.set(runId, execution);
		}
		this.runRoots.set(runId, join(context.cwd, ".pi", "ipd", "runs", runId));
		return this.result(runId, "summary");
	}

	status(runId: string, detail: "summary" | "nodes" | "full" = "summary", afterSequence?: number): IpdToolResult {
		return this.result(runId, detail, afterSequence);
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

	private async runAndAmend(runId: string, skill: SkillSnapshot, context: IpdRuntimeExecutionContext): Promise<void> {
		while (true) {
			let snapshot = this.ledger.getRunSnapshot(runId);
			if (snapshot.run.status === "replanning") {
				const budget = validateSchema<WorkflowDefinition["globalBudget"]>(
					BudgetDefinitionSchema,
					snapshot.run.globalBudget,
				);
				if (!budget.ok) throw new Error("Persisted Run budget is invalid");
				const assets = await this.assetProvider.prepare({
					cwd: context.cwd,
					projectTrusted: context.projectTrusted,
					availableSkills: context.availableSkills,
					runDefaultModel: context.runDefaultModel,
				});
				const request = [...snapshot.decisions]
					.reverse()
					.find((decision) => decision.type === "workflow_amendment_request");
				const planning = await assets.planner.planAndFreeze({
					runId,
					traceId: snapshot.run.traceId,
					task: snapshot.run.task,
					skill,
					agentCards: assets.agentCards,
					plannerCard: assets.plannerCard,
					staffCoreCards: assets.staffCoreCards,
					templates: assets.workflowAssets,
					globalBudget: budget.value,
					cwd: context.cwd,
					runDefaultModel: context.runDefaultModel,
					runDefaultThinkingLevel: context.runDefaultThinkingLevel,
					amendExistingWorkflow: true,
					amendmentContext: request
						? toJsonValue({
								nodeId: request.nodeId ?? null,
								rationale: request.rationale,
								evidence: request.evidence,
							})
						: null,
				});
				if (!planning.ok) return;
				snapshot = this.ledger.getRunSnapshot(runId);
			}
			if (!["ready", "running"].includes(snapshot.run.status)) return;
			const result = await this.graphEngine.run(runId, this.graphContext(skill, context));
			if (result.status !== "replanning") return;
		}
	}

	private recordBackgroundFailure(runId: string, error: unknown): void {
		const run = this.ledger.getRun(runId);
		if (!run || ["succeeded", "failed", "cancelled"].includes(run.status)) return;
		this.ledger.transitionRun({
			runId,
			idempotencyKey: `runtime:${runId}:background-failed`,
			status: "failed",
			failure: toJsonValue(
				createIpdFailure({
					code: "background_execution_failed",
					category: "internal_error",
					message: error instanceof Error ? error.message : String(error),
					retryable: true,
					runId,
					traceId: run.traceId,
				}),
			),
		});
	}

	private result(runId: string, detail: "summary" | "nodes" | "full", afterSequence?: number): IpdToolResult {
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
			budgetMode: snapshot.workflow?.definition.globalBudget.mode ?? "unbounded",
			softTokenLimit:
				snapshot.workflow?.definition.globalBudget.mode === "bounded"
					? snapshot.workflow.definition.globalBudget.tokens
					: undefined,
			hardTokenLimit:
				snapshot.workflow?.definition.globalBudget.mode === "bounded"
					? snapshot.workflow.definition.globalBudget.hardTokenLimit
					: undefined,
			byCategory,
		};
		const status = publicStatus(snapshot.run.status);
		const latestNodes = new Map<string, NodeInstanceRecord>();
		for (const node of snapshot.nodes) {
			const current = latestNodes.get(node.nodeId);
			if (!current || node.attemptNumber > current.attemptNumber) latestNodes.set(node.nodeId, node);
		}
		const lastEvent = snapshot.events.at(-1);
		const progress = {
			phase: snapshot.run.status,
			workflowRevision: snapshot.workflow?.revision,
			activeNodeIds: Array.from(latestNodes.values())
				.filter((node) => ["running", "gate_checking", "gate_reviewing"].includes(node.status))
				.map((node) => node.nodeId),
			readyNodeIds: Array.from(latestNodes.values())
				.filter((node) => node.status === "ready")
				.map((node) => node.nodeId),
			waitingNodeIds: Array.from(latestNodes.values())
				.filter((node) => ["blocked", "rework_pending", "interrupted"].includes(node.status))
				.map((node) => node.nodeId),
			lastEvent: lastEvent
				? { sequence: lastEvent.sequence, type: lastEvent.type, timestamp: lastEvent.timestamp }
				: undefined,
			changedSinceSequence: afterSequence === undefined ? undefined : (lastEvent?.sequence ?? 0) > afterSequence,
			runRoot: this.runRoots.get(runId),
		};
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
							allowedResolutions: allowedUserResumeResolutions(openEscalation),
						}
					: undefined,
			artifacts: artifacts.length > 0 ? artifacts : undefined,
			failure: isIpdFailure(snapshot.run.failure) ? snapshot.run.failure : undefined,
			progress,
			usage,
			details,
		};
	}
}
