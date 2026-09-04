import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { NodeRunner, NodeRunTrace, SkillSnapshot } from "../adapter/node-runner.ts";
import { compileWorkflow } from "../ir/compiler.ts";
import { hashJson, toJsonValue } from "../ir/hash.ts";
import { type WorkflowDefinition, WorkflowDefinitionSchema } from "../ir/schemas.ts";
import type {
	CheckDefinition,
	CompiledAgentCard,
	CompiledWorkflow,
	IpdDiagnostic,
	JsonValue,
	WorkflowAssetRecord,
} from "../ir/types.ts";
import { validateSchema } from "../ir/validation.ts";
import type { SqliteIpdLedger } from "../ledger/sqlite-ledger.ts";
import type { RunSnapshot, WorkflowVersionRecord } from "../ledger/types.ts";
import { type WorkflowAssetStore, WorkflowAssetWriteError } from "../registry/workflow-asset-store.ts";
import { createIpdFailure, type IpdFailureCategory } from "../runtime/failure.ts";

export type WorkflowPlanningFailureCode =
	| "missing_skill"
	| "invalid_skill"
	| "invalid_agent_pool"
	| "planner_failed"
	| "planner_invalid_submission"
	| "planner_budget_exceeded"
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
	staffCoreCards: readonly CompiledAgentCard[];
	templates: readonly WorkflowAssetRecord[];
	workflowTemplateId?: string;
	workflowTemplateVersion?: string;
	workflowTemplateHash?: string;
	globalBudget: WorkflowDefinition["globalBudget"];
	cwd: string;
	runDefaultModel: Model<Api>;
	runDefaultThinkingLevel: ThinkingLevel;
	maxRevisions?: number;
	resumeExistingRun?: boolean;
	amendExistingWorkflow?: boolean;
	amendmentContext?: JsonValue;
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

function cardSummary(card: CompiledAgentCard, staffCore: boolean) {
	return {
		ref: { id: card.id, version: card.version, hash: card.hash },
		staffCore,
		name: card.name,
		description: card.description,
		applicableScenarios: card.applicableScenarios,
		responsibilities: card.responsibilities,
		nonResponsibilities: card.nonResponsibilities,
		capabilities: card.capabilities,
		principles: card.principles,
		deliverables: card.deliverables,
		promptProfile: card.promptProfile,
		knowledgeBases: card.knowledgeBases,
		model: card.model,
		skills: card.skills,
		tools: card.tools,
		permissions: card.permissions,
		defaultBudget: card.defaultBudget,
	};
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
	if (code === "planner_invalid_submission") return "validation_error";
	if (code === "planner_budget_exceeded") return "budget_exceeded";
	if (["missing_skill", "invalid_skill", "invalid_agent_pool"].includes(code)) return "validation_error";
	return "internal_error";
}

function amendmentTarget(context: JsonValue | undefined): string | undefined {
	return typeof context === "object" &&
		context !== null &&
		!Array.isArray(context) &&
		typeof context.nodeId === "string"
		? context.nodeId
		: undefined;
}

