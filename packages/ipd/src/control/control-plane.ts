// 编排任务接入、规范选择、工作流设计和编译冻结。
import { compileWorkflow } from "../compiler/compiler.ts";
import type { CompilerAssetCatalog } from "../compiler/types.ts";
import { validateProcessSpecStaffing } from "../compiler/validate-process-spec.ts";
import type { ExecutionBaseline, LockedSkill } from "../contracts/baseline.ts";
import type { JsonValue } from "../contracts/primitives.ts";
import type { ProcessSelection, ProcessSpec } from "../contracts/process-spec.ts";
import type { RunControllerRecord, RunRequestRecord, RunState } from "../contracts/runtime.ts";
import type { TaskInput } from "../contracts/task-input.ts";
import type { WorkflowDefinition } from "../contracts/workflow.ts";
import { hashJson, toJsonValue } from "../ir/hash.ts";
import type { WorkflowAssetRecord } from "../ir/types.ts";
import type { WorkflowAssetStore } from "../registry/workflow-asset-store.ts";
import { WorkflowAssetWriteError } from "../registry/workflow-asset-store.ts";
import { requireCurrentController } from "../runtime/execution-control.ts";
import { prepareRunDirectory, type RunDirectory } from "../runtime/run-directory.ts";
import { type FileRunStore, RunAlreadyExistsError } from "../runtime/run-store.ts";

export interface ProcessSelector {
	select(runId: string, task: TaskInput, specs: readonly ProcessSpec[]): Promise<ProcessSelection>;
	cancelRun?(runId: string): Promise<void>;
}

export class ProcessSelectionBlockedError extends Error {
	readonly unresolvedFactRefs: string[];

	constructor(message: string, unresolvedFactRefs: string[]) {
		super(message);
		this.name = "ProcessSelectionBlockedError";
		this.unresolvedFactRefs = unresolvedFactRefs;
	}
}

export interface WorkflowDesignBlock {
	type: "resource_gap" | "expressiveness_gap" | "task_blocker" | "other";
	reason: string;
	missing_conditions: string[];
	process_requirement_refs: string[];
	diagnostics: Array<{ code?: string; path?: string; message: string }>;
	needed_to_resume: string[];
}

export class WorkflowDesignBlockedError extends Error {
	readonly block: WorkflowDesignBlock;

	constructor(block: WorkflowDesignBlock) {
		super(block.reason);
		this.name = "WorkflowDesignBlockedError";
		this.block = structuredClone(block);
	}
}

export interface WorkflowDesigner {
	design(
		runId: string,
		task: TaskInput,
		selection: ProcessSelection,
		spec: ProcessSpec,
		compilerDiagnostics?: readonly string[],
	): Promise<WorkflowDefinition>;
	cancelRun?(runId: string): Promise<void>;
}

export interface PrepareRunInput {
	projectRoot: string;
	runId: string;
	taskInput: TaskInput;
	runSkill: LockedSkill;
	processSpecs: readonly ProcessSpec[];
	assets: CompilerAssetCatalog;
	executionIdentity?: JsonValue;
	processSelection?: ProcessSelection;
	selectedProcessSpec?: ProcessSpec;
	workflowCandidate?: WorkflowDefinition;
	workflowTemplate?: WorkflowAssetRecord;
	request?: RunRequestRecord;
	controller?: Pick<RunControllerRecord, "controllerId" | "term">;
}

export type PrepareRunResult =
	| { ok: true; baseline: ExecutionBaseline; directory: RunDirectory }
	| { ok: false; directory: RunDirectory; diagnostics: string[] };

export class IpdControlPlane {
	private readonly store: FileRunStore;
	private readonly selector: ProcessSelector;
	private readonly designer: WorkflowDesigner;
	private readonly workflowAssets: WorkflowAssetStore;

	constructor(
		store: FileRunStore,
		selector: ProcessSelector,
		designer: WorkflowDesigner,
		workflowAssets: WorkflowAssetStore,
	) {
		this.store = store;
		this.selector = selector;
		this.designer = designer;
		this.workflowAssets = workflowAssets;
	}

	async prepare(input: PrepareRunInput): Promise<PrepareRunResult> {
		const directory = await this.accept(input);
		return this.prepareAccepted(input, directory);
	}

	async cancelRun(runId: string): Promise<void> {
		const results = await Promise.allSettled([this.selector.cancelRun?.(runId), this.designer.cancelRun?.(runId)]);
		const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
		if (errors.length)
			throw new AggregateError(
				errors.map((result) => result.reason),
				"Control sessions could not be released",
			);
	}

