// Maintain trusted controller, Attempt, dispatch, wait, and failure records for Runtime adoption.

import type { JsonValue } from "../contracts/primitives.ts";
import type {
	AttemptRecord,
	AttemptStatus,
	DispatchIntentRecord,
	DispatchIntentStatus,
	DispatchOperation,
	ExternalOperationOutcome,
	ExternalOperationRecord,
	FailureRecord,
	NodeRuntimeRecord,
	RoundInputBindingRecord,
	RoundRecord,
	RunControllerRecord,
	RunState,
	WaitConditionKind,
	WaitRecord,
} from "../contracts/runtime.ts";

export type ExecutionStamp = {
	attemptId: string;
	commandId: string;
	runGeneration: number;
	controllerId: string;
	controllerTerm: number;
	scopeEpoch: number;
};

export type ClaimedExecution = ExecutionStamp & {
	attemptIndex: number;
};

export function requireCurrentRunState(state: RunState): RunState {
	if (state.runtimeSchemaVersion !== 2)
		throw new Error(`Unsupported IPD Runtime schema: ${String(state.runtimeSchemaVersion)}`);
	return state;
}

export interface FailureInput {
	phase: FailureRecord["phase"];
	classification: string;
	message: string;
	retryUnchanged: boolean;
	affectedScope: FailureRecord["affectedScope"];
	details?: JsonValue;
}

export function claimRunController(
	state: RunState,
	controllerId: string,
	options: { expectedTerm?: number; allowTakeover?: boolean; now?: number } = {},
): RunControllerRecord {
	requireCurrentRunState(state);
	const current = state.controller;
	if (current?.status === "active") {
		if (current.controllerId !== controllerId) {
			if (!options.allowTakeover)
				throw new Error(`Run is controlled by another owner: ${current.controllerId}@${current.term}`);
		} else {
			if (options.expectedTerm !== undefined && current.term !== options.expectedTerm)
				throw new Error(`Run controller term changed: expected ${options.expectedTerm}, current ${current.term}`);
			return current;
		}
	}
	const term = (current?.term ?? 0) + 1;
	if (options.expectedTerm !== undefined && term !== options.expectedTerm)
		throw new Error(`Run controller term changed: expected ${options.expectedTerm}, next ${term}`);
	state.controller = {
		controllerId,
		term,
		status: "active",
		acquiredAt: options.now ?? Date.now(),
	};
	return state.controller;
}

export function releaseRunController(state: RunState, controllerId: string, term: number, now = Date.now()): void {
	const controller = requireCurrentController(state, controllerId, term);
	controller.status = "released";
	controller.releasedAt = now;
}

export function requireCurrentController(state: RunState, controllerId: string, term: number): RunControllerRecord {
	requireCurrentRunState(state);
	const controller = state.controller;
	if (
		!controller ||
		controller.status !== "active" ||
		controller.controllerId !== controllerId ||
		controller.term !== term
	)
		throw new Error(`Run controller is no longer current: ${controllerId}@${term}`);
	return controller;
}

function activeNode(state: RunState, nodeId: string): NodeRuntimeRecord {
	const node = state.nodes.find((item) => item.nodeId === nodeId);
	if (!node) throw new Error(`Unknown Runtime node: ${nodeId}`);
	return node;
}

function activeRound(state: RunState, roundId: string): RoundRecord {
	const round = state.rounds.find((item) => item.roundId === roundId);
	if (!round) throw new Error(`Unknown Runtime round: ${roundId}`);
	return round;
}