function amendmentEditableSections(workflow: WorkflowDefinition, targetNodeId: string): string[] {
	const affected = new Set([targetNodeId]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const node of workflow.nodes) {
			if (affected.has(node.id)) continue;
			if (
				node.dependsOn.some((dependency) => affected.has(dependency)) ||
				node.inputs.some((input) => affected.has(input.fromNodeId))
			) {
				affected.add(node.id);
				changed = true;
			}
		}
	}
	for (const node of workflow.nodes) {
		if (node.gate.routes.pass === targetNodeId) affected.add(node.id);
	}
	const sections = Array.from(affected, (nodeId) => `node:${nodeId}`);
	if (
		workflow.finalArtifactNodeIds.some((nodeId) => affected.has(nodeId)) ||
		affected.has(workflow.finalGate.routes.rework)
	) {
		sections.push("final");
	}
	return sections;
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
		if (request.resumeExistingRun && request.amendExistingWorkflow) {
			return {
				ok: false,
				failure: planningFailure(
					"ledger_failed",
					"Initial planning recovery and Workflow amendment are mutually exclusive",
				),
				traces,
				revisions: 0,
			};
		}
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
		const poolIdentities = new Set(request.agentCards.map(cardIdentity));
		if (!poolIdentities.has(plannerIdentity)) {
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
		if (request.staffCoreCards.length === 0) {
			return {
				ok: false,
				failure: planningFailure("invalid_agent_pool", "Fixed Staff Core must contain at least one AgentCard"),
				traces,
				revisions: 0,
			};
		}
		if (request.staffCoreCards.some((card) => !poolIdentities.has(cardIdentity(card)))) {
			return {
				ok: false,
				failure: planningFailure(
					"invalid_agent_pool",
					"Fixed Staff Core contains an AgentCard outside the loaded Pool",
				),
				traces,
				revisions: 0,
			};
		}
		if (!request.staffCoreCards.some((card) => cardIdentity(card) === plannerIdentity)) {
			return {
				ok: false,
				failure: planningFailure(
					"invalid_agent_pool",
					"Planner AgentCard must be a member of the fixed Staff Core",
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

		let currentWorkflow: WorkflowVersionRecord | undefined;
		try {
			currentWorkflow = request.amendExistingWorkflow
				? this.ledger.getRunSnapshot(request.runId).workflow
				: undefined;
			if (request.amendExistingWorkflow && !currentWorkflow) {
				throw new Error(`Cannot amend Run without a frozen Workflow: ${request.runId}`);
			}
			if (!request.resumeExistingRun && !request.amendExistingWorkflow)
				this.ledger.createRun({
					runId: request.runId,
					traceId: request.traceId,
					idempotencyKey: `workflow-planner:${request.runId}:create`,
					task: request.task,
					skill: { name: request.skill.name, hash: request.skill.hash },
					globalBudget: toJsonValue(request.globalBudget),
				});
			if (!request.resumeExistingRun && !request.amendExistingWorkflow)
				this.ledger.transitionRun({
					runId: request.runId,
					idempotencyKey: `workflow-planner:${request.runId}:compiling`,
					status: "compiling",
				});
			if (request.resumeExistingRun && this.ledger.getRun(request.runId)?.status === "planning") {
				this.ledger.transitionRun({
					runId: request.runId,
					idempotencyKey: `workflow-planner:${request.runId}:resume-compiling`,
					status: "compiling",
				});
			}
		} catch (error) {
			return {
				ok: false,
				failure: planningFailure("ledger_failed", error instanceof Error ? error.message : String(error)),
				traces,
				revisions: 0,
			};
		}

		let planningSnapshot: RunSnapshot;
		try {
			planningSnapshot = this.ledger.getRunSnapshot(request.runId);
		} catch (error) {
			return {
				ok: false,
				failure: planningFailure("ledger_failed", error instanceof Error ? error.message : String(error)),
				traces,
				revisions: 0,
			};
		}
		const planningCycle =
			planningSnapshot.events.filter((event) => event.type === "workflow_planning_started").length + 1;
		this.ledger.recordRunEvent({
			runId: request.runId,
			idempotencyKey: `workflow-planner:${request.runId}:cycle:${planningCycle}:started`,
			type: "workflow_planning_started",
			payload: {
				planningCycle,
				mode: request.amendExistingWorkflow ? "amend" : request.resumeExistingRun ? "resume_initial" : "initial",
				baseWorkflowRevision: currentWorkflow?.revision ?? null,
			},
		});
		let previousCandidate: WorkflowDefinition | undefined = currentWorkflow?.definition;
		const latestNodes = new Map<string, RunSnapshot["nodes"][number]>();
		for (const attempt of planningSnapshot.nodes) {
			const current = latestNodes.get(attempt.nodeId);
			if (!current || attempt.attemptNumber > current.attemptNumber) latestNodes.set(attempt.nodeId, attempt);
		}
		const lockedNodes = request.amendExistingWorkflow
			? (currentWorkflow?.definition.nodes.filter((node) => latestNodes.get(node.id)?.status === "succeeded") ?? [])
			: [];
		if (request.resumeExistingRun && !previousCandidate) {
			const rejected = [...planningSnapshot.decisions]
				.reverse()
				.find((decision) => decision.type === "workflow_candidate" && decision.action === "reject");
			if (
				rejected &&
				typeof rejected.evidence === "object" &&
				rejected.evidence !== null &&
				!Array.isArray(rejected.evidence)
			) {
				const parsed = validateSchema<WorkflowDefinition>(WorkflowDefinitionSchema, rejected.evidence.candidate);
				if (parsed.ok) previousCandidate = parsed.value;
			}
		}
		let previousDiagnostics: IpdDiagnostic[] = [];
		for (let revision = 1; revision <= maxRevisions; revision++) {
			const result = await this.nodeRunner.runDecisionNode({
				kind: "workflow_planner",
				runId: request.runId,
				instanceId: `workflow-planner:${request.runId}:cycle:${planningCycle}:candidate:${revision}`,
				task: request.task,
				workflowHash: request.skill.hash,
				cwd: request.cwd,
				sessionDirectory: join(request.cwd, ".pi", "ipd", "runs", request.runId, "sessions"),
				agentCard: request.plannerCard,
				skills: [request.skill],
				runDefaultModel: request.runDefaultModel,
				runDefaultThinkingLevel: request.runDefaultThinkingLevel,
				budgetMode: request.globalBudget.mode,
				tokenBudget: request.globalBudget.mode === "bounded" ? request.globalBudget.staffTokens : undefined,
				timeoutMs: request.globalBudget.mode === "bounded" ? request.globalBudget.timeLimitMs : undefined,
				context: this.createPlannerContext(request, revision, previousCandidate, previousDiagnostics, lockedNodes),
				checks: this.checks,
				workflowConstraints: {
					skill: { name: request.skill.name, hash: request.skill.hash },
					globalBudget: request.globalBudget,
					staff: {
						core: request.staffCoreCards.map((card) => ({
							id: card.id,
							version: card.version,
							hash: card.hash,
						})),
					},
				},
				initialWorkflow:
					previousCandidate ?? (request.workflowTemplateId ? request.templates[0]?.workflow : undefined),
				lockedNodes,
				signal: request.signal,
			});
			traces.push(result.trace);
			this.recordPlannerUsage(request.runId, result.trace);
			if (!result.ok || result.kind !== "workflow_planner") {
				const message = !result.ok ? result.failure.message : "Planner returned an unexpected Decision kind";
				const code =
					!result.ok && result.failure.code === "budget_exceeded"
						? "planner_budget_exceeded"
						: !result.ok && ["invalid_submission", "missing_submission"].includes(result.failure.code)
							? "planner_invalid_submission"
							: "planner_failed";
				const retryable = !result.ok && result.failure.code === "provider_error";
				await this.failRun(request.runId, planningCycle, revision, code, message, [], traces, retryable);
				return {
					ok: false,
					failure: planningFailure(code, message),
					traces,
					revisions: revision,
				};
			}

			const candidate = result.submission;
			const planningDiagnostics: IpdDiagnostic[] = [];
			const fixedStaffCore = request.staffCoreCards.map((card) => ({
				id: card.id,
				version: card.version,
				hash: card.hash,
			}));
			if (hashJson(candidate.globalBudget) !== hashJson(request.globalBudget)) {
				planningDiagnostics.push({
					code: "budget_invalid",
					path: "/globalBudget",
					message: "Workflow must preserve the global budget supplied to ST",
				});
			}
			const compiled = compileWorkflow(candidate, {
				agentCards: request.agentCards,
				fixedStaffCore,
				runSkill: { name: request.skill.name, hash: request.skill.hash },
				skillNames: new Set([request.skill.name, ...request.agentCards.flatMap((card) => card.skills)]),
				toolNames: this.toolNames,
				checks: this.checks,
				workflowAssetIds: new Set(request.templates.map((template) => template.workflow.id)),
				workflowAssetRefs: new Set(
					request.templates.map(
						(template) => `${template.workflow.id}@${template.workflow.version}#${template.hash}`,
					),
				),
			});
			if (!compiled.ok) planningDiagnostics.push(...compiled.diagnostics);
			if (compiled.ok && request.amendExistingWorkflow) {
				planningDiagnostics.push(...this.ledger.validateWorkflowAmendment(request.runId, compiled.value));
			}
			if (!compiled.ok || planningDiagnostics.length > 0) {
				previousCandidate = candidate;
				previousDiagnostics = planningDiagnostics;
				this.recordCandidateRejection(
					request.runId,
					planningCycle,
					revision,
					candidate,
					planningDiagnostics,
					result.trace,
					"Workflow Compiler rejected the candidate",
				);
				continue;
			}

			let asset: WorkflowAssetRecord;
			try {
				asset = (await this.assetStore.save(compiled.value.definition, compiled.value.hash)).record;
			} catch (error) {
				if (error instanceof WorkflowAssetWriteError && error.code === "version_conflict") {
					const diagnostic: IpdDiagnostic = {
						code: "workflow_version_conflict",
						path: "/version",
						message: `${error.message}. Call submit_workflow_header with the same Workflow ID and a new, higher SemVer that is not already used; keep all unrelated preloaded sections unchanged, then finalize again.`,
					};
					previousCandidate = candidate;
					previousDiagnostics = [diagnostic];
					this.recordCandidateRejection(
						request.runId,
						planningCycle,
						revision,
						candidate,
						[diagnostic],
						result.trace,
						"Workflow Asset version conflicts with different existing content",
					);
					continue;
				}
				const message = error instanceof Error ? error.message : String(error);
				await this.failRun(request.runId, planningCycle, revision, "asset_write_failed", message, [], traces);
				return {
					ok: false,
					failure: planningFailure("asset_write_failed", message),
					traces,
					revisions: revision,
				};
			}

			try {
				const freezeInput = {
					runId: request.runId,
					idempotencyKey: `workflow-planner:${request.runId}:cycle:${planningCycle}:freeze`,
					workflow: compiled.value,
				};
				const workflowVersion = request.amendExistingWorkflow
					? this.ledger.amendWorkflow(freezeInput)
					: this.ledger.freezeWorkflow(freezeInput);
				this.ledger.recordDecision({
					runId: request.runId,
					idempotencyKey: `workflow-planner:${request.runId}:cycle:${planningCycle}:accepted`,
					decisionId: `workflow-candidate-accepted:${request.runId}:${planningCycle}`,
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
				await this.failRun(request.runId, planningCycle, revision, "ledger_failed", message, [], traces);
				return {
					ok: false,
					failure: planningFailure("ledger_failed", message),
					traces,
					revisions: revision,
				};
			}
		}

		const message = `Workflow planning exhausted all ${maxRevisions} candidate revisions`;
		if (request.amendExistingWorkflow) {
			this.pauseAmendment(request.runId, planningCycle, maxRevisions, message, previousDiagnostics, traces);
		} else {
			await this.failRun(
				request.runId,
				planningCycle,
				maxRevisions,
				"compiler_exhausted",
				message,
				previousDiagnostics,
				traces,
			);
		}
		return {
			ok: false,
			failure: planningFailure("compiler_exhausted", message, previousDiagnostics),
			traces,
			revisions: maxRevisions,
		};
	}

	private recordCandidateRejection(
		runId: string,
		planningCycle: number,
		revision: number,
		candidate: WorkflowDefinition,
		diagnostics: readonly IpdDiagnostic[],
		trace: NodeRunTrace,
		rationale: string,
	): void {
		this.ledger.recordDecision({
			runId,
			idempotencyKey: `workflow-planner:${runId}:cycle:${planningCycle}:rejected:${revision}`,
			decisionId: `workflow-candidate-rejected:${runId}:${planningCycle}:${revision}`,
			type: "workflow_candidate",
			action: "reject",
			rationale,
			evidence: toJsonValue({ candidate, diagnostics, trace }),
		});
	}

	private createPlannerContext(
		request: PlanAndFreezeWorkflowRequest,
		revision: number,
		previousCandidate: WorkflowDefinition | undefined,
		previousDiagnostics: readonly IpdDiagnostic[],
		lockedNodes: readonly WorkflowDefinition["nodes"][number][],
	) {
		const preloaded = previousCandidate ?? request.templates[0]?.workflow;
		const loadedSections = preloaded
			? {
					header: preloaded.id,
					acceptanceCriteria: preloaded.acceptanceCriteria.map((criterion) => criterion.id),
					nodes: preloaded.nodes.map((node) => node.id),
					nodeGates: preloaded.nodes.map((node) => node.gate.id),
					finalGate: preloaded.finalGate.id,
				}
			: null;
		const editableSections = Array.from(
			new Set(
				previousDiagnostics.map((diagnostic) => {
					if (diagnostic.nodeId) return `node:${diagnostic.nodeId}`;
					const nodeMatch = diagnostic.path.match(/^\/nodes\/(\d+)/);
					if (nodeMatch && previousCandidate) {
						const node = previousCandidate.nodes[Number(nodeMatch[1])];
						return node ? `node:${node.id}` : "nodes";
					}
					if (diagnostic.path.startsWith("/final")) return "final";
					if (diagnostic.path.startsWith("/acceptanceCriteria")) return "acceptance";
					return "header";
				}),
			),
		);
		const targetNodeId = amendmentTarget(request.amendmentContext);
		const initialAmendmentSections =
			request.amendExistingWorkflow && previousDiagnostics.length === 0 && preloaded
				? targetNodeId
					? amendmentEditableSections(preloaded, targetNodeId)
					: []
				: [];
		return toJsonValue({
			revision,
			workflowRevision: request.amendExistingWorkflow
				? (this.ledger.getRunSnapshot(request.runId).workflow?.revision ?? 0) + 1
				: 1,
			amendment: request.amendExistingWorkflow
				? {
						mode: "same_run",
						context: request.amendmentContext ?? null,
						constraints: [
							"Keep accepted execution and Gate contracts unchanged when reusing Artifacts; only an outgoing Gate pass route may be retargeted to a replacement Node",
							"Replace every attempted non-succeeded Node with a new Node ID",
							"Do not mutate or delete prior Attempts, Gates, Decisions, or Artifacts",
						],
					}
				: null,
			loadedSections,
			editableSections:
				editableSections.length > 0
					? editableSections
					: initialAmendmentSections.length > 0
						? initialAmendmentSections
						: ["all"],
			lockedAcceptedNodeIds: lockedNodes.map((node) => node.id),
			globalBudget: request.globalBudget,
			fixedStaffCore: request.staffCoreCards.map((card) => cardSummary(card, true)),
			agentCards: request.agentCards.map((card) =>
				cardSummary(
					card,
					request.staffCoreCards.some((staffCard) => cardIdentity(staffCard) === cardIdentity(card)),
				),
			),
			workflowAssets: request.templates.map((template) => ({
				id: template.workflow.id,
				version: template.workflow.version,
				hash: template.hash,
				definition: template.workflow,
			})),
			preloadedWorkflow:
				previousCandidate !== undefined
					? { source: "previous_candidate", id: previousCandidate.id, version: previousCandidate.version }
					: request.workflowTemplateId
						? {
								source: "template",
								id: request.workflowTemplateId,
								version: request.workflowTemplateVersion,
								hash: request.workflowTemplateHash,
							}
						: null,
			mechanicalChecks: this.checks.map((check) => ({
				id: check.id,
				parameters: check.parameters,
			})),
			compilerRules: {
				onlyExecutionNodes: true,
				everyNodeRequiresMechanicalAndSemanticGate: true,
				artifactSuccessPathMustBeDag: true,
				workflowMustReferenceLoadedAgentCards: true,
				workflowMustPreserveFixedStaffCore: true,
			},
			previousCandidate: previousCandidate ?? null,
			previousDiagnostics,
		});
	}

	private pauseAmendment(
		runId: string,
		planningCycle: number,
		revision: number,
		message: string,
		diagnostics: readonly IpdDiagnostic[],
		traces: readonly NodeRunTrace[],
	): void {
		try {
			this.ledger.recordDecision({
				runId,
				idempotencyKey: `workflow-planner:${runId}:cycle:${planningCycle}:paused-decision:${revision}`,
				decisionId: `workflow-planning-paused:${runId}:${planningCycle}:${revision}`,
				type: "workflow_planning",
				action: "pause",
				rationale: message,
				evidence: toJsonValue({ code: "compiler_exhausted", diagnostics, traces }),
			});
			const escalationId = `${runId}:workflow-amendment:${planningCycle}`;
			this.ledger.createEscalation({
				runId,
				idempotencyKey: `workflow-planner:${runId}:cycle:${planningCycle}:paused-escalation`,
				escalationId,
				target: "user",
				question: `${message}. Review the Compiler diagnostics and choose whether to revise the Workflow again or fail the Run.`,
				context: {
					reason: "amendment_exhausted",
					diagnostics: toJsonValue(diagnostics),
				},
			});
			this.ledger.transitionRun({
				runId,
				idempotencyKey: `workflow-planner:${runId}:cycle:${planningCycle}:paused:${revision}`,
				status: "waiting_user",
			});
		} catch {
			// Preserve the original planning failure returned to the caller.
		}
	}

	private async failRun(
		runId: string,
		planningCycle: number,
		revision: number,
		code: WorkflowPlanningFailureCode,
		message: string,
		diagnostics: readonly IpdDiagnostic[],
		traces: readonly NodeRunTrace[],
		retryable = false,
	): Promise<void> {
		try {
			this.ledger.recordDecision({
				runId,
				idempotencyKey: `workflow-planner:${runId}:cycle:${planningCycle}:failed-decision:${revision}`,
				decisionId: `workflow-planning-failed:${runId}:${planningCycle}:${revision}`,
				type: "workflow_planning",
				action: "fail",
				rationale: message,
				evidence: toJsonValue({ code, diagnostics, traces }),
			});
			this.ledger.transitionRun({
				runId,
				idempotencyKey: `workflow-planner:${runId}:cycle:${planningCycle}:failed:${revision}`,
				status: "failed",
				failure: toJsonValue(
					createIpdFailure({
						code,
						category: planningFailureCategory(code),
						message,
						retryable,
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
