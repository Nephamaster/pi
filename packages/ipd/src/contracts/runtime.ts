// 定义 Run、节点、轮次、提交、评审和批准的运行记录。
import type { ArtifactManifest } from "../artifact/manifest.ts";
import type { ExecutionBaseline, LockedSkill } from "./baseline.ts";
import type { JsonValue } from "./primitives.ts";
import type { ProcessSelection } from "./process-spec.ts";
import type { TaskInput } from "./task-input.ts";
import type { WorkflowDefinition } from "./workflow.ts";

export type RunPhase = "intake" | "selection" | "design" | "compile" | "execute" | "closed";
export type RunStatus = "running" | "blocked" | "succeeded" | "failed";
export type NodeStatus = "waiting" | "ready" | "active" | "waiting_review" | "waiting_rework" | "succeeded" | "blocked";
export type RoundStatus = "active" | "submitted" | "completed" | "blocked" | "invalidated" | "failed";
export type SubmissionStatus = "candidate" | "approved" | "rejected" | "stale";

export interface NodeBlockRecord {
	blockId: string;
	roundId: string;
	reason: string;
	missingConditions: string[];
	affectedRequirementIds: string[];
	attemptedActions: string[];
	evidence: JsonValue;
	neededToResume: string[];
	createdAt: number;
}

export interface NodeRuntimeRecord {
	nodeId: string;
	kind: "execution" | "review";
	status: NodeStatus;
	nextRound: number;
	activeRoundId?: string;
	block?: NodeBlockRecord;
}

export interface RoundRecord {
	roundId: string;
	nodeId: string;
	index: number;
	status: RoundStatus;
	inputSubmissionIds: string[];
	inputBindings: RoundInputBindingRecord[];
	startedAt: number;
	finishedAt?: number;
}

export interface RoundInputBindingRecord {
	inputId: string;
	submissionId: string;
	outputId: string;
	approvalReviewNodeIds: string[];
}

export interface SubmissionOutputRecord {
	outputId: string;
	sealedRoot: string;
	manifest: ArtifactManifest;
}

export interface SubmissionRecord {
	submissionId: string;
	contentHash: string;
	nodeId: string;
	roundId: string;
	status: SubmissionStatus;
	inputSubmissionIds: string[];
	outputs: SubmissionOutputRecord[];
	evidence: JsonValue;
	createdAt: number;
}

export interface CriterionResultRecord {
	criterionId: string;
	result: "PASS" | "FAIL" | "BLOCKED";
	evidence: JsonValue;
	rationale: string;
	requiredRework: string[];
}

export interface ReviewRecord {
	reviewId: string;
	reviewNodeId: string;
	roundId: string;
	submissionIds: string[];
	decision: "PASS" | "REWORK" | "BLOCKED";
	criteria: CriterionResultRecord[];
	reworkNodeIds: string[];
	status: "active" | "stale";
	createdAt: number;
}

export interface ApprovalRecord {
	approvalId: string;
	reviewId: string;
	reviewNodeId: string;
	submissionId: string;
	outputId: string;
	criterionIds: string[];
	status: "active" | "stale";
	createdAt: number;
}

export interface MechanicalCheckRecord {
	nodeId: string;
	roundId: string;
	submissionId: string;
	outputId: string;
	result: "PASS" | "FAIL" | "ERROR";
	feedback: string[];
	outcome: JsonValue;
	createdAt: number;
}

export interface FinalSubmissionFileRecord {
	path: string;
	mimeType: string;
	sha256: string;
	size: number;
	submissionId: string;
	nodeId: string;
	outputId: string;
	sourcePath: string;
}

export interface FinalSubmissionRecord {
	directory: string;
	files: FinalSubmissionFileRecord[];
	createdAt: number;
}

export interface RunEvent {
	sequence: number;
	type: string;
	timestamp: number;
	nodeId?: string;
	roundId?: string;
	data: JsonValue;
}

export interface OperationRecord {
	requestHash: string;
	result: JsonValue;
}

export interface RunState {
	runId: string;
	revision: number;
	phase: RunPhase;
	status: RunStatus;
	taskInput?: TaskInput;
	runSkill?: LockedSkill;
	processSelection?: ProcessSelection;
	workflowCandidate?: WorkflowDefinition;
	baseline?: ExecutionBaseline;
	nodes: NodeRuntimeRecord[];
	rounds: RoundRecord[];
	submissions: SubmissionRecord[];
	reviews: ReviewRecord[];
	approvals: ApprovalRecord[];
	mechanicalChecks: MechanicalCheckRecord[];
	finalSubmission?: FinalSubmissionRecord;
	events: RunEvent[];
	operations: Record<string, OperationRecord>;
	failure?: { code: string; message: string };
}