export function claimExecution(input: {
	state: RunState;
	controllerId: string;
	controllerTerm: number;
	nodeId: string;
	participantId: string;
	roundId: string;
	operation: DispatchOperation;
	inputBindings: readonly RoundInputBindingRecord[];
	inputBindingHash: string;
	now?: number;
}): ClaimedExecution {
	const { state } = input;
	requireCurrentController(state, input.controllerId, input.controllerTerm);
	const node = activeNode(state, input.nodeId);
	const round = activeRound(state, input.roundId);
	if (node.activeAttemptId || round.activeAttemptId)
		throw new Error(`Node ${input.nodeId} already has an active Attempt`);
	const attemptIndex = state.attempts.filter((attempt) => attempt.roundId === input.roundId).length + 1;
	const attemptId = `${input.roundId}:attempt:${attemptIndex}:term:${input.controllerTerm}:scope:${node.scopeEpoch}`;
	const commandId = `${attemptId}:dispatch`;
	const existingAttempt = state.attempts.find((attempt) => attempt.attemptId === attemptId);
	const existingDispatch = state.dispatchIntents.find((dispatch) => dispatch.commandId === commandId);
	if (existingAttempt || existingDispatch) throw new Error(`Attempt identity conflict: ${attemptId}`);
	const now = input.now ?? Date.now();
	const runGeneration = state.generation ?? 0;
	const attempt: AttemptRecord = {
		attemptId,
		nodeId: input.nodeId,
		participantId: input.participantId,
		roundId: input.roundId,
		index: attemptIndex,
		runGeneration,
		controllerTerm: input.controllerTerm,
		scopeEpoch: node.scopeEpoch,
		status: "claimed",
		inputBindings: input.inputBindings.map((binding) => structuredClone(binding)),
		claimedAt: now,
	};
	const dispatch: DispatchIntentRecord = {
		commandId,
		attemptId,
		nodeId: input.nodeId,
		participantId: input.participantId,
		roundId: input.roundId,
		runGeneration,
		controllerTerm: input.controllerTerm,
		scopeEpoch: node.scopeEpoch,
		operation: input.operation,
		inputBindingHash: input.inputBindingHash,
		status: "pending",
		deliveryCount: 0,
		createdAt: now,
	};
	state.attempts.push(attempt);
	state.dispatchIntents.push(dispatch);
	node.activeAttemptId = attemptId;
	round.activeAttemptId = attemptId;
	resolveNodeWaits(state, input.nodeId, now);
	return {
		attemptId,
		commandId,
		attemptIndex,
		runGeneration,
		controllerId: input.controllerId,
		controllerTerm: input.controllerTerm,
		scopeEpoch: node.scopeEpoch,
	};
}

export function executionIsCurrent(state: RunState, nodeId: string, roundId: string, stamp: ExecutionStamp): boolean {
	requireCurrentRunState(state);
	const controller = state.controller;
	const node = state.nodes.find((item) => item.nodeId === nodeId);
	const round = state.rounds.find((item) => item.roundId === roundId);
	const attempt = state.attempts.find((item) => item.attemptId === stamp.attemptId);
	const dispatch = state.dispatchIntents.find((item) => item.commandId === stamp.commandId);
	return (
		state.status === "running" &&
		(state.generation ?? 0) === stamp.runGeneration &&
		controller?.status === "active" &&
		controller.controllerId === stamp.controllerId &&
		controller.term === stamp.controllerTerm &&
		node?.scopeEpoch === stamp.scopeEpoch &&
		node.activeRoundId === roundId &&
		node.activeAttemptId === stamp.attemptId &&
		round?.activeAttemptId === stamp.attemptId &&
		attempt?.controllerTerm === stamp.controllerTerm &&
		attempt.scopeEpoch === stamp.scopeEpoch &&
		["claimed", "dispatching", "active"].includes(attempt.status) &&
		dispatch?.attemptId === stamp.attemptId &&
		["pending", "delivering", "started"].includes(dispatch.status)
	);
}

function requireCurrentExecution(
	state: RunState,
	nodeId: string,
	roundId: string,
	stamp: ExecutionStamp,
): { attempt: AttemptRecord; dispatch: DispatchIntentRecord } {
	if (!executionIsCurrent(state, nodeId, roundId, stamp))
		throw new Error(`Execution Attempt is no longer current: ${stamp.attemptId}`);
	return {
		attempt: state.attempts.find((item) => item.attemptId === stamp.attemptId)!,
		dispatch: state.dispatchIntents.find((item) => item.commandId === stamp.commandId)!,
	};
}

export function markDispatchDelivering(state: RunState, nodeId: string, roundId: string, stamp: ExecutionStamp): void {
	const { attempt, dispatch } = requireCurrentExecution(state, nodeId, roundId, stamp);
	if (dispatch.status === "pending") {
		dispatch.status = "delivering";
		dispatch.deliveryCount++;
		attempt.status = "dispatching";
	}
}

