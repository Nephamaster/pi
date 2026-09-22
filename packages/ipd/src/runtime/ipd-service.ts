// 提供 Run 创建、后台执行、查询、事件和结果服务。
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CompilerAssetCatalog } from "../compiler/types.ts";
import type { LockedSkill } from "../contracts/baseline.ts";
import type { JsonValue } from "../contracts/primitives.ts";
import type { ProcessSpec } from "../contracts/process-spec.ts";
import type {
	ExternalOperationOutcome,
	FinalSubmissionRecord,
	RunControllerRecord,
	RunEvent,
	RunRequestRecord,
	RunState,
	RunTemplateSelectionRecord,
} from "../contracts/runtime.ts";
import type { TaskInput } from "../contracts/task-input.ts";
import type { WorkflowDefinition } from "../contracts/workflow.ts";
import type { IpdControlPlane, PrepareRunResult } from "../control/control-plane.ts";
import { hashJson } from "../ir/hash.ts";
import type { WorkflowAssetRecord } from "../ir/types.ts";
import type { WorkflowAssetStore } from "../registry/workflow-asset-store.ts";
import { claimRunController, requireCurrentController, settleExternalOperation } from "./execution-control.ts";
import { bounded, isTerminal } from "./lifecycle.ts";
import { prepareRunDirectory, type RunDirectory } from "./run-directory.ts";
import { classifyRunRecovery, fencePendingDispatches } from "./run-recovery.ts";
import { FileRunRequestRegistry, type RunRequestRegistry } from "./run-request-registry.ts";
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
	createControlPlane(runId: string, runSkill?: LockedSkill): IpdControlPlane;
	createRuntime(
		directory: RunDirectory,
		controller: Pick<RunControllerRecord, "controllerId" | "term">,
	): WorkflowRuntime;
	workflowAssets?: WorkflowAssetStore;
	visualizer?: IpdRunVisualizer;
	idFactory?: () => string;
	onClose?: () => Promise<void>;
	cleanupTimeoutMs?: number;
	controllerId?: string;
	requestRegistry?: RunRequestRegistry;
}

export interface CreateRunReceipt {
	runId: string;
	accepted: boolean;
	phase: RunState["phase"];
	status: RunState["status"];
	visualization?: IpdVisualizationLink;
	visualizationError?: string;
}

export type IpdRunTemplateSelection = RunTemplateSelectionRecord;

export function createRunId(now = Date.now()): string {
	return new Date(now).toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
}

interface ManagedRun {
	controlPlane: IpdControlPlane;
	controller: Pick<RunControllerRecord, "controllerId" | "term">;
	runtime?: WorkflowRuntime;
	promise?: Promise<void>;
	cleanup?: Promise<void>;
}

export class IpdService {
	private readonly options: IpdServiceOptions;
	private readonly idFactory: () => string;
	private readonly controllerId: string;
	private readonly requestRegistry: RunRequestRegistry;
	private readonly requests = new Map<string, { hash: string; result: Promise<CreateRunReceipt> }>();
	private readonly managed = new Map<string, ManagedRun>();
	private readonly recoveries = new Map<string, Promise<ManagedRun>>();
	private readonly transitions = new Map<string, Promise<unknown>>();
	private closed = false;

	constructor(options: IpdServiceOptions) {
		this.options = options;
		if (!Number.isFinite(options.cleanupTimeoutMs ?? 5000) || (options.cleanupTimeoutMs ?? 5000) <= 0)
			throw new Error("cleanupTimeoutMs must be positive");
		this.idFactory = options.idFactory ?? (() => createRunId());
		this.controllerId = options.controllerId ?? randomUUID();
		this.requestRegistry =
			options.requestRegistry ?? new FileRunRequestRegistry(join(options.projectRoot, ".pi", "ipd", "requests"));
	}

	createRun(requestId: string, taskInput: TaskInput, runSkillId?: string): Promise<CreateRunReceipt> {
		return this.createRequestedRun(requestId, taskInput, runSkillId);
	}

	createRunFromTemplates(
		requestId: string,
		taskInput: TaskInput,
		runSkillId: string | undefined,
		templates: IpdRunTemplateSelection,
	): Promise<CreateRunReceipt> {
		return this.createRequestedRun(requestId, taskInput, runSkillId, templates);
	}

	private createRequestedRun(
		requestId: string,
		taskInput: TaskInput,
		runSkillId: string | undefined,
		templates?: IpdRunTemplateSelection,
	): Promise<CreateRunReceipt> {
		if (this.closed) throw new Error("IPD service is closed");
		const hash = hashJson({ taskInput, runSkillId, ...(templates ? { templates } : {}) });
		const existing = this.requests.get(requestId);
		if (existing) {
			if (existing.hash !== hash) throw new Error(`create_run request ID conflict: ${requestId}`);
			return existing.result;
		}
		const result = this.claimAndCreateRun(requestId, hash, taskInput, runSkillId, templates);
		this.requests.set(requestId, { hash, result });
		return result;
	}

