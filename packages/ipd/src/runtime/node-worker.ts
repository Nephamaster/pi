// Node work and domain feedback. Model retries belong to Pi AgentSession.
import type { ReportNodeBlocked, SubmitArtifact, SubmitReview } from "../adapter/structured-submissions.ts";
import type { EffectiveNode } from "../contracts/baseline.ts";
import type {
	RoundInputBindingRecord,
	RunResourceReference,
	SubmissionRecord,
	WorkProgressReference,
} from "../contracts/runtime.ts";
import type { TaskInput } from "../contracts/task-input.ts";
import type { EnvironmentBinding, EnvironmentErrorCode } from "../environment/contracts.ts";

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

export interface NodeRoundWork {
	generation?: number;
	resuming?: boolean;
	signal?: AbortSignal;
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
	validateResume?(runId: string, progress: readonly WorkProgressReference[]): Promise<void>;
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

	constructor(kind: NodeWorkerFailureKind, message: string, retryable = false, options?: ErrorOptions) {
		super(message, options);
		this.name = "NodeWorkerError";
		this.kind = kind;
		// Diagnostic metadata, not permission to replay an entire node round.
		this.retryable = retryable;
	}
}
