// 提供 Run 创建、后台执行、查询、事件和结果服务。
import { randomUUID } from "node:crypto";
import type { CompilerAssetCatalog } from "../compiler/types.ts";
import type { LockedSkill } from "../contracts/baseline.ts";
import type { JsonValue } from "../contracts/primitives.ts";
import type { ProcessSpec } from "../contracts/process-spec.ts";
import type { FinalSubmissionRecord, RunEvent, RunState } from "../contracts/runtime.ts";
import type { TaskInput } from "../contracts/task-input.ts";
import type { IpdControlPlane, PrepareRunResult } from "../control/control-plane.ts";
import { hashJson } from "../ir/hash.ts";
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
	visualizer?: IpdRunVisualizer;
	idFactory?: () => string;
	onClose?: () => Promise<void>;
}

export interface CreateRunReceipt {
	runId: string;
	accepted: boolean;
	phase: RunState["phase"];
	status: RunState["status"];
	visualization?: IpdVisualizationLink;
	visualizationError?: string;
}

export function createRunId(now = Date.now(), uuid = randomUUID()): string {
	const timestamp = new Date(now).toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
	return `${timestamp}-${uuid}`;
}

export class IpdService {
	private readonly options: IpdServiceOptions;
	private readonly idFactory: () => string;
	private readonly requests = new Map<string, { hash: string; result: Promise<CreateRunReceipt> }>();
	private readonly active = new Map<
		string,
		{
			controlPlane: IpdControlPlane;
			runtime?: WorkflowRuntime;
			promise: Promise<void>;
		}
	>();

	constructor(options: IpdServiceOptions) {
		this.options = options;
		this.idFactory = options.idFactory ?? (() => createRunId());
	}

	createRun(requestId: string, taskInput: TaskInput, runSkillId: string): Promise<CreateRunReceipt> {
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

	async cancelRun(runId: string, reason = "Cancelled by user"): Promise<RunState> {
		const state = await this.getRun(runId);
		if (state.status !== "running") return state;
		await this.options.store.mutate(runId, `cancel:${state.revision}`, { reason }, (draft, event) => {
			if (draft.status !== "running") return false;
			markRunCancelled(draft);
			event.emit("run_cancelled", { reason });
			return true;
		});
		const active = this.active.get(runId);
		await active?.controlPlane.cancelRun(runId);
		await active?.runtime?.cancel(reason);
		if (active) await active.promise;
		return this.getRun(runId);
	}

	async close(): Promise<void> {
		await Promise.allSettled([...this.active.keys()].map((runId) => this.cancelRun(runId, "IPD service closed")));
		await this.options.visualizer?.close?.();
		await this.options.onClose?.();
	}

	subscribeEvents(runId: string, listener: (events: readonly RunEvent[]) => void): () => void {
		return this.options.store.subscribe(runId, listener);
	}

	private async createRunOnce(runId: string, taskInput: TaskInput, runSkillId: string): Promise<CreateRunReceipt> {
		const runSkill = this.options.assets.skills.find((skill) => skill.id === runSkillId);
		if (!runSkill) throw new Error(`Unknown Run Skill: ${runSkillId}`);
		const controlPlane = this.options.createControlPlane(runId, runSkill);
		const input = {
			projectRoot: this.options.projectRoot,
			runId,
			taskInput,
			runSkill,
			processSpecs: this.options.processSpecs,
			assets: this.options.assets,
			executionIdentity: this.options.executionIdentity,
		};
		const directory = await controlPlane.accept(input);
		this.startBackground(runId, controlPlane, controlPlane.prepareAccepted(input, directory));
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
		if (this.active.has(runId)) return;
		const active: { controlPlane: IpdControlPlane; runtime?: WorkflowRuntime; promise: Promise<void> } = {
			controlPlane,
			promise: Promise.resolve(),
		};
		const running = preparation
			.then(
				async (prepared) => {
					if (!prepared.ok) return;
					try {
						if ((await this.getRun(runId)).status !== "running") return;
						const runtime = this.options.createRuntime(prepared.directory);
						active.runtime = runtime;
						await runtime.activate(prepared.baseline);
						await runtime.run();
					} catch (error) {
						await this.recordRuntimeFailure(runId, error);
					}
				},
				async (error) => this.recordPreparationFailure(runId, error),
			)
			.finally(() => {
				if (this.active.get(runId) === active) this.active.delete(runId);
			});
		active.promise = running;
		this.active.set(runId, active);
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
