// 用 Pi AgentSession 实现流程选择者和工作流设计师。
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import Type, { type Static } from "typebox";
import { NodeSessionAdapter, type NodeSessionEventEnvelope } from "../adapter/node-session-adapter.ts";
import { type PiNodeSessionCreateInput, PiNodeSessionFactory } from "../adapter/pi-node-session-factory.ts";
import { loadPrompt } from "../adapter/prompt-loader.ts";
import { renderAgentRuntimeProfile } from "../adapter/render-agent-profile.ts";
import type { IpdSessionSettings } from "../adapter/session-policy.ts";
import { createSubmissionTool, SubmissionCapture } from "../adapter/structured-submissions.ts";
import type { CompiledAgentCard } from "../contracts/agent-card.ts";
import type { LockedSkill, LockedTool } from "../contracts/baseline.ts";
import { IdentifierSchema, type JsonValue, NonEmptyStringSchema } from "../contracts/primitives.ts";
import { type ProcessSelection, ProcessSelectionDecisionSchema, type ProcessSpec } from "../contracts/process-spec.ts";
import type { TaskInput } from "../contracts/task-input.ts";
import type { WorkflowDefinition } from "../contracts/workflow.ts";
import { hashJson, toJsonValue } from "../ir/hash.ts";
import type { ResourceAdmission } from "../runtime/resource-admission.ts";
import { createAgentCardCatalogTools, createProcessSpecCatalogTools } from "./asset-catalog-tools.ts";
import {
	ProcessSelectionBlockedError,
	type ProcessSelector,
	type WorkflowDesignBlock,
	WorkflowDesignBlockedError,
	type WorkflowDesigner,
} from "./control-plane.ts";
import {
	buildInitialWorkflowDesignPrompt,
	buildProcessSelectionPrompt,
	buildWorkflowDesignRevisionPrompt,
} from "./control-role-prompts.ts";
import type { WorkflowDraftManager } from "./workflow-draft.ts";
import { createWorkflowDraftTools, type WorkflowDraftToolset } from "./workflow-draft-tools.ts";

