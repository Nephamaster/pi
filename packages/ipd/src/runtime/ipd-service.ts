// 提供 Run 创建、后台执行、查询、事件和结果服务。
import type { CompilerAssetCatalog } from "../compiler/types.ts";
import type { LockedSkill } from "../contracts/baseline.ts";
import type { JsonValue } from "../contracts/primitives.ts";
import type { ProcessSpec } from "../contracts/process-spec.ts";
import type { FinalSubmissionRecord, RunEvent, RunState } from "../contracts/runtime.ts";
import type { TaskInput } from "../contracts/task-input.ts";
import type { WorkflowDefinition } from "../contracts/workflow.ts";
import type { IpdControlPlane, PrepareRunResult } from "../control/control-plane.ts";
import { hashJson } from "../ir/hash.ts";
import type { WorkflowAssetRecord } from "../ir/types.ts";
import type { WorkflowAssetStore } from "../registry/workflow-asset-store.ts";
import { bounded, isTerminal } from "./lifecycle.ts";
import { prepareRunDirectory, type RunDirectory } from "./run-directory.ts";
import type { FileRunStore } from "./run-store.ts";
import { finalApprovedSubmissionIds, markRunCancelled } from "./runtime-state.ts";
import type { WorkflowRuntime } from "./workflow-runtime.ts";

export interface IpdVisualizationLink {
	url: string;
	snapshotUrl: string;
	bindHost: string;
	port: number;
	shareHint?: string;
}

export interface IpdRunVisualizer {
	registerRun(runId: string): Promise<IpdVisualizationLink>;
	close?(): Promise<void>;
}

export interface IpdServiceOptions {
	store: FileRunStore;
	processSpecs: readonly ProcessSpec[];
	assets: CompilerAssetCatalog;
	projectRoot: string;
	executionIdentity?: JsonValue;
	createControlPlane(runId: string, runSkill: LockedSkill): IpdControlPlane;
	createRuntime(directory: RunDirectory): WorkflowRuntime;
	workflowAssets?: WorkflowAssetStore;
	visualizer?: IpdRunVisualizer;
	idFactory?: () => string;
	onClose?: () => Promise<void>;
	cleanupTimeoutMs?: number;
}

export interface CreateRunReceipt {
	runId: string;
	accepted: boolean;
	phase: RunState["phase"];
	status: RunState["status"];
	visualization?: IpdVisualizationLink;
	visualizationError?: string;
}

export interface IpdRunTemplateSelection {
	processSpecId: string;
	processSpecVersion: string;
	workflowId?: string;
	workflowVersion?: string;
}

export function createRunId(now = Date.now()): string {
	return new Date(now).toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
}

interface ManagedRun {
	controlPlane: IpdControlPlane;
	runtime?: WorkflowRuntime;
	promise?: Promise<void>;
	cleanup?: Promise<void>;
	transition?: Promise<unknown>;
}

export class IpdService {
	private readonly options: IpdServiceOptions;
	private readonly idFactory: () => string;
	private readonly requests = new Map<string, { hash: string; result: Promise<CreateRunReceipt> }>();
	private readonly managed = new Map<string, ManagedRun>();
	private closed = false;

	constructor(options: IpdServiceOptions) {
		this.options = options;
		if (!Number.isFinite(options.cleanupTimeoutMs ?? 5000) || (options.cleanupTimeoutMs ?? 5000) <= 0)
			throw new Error("cleanupTimeoutMs must be positive");
		this.idFactory = options.idFactory ?? (() => createRunId());
	}

	createRun(requestId: string, taskInput: TaskInput, runSkillId: string): Promise<CreateRunReceipt> {
		if (this.closed) throw new Error("IPD service is closed");
		const hash = hashJson({ taskInput, runSkillId });
		const existing = this.requests.get(requestId);
		if (existing) {
			if (existing.hash !== hash) throw new Error(`create_run request ID conflict: ${requestId}`);
			return existing.result;
		}
		const result = this.createRunOnce(this.idFactory(), taskInput, runSkillId);
		this.requests.set(requestId, { hash, result });
		return result;
	}

