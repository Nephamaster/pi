// 定义 Run、节点、轮次、提交、评审和批准的运行记录。
import type { ArtifactManifest } from "../artifact/manifest.ts";
import type { ExecutionBaseline, LockedSkill } from "./baseline.ts";
import type { ConsumptionView, GovernanceState, InputPurpose } from "./governance.ts";
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

export interface RunControllerRecord {
	controllerId: string;
	term: number;
	status: "active" | "released";
	acquiredAt: number;
	releasedAt?: number;
}

export interface RunTemplateSelectionRecord {
	processSpecId: string;
	processSpecVersion: string;
	workflowId?: string;
	workflowVersion?: string;
}

export interface RunRequestRecord {
	requestId: string;
	requestHash: string;
	runId: string;
	runSkillId?: string;
	templates?: RunTemplateSelectionRecord;
	acceptedAt: number;
}

export type AttemptStatus =
	| "claimed"
	| "dispatching"
	| "active"
	| "paused"
	| "completed"
	| "failed"
	| "cancelled"
	| "superseded";

export interface AttemptRecord {
	attemptId: string;
	nodeId: string;
	participantId: string;
	roundId: string;
	index: number;
	runGeneration: number;
	controllerTerm: number;
	scopeEpoch: number;
	status: AttemptStatus;
	inputBindings: RoundInputBindingRecord[];
	claimedAt: number;
	dispatchedAt?: number;
	finishedAt?: number;
	failureId?: string;
}

export type DispatchIntentStatus =
	| "pending"
	| "delivering"
	| "started"
	| "completed"
	| "failed"
	| "cancelled"
	| "outcome_unknown";

export type DispatchOperation =
	| "execute"
	| "review"
	| "resume"
	| "quality_rework"
	| "mechanical_rework"
	| "submission_correction";

export interface DispatchIntentRecord {
	commandId: string;
	attemptId: string;
	nodeId: string;
	participantId: string;
	roundId: string;
	runGeneration: number;
	controllerTerm: number;
	scopeEpoch: number;
	operation: DispatchOperation;
	inputBindingHash: string;
	status: DispatchIntentStatus;
	deliveryCount: number;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
}

export type WaitConditionKind =
	| "dependency"
	| "business_condition"
	| "technical_recovery"
	| "resource"
	| "dispatch_reconciliation"
	| "external_operation"
	| "cleanup";

export interface WaitRecord {
	waitId: string;
	nodeId: string;
	participantId: string;
	roundId?: string;
	attemptId?: string;
	kind: WaitConditionKind;
	reason: string;
	missingConditions: string[];
	wakeEvents: string[];
	state: "waiting" | "satisfied" | "cancelled";
	createdAt: number;
	resolvedAt?: number;
}

export interface FailureRecord {
	failureId: string;
	nodeId?: string;
	roundId?: string;
	attemptId?: string;
	phase: "prepare" | "model" | "export" | "check" | "review" | "dispatch" | "runtime";
	classification: string;
	message: string;
	retryUnchanged: boolean;
	affectedScope: "attempt" | "node" | "run";
	details: JsonValue;
	observedAt: number;
}

export type ExternalOperationOutcome = "pending" | "succeeded" | "failed" | "unknown" | "cancelled";

export interface ExternalOperationRecord {
	operationId: string;
	nodeId: string;
	participantId: string;
	attemptId: string;
	intentRef: string;
	requestHash: string;
	authorizationRef: string;
	targetRef: string;
	outcome: ExternalOperationOutcome;
	receiptRef?: string;
	createdAt: number;
	updatedAt: number;
}

export interface ProviderRequestRecord {
	requestId: string;
	attemptId: string;
	commandId: string;
	nodeId: string;
	provider: string;
	modelId: string;
	serializedBytes: number;
	imageCount: number;
	maxImagesInMessage: number;
	maxRequestBytes?: number;
	maxImagesPerRequest?: number;
	maxImagesPerMessage?: number;
	status: "admitted" | "rejected";
	reasonCode?: "request_bytes_exceeded" | "request_images_exceeded" | "message_images_exceeded" | "stale_dispatch";
	createdAt: number;
}

export interface CompletionDeliveryBinding {
	nodeId: string;
	outputId: string;
	submissionId: string;
	manifestHash: string;
	approvalIds: string[];
}

export interface CompletionBasis {
	baselineId: string;
	runGeneration: number;
	deliveryBindings: CompletionDeliveryBinding[];
	requiredReviewIds: string[];
	governanceDigest?: string;
}

export interface CompletionCandidateRecord {
	finalizationId: string;
	basis: CompletionBasis;
	basisHash: string;
	status: "preparing" | "prepared" | "committed" | "abandoned";
	preparedDirectory?: string;
	createdAt: number;
	preparedAt?: number;
	finishedAt?: number;
}

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
	attemptId: string;
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
	scopeEpoch: number;
	nextRound: number;
	activeRoundId?: string;
	activeAttemptId?: string;
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
	activeAttemptId?: string;
	reviewBundleId?: string;
	startedAt: number;
	finishedAt?: number;
}

export interface RoundInputBindingRecord {
	inputId: string;
	submissionId: string;
	outputId: string;
	approvalReviewNodeIds: string[];
	revisionId?: string;
	purpose?: InputPurpose;
	releaseIds?: string[];
}

export interface SubmissionOutputRecord {
	outputId: string;
	sealedRoot: string;
	manifest: ArtifactManifest;
	revisionId?: string;
	preservedFrom?: { submissionId: string; revisionId: string };
	manifestHash?: string;
	contractHash?: string;
	handoff?: ConsumptionView;
}

export interface SubmissionRecord {
	submissionId: string;
	contentHash: string;
	nodeId: string;
	roundId: string;
	attemptId: string;
	status: SubmissionStatus;
	inputSubmissionIds: string[];
	outputs: SubmissionOutputRecord[];
	evidence: JsonValue;
	createdAt: number;
	resolutionClaims?: Array<{ findingId: string; outputId: string; explanation: string; evidence: string[] }>;
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
	}>;
	findingIds?: string[];
}

export interface ReviewRecord {
	reviewId: string;
	reviewNodeId: string;
	roundId: string;
	attemptId: string;
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
	attemptId: string;
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
	finalizationId: string;
	basisHash: string;
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
	runtimeSchemaVersion: 3;
	governance: GovernanceState;
	request?: RunRequestRecord;
	generation?: number;
	controller?: RunControllerRecord;
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
	attempts: AttemptRecord[];
	dispatchIntents: DispatchIntentRecord[];
	waits: WaitRecord[];
	failures: FailureRecord[];
	externalOperations: ExternalOperationRecord[];
	providerRequests: ProviderRequestRecord[];
	completionCandidates: CompletionCandidateRecord[];
	activeResources: RunResourceReference[];
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
	environment?: {
		leaseId: string;
		providerHandle: string;
		generation: number;
		bindingId: string;
		identity: string;
		workspaceHash: string;
	};
}

export interface RunResourceReference {
	nodeId: string;
	participantId: string;
	sessionId?: string;
	sessionFile?: string;
	entryId?: string;
	leaseId?: string;
	providerHandle?: string;
	bindingId?: string;
	generation?: number;
}
