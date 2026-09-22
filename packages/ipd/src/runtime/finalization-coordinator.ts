// Prepare and atomically adopt immutable final delivery versions against one exact CompletionBasis.
import type { RunControllerRecord, RunState } from "../contracts/runtime.ts";
import { hashJson, toJsonValue } from "../ir/hash.ts";
import { releaseRunController } from "./execution-control.ts";
import {
	completionBasisForState,
	completionBasisMatchesState,
	materializeFinalSubmission,
} from "./final-submission.ts";
import type { RunDirectory } from "./run-directory.ts";
import type { RunStore } from "./run-store.ts";

export interface RunFinalizerOptions {
	materialize?: typeof materializeFinalSubmission;
}

export class RunFinalizer {
	private readonly store: RunStore;
	private readonly directory: RunDirectory;
	private readonly materialize: typeof materializeFinalSubmission;

	constructor(store: RunStore, directory: RunDirectory, options: RunFinalizerOptions = {}) {
		this.store = store;
		this.directory = directory;
		this.materialize = options.materialize ?? materializeFinalSubmission;
	}

	async finalize(
		state: RunState,
		controller: Pick<RunControllerRecord, "controllerId" | "term">,
		signal?: AbortSignal,
	): Promise<boolean> {
		const candidate = await this.prepareCandidate(state);
		const finalSubmission = await this.materialize(
			this.directory,
			state,
			candidate.finalizationId,
			candidate.basis,
			signal,
		);
		return this.store.mutate(
			state.runId,
			`complete:${candidate.finalizationId}`,
			toJsonValue({
				finalizationId: candidate.finalizationId,
				basisHash: candidate.basisHash,
				files: finalSubmission.files,
			}),
			(draft, event) => {
				const current = draft.completionCandidates.find((item) => item.finalizationId === candidate.finalizationId);
				if (
					!current ||
					current.status !== "preparing" ||
					draft.status !== "running" ||
					draft.controller?.controllerId !== controller.controllerId ||
					draft.controller?.term !== controller.term ||
					!completionBasisMatchesState(draft, candidate.basis)
				) {
					if (current?.status === "preparing") {
						current.status = "abandoned";
						current.finishedAt = Date.now();
					}
					event.emit("finalization_abandoned", {
						finalizationId: candidate.finalizationId,
						basisHash: candidate.basisHash,
					});
					return false;
				}
				current.status = "committed";
				current.preparedDirectory = finalSubmission.directory;
				current.preparedAt = finalSubmission.createdAt;
				current.finishedAt = Date.now();
				draft.finalSubmission = finalSubmission;
				releaseRunController(draft, controller.controllerId, controller.term);
				draft.status = "succeeded";
				draft.phase = "closed";
				event.emit("final_submission_materialized", {
					directory: finalSubmission.directory,
					files: finalSubmission.files.map((file) => file.path),
				});
				event.emit("run_succeeded");
				return true;
			},
		);
	}

	private async prepareCandidate(state: RunState): Promise<RunState["completionCandidates"][number]> {
		const basis = completionBasisForState(state);
		if (!basis) throw new Error("Run completion basis is unavailable");
		const basisHash = hashJson(basis);
		const existing = state.completionCandidates.find(
			(candidate) => candidate.basisHash === basisHash && candidate.status === "preparing",
		);
		if (existing) return structuredClone(existing);
		const value = await this.store.mutate(
			state.runId,
			`finalization-prepare:${basisHash}:${state.completionCandidates.length + 1}`,
			{ basisHash, index: state.completionCandidates.length + 1 },
			(draft, event) => {
				const currentBasis = completionBasisForState(draft);
				if (!currentBasis || hashJson(currentBasis) !== basisHash)
					throw new Error("Run completion basis changed before finalization was registered");
				const finalizationId = `finalization-${draft.completionCandidates.length + 1}-${basisHash.slice(0, 16)}`;
				const candidate = {
					finalizationId,
					basis: currentBasis,
					basisHash,
					status: "preparing" as const,
					createdAt: Date.now(),
				};
				draft.completionCandidates.push(candidate);
				event.emit("finalization_preparing", { finalizationId, basisHash });
				return toJsonValue(candidate);
			},
		);
		return value as unknown as RunState["completionCandidates"][number];
	}
}