	private async claimAndCreateRun(
		requestId: string,
		requestHash: string,
		taskInput: TaskInput,
		runSkillId: string | undefined,
		templates?: IpdRunTemplateSelection,
	): Promise<CreateRunReceipt> {
		const claim = await this.requestRegistry.claim({
			requestId,
			requestHash,
			proposedRunId: this.idFactory(),
			runSkillId,
			...(templates ? { templates } : {}),
		});
		let existing: RunState | undefined;
		try {
			existing = await this.getRun(claim.record.runId);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (existing) {
			if (existing.request && existing.request.requestHash !== requestHash)
				throw new Error(`create_run request ID conflict: ${requestId}`);
			if (existing.status !== "running" || existing.controller?.status === "active")
				return this.receiptForState(existing);
		}
		return this.createRunOnce(claim.record.runId, taskInput, runSkillId, templates, claim.record);
	}

	private async receiptForState(state: RunState): Promise<CreateRunReceipt> {
		const visualization = await this.visualizationReceipt(state.runId);
		return { runId: state.runId, accepted: true, phase: state.phase, status: state.status, ...visualization };
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

	reconcileExternalOperation(
		runId: string,
		operationId: string,
		outcome: Extract<ExternalOperationOutcome, "succeeded" | "failed">,
		receiptRef?: string,
	): Promise<RunState> {
		return this.transition(runId, async () => {
			const state = await this.getRun(runId);
			await this.options.store.mutate(
				runId,
				`external-operation-reconcile:${operationId}:${outcome}`,
				{ operationId, outcome, receiptRef: receiptRef ?? null },
				(draft, event) => {
					const operation = settleExternalOperation(draft, operationId, outcome, receiptRef);
					if (!draft.externalOperations.some((candidate) => candidate.outcome === "unknown")) {
						for (const wait of draft.waits) {
							if (wait.kind !== "external_operation" || wait.state !== "waiting") continue;
							wait.state = "satisfied";
							wait.resolvedAt = Date.now();
						}
						if (draft.failure?.code === "external_outcome_unknown") delete draft.failure;
					}
					event.emit("external_operation_reconciled", {
						operationId,
						outcome: operation.outcome,
						receiptRef: operation.receiptRef ?? null,
						previousRevision: state.revision,
					});
					return true;
				},
			);
			return this.getRun(runId);
		});
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
			const entry = this.managed.get(runId) ?? (await this.recoverManagedRun(runId));
			if (!entry.runtime) return this.getRun(runId);
			if (entry.promise)
				await bounded(entry.promise, this.options.cleanupTimeoutMs ?? 5000, "Previous Run execution");
			const current = await this.getRun(runId);
			if (current.status !== "running") await entry.runtime.resume();
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
			let entry = this.managed.get(runId);
			let recoveryError: unknown;
			if (
				!entry &&
				state.baseline &&
				["paused", "blocked"].includes(state.status) &&
				state.cleanup?.status === "complete"
			)
				try {
					entry = await this.recoverManagedRun(runId);
				} catch (error) {
					recoveryError = error;
				}
			if (!isTerminal(state.status))
				await this.options.store.mutate(runId, `cancel:${state.revision}`, { reason }, (draft, event) => {
					if (isTerminal(draft.status)) return false;
					draft.generation = (draft.generation ?? 0) + 1;
					markRunCancelled(draft);
					event.emit("run_cancelled", { reason });
					return true;
				});
			if (entry) await this.cleanupRun(runId, entry);
			else if (!isTerminal(state.status))
				await this.setCleanup(
					runId,
					"failed",
					recoveryError instanceof Error
						? `Original live resource ownership could not be recovered: ${recoveryError.message}`
						: "Original live resource ownership is unavailable",
				);
			return this.getRun(runId);
		});
	}

	private transition<T>(runId: string, action: () => Promise<T>): Promise<T> {
		const current = (this.transitions.get(runId) ?? Promise.resolve()).catch(() => {}).then(action);
		this.transitions.set(runId, current);
		void current
			.finally(() => {
				if (this.transitions.get(runId) === current) this.transitions.delete(runId);
			})
			.catch(() => {});
		return current;
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.allSettled(
			[...this.managed.entries()].map(([runId, entry]) => this.preserveRunForShutdown(runId, entry)),
		);
		this.managed.clear();
		await this.options.visualizer?.close?.();
		await this.options.onClose?.();
	}