	createRunFromTemplates(
		requestId: string,
		taskInput: TaskInput,
		runSkillId: string,
		templates: IpdRunTemplateSelection,
	): Promise<CreateRunReceipt> {
		const hash = hashJson({ taskInput, runSkillId, templates });
		const existing = this.requests.get(requestId);
		if (existing) {
			if (existing.hash !== hash) throw new Error(`create_run request ID conflict: ${requestId}`);
			return existing.result;
		}
		const result = this.createRunOnce(this.idFactory(), taskInput, runSkillId, templates);
		this.requests.set(requestId, { hash, result });
		return result;
	}

	listProcessSpecTemplates(): ProcessSpec[] {
		return this.options.processSpecs.filter((spec) => spec.default_executable).map((spec) => structuredClone(spec));
	}

	listRunSkills(): LockedSkill[] {
		return this.options.assets.skills.map((skill) => structuredClone(skill));
	}

	ownsRun(runId: string, projectRoot = this.options.projectRoot): boolean {
		return this.options.projectRoot === projectRoot && this.managed.has(runId);
	}

	hasManagedRuns(): boolean {
		return this.managed.size > 0;
	}

	async listWorkflowTemplates(processSpecId: string, processSpecVersion: string): Promise<WorkflowAssetRecord[]> {
		const spec = this.options.processSpecs.find(
			(item) => item.process_spec_id === processSpecId && item.version === processSpecVersion,
		);
		if (!spec || !this.options.workflowAssets) return [];
		return (await this.options.workflowAssets.list())
			.filter((record) => workflowMatchesProcessSpec(record.workflow, spec))
			.map((record) => structuredClone(record));
	}

	async getRun(runId: string): Promise<RunState> {
		const directory = await prepareRunDirectory(this.options.projectRoot, runId);
		this.options.store.bind(runId, directory.stateFile);
		return this.options.store.read(runId);
	}

	async readEvents(runId: string, afterSequence = 0): Promise<RunEvent[]> {
		return (await this.getRun(runId)).events.filter((event) => event.sequence > afterSequence);
	}

	async getResult(
		runId: string,
	): Promise<{ state: RunState; finalSubmissionIds: string[]; finalSubmission?: FinalSubmissionRecord }> {
		const state = await this.getRun(runId);
		return {
			state,
			finalSubmissionIds: state.status === "succeeded" && state.baseline ? finalApprovedSubmissionIds(state) : [],
			finalSubmission: state.status === "succeeded" ? state.finalSubmission : undefined,
		};
	}

	pauseRun(runId: string, reason = "Paused by user"): Promise<RunState> {
		return this.transition(runId, async () => {
			const entry = this.managed.get(runId);
			if (!entry?.runtime) throw new Error("Pause requires a managed Run with a frozen execution Baseline");
			return entry.runtime.pause(reason);
		});
	}

	resumeRun(runId: string): Promise<RunState> {
		return this.transition(runId, async () => {
			if (this.closed) throw new Error("IPD service is closed");
			const entry = this.managed.get(runId);
			if (!entry?.runtime)
				throw new Error(
					"Cannot resume: original Session/environment ownership is unavailable; no empty replacement will be created",
				);
			if (entry.promise)
				await bounded(entry.promise, this.options.cleanupTimeoutMs ?? 5000, "Previous Run execution");
			await entry.runtime.resume();
			this.executeManaged(
				runId,
				entry,
				entry.runtime.run().then(() => {}),
			);
			return this.getRun(runId);
		});
	}

	cancelRun(runId: string, reason = "Cancelled by user"): Promise<RunState> {
		return this.transition(runId, async () => {
			const state = await this.getRun(runId);
			if (!isTerminal(state.status))
				await this.options.store.mutate(runId, `cancel:${state.revision}`, { reason }, (draft, event) => {
					if (isTerminal(draft.status)) return false;
					draft.generation = (draft.generation ?? 0) + 1;
					markRunCancelled(draft);
					event.emit("run_cancelled", { reason });
					return true;
				});
			const entry = this.managed.get(runId);
			if (entry) await this.cleanupRun(runId, entry);
			else if (!isTerminal(state.status))
				await this.setCleanup(runId, "failed", "Original live resource ownership is unavailable");
			return this.getRun(runId);
		});
	}

