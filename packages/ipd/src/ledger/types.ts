import type {
	AgentCardRef,
	CompiledAgentCard,
	CompiledWorkflow,
	IpdDiagnostic,
	JsonValue,
	SkillRef,
	WorkflowDefinition,
} from "../ir/types.ts";

export type RunStatus =
	| "planning"
	| "compiling"
	| "ready"
	| "running"
	| "waiting_user"
	| "succeeded"
	| "failed"
	| "cancelled";

export type NodeStatus =
	| "pending"
	| "ready"
	| "running"
	| "gate_checking"
	| "gate_reviewing"
	| "rework_pending"
	| "blocked"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "interrupted";

export type ArtifactStatus = "candidate" | "accepted" | "rejected";

export type GateStatus =
	| "pending"
	| "mechanical_checking"
	| "mechanical_failed"
	| "semantic_reviewing"
	| "passed"
	| "failed"
	| "inconclusive"
	| "blocked"
	| "cancelled"
	| "interrupted";

export type ReviewerStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type CriterionKind = "mechanical" | "semantic";
export type CriterionResult = "PASS" | "FAIL" | "INCONCLUSIVE" | "BLOCKED";
export type EscalationStatus = "open" | "answered" | "cancelled";

export interface RunRecord {
	id: string;
	traceId: string;
	status: RunStatus;
	task: string;
	skill: SkillRef;
	globalBudget: JsonValue;
	workflowRef?: { id: string; version: string; hash: string };
	createdAt: number;
	updatedAt: number;
	version: number;
	failure?: JsonValue;
}

export interface WorkflowVersionRecord {
	runId: string;
	id: string;
	version: string;
	hash: string;
	source: WorkflowDefinition["source"];
	definition: WorkflowDefinition;
	createdAt: number;
}

export interface AgentCardSnapshotRecord {
	runId: string;
	ref: AgentCardRef;
	card: CompiledAgentCard;
	createdAt: number;
}

export interface NodeInstanceRecord {
	attemptId: string;
	runId: string;
	nodeId: string;
	attemptNumber: number;
	status: NodeStatus;
	agentCardRef: AgentCardRef;
	sessionId?: string;
	sessionFile?: string;
	createdAt: number;
	updatedAt: number;
	error?: JsonValue;
}

export interface ArtifactRecord {
	id: string;
	runId: string;
	nodeId: string;
	attemptId: string;
	contractId: string;
	status: ArtifactStatus;
	manifest: JsonValue;
	manifestHash: string;
	createdAt: number;
	updatedAt: number;
}

export interface GateRunRecord {
	id: string;
	runId: string;
	nodeId?: string;
	attemptId?: string;
	artifactId?: string;
	gateId: string;
	status: GateStatus;
	createdAt: number;
	updatedAt: number;
	decision?: JsonValue;
}

export interface ReviewerInstanceRecord {
	id: string;
	runId: string;
	gateRunId: string;
	agentCardRef: AgentCardRef;
	status: ReviewerStatus;
	sessionId?: string;
	sessionFile?: string;
	createdAt: number;
	updatedAt: number;
	result?: JsonValue;
}

export interface CriterionResultRecord {
	id: string;
	runId: string;
	gateRunId: string;
	criterionId: string;
	kind: CriterionKind;
	result: CriterionResult;
	reviewerInstanceId?: string;
	evidence: JsonValue;
	rationale: string;
	createdAt: number;
}

export interface DecisionRecord {
	id: string;
	runId: string;
	type: string;
	action: string;
	rationale: string;
	nodeId?: string;
	gateRunId?: string;
	reviewerInstanceId?: string;
	evidence: JsonValue;
	createdAt: number;
}

export interface EscalationRecord {
	id: string;
	runId: string;
	nodeId?: string;
	status: EscalationStatus;
	target: "staff" | "user";
	question: string;
	context: JsonValue;
	answer?: string;
	createdAt: number;
	updatedAt: number;
}

export interface BudgetUsageRecord {
	id: string;
	runId: string;
	category: "staff" | "execution" | "review" | "rework";
	nodeId?: string;
	attemptId?: string;
	reviewerInstanceId?: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUsd: number;
	durationMs: number;
	details: JsonValue;
	createdAt: number;
}

export interface IpdEventRecord {
	eventId: string;
	sequence: number;
	runId: string;
	traceId: string;
	type: string;
	timestamp: number;
	payload: JsonValue;
	nodeId?: string;
	attemptId?: string;
	gateRunId?: string;
	reviewerInstanceId?: string;
}