export function markDispatchStarted(
	state: RunState,
	nodeId: string,
	roundId: string,
	stamp: ExecutionStamp,
	now = Date.now(),
): void {
	const { attempt, dispatch } = requireCurrentExecution(state, nodeId, roundId, stamp);
	if (dispatch.status === "pending") dispatch.deliveryCount++;
	dispatch.status = "started";
	dispatch.startedAt ??= now;
	attempt.status = "active";
	attempt.dispatchedAt ??= now;
}

export function finishExecution(
	state: RunState,
	nodeId: string,
	roundId: string,
	stamp: ExecutionStamp,
	status: Extract<AttemptStatus, "completed" | "failed" | "cancelled" | "paused" | "superseded">,
	dispatchStatus: Extract<DispatchIntentStatus, "completed" | "failed" | "cancelled" | "outcome_unknown">,
	now = Date.now(),
): void {
	const { attempt, dispatch } = requireCurrentExecution(state, nodeId, roundId, stamp);
	attempt.status = status;
	attempt.finishedAt = now;
	dispatch.status = dispatchStatus;
	dispatch.finishedAt = now;
	const node = activeNode(state, nodeId);
	const round = activeRound(state, roundId);
	if (node.activeAttemptId === attempt.attemptId) delete node.activeAttemptId;
	if (round.activeAttemptId === attempt.attemptId) delete round.activeAttemptId;
}

export function recordFailure(
	state: RunState,
	stamp: ExecutionStamp | undefined,
	input: FailureInput & { nodeId?: string; roundId?: string; now?: number },
): FailureRecord {
	requireCurrentRunState(state);
	const attemptId = stamp?.attemptId;
	const base = attemptId ?? `${input.nodeId ?? "run"}:${state.failures.length + 1}`;
	const failureId = `${base}:failure`;
	const existing = state.failures.find((failure) => failure.failureId === failureId);
	if (existing) return existing;
	const failure: FailureRecord = {
		failureId,
		...(input.nodeId ? { nodeId: input.nodeId } : {}),
		...(input.roundId ? { roundId: input.roundId } : {}),
		...(attemptId ? { attemptId } : {}),
		phase: input.phase,
		classification: input.classification,
		message: input.message,
		retryUnchanged: input.retryUnchanged,
		affectedScope: input.affectedScope,
		details: input.details ?? null,
		observedAt: input.now ?? Date.now(),
	};
	state.failures.push(failure);
	if (attemptId) {
		const attempt = state.attempts.find((item) => item.attemptId === attemptId);
		if (attempt) attempt.failureId = failureId;
	}
	return failure;
}

export function incrementScopeEpoch(state: RunState, nodeId: string): number {
	const node = activeNode(state, nodeId);
	node.scopeEpoch++;
	return node.scopeEpoch;
}

export function interruptActiveExecution(
	state: RunState,
	nodeId: string,
	status: Extract<AttemptStatus, "paused" | "cancelled" | "superseded">,
	dispatchStatus: Extract<DispatchIntentStatus, "cancelled" | "outcome_unknown">,
	now = Date.now(),
): string | undefined {
	requireCurrentRunState(state);
	const node = activeNode(state, nodeId);
	const attemptId = node.activeAttemptId;
	if (!attemptId) return undefined;
	const attempt = state.attempts.find((item) => item.attemptId === attemptId);
	if (!attempt) throw new Error(`Active Attempt record is missing: ${attemptId}`);
	const dispatch = state.dispatchIntents.find((item) => item.attemptId === attemptId);
	if (!dispatch) throw new Error(`Active dispatch record is missing: ${attemptId}`);
	attempt.status = status;
	attempt.finishedAt = now;
	dispatch.status = dispatchStatus;
	dispatch.finishedAt = now;
	delete node.activeAttemptId;
	const round = state.rounds.find((item) => item.roundId === attempt.roundId);
	if (round?.activeAttemptId === attemptId) delete round.activeAttemptId;
	return attemptId;
}