const WorkflowDesignBlockSchema = Type.Object(
	{
		type: Type.Union([
			Type.Literal("resource_gap"),
			Type.Literal("expressiveness_gap"),
			Type.Literal("task_blocker"),
			Type.Literal("other"),
		]),
		reason: NonEmptyStringSchema,
		missing_conditions: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
		process_requirement_refs: Type.Array(IdentifierSchema, { uniqueItems: true }),
		diagnostics: Type.Array(
			Type.Object(
				{
					code: Type.Optional(NonEmptyStringSchema),
					path: Type.Optional(NonEmptyStringSchema),
					message: NonEmptyStringSchema,
				},
				{ additionalProperties: false },
			),
		),
		needed_to_resume: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export interface PiControlRoleOptions {
	admission?: ResourceAdmission;
	agentDir: string;
	sessionDirectory: string;
	workspace: string;
	modelRuntime: ModelRuntime;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	agentCard: CompiledAgentCard;
	skills?: readonly LockedSkill[];
	tools?: readonly LockedTool[];
	sessionSettings?: IpdSessionSettings;
	onSessionEvent?: (event: NodeSessionEventEnvelope) => void;
}

export class PiProcessSelector implements ProcessSelector {
	private readonly options: PiControlRoleOptions;
	private readonly selectionSkill: LockedSkill;
	private readonly sessions: NodeSessionAdapter<
		PiNodeSessionCreateInput,
		SubmissionCapture<Static<typeof ProcessSelectionDecisionSchema>>
	>;
	constructor(options: PiControlRoleOptions, selectionSkill: LockedSkill) {
		this.options = {
			...options,
			skills: [...(options.skills ?? []).filter((skill) => skill.id !== selectionSkill.id), selectionSkill],
		};
		this.selectionSkill = selectionSkill;
		this.sessions = new NodeSessionAdapter(new PiNodeSessionFactory(this.options), options.onSessionEvent, {
			maxToolCalls: 40,
			maxToolErrors: 5,
		});
	}
	async select(runId: string, task: TaskInput, specs: readonly ProcessSpec[]): Promise<ProcessSelection> {
		const roleId = "process-selector";
		if (this.sessions.getState(runId, roleId, roleId))
			throw new Error("Process selection already has a bound Session");
		const capture = this.sessions.bindState(
			runId,
			roleId,
			roleId,
			() => new SubmissionCapture<Static<typeof ProcessSelectionDecisionSchema>>(),
		);
		const tool = createSubmissionTool({
			name: "submit_process_selection",
			label: "submit_process_selection",
			description:
				"Submit the selected ProcessSpec or a blocked selection result. Use exact registered IDs, versions, and ProcessSpec requirement references. Runtime validates and records the candidate decision.",
			parameters: ProcessSelectionDecisionSchema,
			capture,
			validate: (decision) => validateProcessSelectionDecision(decision, task, specs),
		});
		let decision: Static<typeof ProcessSelectionDecisionSchema>;
		try {
			await this.sessions.create({
				runId,
				nodeId: roleId,
				participantId: roleId,
				createInput: {
					controlRole: true,
					resourceAdmission: this.options.admission
						? { admission: this.options.admission, rootId: runId }
						: undefined,
					nodeId: roleId,
					workspace: this.options.workspace,
					sessionDirectory: this.options.sessionDirectory,
					systemPrompt: `${loadPrompt("common")}\n\n${renderAgentRuntimeProfile(this.options.agentCard)}\n\n${loadPrompt("process-selector")}`,
					participant: {
						participantId: roleId,
						agentCard: this.options.agentCard,
						lockedSkills: [...(this.options.skills ?? [])],
						lockedTools: [...(this.options.tools ?? [])],
						lockedKnowledgeBases: [],
					},
					runDefaultModel: this.options.model,
					runDefaultThinkingLevel: this.options.thinkingLevel,
					controlTools: [...createProcessSpecCatalogTools(specs), tool],
				},
			});
			decision = await this.sessions.dispatch(
				runId,
				roleId,
				roleId,
				"selection-1",
				buildProcessSelectionPrompt(this.selectionSkill.id, task),
				{
					prepare: () => capture.beginRound(),
					result: () => {
						const value = capture.value;
						if (!value) throw new Error("process-selector did not submit a structured result");
						return value;
					},
				},
			);
		} finally {
			await this.sessions.releaseRun(runId);
			this.options.admission?.releaseParticipant(runId, `${roleId}/${roleId}`);
		}
		if (decision.status === "blocked")
			throw new ProcessSelectionBlockedError(
				decision.reason ?? "Process selection is blocked",
				decision.unresolved_fact_refs,
			);
		if (
			!decision.process_spec_id ||
			!decision.process_spec_version ||
			!decision.rationale ||
			!decision.process_requirement_refs
		)
			throw new Error("Process Selector submitted an incomplete selected decision");
		const spec = specs.find(
			(candidate) =>
				candidate.process_spec_id === decision.process_spec_id &&
				candidate.version === decision.process_spec_version,
		);
		if (!spec) throw new Error(`Process Selector chose an unavailable ProcessSpec: ${decision.process_spec_id}`);
		return {
			schema_version: 2,
			process_selection_id: `${runId}:selection`,
			run_id: runId,
			task_input_ref: { id: task.task_input_id, hash: hashJson(task) },
			process_spec_ref: { id: spec.process_spec_id, version: spec.version, hash: hashJson(spec) },
			rationale: decision.rationale,
			process_requirement_refs: decision.process_requirement_refs,
			unresolved_fact_refs: decision.unresolved_fact_refs,
		};
	}

	cancelRun(runId: string): Promise<void> {
		return this.sessions.releaseRun(runId);
	}
}

function validateProcessSelectionDecision(
	decision: Static<typeof ProcessSelectionDecisionSchema>,
	task: TaskInput,
	specs: readonly ProcessSpec[],
): string[] {
	const diagnostics: string[] = [];
	const unresolvedFactIds = new Set(task.unresolved_facts.map((item) => item.fact_id));
	if (decision.status === "blocked") {
		if (!decision.reason) diagnostics.push("blocked decision requires reason");
		for (const id of decision.unresolved_fact_refs)
			if (!unresolvedFactIds.has(id)) diagnostics.push(`Unknown unresolved_fact_ref: ${id}`);
		return diagnostics;
	}
	if (!decision.process_spec_id) diagnostics.push("selected decision requires process_spec_id");
	if (!decision.process_spec_version) diagnostics.push("selected decision requires process_spec_version");
	if (!decision.rationale) diagnostics.push("selected decision requires rationale");
	if (!decision.process_requirement_refs) diagnostics.push("selected decision requires process_requirement_refs");
	if (diagnostics.length > 0) return diagnostics;
	const spec = specs.find(
		(candidate) =>
			candidate.process_spec_id === decision.process_spec_id && candidate.version === decision.process_spec_version,
	);
	if (!spec) return [`Unknown ProcessSpec ${decision.process_spec_id}@${decision.process_spec_version}`];
	const processRequirementIds = new Set([
		...spec.required_activities.map((item) => item.activity_id),
		...spec.required_deliverables.map((item) => item.deliverable_id),
		...spec.required_reviews.map((item) => item.review_id),
		...spec.workflow_rules.map((item) => item.rule_id),
	]);
	for (const id of decision.process_requirement_refs ?? [])
		if (!processRequirementIds.has(id)) diagnostics.push(`Unknown process_requirement_ref: ${id}`);
	for (const id of decision.unresolved_fact_refs)
		if (!unresolvedFactIds.has(id)) diagnostics.push(`Unknown unresolved_fact_ref: ${id}`);
	return diagnostics;
}

function validateWorkflowDesignBlock(block: WorkflowDesignBlock, spec: ProcessSpec): string[] {
	const diagnostics: string[] = [];
	const processRequirementIds = new Set([
		...spec.required_activities.map((item) => item.activity_id),
		...spec.required_deliverables.map((item) => item.deliverable_id),
		...spec.required_reviews.map((item) => item.review_id),
		...spec.workflow_rules.map((item) => item.rule_id),
	]);
	for (const id of block.process_requirement_refs)
		if (!processRequirementIds.has(id)) diagnostics.push(`Unknown process_requirement_ref: ${id}`);
	return diagnostics;
}

export class PiWorkflowDesigner implements WorkflowDesigner {
	private readonly optionsForRun: (runId: string) => PiControlRoleOptions;
	private readonly managerForRun: (
		runId: string,
		task: TaskInput,
		selection: ProcessSelection,
		spec: ProcessSpec,
	) => WorkflowDraftManager;
	private readonly designSkill: LockedSkill;
	private readonly runSkill?: LockedSkill;
	private readonly assetSummary: JsonValue;
	private readonly agentCards: readonly CompiledAgentCard[];
	private readonly active = new Map<
		string,
		{
			adapter: NodeSessionAdapter<Parameters<PiNodeSessionFactory["create"]>[0]>;
			tools: WorkflowDraftToolset;
			blockCapture: SubmissionCapture<WorkflowDesignBlock>;
			initialized: boolean;
		}
	>();

	constructor(options: {
		optionsForRun(runId: string): PiControlRoleOptions;
		managerForRun(
			runId: string,
			task: TaskInput,
			selection: ProcessSelection,
			spec: ProcessSpec,
		): WorkflowDraftManager;
		designSkill: LockedSkill;
		runSkill?: LockedSkill;
		assetSummary: JsonValue;
		agentCards: readonly CompiledAgentCard[];
	}) {
		this.optionsForRun = options.optionsForRun;
		this.managerForRun = options.managerForRun;
		this.designSkill = options.designSkill;
		this.runSkill = options.runSkill;
		this.assetSummary = options.assetSummary;
		this.agentCards = options.agentCards;
	}
	async design(
		runId: string,
		task: TaskInput,
		selection: ProcessSelection,
		spec: ProcessSpec,
		compilerDiagnostics: readonly string[] = [],
	): Promise<WorkflowDefinition> {
		const manager = this.managerForRun(runId, task, selection, spec);
		const draft = await manager.open(runId);
		await manager.beginRevision();
		let active = this.active.get(runId);
		if (!active) {
			const options = this.optionsForRun(runId);
			const tools = createWorkflowDraftTools(manager, runId, {
				catalog: this.assetSummary,
				process: toJsonValue(spec),
				materialIds: task.materials.map((material) => material.material_id),
			});
			const blockCapture = new SubmissionCapture<WorkflowDesignBlock>();
			const blockTool = createSubmissionTool({
				name: "report_workflow_design_blocked",
				label: "Report Workflow Design Blocked",
				description:
					"Report a genuine task, resource, or workflow-expressiveness gap that prevents a legal WorkflowDefinition. Use this only after verifying that the gap cannot be solved by a different valid employee/resource binding without weakening the user task or ProcessSpec obligations.",
				parameters: WorkflowDesignBlockSchema,
				capture: blockCapture,
				validate: (value) => validateWorkflowDesignBlock(value as WorkflowDesignBlock, spec),
			});
			active = {
				adapter: new NodeSessionAdapter(new PiNodeSessionFactory(options), options.onSessionEvent, {
					maxToolCalls: 120,
					maxToolErrors: 8,
				}),
				tools,
				blockCapture,
				initialized: false,
			};
			this.active.set(runId, active);
			await active.adapter.create({
				runId,
				nodeId: "workflow-designer",
				participantId: "workflow-designer",
				createInput: {
					controlRole: true,
					nodeId: "workflow-designer",
					resourceAdmission: options.admission ? { admission: options.admission, rootId: runId } : undefined,
					workspace: options.workspace,
					sessionDirectory: options.sessionDirectory,
					systemPrompt: `${loadPrompt("common")}\n\n${renderAgentRuntimeProfile(options.agentCard)}\n\n${loadPrompt("workflow-designer")}`,
					participant: {
						participantId: "workflow-designer",
						agentCard: options.agentCard,
						lockedSkills: [this.designSkill, ...(this.runSkill ? [this.runSkill] : [])],
						lockedTools: [...(options.tools ?? [])],
						lockedKnowledgeBases: [],
					},
					runDefaultModel: options.model,
					runDefaultThinkingLevel: options.thinkingLevel,
					controlTools: [...tools.tools, ...createAgentCardCatalogTools(this.agentCards), blockTool],
				},
			});
		}
		const prompt = active.initialized
			? buildWorkflowDesignRevisionPrompt(draft.revision, compilerDiagnostics)
			: buildInitialWorkflowDesignPrompt(
					this.designSkill.id,
					task,
					selection,
					spec,
					this.assetSummary,
					compilerDiagnostics,
					this.runSkill,
				);
		const { submitted, blocked } = await active.adapter.dispatch(
			runId,
			"workflow-designer",
			"workflow-designer",
			`design-${draft.revision + 1}`,
			prompt,
			{
				prepare: () => {
					active.tools.resetSubmitted();
					active.blockCapture.beginRound();
				},
				result: () => ({ submitted: active.tools.getSubmitted(), blocked: active.blockCapture.value }),
			},
		);
		active.initialized = true;
		if (submitted) return submitted;
		if (blocked) throw new WorkflowDesignBlockedError(blocked);
		throw new Error("Workflow Designer did not submit a valid Draft or structured blocked result");
	}

	async cancelRun(runId: string): Promise<void> {
		const active = this.active.get(runId);
		if (!active) return;
		try {
			await active.tools.close();
		} finally {
			await active.adapter.releaseRun(runId);
			this.optionsForRun(runId).admission?.releaseParticipant(runId, "workflow-designer/workflow-designer");
			this.active.delete(runId);
		}
	}
}