	private transition<T>(runId: string, action: () => Promise<T>): Promise<T> {
		const entry = this.managed.get(runId);
		if (!entry) return action();
		const current = (entry.transition ?? Promise.resolve()).catch(() => {}).then(action);
		entry.transition = current;
		void current
			.finally(() => {
				if (entry.transition === current) entry.transition = undefined;
			})
			.catch(() => {});
		return current;
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.allSettled([...this.managed.keys()].map((runId) => this.cancelRun(runId, "IPD service closed")));
		await this.options.visualizer?.close?.();
		await this.options.onClose?.();
	}

	private async setCleanup(runId: string, status: "pending" | "failed" | "complete", message?: string): Promise<void> {
		const state = await this.getRun(runId);
		await this.options.store.mutate(
			runId,
			`resource-cleanup:${state.revision}:${status}`,
			{ status, message: message ?? "" },
			(draft, event) => {
				draft.cleanup = {
					status,
					...(message ? { message } : {}),
					resources: this.managed.get(runId)?.runtime?.inspectResources() ?? draft.cleanup?.resources,
				};
				event.emit("resource_cleanup", { status, ...(message ? { message } : {}) });
				return true;
			},
		);
	}

	private async cleanupRun(runId: string, entry: ManagedRun): Promise<void> {
		if (!entry.cleanup) {
			const operation = (async () => {
				await this.setCleanup(runId, "pending");
				const results = await Promise.allSettled([entry.controlPlane.cancelRun(runId), entry.runtime?.release()]);
				const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
				if (errors.length)
					throw new AggregateError(
						errors.map((result) => result.reason),
						"Run resource cleanup failed",
					);
				await entry.promise;
				await this.setCleanup(runId, "complete");
				if (this.managed.get(runId) === entry) this.managed.delete(runId);
			})();
			entry.cleanup = operation;
			void operation
				.finally(() => {
					if (entry.cleanup === operation) entry.cleanup = undefined;
				})
				.catch(() => {});
		}
		try {
			await bounded(entry.cleanup, this.options.cleanupTimeoutMs ?? 5000, "Run resource cleanup");
		} catch (error) {
			if ((await this.getRun(runId)).cleanup?.status !== "complete")
				await this.setCleanup(runId, "failed", error instanceof Error ? error.message : String(error));
		}
	}

	subscribeEvents(runId: string, listener: (events: readonly RunEvent[]) => void): () => void {
		return this.options.store.subscribe(runId, listener);
	}

	private async createRunOnce(
		runId: string,
		taskInput: TaskInput,
		runSkillId: string,
		templates?: IpdRunTemplateSelection,
	): Promise<CreateRunReceipt> {
		const runSkill = this.options.assets.skills.find((skill) => skill.id === runSkillId);
		if (!runSkill) throw new Error(`Unknown Run Skill: ${runSkillId}`);
		let selectedProcessSpec: ProcessSpec | undefined;
		let workflowTemplate: WorkflowAssetRecord | undefined;
		if (templates) {
			selectedProcessSpec = this.options.processSpecs.find(
				(spec) => spec.process_spec_id === templates.processSpecId && spec.version === templates.processSpecVersion,
			);
			if (!selectedProcessSpec)
				throw new Error(`Unknown ProcessSpec template: ${templates.processSpecId}@${templates.processSpecVersion}`);
			if (templates.workflowId || templates.workflowVersion) {
				if (!templates.workflowId || !templates.workflowVersion)
					throw new Error("Workflow template ID and version must be provided together");
				workflowTemplate = await this.options.workflowAssets?.get(templates.workflowId, templates.workflowVersion);
				if (!workflowTemplate)
					throw new Error(`Unknown Workflow template: ${templates.workflowId}@${templates.workflowVersion}`);
			}
		}
		const controlPlane = this.options.createControlPlane(runId, runSkill);
		const input = {
			projectRoot: this.options.projectRoot,
			runId,
			taskInput,
			runSkill,
			processSpecs: this.options.processSpecs,
			assets: this.options.assets,
			executionIdentity: this.options.executionIdentity,
			selectedProcessSpec,
			workflowTemplate,
		};
		const directory = await controlPlane.accept(input);
		if (this.closed) {
			this.managed.set(runId, { controlPlane });
			await this.cancelRun(runId, "IPD service closed during acceptance");
		} else this.startBackground(runId, controlPlane, controlPlane.prepareAccepted(input, directory));
		const state = await this.getRun(runId);
		const visualization = await this.visualizationReceipt(runId);
		return { runId, accepted: true, phase: state.phase, status: state.status, ...visualization };
	}

