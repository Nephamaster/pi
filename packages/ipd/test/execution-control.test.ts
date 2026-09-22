import { describe, expect, it } from "vitest";
import {
	claimExecution,
	claimRunController,
	executionIsCurrent,
	finishExecution,
	incrementScopeEpoch,
	markDispatchDelivering,
	markDispatchStarted,
	type RunState,
	recordFailure,
	registerExternalOperation,
	registerNodeWait,
	settleExternalOperation,
} from "../src/index.ts";
import { createEmptyRuntimeRecords } from "./fixtures.ts";

function stateFixture(): RunState {
	return {
		...createEmptyRuntimeRecords(),
		runId: "run-1",
		revision: 0,
		phase: "execute",
		status: "running",
		nodes: [
			{
				nodeId: "produce",
				kind: "execution",
				status: "active",
				scopeEpoch: 1,
				nextRound: 2,
				activeRoundId: "produce:round:1",
			},
		],
		rounds: [
			{
				roundId: "produce:round:1",
				nodeId: "produce",
				index: 1,
				status: "active",
				inputSubmissionIds: [],
				inputBindings: [],
				startedAt: 1,
			},
		],
		submissions: [],
		reviews: [],
		approvals: [],
		mechanicalChecks: [],
		events: [],
		operations: {},
	};
}

describe("reliable execution control", () => {
	it("records one append-only Attempt and dispatch before allowing adoption", () => {
		const state = stateFixture();
		const controller = claimRunController(state, "controller-a", { now: 10 });
		const stamp = claimExecution({
			state,
			controllerId: controller.controllerId,
			controllerTerm: controller.term,
			nodeId: "produce",
			participantId: "producer",
			roundId: "produce:round:1",
			operation: "execute",
			inputBindings: [],
			inputBindingHash: "inputs-v1",
			now: 11,
		});

		expect(state.attempts).toEqual([
			expect.objectContaining({ attemptId: stamp.attemptId, status: "claimed", controllerTerm: 1, scopeEpoch: 1 }),
		]);
		expect(state.dispatchIntents).toEqual([
			expect.objectContaining({ commandId: stamp.commandId, status: "pending", deliveryCount: 0 }),
		]);
		expect(executionIsCurrent(state, "produce", "produce:round:1", stamp)).toBe(true);

		state.revision++;
		markDispatchDelivering(state, "produce", "produce:round:1", stamp);
		markDispatchStarted(state, "produce", "produce:round:1", stamp, 12);
		expect(state.dispatchIntents[0]).toMatchObject({ status: "started", deliveryCount: 1, startedAt: 12 });
		expect(state.attempts[0]).toMatchObject({ status: "active", dispatchedAt: 12 });

		finishExecution(state, "produce", "produce:round:1", stamp, "completed", "completed", 13);
		expect(state.attempts[0]).toMatchObject({ status: "completed", finishedAt: 13 });
		expect(state.nodes[0].activeAttemptId).toBeUndefined();
		expect(executionIsCurrent(state, "produce", "produce:round:1", stamp)).toBe(false);
	});

	it("rejects an old Attempt after either scope revocation or controller takeover", () => {
		const state = stateFixture();
		const first = claimRunController(state, "controller-a");
		const stamp = claimExecution({
			state,
			controllerId: first.controllerId,
			controllerTerm: first.term,
			nodeId: "produce",
			participantId: "producer",
			roundId: "produce:round:1",
			operation: "execute",
			inputBindings: [],
			inputBindingHash: "inputs-v1",
		});

		incrementScopeEpoch(state, "produce");
		expect(executionIsCurrent(state, "produce", "produce:round:1", stamp)).toBe(false);
		state.nodes[0].scopeEpoch = stamp.scopeEpoch;
		const second = claimRunController(state, "controller-b", { allowTakeover: true });
		expect(second.term).toBe(2);
		expect(executionIsCurrent(state, "produce", "produce:round:1", stamp)).toBe(false);
	});

	it("keeps structured failure and wait facts separate from the node status", () => {
		const state = stateFixture();
		const failure = recordFailure(state, undefined, {
			nodeId: "produce",
			phase: "prepare",
			classification: "environment_unavailable",
			message: "Dependency probe failed",
			retryUnchanged: false,
			affectedScope: "node",
			details: { probe: "office" },
			now: 20,
		});
		const wait = registerNodeWait({
			state,
			nodeId: "produce",
			participantId: "producer",
			kind: "technical_recovery",
			reason: failure.message,
			missingConditions: ["Repair the environment"],
			wakeEvents: ["run_resumed"],
			now: 21,
		});

		expect(failure).toMatchObject({ phase: "prepare", classification: "environment_unavailable" });
		expect(wait).toMatchObject({ state: "waiting", kind: "technical_recovery" });
		expect(state.status).toBe("running");
	});

	it("does not replay an external action whose outcome is still unknown", () => {
		const state = stateFixture();
		const controller = claimRunController(state, "controller-a");
		const stamp = claimExecution({
			state,
			controllerId: controller.controllerId,
			controllerTerm: controller.term,
			nodeId: "produce",
			participantId: "producer",
			roundId: "produce:round:1",
			operation: "execute",
			inputBindings: [],
			inputBindingHash: "inputs-v1",
		});
		const operation = registerExternalOperation({
			state,
			stamp,
			nodeId: "produce",
			participantId: "producer",
			operationId: "publish-1",
			intentRef: "publish-approved-result",
			requestHash: "request-a",
			authorizationRef: "grant-a",
			targetRef: "release-service/project-a",
		});
		settleExternalOperation(state, operation.operationId, "unknown", undefined);

		expect(
			registerExternalOperation({
				state,
				stamp,
				nodeId: "produce",
				participantId: "producer",
				operationId: "publish-1",
				intentRef: "publish-approved-result",
				requestHash: "request-a",
				authorizationRef: "grant-a",
				targetRef: "release-service/project-a",
			}),
		).toBe(operation);
		expect(() => settleExternalOperation(state, operation.operationId, "cancelled", undefined)).toThrow(
			"cannot be treated as cancelled",
		);
		expect(() =>
			registerExternalOperation({
				state,
				stamp,
				nodeId: "produce",
				participantId: "producer",
				operationId: "publish-1",
				intentRef: "publish-approved-result",
				requestHash: "different-request",
				authorizationRef: "grant-a",
				targetRef: "release-service/project-a",
			}),
		).toThrow("operation ID conflict");
	});
});