export interface RunSnapshot {
	run: RunRecord;
	workflow?: WorkflowVersionRecord;
	agentCards: AgentCardSnapshotRecord[];
	nodes: NodeInstanceRecord[];
	artifacts: ArtifactRecord[];
	gates: GateRunRecord[];
	reviewers: ReviewerInstanceRecord[];
	criteria: CriterionResultRecord[];
	decisions: DecisionRecord[];
	escalations: EscalationRecord[];
	budgetUsage: BudgetUsageRecord[];
	events: IpdEventRecord[];
}

export interface ConsistencyReport {
	ok: boolean;
	diagnostics: IpdDiagnostic[];
}

export interface CreateRunInput {
	runId: string;
	traceId: string;
	idempotencyKey: string;
	task: string;
	skill: SkillRef;
	globalBudget: JsonValue;
}

export interface FreezeWorkflowInput {
	runId: string;
	idempotencyKey: string;
	workflow: CompiledWorkflow;
}

export interface TransitionRunInput {
	runId: string;
	idempotencyKey: string;
	status: RunStatus;
	failure?: JsonValue;
}

export interface CreateNodeAttemptInput {
	runId: string;
	idempotencyKey: string;
	attemptId: string;
	nodeId: string;
	attemptNumber: number;
	agentCardRef: AgentCardRef;
	sessionId?: string;
	sessionFile?: string;
}

export interface TransitionNodeInput {
	runId: string;
	idempotencyKey: string;
	attemptId: string;
	status: NodeStatus;
	error?: JsonValue;
	sessionId?: string;
	sessionFile?: string;
}

export interface RecordArtifactInput {
	runId: string;
	idempotencyKey: string;
	artifactId: string;
	nodeId: string;
	attemptId: string;
	contractId: string;
	manifest: JsonValue;
}

export interface TransitionArtifactInput {
	runId: string;
	idempotencyKey: string;
	artifactId: string;
	status: ArtifactStatus;
}

export interface CreateGateRunInput {
	runId: string;
	idempotencyKey: string;
	gateRunId: string;
	gateId: string;
	nodeId?: string;
	attemptId?: string;
	artifactId?: string;
}

export interface TransitionGateInput {
	runId: string;
	idempotencyKey: string;
	gateRunId: string;
	status: GateStatus;
	decision?: JsonValue;
}

export interface CreateReviewerInput {
	runId: string;
	idempotencyKey: string;
	reviewerInstanceId: string;
	gateRunId: string;
	agentCardRef: AgentCardRef;
	sessionId?: string;
	sessionFile?: string;
}

export interface TransitionReviewerInput {
	runId: string;
	idempotencyKey: string;
	reviewerInstanceId: string;
	status: ReviewerStatus;
	result?: JsonValue;
	sessionId?: string;
	sessionFile?: string;
}

export interface RecordCriterionInput {
	runId: string;
	idempotencyKey: string;
	criterionResultId: string;
	gateRunId: string;
	criterionId: string;
	kind: CriterionKind;
	result: CriterionResult;
	reviewerInstanceId?: string;
	evidence: JsonValue;
	rationale: string;
}

export interface RecordDecisionInput {
	runId: string;
	idempotencyKey: string;
	decisionId: string;
	type: string;
	action: string;
	rationale: string;
	nodeId?: string;
	gateRunId?: string;
	reviewerInstanceId?: string;
	evidence: JsonValue;
}

export interface CreateEscalationInput {
	runId: string;
	idempotencyKey: string;
	escalationId: string;
	target: "staff" | "user";
	question: string;
	context: JsonValue;
	nodeId?: string;
}

export interface AnswerEscalationInput {
	runId: string;
	idempotencyKey: string;
	escalationId: string;
	answer: string;
}

export interface RecordBudgetUsageInput {
	runId: string;
	idempotencyKey: string;
	usageId: string;
	category: BudgetUsageRecord["category"];
	nodeId?: string;
	attemptId?: string;
	reviewerInstanceId?: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUsd: number;
	durationMs: number;
	details: JsonValue;
}

export type BudgetSignalType = "budget_warning" | "budget_reached" | "hard_limit_reached";

export interface RecordBudgetSignalInput {
	runId: string;
	idempotencyKey: string;
	type: BudgetSignalType;
	payload: JsonValue;
}