	private async visualizationReceipt(
		runId: string,
	): Promise<Pick<CreateRunReceipt, "visualization" | "visualizationError">> {
		if (!this.options.visualizer) return {};
		try {
			return { visualization: await this.options.visualizer.registerRun(runId) };
		} catch (error) {
			return { visualizationError: error instanceof Error ? error.message : String(error) };
		}
	}

	private startBackground(runId: string, controlPlane: IpdControlPlane, preparation: Promise<PrepareRunResult>): void {
		if (this.managed.has(runId)) return;
		const entry: ManagedRun = { controlPlane };
		this.managed.set(runId, entry);
		const operation = preparation.then(
			async (prepared) => {
				if (!prepared.ok || (await this.getRun(runId)).status !== "running") return;
				try {
					const runtime = this.options.createRuntime(prepared.directory);
					await runtime.activate(prepared.baseline);
					entry.runtime = runtime;
					await runtime.run();
				} catch (error) {
					await this.recordRuntimeFailure(runId, error);
				}
			},
			async (error) => this.recordPreparationFailure(runId, error),
		);
		this.executeManaged(runId, entry, operation);
	}

	private executeManaged(runId: string, entry: ManagedRun, operation: Promise<void>): void {
		entry.promise = operation;
		void operation
			.catch((error) => this.recordRuntimeFailure(runId, error))
			.finally(async () => {
				if (entry.promise === operation) entry.promise = undefined;
				if (isTerminal((await this.getRun(runId)).status)) await this.cleanupRun(runId, entry);
			})
			.catch(() => {
				/* Resource ownership remains registered when state storage is unavailable. */
			});
	}

	private async recordPreparationFailure(runId: string, error: unknown): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		try {
			await this.options.store.mutate(
				runId,
				`preparation-failed:${hashJson(message)}`,
				{ message },
				(draft, event) => {
					if (draft.status !== "running") return false;
					draft.status = "blocked";
					draft.failure = { code: "preparation_failure", message };
					event.emit("preparation_failed", { message });
					return true;
				},
			);
		} catch {
			// Storage failure must not be misclassified as execution failure.
		}
	}

	private async recordRuntimeFailure(runId: string, error: unknown): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		try {
			await this.options.store.mutate(runId, `runtime-failed:${hashJson(message)}`, { message }, (draft, event) => {
				if (draft.status !== "running") return false;
				draft.status = "failed";
				draft.phase = "closed";
				draft.failure = { code: "runtime_failure", message };
				event.emit("runtime_failed", { message });
				return true;
			});
		} catch {
			// The original execution error remains the relevant failure when storage is unavailable.
		}
	}
}

function workflowMatchesProcessSpec(workflow: WorkflowDefinition, spec: ProcessSpec): boolean {
	const expected = new Set([
		...spec.required_activities.map((item) => `process_activity:${item.activity_id}`),
		...spec.required_deliverables.map((item) => `process_deliverable:${item.deliverable_id}`),
		...spec.required_reviews.map((item) => `process_review:${item.review_id}`),
		...spec.workflow_rules.map((item) => `process_rule:${item.rule_id}`),
	]);
	const actual = new Set(workflow.requirement_coverage.map((item) => `${item.source}:${item.requirement_id}`));
	return expected.size === actual.size && [...expected].every((item) => actual.has(item));
}