	async accept(input: PrepareRunInput): Promise<RunDirectory> {
		const directory = await prepareRunDirectory(input.projectRoot, input.runId);
		this.store.bind(input.runId, directory.stateFile);
		const initial: RunState = {
			runtimeSchemaVersion: 2,
			runId: input.runId,
			revision: 0,
			phase: "intake",
			status: "running",
			...(input.request ? { request: structuredClone(input.request) } : {}),
			taskInput: input.taskInput,
			runSkill: input.runSkill,
			nodes: [],
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
		const assertCompatible = (existing: RunState) => {
			if (
				hashJson(existing.taskInput) !== hashJson(input.taskInput) ||
				existing.runSkill?.hash !== input.runSkill.hash ||
				(input.request !== undefined && existing.request?.requestHash !== input.request.requestHash)
			)
				throw new Error(`Run ${input.runId} was already accepted with different input`);
		};
		try {
			assertCompatible(await this.store.read(input.runId));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			try {
				await this.store.create(initial);
			} catch (createError) {
				if (!(createError instanceof RunAlreadyExistsError)) throw createError;
				assertCompatible(await this.store.read(input.runId));
			}
		}
		return directory;
	}

	async prepareAccepted(input: PrepareRunInput, directory: RunDirectory): Promise<PrepareRunResult> {
		let selection: ProcessSelection;
		let spec: ProcessSpec;
		if (input.processSelection && input.selectedProcessSpec) {
			selection = structuredClone(input.processSelection);
			spec = structuredClone(input.selectedProcessSpec);
		} else if (input.selectedProcessSpec) {
			spec = input.selectedProcessSpec;
			selection = explicitProcessSelection(input.runId, input.taskInput, spec);
		} else {
			await this.setPreparationPhase(input.runId, "selection", "selection", input.controller);
			try {
				selection = await this.selector.select(input.runId, input.taskInput, input.processSpecs);
			} catch (error) {
				if (!(error instanceof ProcessSelectionBlockedError)) throw error;
				return this.block(
					input.runId,
					directory,
					[
						`Process selection blocked: ${error.message}`,
						...error.unresolvedFactRefs.map((id) => `Unresolved fact: ${id}`),
					],
					undefined,
					input.controller,
				);
			}
			if (!(await this.isRunning(input.runId, input.controller)))
				return { ok: false, directory, diagnostics: ["Run cancelled or controller replaced"] };
			const selected = input.processSpecs.find(
				(item) =>
					item.process_spec_id === selection.process_spec_ref.id &&
					item.version === selection.process_spec_ref.version,
			);
			if (!selected || hashJson(selected) !== selection.process_spec_ref.hash)
				return this.block(
					input.runId,
					directory,
					["Selected ProcessSpec is unavailable or changed"],
					undefined,
					input.controller,
				);
			spec = selected;
		}

		const staffingDiagnostics = validateProcessSpecStaffing(spec, input.assets.agentCards);
		await this.store.mutate(input.runId, "process-selected", { selection: hashJson(selection) }, (draft, event) => {
			if (draft.status !== "running") return false;
			this.requireController(draft, input.controller);
			draft.processSelection = selection;
			draft.selectedProcessSpec = structuredClone(spec);
			draft.staffingReport = {
				ok: staffingDiagnostics.length === 0,
				diagnostics: staffingDiagnostics.map((item) => ({ ...item })),
			};
			draft.phase = staffingDiagnostics.length === 0 ? "design" : "selection";
			event.emit("process_selected", { processSpec: selection.process_spec_ref.id });
			event.emit("process_staffing_checked", {
				ok: staffingDiagnostics.length === 0,
				diagnostics: staffingDiagnostics.map((item) => ({
					code: item.code,
					path: item.path,
					message: item.message,
				})),
			});
			return true;
		});
		if (staffingDiagnostics.length > 0)
			return this.block(
				input.runId,
				directory,
				staffingDiagnostics.map((item) => `${item.path}: ${item.message}`),
				"process_spec_unstaffable",
				input.controller,
			);
		if (input.workflowCandidate)
			return this.prepareRecoveredWorkflow(input, directory, selection, spec, input.workflowCandidate);
		if (input.workflowTemplate)
			return this.prepareWorkflowTemplate(input, directory, selection, spec, input.workflowTemplate);

		let diagnostics: string[] = [];
		for (let revision = 1; revision <= 10; revision++) {
			await this.setPreparationPhase(input.runId, "design", `design:${revision}`, input.controller);
			if (!(await this.isRunning(input.runId, input.controller)))
				return { ok: false, directory, diagnostics: ["Run cancelled or controller replaced"] };
			let workflow: WorkflowDefinition;
			try {
				workflow = await this.designer.design(input.runId, input.taskInput, selection, spec, diagnostics);
			} catch (error) {
				if (!(error instanceof WorkflowDesignBlockedError)) throw error;
				const blockJson = toJsonValue(error.block);
				await this.store.mutate(
					input.runId,
					`workflow-design-blocked:${hashJson(error.block)}`,
					{ block: blockJson },
					(draft, event) => {
						if (draft.status !== "running") return false;
						this.requireController(draft, input.controller);
						draft.workflowDesignBlock = structuredClone(error.block);
						event.emit("workflow_design_blocked", blockJson);
						return true;
					},
				);
				return this.block(
					input.runId,
					directory,
					[
						error.block.reason,
						...error.block.missing_conditions,
						...error.block.diagnostics.map((item) => item.message),
					],
					"workflow_design_blocked",
					input.controller,
				);
			}
			if (!(await this.isRunning(input.runId, input.controller)))
				return { ok: false, directory, diagnostics: ["Run cancelled or controller replaced"] };
			const workflowHash = hashJson(workflow);
			await this.store.mutate(
				input.runId,
				`workflow-designed:${workflowHash}`,
				{ workflow: workflowHash },
				(draft, event) => {
					if (draft.status !== "running") return false;
					this.requireController(draft, input.controller);
					draft.phase = "compile";
					draft.workflowCandidate = workflow;
					event.emit("workflow_designed", { workflowId: workflow.workflow_id, revision });
					return true;
				},
			);
			const compiled = compileWorkflow({
				runId: input.runId,
				workflow,
				taskInput: input.taskInput,
				processSelection: selection,
				processSpec: spec,
				assets: input.assets,
				executionIdentity: input.executionIdentity,
			});
			if (compiled.ok) {
				try {
					if (!(await this.isRunning(input.runId, input.controller)))
						return { ok: false, directory, diagnostics: ["Run cancelled or controller replaced"] };
					const saved = await this.workflowAssets.save(workflow, compiled.baseline.workflowHash);
					await this.store.mutate(
						input.runId,
						`workflow-asset-saved:${compiled.baseline.workflowHash}`,
						{ source: saved.record.source },
						(draft, event) => {
							if (draft.status !== "running") return false;
							this.requireController(draft, input.controller);
							event.emit("workflow_asset_saved", {
								source: saved.record.source,
								reused: saved.reused,
							});
							return true;
						},
					);
					return { ok: true, baseline: compiled.baseline, directory };
				} catch (error) {
					if (!(error instanceof WorkflowAssetWriteError) || error.code !== "version_conflict") throw error;
					diagnostics = [`/workflow_version: ${error.message}`];
					continue;
				}
			}
			diagnostics = compiled.report.diagnostics.map((item) => `${item.path}: ${item.message}`);
		}
		return this.block(input.runId, directory, diagnostics, undefined, input.controller);
	}

	private async prepareRecoveredWorkflow(
		input: PrepareRunInput,
		directory: RunDirectory,
		selection: ProcessSelection,
		spec: ProcessSpec,
		candidate: WorkflowDefinition,
	): Promise<PrepareRunResult> {
		const workflow = structuredClone(candidate);
		const compiled = compileWorkflow({
			runId: input.runId,
			workflow,
			taskInput: input.taskInput,
			processSelection: selection,
			processSpec: spec,
			assets: input.assets,
			executionIdentity: input.executionIdentity,
		});
		if (!compiled.ok)
			return this.block(
				input.runId,
				directory,
				compiled.report.diagnostics.map((item) => `${item.path}: ${item.message}`),
				"workflow_recovery_invalid",
				input.controller,
			);
		const saved = await this.workflowAssets.save(workflow, compiled.baseline.workflowHash);
		await this.store.mutate(
			input.runId,
			`workflow-recovered:${compiled.baseline.workflowHash}`,
			{ source: saved.record.source },
			(draft, event) => {
				if (draft.status !== "running") return false;
				this.requireController(draft, input.controller);
				draft.phase = "compile";
				draft.workflowCandidate = workflow;
				event.emit("workflow_candidate_recovered", {
					workflowId: workflow.workflow_id,
					workflowVersion: workflow.workflow_version,
					source: saved.record.source,
					reused: saved.reused,
				});
				return true;
			},
		);
		return { ok: true, baseline: compiled.baseline, directory };
	}

	private async prepareWorkflowTemplate(
		input: PrepareRunInput,
		directory: RunDirectory,
		selection: ProcessSelection,
		spec: ProcessSpec,
		template: WorkflowAssetRecord,
	): Promise<PrepareRunResult> {
		if (hashJson(template.workflow) !== template.hash)
			return this.block(
				input.runId,
				directory,
				["Selected Workflow template content Hash is invalid"],
				undefined,
				input.controller,
			);
		const workflow: WorkflowDefinition = {
			...structuredClone(template.workflow),
			task_input_ref: { id: input.taskInput.task_input_id, hash: hashJson(input.taskInput) },
			process_selection_ref: { id: selection.process_selection_id, hash: hashJson(selection) },
		};
		await this.store.mutate(
			input.runId,
			`workflow-template-selected:${template.hash}`,
			{ source: template.source },
			(draft, event) => {
				if (draft.status !== "running") return false;
				this.requireController(draft, input.controller);
				draft.phase = "compile";
				draft.workflowCandidate = structuredClone(workflow);
				event.emit("workflow_template_selected", {
					workflowId: workflow.workflow_id,
					workflowVersion: workflow.workflow_version,
					source: template.source,
				});
				return true;
			},
		);
		const compiled = compileWorkflow({
			runId: input.runId,
			workflow,
			taskInput: input.taskInput,
			processSelection: selection,
			processSpec: spec,
			assets: input.assets,
			executionIdentity: input.executionIdentity,
		});
		if (compiled.ok) return { ok: true, baseline: compiled.baseline, directory };
		return this.block(
			input.runId,
			directory,
			compiled.report.diagnostics.map((item) => `${item.path}: ${item.message}`),
			"workflow_template_invalid",
			input.controller,
		);
	}

	private async setPreparationPhase(
		runId: string,
		phase: "selection" | "design",
		operationId: string,
		controller?: Pick<RunControllerRecord, "controllerId" | "term">,
	): Promise<void> {
		await this.store.mutate(runId, `prepare-phase:${operationId}`, { phase }, (draft) => {
			if (draft.status !== "running") return false;
			this.requireController(draft, controller);
			draft.phase = phase;
			return true;
		});
	}

	private async isRunning(
		runId: string,
		controller?: Pick<RunControllerRecord, "controllerId" | "term">,
	): Promise<boolean> {
		const state = await this.store.read(runId);
		if (state.status !== "running") return false;
		if (!controller) return true;
		return (
			state.controller?.status === "active" &&
			state.controller.controllerId === controller.controllerId &&
			state.controller.term === controller.term
		);
	}

	private async block(
		runId: string,
		directory: RunDirectory,
		diagnostics: string[],
		failureCode = "preparation_blocked",
		controller?: Pick<RunControllerRecord, "controllerId" | "term">,
	): Promise<PrepareRunResult> {
		await this.store.mutate(
			runId,
			`prepare-blocked:${controller?.term ?? 0}:${hashJson({ failureCode, diagnostics })}`,
			{ diagnostics, controllerTerm: controller?.term ?? 0 },
			(draft, event) => {
				if (draft.status !== "running") return false;
				this.requireController(draft, controller);
				draft.status = "blocked";
				draft.failure = { code: failureCode, message: diagnostics.join("\n") };
				event.emit("preparation_blocked", { code: failureCode, diagnostics });
				return true;
			},
		);
		return { ok: false, directory, diagnostics };
	}

	private requireController(state: RunState, controller?: Pick<RunControllerRecord, "controllerId" | "term">): void {
		if (controller) requireCurrentController(state, controller.controllerId, controller.term);
	}
}

function explicitProcessSelection(runId: string, task: TaskInput, spec: ProcessSpec): ProcessSelection {
	return {
		schema_version: 2,
		process_selection_id: `${runId}:selection`,
		run_id: runId,
		task_input_ref: { id: task.task_input_id, hash: hashJson(task) },
		process_spec_ref: {
			id: spec.process_spec_id,
			version: spec.version,
			hash: hashJson(spec),
		},
		rationale: "Selected explicitly by the user through /ipd.",
		process_requirement_refs: [
			...spec.required_activities.map((item) => item.activity_id),
			...spec.required_deliverables.map((item) => item.deliverable_id),
			...spec.required_reviews.map((item) => item.review_id),
			...spec.workflow_rules.map((item) => item.rule_id),
		],
		unresolved_fact_refs: [],
	};
}
