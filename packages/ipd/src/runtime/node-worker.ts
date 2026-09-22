// Node work and domain feedback. Model retries belong to Pi AgentSession.
import type { ReportNodeBlocked, SubmitArtifact, SubmitReview } from "../adapter/structured-submissions.ts";
import type { EffectiveNode } from "../contracts/baseline.ts";
import type { JsonValue } from "../contracts/primitives.ts";
import type {
	ExternalOperationOutcome,
	ProviderRequestRecord,
	RoundInputBindingRecord,
	RunResourceReference,
	RunState,
	SubmissionRecord,
	WorkProgressReference,
} from "../contracts/runtime.ts";
import type { TaskInput } from "../contracts/task-input.ts";
import type { EnvironmentBinding, EnvironmentErrorCode } from "../environment/contracts.ts";
import type { ExecutionStamp } from "./execution-control.ts";

export interface NodeTaskContext {
	rawTask?: TaskInput["raw_task"];
	materials: TaskInput["materials"];
	unresolvedFacts: TaskInput["unresolved_facts"];
}

export interface RoundFeedback {
	type: "submission_correction" | "quality_rework" | "mechanical_failure";
	sourceId?: string;
	criterionId?: string;
	outputId?: string;
	issue: string;
	evidenceRef?: string;
	expectedCorrection?: string;
}

export interface ExternalOperationIntent {
	operationKey: string;
	intentRef: string;
	requestHash: string;
	authorizationRef: string;
	targetRef: string;
}

export interface ExternalOperationRecorder {
	begin(intent: ExternalOperationIntent): Promise<string>;
	settle(
		operationId: string,
		outcome: Exclude<ExternalOperationOutcome, "pending" | "cancelled">,
		receiptRef?: string,
	): Promise<void>;
}

export interface NodeRoundWork {
	stamp: ExecutionStamp;
	generation?: number;
	resuming?: boolean;
	signal?: AbortSignal;
	onDispatchDelivering?: () => Promise<void>;
	onDispatchStarted?: () => Promise<void>;
	onProviderRequest?: (
		observation: Omit<ProviderRequestRecord, "attemptId" | "commandId" | "nodeId" | "createdAt">,
	) => Promise<boolean>;
	externalOperations?: ExternalOperationRecorder;
	onResourcesChanged?: (resources: readonly RunResourceReference[]) => Promise<boolean>;
	runId: string;
	roundId: string;
	node: EffectiveNode;
	inputSubmissions: SubmissionRecord[];
	inputBindings: RoundInputBindingRecord[];
	taskContext: NodeTaskContext;
	forbiddenMutableReadPaths: string[];
	feedback: RoundFeedback[];
	environmentBinding?: EnvironmentBinding;
}

export type ExecutionNodeResult = SubmitArtifact | { kind: "blocked"; report: ReportNodeBlocked };

export interface NodeWorker {
	inspectRun?(runId: string): RunResourceReference[];
	pauseRun?(runId: string): Promise<WorkProgressReference[]>;
	validateResume?(state: RunState): Promise<void>;
	recoverInterrupted?(state: RunState): Promise<WorkProgressReference[]>;
	requestCheckpoint?(work: NodeRoundWork): Promise<void>;
	prepareRound?(work: NodeRoundWork, signal?: AbortSignal): Promise<void>;
	exportSubmission?(
		work: NodeRoundWork,
		submission: SubmitArtifact,
		signal?: AbortSignal,
	): Promise<string | undefined>;
	runExecution(work: NodeRoundWork): Promise<ExecutionNodeResult>;
	runReview(work: NodeRoundWork): Promise<SubmitReview>;
	stopRound?(runId: string, nodeId: string, participantId: string, roundId: string): Promise<void>;
	releaseRun?(runId: string): Promise<void>;
}

export type NodeWorkerFailureKind =
	| "transient"
	| "external_outcome_unknown"
	| "session_lost"
	| "configuration"
	| "request_capacity"
	| "timeout"
	| "cancelled"
	| EnvironmentErrorCode;

export class NodeSubmissionProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NodeSubmissionProtocolError";
	}
}

export class NodeWorkerError extends Error {
	readonly kind: NodeWorkerFailureKind;
	readonly retryable: boolean;
	readonly details?: JsonValue;

	constructor(
		kind: NodeWorkerFailureKind,
		message: string,
		retryable = false,
		options?: ErrorOptions & { details?: JsonValue },
	) {
		super(message, options);
		this.name = "NodeWorkerError";
		this.kind = kind;
		// Diagnostic metadata, not permission to replay an entire node round.
		this.retryable = retryable;
		this.details = options?.details;
	}
}
