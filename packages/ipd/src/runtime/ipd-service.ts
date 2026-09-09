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
import { finalApprovedSubmissionIds } from "./runtime-state.ts";
import type { WorkflowRuntime } from "./workflow-runtime.ts";

export interface IpdServiceOptions {
	store: FileRunStore;
	processSpecs: readonly ProcessSpec[];
	assets: CompilerAssetCatalog;
	projectRoot: string;
	executionIdentity?: JsonValue;
	createControlPlane(runId: string, runSkill: LockedSkill): IpdControlPlane;
	createRuntime(directory: RunDirectory): WorkflowRuntime;
	idFactory?: () => string;
}

export interface CreateRunReceipt {
	runId: string;
	accepted: boolean;
	phase: RunState["phase"];
	status: RunState["status"];
}

export function createRunId(now = Date.now(), uuid = randomUUID()): string {
	const timestamp = new Date(now).toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
	return `${timestamp}-${uuid}`;
}

export class IpdService {
	private readonly options: IpdServiceOptions;
	private readonly idFactory: () => string;
	private readonly requests = new Map<string, { hash: string; result: Promise<CreateRunReceipt> }>();
	private readonly active = new Map<string, Promise<void>>();

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
		this.startBackground(runId, controlPlane.prepareAccepted(input, directory));
		const state = await this.getRun(runId);
		return { runId, accepted: true, phase: state.phase, status: state.status };
	}

	private startBackground(runId: string, preparation: Promise<PrepareRunResult>): void {
		if (this.active.has(runId)) return;
		const running = preparation
			.then(async (prepared) => {
				if (!prepared.ok) return;
				const runtime = this.options.createRuntime(prepared.directory);
				await runtime.activate(prepared.baseline);
				await runtime.run();
			})
			.then(() => undefined)
			.catch(async (error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				try {
					await this.options.store.mutate(
						runId,
						`runtime-failed:${hashJson(message)}`,
						{ message },
						(draft, event) => {
							draft.status = "failed";
							draft.phase = "closed";
							draft.failure = { code: "runtime_failure", message };
							event.emit("runtime_failed", { message });
							return true;
						},
					);
				} catch {
					// The original error remains observable through the failed background operation when storage is unavailable.
				}
			})
			.finally(() => this.active.delete(runId));
		this.active.set(runId, running);
	}
}
