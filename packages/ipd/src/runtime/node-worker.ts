// 定义节点执行接口、结构化反馈和有限技术重试。
import type { ReportNodeBlocked, SubmitArtifact, SubmitReview } from "../adapter/structured-submissions.ts";
import type { EffectiveNode } from "../contracts/baseline.ts";
import type { RoundInputBindingRecord, SubmissionRecord } from "../contracts/runtime.ts";
import type { TaskInput } from "../contracts/task-input.ts";

export interface NodeTaskContext {
	rawTask?: TaskInput["raw_task"];
	objectives: TaskInput["objectives"];
	requirements: TaskInput["requirements"];
	materials: TaskInput["materials"];
	unresolvedFacts: TaskInput["unresolved_facts"];
}

export interface RoundFeedback {
	type: "submission_correction" | "quality_rework" | "mechanical_failure" | "technical_retry";
	sourceId?: string;
	criterionId?: string;
	outputId?: string;
	issue: string;
	evidenceRef?: string;
	expectedCorrection?: string;
}

export interface NodeRoundWork {
	runId: string;
	roundId: string;
	node: EffectiveNode;
	inputSubmissions: SubmissionRecord[];
	inputBindings: RoundInputBindingRecord[];
	taskContext: NodeTaskContext;
	forbiddenMutableReadPaths: string[];
	feedback: RoundFeedback[];
}

export type ExecutionNodeResult = SubmitArtifact | { kind: "blocked"; report: ReportNodeBlocked };

export interface NodeWorker {
	runExecution(work: NodeRoundWork): Promise<ExecutionNodeResult>;
	runReview(work: NodeRoundWork): Promise<SubmitReview>;
	stopRound?(runId: string, nodeId: string, participantId: string, roundId: string): Promise<void>;
	releaseRun?(runId: string): Promise<void>;
}

export type NodeWorkerFailureKind = "transient" | "external_outcome_unknown" | "session_lost" | "configuration";

export class NodeSubmissionProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NodeSubmissionProtocolError";
	}
}

export class NodeWorkerError extends Error {
	readonly kind: NodeWorkerFailureKind;
	readonly retryable: boolean;

	constructor(kind: NodeWorkerFailureKind, message: string, retryable = kind === "transient", options?: ErrorOptions) {
		super(message, options);
		this.name = "NodeWorkerError";
		this.kind = kind;
		this.retryable = retryable;
	}
}

export class RetryingNodeWorker implements NodeWorker {
	private readonly delegate: NodeWorker;
	private readonly maxAttempts: number;
	private readonly delay: (milliseconds: number) => Promise<void>;
	private readonly stoppedRounds = new Set<string>();

	constructor(
		delegate: NodeWorker,
		maxAttempts = 3,
		delay: (milliseconds: number) => Promise<void> = (milliseconds) =>
			new Promise((resolve) => setTimeout(resolve, milliseconds)),
	) {
		this.delegate = delegate;
		this.maxAttempts = maxAttempts;
		this.delay = delay;
	}

	runExecution(work: NodeRoundWork): Promise<ExecutionNodeResult> {
		return this.retry(work, (current) => this.delegate.runExecution(current));
	}

	runReview(work: NodeRoundWork): Promise<SubmitReview> {
		return this.retry(work, (current) => this.delegate.runReview(current));
	}

	stopRound(runId: string, nodeId: string, participantId: string, roundId: string): Promise<void> {
		this.stoppedRounds.add(`${runId}\0${nodeId}\0${participantId}\0${roundId}`);
		return this.delegate.stopRound?.(runId, nodeId, participantId, roundId) ?? Promise.resolve();
	}

	releaseRun(runId: string): Promise<void> {
		for (const key of this.stoppedRounds) {
			if (key.startsWith(`${runId}\0`)) this.stoppedRounds.delete(key);
		}
		return this.delegate.releaseRun?.(runId) ?? Promise.resolve();
	}

	private async retry<T>(work: NodeRoundWork, operation: (current: NodeRoundWork) => Promise<T>): Promise<T> {
		let last: unknown;
		let current = work;
		const participantId = work.node.agents[0].participantId;
		const key = `${work.runId}\0${work.node.definition.node_id}\0${participantId}\0${work.roundId}`;
		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			if (this.stoppedRounds.has(key))
				throw new NodeWorkerError("configuration", `Round is no longer active: ${work.roundId}`, false);
			try {
				return await operation(current);
			} catch (error) {
				last = error;
				if (!(error instanceof NodeWorkerError) || !error.retryable || attempt === this.maxAttempts) throw error;
				if (this.stoppedRounds.has(key))
					throw new NodeWorkerError("configuration", `Round is no longer active: ${work.roundId}`, false);
				current = {
					...current,
					feedback: [...current.feedback, { type: "technical_retry", issue: error.message }],
				};
				await this.delay(250 * 2 ** (attempt - 1));
			}
		}
		throw last;
	}
}