export function registerNodeWait(input: {
	state: RunState;
	nodeId: string;
	participantId: string;
	kind: WaitConditionKind;
	reason: string;
	missingConditions: readonly string[];
	wakeEvents?: readonly string[];
	roundId?: string;
	attemptId?: string;
	now?: number;
}): WaitRecord {
	requireCurrentRunState(input.state);
	const waitId = `${input.nodeId}:${input.kind}:${input.roundId ?? "none"}:${input.attemptId ?? "none"}`;
	const existing = input.state.waits.find((wait) => wait.waitId === waitId);
	if (existing) {
		if (existing.state !== "waiting") throw new Error(`Wait identity is already resolved: ${waitId}`);
		return existing;
	}
	const wait: WaitRecord = {
		waitId,
		nodeId: input.nodeId,
		participantId: input.participantId,
		...(input.roundId ? { roundId: input.roundId } : {}),
		...(input.attemptId ? { attemptId: input.attemptId } : {}),
		kind: input.kind,
		reason: input.reason,
		missingConditions: [...input.missingConditions],
		wakeEvents: [...(input.wakeEvents ?? [])],
		state: "waiting",
		createdAt: input.now ?? Date.now(),
	};
	input.state.waits.push(wait);
	return wait;
}

export function resolveNodeWaits(state: RunState, nodeId: string, now = Date.now()): void {
	requireCurrentRunState(state);
	for (const wait of state.waits) {
		if (wait.nodeId !== nodeId || wait.state !== "waiting") continue;
		wait.state = "satisfied";
		wait.resolvedAt = now;
	}
}

export function cancelNodeWaits(state: RunState, nodeId: string, now = Date.now()): void {
	requireCurrentRunState(state);
	for (const wait of state.waits) {
		if (wait.nodeId !== nodeId || wait.state !== "waiting") continue;
		wait.state = "cancelled";
		wait.resolvedAt = now;
	}
}

export function registerExternalOperation(input: {
	state: RunState;
	stamp: ExecutionStamp;
	nodeId: string;
	participantId: string;
	operationId: string;
	intentRef: string;
	requestHash: string;
	authorizationRef: string;
	targetRef: string;
	now?: number;
}): ExternalOperationRecord {
	requireCurrentRunState(input.state);
	const existing = input.state.externalOperations.find((operation) => operation.operationId === input.operationId);
	if (existing) {
		if (
			existing.attemptId !== input.stamp.attemptId ||
			existing.requestHash !== input.requestHash ||
			existing.intentRef !== input.intentRef
		)
			throw new Error(`External operation ID conflict: ${input.operationId}`);
		return existing;
	}
	const now = input.now ?? Date.now();
	const operation: ExternalOperationRecord = {
		operationId: input.operationId,
		nodeId: input.nodeId,
		participantId: input.participantId,
		attemptId: input.stamp.attemptId,
		intentRef: input.intentRef,
		requestHash: input.requestHash,
		authorizationRef: input.authorizationRef,
		targetRef: input.targetRef,
		outcome: "pending",
		createdAt: now,
		updatedAt: now,
	};
	input.state.externalOperations.push(operation);
	return operation;
}

export function settleExternalOperation(
	state: RunState,
	operationId: string,
	outcome: Exclude<ExternalOperationOutcome, "pending">,
	receiptRef: string | undefined,
	now = Date.now(),
): ExternalOperationRecord {
	requireCurrentRunState(state);
	const operation = state.externalOperations.find((candidate) => candidate.operationId === operationId);
	if (!operation) throw new Error(`Unknown external operation: ${operationId}`);
	if (operation.outcome !== "pending" && operation.outcome !== "unknown") {
		if (operation.outcome !== outcome || operation.receiptRef !== receiptRef)
			throw new Error(`External operation outcome conflict: ${operationId}`);
		return operation;
	}
	if (operation.outcome === "unknown" && outcome === "cancelled")
		throw new Error(
			`Unknown external operation cannot be treated as cancelled without reconciliation: ${operationId}`,
		);
	operation.outcome = outcome;
	operation.updatedAt = now;
	if (receiptRef) operation.receiptRef = receiptRef;
	return operation;
}