	private async preserveRunForShutdown(runId: string, entry: ManagedRun): Promise<void> {
		const state = await this.getRun(runId);
		if (isTerminal(state.status)) {
			await this.cleanupRun(runId, entry);
			return;
		}
		if (entry.runtime) {
			if (state.status === "running") await entry.runtime.pause("IPD service is shutting down");
			return;
		}
		await this.options.store.mutate(
			runId,
			`preparation-shutdown:${state.revision}`,
			{ reason: "IPD service is shutting down" },
			(draft, event) => {
				if (isTerminal(draft.status)) return false;
				draft.generation = (draft.generation ?? 0) + 1;
				draft.status = "paused";
				draft.interruption = {
					reason: "IPD service is shutting down during preparation",
					timestamp: Date.now(),
				};
				draft.failure = {
					code: "preparation_interrupted",
					message: "Preparation must be recovered before execution can continue",
				};
				draft.cleanup = { status: "pending" };
				event.emit("preparation_paused", { reason: draft.interruption.reason });
				return true;
			},
		);
		try {
			await bounded(entry.controlPlane.cancelRun(runId), this.options.cleanupTimeoutMs ?? 5000, "Control cleanup");
			await this.setCleanup(runId, "complete");
		} catch (error) {
			await this.setCleanup(runId, "failed", error instanceof Error ? error.message : String(error));
		}
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
				if (status === "complete" && isTerminal(draft.status)) draft.activeResources = [];
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
		runSkillId: string | undefined,
		templates?: IpdRunTemplateSelection,
		request?: RunRequestRecord,
	): Promise<CreateRunReceipt> {
		const runSkill = this.options.assets.skills.find((skill) => skill.id === runSkillId);
		if (runSkillId !== undefined && !runSkill) throw new Error(`Unknown Run Skill: ${runSkillId}`);
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
			request,
		};
		const directory = await controlPlane.accept(input);
		const controller = await this.acquireController(runId);
		const controlledInput = { ...input, controller };
		if (this.closed) {
			this.managed.set(runId, { controlPlane, controller });
			await this.cancelRun(runId, "IPD service closed during acceptance");
		} else
			this.startBackground(
				runId,
				controlPlane,
				controller,
				controlPlane.prepareAccepted(controlledInput, directory),
			);
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

	private async acquireController(
		runId: string,
		allowTakeover = false,
	): Promise<Pick<RunControllerRecord, "controllerId" | "term">> {
		const state = await this.getRun(runId);
		return this.options.store.mutate(
			runId,
			`controller-acquire:${this.controllerId}:${allowTakeover ? "takeover" : "initial"}`,
			{ controllerId: this.controllerId, allowTakeover },
			(draft, event) => {
				const controller = claimRunController(draft, this.controllerId, { allowTakeover });
				event.emit("run_controller_acquired", {
					controllerId: controller.controllerId,
					term: controller.term,
					previousRevision: state.revision,
				});
				return { controllerId: controller.controllerId, term: controller.term };
			},
		);
	}

