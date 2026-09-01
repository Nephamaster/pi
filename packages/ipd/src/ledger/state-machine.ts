import { IpdLedgerError } from "./errors.ts";
import type { ArtifactStatus, GateStatus, NodeStatus, ReviewerStatus, RunStatus } from "./types.ts";

const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
	planning: ["compiling", "failed", "cancelled"],
	compiling: ["ready", "failed", "cancelled"],
	ready: ["running", "failed", "cancelled"],
	running: ["waiting_user", "succeeded", "failed", "cancelled"],
	waiting_user: ["running", "failed", "cancelled"],
	succeeded: [],
	failed: [],
	cancelled: [],
};

const NODE_TRANSITIONS: Readonly<Record<NodeStatus, readonly NodeStatus[]>> = {
	pending: ["ready", "failed", "cancelled"],
	ready: ["running", "failed", "cancelled"],
	running: ["gate_checking", "blocked", "failed", "cancelled", "interrupted"],
	gate_checking: ["gate_reviewing", "rework_pending", "blocked", "failed", "cancelled", "interrupted"],
	gate_reviewing: ["succeeded", "rework_pending", "blocked", "failed", "cancelled", "interrupted"],
	rework_pending: ["ready", "failed", "cancelled"],
	blocked: ["ready", "failed", "cancelled"],
	interrupted: ["ready", "failed", "cancelled"],
	succeeded: [],
	failed: [],
	cancelled: [],
};

const ARTIFACT_TRANSITIONS: Readonly<Record<ArtifactStatus, readonly ArtifactStatus[]>> = {
	candidate: ["accepted", "rejected"],
	accepted: [],
	rejected: [],
};

const GATE_TRANSITIONS: Readonly<Record<GateStatus, readonly GateStatus[]>> = {
	pending: ["mechanical_checking", "cancelled"],
	mechanical_checking: ["mechanical_failed", "semantic_reviewing", "blocked", "cancelled", "interrupted"],
	semantic_reviewing: ["passed", "failed", "inconclusive", "blocked", "cancelled", "interrupted"],
	mechanical_failed: [],
	passed: [],
	failed: [],
	inconclusive: [],
	blocked: [],
	cancelled: [],
	interrupted: [],
};

const REVIEWER_TRANSITIONS: Readonly<Record<ReviewerStatus, readonly ReviewerStatus[]>> = {
	pending: ["running", "cancelled"],
	running: ["completed", "failed", "cancelled", "interrupted"],
	completed: [],
	failed: [],
	cancelled: [],
	interrupted: [],
};

function assertTransition<TStatus extends string>(
	kind: string,
	current: TStatus,
	next: TStatus,
	allowed: Readonly<Record<TStatus, readonly TStatus[]>>,
): void {
	if (current === next || allowed[current].includes(next)) return;
	throw new IpdLedgerError("invalid_transition", `Invalid ${kind} transition: ${current} -> ${next}`);
}

export function assertRunTransition(current: RunStatus, next: RunStatus): void {
	assertTransition("Run", current, next, RUN_TRANSITIONS);
}

export function assertNodeTransition(current: NodeStatus, next: NodeStatus): void {
	assertTransition("Node", current, next, NODE_TRANSITIONS);
}

export function assertArtifactTransition(current: ArtifactStatus, next: ArtifactStatus): void {
	assertTransition("Artifact", current, next, ARTIFACT_TRANSITIONS);
}

export function assertGateTransition(current: GateStatus, next: GateStatus): void {
	assertTransition("Gate", current, next, GATE_TRANSITIONS);
}

export function assertReviewerTransition(current: ReviewerStatus, next: ReviewerStatus): void {
	assertTransition("Reviewer", current, next, REVIEWER_TRANSITIONS);
}
