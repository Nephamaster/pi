// 定义 Run、节点、轮次、提交、评审和批准的运行记录。
import type { ArtifactManifest } from "../artifact/manifest.ts";
import type { ExecutionBaseline, LockedSkill } from "./baseline.ts";
import type { JsonValue } from "./primitives.ts";
import type { ProcessSelection, ProcessSpec } from "./process-spec.ts";
import type { TaskInput } from "./task-input.ts";
import type { WorkflowDefinition } from "./workflow.ts";

export type RunPhase = "intake" | "selection" | "design" | "compile" | "execute" | "closed";
export type RunStatus = "running" | "paused" | "blocked" | "succeeded" | "failed" | "cancelled";
export type NodeStatus =
	| "waiting"
	| "ready"
	| "active"
	| "waiting_review"
	| "waiting_rework"
	| "succeeded"
	| "blocked"
	| "paused"
	| "cancelled";
export type RoundStatus =
	| "active"
	| "paused"
	| "submitted"
	| "completed"
	| "blocked"
	| "invalidated"
	| "failed"
	| "cancelled";
export type SubmissionStatus = "candidate" | "approved" | "rejected" | "stale";

export interface PreparationDiagnosticRecord {
	code?: string;
	path?: string;
	message: string;
	nodeId?: string;
	processRequirementId?: string;
	category?: string;
}

export interface ProcessSpecStaffingReport {
	ok: boolean;
	diagnostics: Array<{ code: string; path: string; message: string }>;
}

export interface WorkflowDesignBlockRecord {
	type: "resource_gap" | "expressiveness_gap" | "task_blocker" | "other";
	reason: string;
	missing_conditions: string[];
	process_requirement_refs: string[];
	diagnostics: Array<{ code?: string; path?: string; message: string }>;
	needed_to_resume: string[];
}

export interface NodeBlockRecord {
	blockId: string;
	roundId: string;
	reason: string;
	missingConditions: string[];
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
	resumeRoundId?: string;
	block?: NodeBlockRecord;
}

export interface RoundRecord {
	generation?: number;
	attempt?: number;
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
	reworkTargets: Array<{
		nodeId: string;
		outputId: string;
		status: "pending" | "addressed" | "resolved" | "superseded";
	}>;
}

export interface ReviewRecord {
	reviewId: string;
	reviewNodeId: string;
	roundId: string;
	submissionIds: string[];
	decision: "PASS" | "REWORK" | "BLOCKED";
	criteria: CriterionResultRecord[];
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
	generation?: number;
	interruption?: { reason: string; timestamp: number; baselineHash?: string };
	workProgress?: WorkProgressReference[];
	cleanup?: { status: "pending" | "failed" | "complete"; message?: string; resources?: RunResourceReference[] };
	runId: string;
	revision: number;
	phase: RunPhase;
	status: RunStatus;
	taskInput?: TaskInput;
	runSkill?: LockedSkill;
	processSelection?: ProcessSelection;
	selectedProcessSpec?: ProcessSpec;
	staffingReport?: ProcessSpecStaffingReport;
	workflowDesignBlock?: WorkflowDesignBlockRecord;
	lastWorkflowValidation?: {
		revision: number;
		valid: boolean;
		diagnostics: PreparationDiagnosticRecord[];
	};
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

/** References to retained work, never approved submissions or a duplicate conversation log. */
export interface WorkProgressReference {
	nodeId: string;
	participantId: string;
	sessionId?: string;
	sessionFile?: string;
	entryId?: string;
	workspace: string;
	workspaceHash?: string;
	environment?: { leaseId: string; generation: number; bindingId: string; identity: string; workspaceHash: string };
}

export interface RunResourceReference {
	nodeId: string;
	participantId: string;
	sessionId?: string;
	sessionFile?: string;
	leaseId?: string;
	providerHandle?: string;
}
