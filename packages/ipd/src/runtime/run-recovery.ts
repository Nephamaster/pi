// Classify recoverable Run boundaries and fence commands that were claimed but never delivered.
import type { RunControllerRecord, RunState } from "../contracts/runtime.ts";
import { incrementScopeEpoch, interruptActiveExecution, requireCurrentController } from "./execution-control.ts";

export type RunRecoveryBoundary =
	| { kind: "paused_execution" }
	| { kind: "paused_preparation" }
	| { kind: "interrupted_preparation" }
	| { kind: "pending_dispatch" }
	| { kind: "interrupted_execution" }
	| { kind: "finalization" }
	| { kind: "unsupported"; reason: string };

export function classifyRunRecovery(state: RunState): RunRecoveryBoundary {
	if (state.externalOperations.some((operation) => operation.outcome === "unknown"))
		return { kind: "unsupported", reason: "An external operation outcome requires reconciliation" };
	if (
		state.status === "running" &&
		!state.baseline &&
		["intake", "selection", "design", "compile"].includes(state.phase)
	)
		return { kind: "interrupted_preparation" };
	const activeAttempts = state.attempts.filter((attempt) =>
		["claimed", "dispatching", "active"].includes(attempt.status),
	);
	const pendingDispatch =
		state.status === "running" &&
		state.activeResources.length === 0 &&
		activeAttempts.length > 0 &&
		activeAttempts.every(
			(attempt) =>
				attempt.status === "claimed" &&
				state.dispatchIntents.some(
					(dispatch) => dispatch.attemptId === attempt.attemptId && dispatch.status === "pending",
				),
		);
	if (pendingDispatch) return { kind: "pending_dispatch" };
	if (state.status === "running" && activeAttempts.length > 0 && state.activeResources.length > 0)
		return { kind: "interrupted_execution" };
	const finalization =
		state.status === "running" &&
		state.completionCandidates.some((candidate) => candidate.status === "preparing") &&
		activeAttempts.length === 0 &&
		!state.dispatchIntents.some((dispatch) =>
			["pending", "delivering", "started", "outcome_unknown"].includes(dispatch.status),
		);
	if (finalization) return { kind: "finalization" };
	if (["paused", "blocked"].includes(state.status)) {
		if (state.cleanup?.status !== "complete")
			return { kind: "unsupported", reason: "Work preservation or cleanup has not completed" };
		if (activeAttempts.length > 0)
			return { kind: "unsupported", reason: "An Attempt outcome remains active or unknown" };
		return state.baseline ? { kind: "paused_execution" } : { kind: "paused_preparation" };
	}
	return { kind: "unsupported", reason: "Run is not at a recoverable boundary" };
}

export function fencePendingDispatches(
	state: RunState,
	controller: Pick<RunControllerRecord, "controllerId" | "term">,
): number {
	requireCurrentController(state, controller.controllerId, controller.term);
	let count = 0;
	for (const node of state.nodes.filter((candidate) => candidate.activeAttemptId)) {
		const attempt = state.attempts.find((candidate) => candidate.attemptId === node.activeAttemptId);
		const dispatch = state.dispatchIntents.find((candidate) => candidate.attemptId === node.activeAttemptId);
		if (!attempt || attempt.status !== "claimed" || dispatch?.status !== "pending")
			throw new Error("Pending dispatch recovery found an ambiguous execution outcome");
		const roundId = node.activeRoundId;
		interruptActiveExecution(state, node.nodeId, "superseded", "cancelled");
		incrementScopeEpoch(state, node.nodeId);
		node.resumeRoundId = roundId;
		node.activeRoundId = undefined;
		node.status = "paused";
		const round = state.rounds.find((candidate) => candidate.roundId === roundId);
		if (round) round.status = "paused";
		count++;
	}
	state.generation = (state.generation ?? 0) + 1;
	state.status = "paused";
	state.cleanup = { status: "complete" };
	state.workProgress = [];
	state.interruption = {
		reason: "Recovered a dispatch that was durably claimed but never delivered",
		timestamp: Date.now(),
	};
	return count;
}