	private recoverManagedRun(runId: string): Promise<ManagedRun> {
		const existing = this.recoveries.get(runId);
		if (existing) return existing;
		const recovery = (async () => {
			let state = await this.getRun(runId);
			let boundary = classifyRunRecovery(state);
			if (boundary.kind === "unsupported") throw new Error(`Cannot recover: ${boundary.reason}`);
			const runSkill = state.runSkill;
			const taskInput = state.taskInput;
			if (!taskInput) throw new Error("Cannot recover: TaskInput is unavailable");
			if (state.request?.runSkillId !== undefined && runSkill?.id !== state.request.runSkillId)
				throw new Error("Cannot recover: the explicitly selected Run Skill snapshot is unavailable");
			const controller = await this.acquireController(runId, true);
			if (boundary.kind === "pending_dispatch") {
				await this.options.store.mutate(
					runId,
					`pending-dispatch-recovery:${controller.term}`,
					{ controllerTerm: controller.term },
					(draft, event) => {
						const count = fencePendingDispatches(draft, controller);
						event.emit("pending_dispatch_recovered", { controllerTerm: controller.term, count });
						return true;
					},
				);
				state = await this.getRun(runId);
				boundary = classifyRunRecovery(state);
				if (boundary.kind === "unsupported") throw new Error(`Cannot recover: ${boundary.reason}`);
			}
			const directory = await prepareRunDirectory(this.options.projectRoot, runId);
			const controlPlane = this.options.createControlPlane(runId, runSkill);
			if (state.baseline) {
				const runtime = this.options.createRuntime(directory, controller);
				await runtime.recover();
				const entry: ManagedRun = { controlPlane, controller, runtime };
				this.managed.set(runId, entry);
				return entry;
			}
			let workflowTemplate: WorkflowAssetRecord | undefined;
			const templates = state.request?.templates;
			if (templates?.workflowId && templates.workflowVersion)
				workflowTemplate = await this.options.workflowAssets?.get(templates.workflowId, templates.workflowVersion);
			if (templates?.workflowId && templates.workflowVersion && !workflowTemplate)
				throw new Error(
					`Cannot recover: Workflow template is unavailable: ${templates.workflowId}@${templates.workflowVersion}`,
				);
			const interruptedPreparation = boundary.kind === "interrupted_preparation";
			await this.options.store.mutate(
				runId,
				`${interruptedPreparation ? "preparation-recover" : "preparation-resume"}:${controller.term}`,
				{ controllerTerm: controller.term, interrupted: interruptedPreparation },
				(draft, event) => {
					requireCurrentController(draft, controller.controllerId, controller.term);
					if (
						(interruptedPreparation && draft.status !== "running") ||
						(!interruptedPreparation && !["paused", "blocked"].includes(draft.status))
					)
						throw new Error("Preparation Run changed before recovery");
					draft.status = "running";
					delete draft.interruption;
					delete draft.failure;
					delete draft.cleanup;
					event.emit(interruptedPreparation ? "preparation_controller_recovered" : "preparation_resumed", {
						controllerTerm: controller.term,
					});
					return true;
				},
			);
			const input = {
				projectRoot: this.options.projectRoot,
				runId,
				taskInput,
				runSkill,
				processSpecs: this.options.processSpecs,
				assets: this.options.assets,
				executionIdentity: this.options.executionIdentity,
				processSelection: state.processSelection,
				selectedProcessSpec: state.selectedProcessSpec,
				workflowCandidate: state.workflowCandidate,
				workflowTemplate,
				request: state.request,
				controller,
			};
			this.startBackground(runId, controlPlane, controller, controlPlane.prepareAccepted(input, directory));
			return this.managed.get(runId)!;
		})();
		this.recoveries.set(runId, recovery);
		void recovery
			.finally(() => {
				if (this.recoveries.get(runId) === recovery) this.recoveries.delete(runId);
			})
			.catch(() => {});
		return recovery;
	}

	private startBackground(
		runId: string,
		controlPlane: IpdControlPlane,
		controller: Pick<RunControllerRecord, "controllerId" | "term">,
		preparation: Promise<PrepareRunResult>,
	): void {
		if (this.managed.has(runId)) return;
		const entry: ManagedRun = { controlPlane, controller };
		this.managed.set(runId, entry);
		const operation = preparation.then(
			async (prepared) => {
				if (!prepared.ok || (await this.getRun(runId)).status !== "running") return;
				try {
					const runtime = this.options.createRuntime(prepared.directory, controller);
					await runtime.activate(prepared.baseline);
					entry.runtime = runtime;
					await runtime.run();
				} catch (error) {
					await this.recordRuntimeFailure(runId, error, controller);
				}
			},
			async (error) => this.recordPreparationFailure(runId, error, controller),
		);
		this.executeManaged(runId, entry, operation);
	}

	private executeManaged(runId: string, entry: ManagedRun, operation: Promise<void>): void {
		entry.promise = operation;
		void operation
			.catch((error) => this.recordRuntimeFailure(runId, error, entry.controller))
			.finally(async () => {
				if (entry.promise === operation) entry.promise = undefined;
				if (isTerminal((await this.getRun(runId)).status)) await this.cleanupRun(runId, entry);
			})
			.catch(() => {
				/* Resource ownership remains registered when state storage is unavailable. */
			});
	}

	private async recordPreparationFailure(
		runId: string,
		error: unknown,
		controller: Pick<RunControllerRecord, "controllerId" | "term">,
	): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		try {
			await this.options.store.mutate(
				runId,
				`preparation-failed:${controller.term}:${hashJson(message)}`,
				{ message, controllerTerm: controller.term },
				(draft, event) => {
					if (draft.status !== "running") return false;
					if (
						draft.controller?.controllerId !== controller.controllerId ||
						draft.controller?.term !== controller.term
					)
						return false;
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

	private async recordRuntimeFailure(
		runId: string,
		error: unknown,
		controller: Pick<RunControllerRecord, "controllerId" | "term">,
	): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		try {
			await this.options.store.mutate(
				runId,
				`runtime-failed:${controller.term}:${hashJson(message)}`,
				{ message, controllerTerm: controller.term },
				(draft, event) => {
					if (draft.status !== "running") return false;
					if (
						draft.controller?.controllerId !== controller.controllerId ||
						draft.controller?.term !== controller.term
					)
						return false;
					draft.status = "failed";
					draft.phase = "closed";
					draft.failure = { code: "runtime_failure", message };
					event.emit("runtime_failed", { message });
					return true;
				},
			);
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
