// 编排任务接入、规范选择、工作流设计和编译冻结。
import { compileWorkflow } from "../compiler/compiler.ts";
import type { CompilerAssetCatalog } from "../compiler/types.ts";
import type { ExecutionBaseline, LockedSkill } from "../contracts/baseline.ts";
import type { JsonValue } from "../contracts/primitives.ts";
import type { ProcessSelection, ProcessSpec } from "../contracts/process-spec.ts";
import type { RunState } from "../contracts/runtime.ts";
import type { TaskInput } from "../contracts/task-input.ts";
import type { WorkflowDefinition } from "../contracts/workflow.ts";
import { hashJson } from "../ir/hash.ts";
import type { WorkflowAssetStore } from "../registry/workflow-asset-store.ts";
import { WorkflowAssetWriteError } from "../registry/workflow-asset-store.ts";
import { prepareRunDirectory, type RunDirectory } from "../runtime/run-directory.ts";
import type { FileRunStore } from "../runtime/run-store.ts";

export interface ProcessSelector {
	select(runId: string, task: TaskInput, specs: readonly ProcessSpec[]): Promise<ProcessSelection>;
}

export class ProcessSelectionBlockedError extends Error {
	readonly unresolvedFactRefs: string[];

	constructor(message: string, unresolvedFactRefs: string[]) {
		super(message);
		this.name = "ProcessSelectionBlockedError";
		this.unresolvedFactRefs = unresolvedFactRefs;
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
}

export interface PrepareRunInput {
	projectRoot: string;
	runId: string;
	taskInput: TaskInput;
	runSkill: LockedSkill;
	processSpecs: readonly ProcessSpec[];
	assets: CompilerAssetCatalog;
	executionIdentity?: JsonValue;
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

	async accept(input: PrepareRunInput): Promise<RunDirectory> {
		const directory = await prepareRunDirectory(input.projectRoot, input.runId);
		this.store.bind(input.runId, directory.stateFile);
		const initial: RunState = {
			runId: input.runId,
			revision: 0,
			phase: "intake",
			status: "running",
			taskInput: input.taskInput,
			runSkill: input.runSkill,
			nodes: [],
			rounds: [],
			submissions: [],
			reviews: [],
			approvals: [],
			mechanicalChecks: [],
			events: [],
			operations: {},
		};
		try {
			const existing = await this.store.read(input.runId);
			if (
				hashJson(existing.taskInput) !== hashJson(input.taskInput) ||
				existing.runSkill?.hash !== input.runSkill.hash
			)
				throw new Error(`Run ${input.runId} was already accepted with different input`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await this.store.create(initial);
		}
		return directory;
	}

	async prepareAccepted(input: PrepareRunInput, directory: RunDirectory): Promise<PrepareRunResult> {
		let selection: ProcessSelection;
		try {
			selection = await this.selector.select(input.runId, input.taskInput, input.processSpecs);
		} catch (error) {
			if (!(error instanceof ProcessSelectionBlockedError)) throw error;
			return this.block(input.runId, directory, [
				`Process selection blocked: ${error.message}`,
				...error.unresolvedFactRefs.map((id) => `Unresolved fact: ${id}`),
			]);
		}
		const spec = input.processSpecs.find(
			(item) =>
				item.process_spec_id === selection.process_spec_ref.id &&
				item.version === selection.process_spec_ref.version,
		);
		if (!spec || hashJson(spec) !== selection.process_spec_ref.hash)
			return this.block(input.runId, directory, ["Selected ProcessSpec is unavailable or changed"]);
		await this.store.mutate(input.runId, "process-selected", { selection: hashJson(selection) }, (draft, event) => {
			draft.phase = "design";
			draft.processSelection = selection;
			event.emit("process_selected", { processSpec: selection.process_spec_ref.id });
			return true;
		});
		let diagnostics: string[] = [];
		for (let revision = 1; revision <= 10; revision++) {
			const workflow = await this.designer.design(input.runId, input.taskInput, selection, spec, diagnostics);
			const workflowHash = hashJson(workflow);
			await this.store.mutate(
				input.runId,
				`workflow-designed:${workflowHash}`,
				{ workflow: workflowHash },
				(draft, event) => {
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
					const saved = await this.workflowAssets.save(workflow, compiled.baseline.workflowHash);
					await this.store.mutate(
						input.runId,
						`workflow-asset-saved:${compiled.baseline.workflowHash}`,
						{ source: saved.record.source },
						(_draft, event) => {
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
		return this.block(input.runId, directory, diagnostics);
	}

	private async block(runId: string, directory: RunDirectory, diagnostics: string[]): Promise<PrepareRunResult> {
		await this.store.mutate(runId, `prepare-blocked:${hashJson(diagnostics)}`, { diagnostics }, (draft, event) => {
			draft.status = "blocked";
			draft.failure = { code: "preparation_blocked", message: diagnostics.join("\n") };
			event.emit("preparation_blocked", { diagnostics });
			return true;
		});
		return { ok: false, directory, diagnostics };
	}
}
