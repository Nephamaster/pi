import { isAbsolute } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildNodeRoundPrompt, buildNodeSystemPrompt } from "../runtime/node-prompts.ts";
import { type NodeRoundWork, type NodeWorker, NodeWorkerError } from "../runtime/node-worker.ts";
import { renderCurrentRoundContext, renderNodeContractFile } from "./node-context.ts";
import { NodeSessionAdapter } from "./node-session-adapter.ts";
import { type PiNodeSessionCreateInput, PiNodeSessionFactory } from "./pi-node-session-factory.ts";
import type { SubmitArtifact, SubmitReview } from "./structured-submissions.ts";
import {
	createSubmissionTool,
	SubmissionCapture,
	SubmitArtifactSchema,
	SubmitReviewSchema,
} from "./structured-submissions.ts";

interface WorkerBinding {
	runId: string;
	nodeId: string;
	participantId: string;
	kind: "execution" | "review";
	capture: SubmissionCapture<SubmitArtifact> | SubmissionCapture<SubmitReview>;
	tool: ToolDefinition;
	currentContext?: string;
	additionalReadRoots: string[];
	deniedReadRoots: string[];
}

export interface PiNodeWorkerOptions {
	agentDir: string;
	workspace: string;
	sessionDirectory: string;
	modelRuntime: ModelRuntime;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	customTools?: readonly ToolDefinition[];
}

const keyOf = (work: NodeRoundWork) =>
	`${work.runId}\0${work.node.definition.node_id}\0${work.node.agents[0].participantId}`;

export class PiNodeWorker implements NodeWorker {
	private readonly options: PiNodeWorkerOptions;
	private readonly sessions: NodeSessionAdapter<PiNodeSessionCreateInput>;
	private readonly bindings = new Map<string, WorkerBinding>();

	constructor(options: PiNodeWorkerOptions) {
		this.options = options;
		this.sessions = new NodeSessionAdapter(
			new PiNodeSessionFactory({
				agentDir: options.agentDir,
				modelRuntime: options.modelRuntime,
				customTools: options.customTools,
			}),
		);
	}

	async runExecution(work: NodeRoundWork): Promise<SubmitArtifact> {
		const binding = this.binding(work, "execution");
		binding.capture.beginRound();
		await this.dispatch(work, binding);
		const value = binding.capture.value;
		if (!value) throw new NodeWorkerError("configuration", "Execution node submitted no Artifact", false);
		return value as SubmitArtifact;
	}

	async runReview(work: NodeRoundWork): Promise<SubmitReview> {
		const binding = this.binding(work, "review");
		binding.capture.beginRound();
		await this.dispatch(work, binding);
		const value = binding.capture.value;
		if (!value) throw new NodeWorkerError("configuration", "Review node submitted no Review", false);
		return value as SubmitReview;
	}

	stopRound(runId: string, nodeId: string, participantId: string, roundId: string): Promise<void> {
		return this.sessions.stop(runId, nodeId, participantId, roundId);
	}

	private binding(work: NodeRoundWork, kind: "execution" | "review"): WorkerBinding {
		const key = keyOf(work);
		const existing = this.bindings.get(key);
		if (existing) {
			if (existing.kind !== kind)
				throw new NodeWorkerError("configuration", "Node kind changed after Session binding", false);
			return existing;
		}
		const capture =
			kind === "execution" ? new SubmissionCapture<SubmitArtifact>() : new SubmissionCapture<SubmitReview>();
		const tool =
			kind === "execution"
				? createSubmissionTool({
						name: "submit_artifact",
						label: "Submit Artifact",
						description: "Submit this round's declared outputs and evidence.",
						parameters: SubmitArtifactSchema,
						capture: capture as SubmissionCapture<SubmitArtifact>,
					})
				: createSubmissionTool({
						name: "submit_review",
						label: "Submit Review",
						description: "Submit criterion-level review results.",
						parameters: SubmitReviewSchema,
						capture: capture as SubmissionCapture<SubmitReview>,
					});
		const participant = work.node.agents[0];
		const binding = {
			runId: work.runId,
			nodeId: work.node.definition.node_id,
			participantId: participant.participantId,
			kind,
			capture,
			tool,
			additionalReadRoots: [],
			deniedReadRoots: [],
		};
		this.bindings.set(key, binding);
		return binding;
	}

	async releaseRun(runId: string): Promise<void> {
		for (const [key, binding] of this.bindings) {
			if (binding.runId !== runId) continue;
			await this.sessions.release(binding.runId, binding.nodeId, binding.participantId);
			this.bindings.delete(key);
		}
	}

	private async dispatch(work: NodeRoundWork, binding: WorkerBinding): Promise<void> {
		const participant = work.node.agents[0];
		binding.currentContext = renderCurrentRoundContext(work);
		binding.additionalReadRoots = [
			...work.inputSubmissions.flatMap((submission) => submission.outputs.map((output) => output.sealedRoot)),
			...work.taskContext.materials.flatMap((material) =>
				isAbsolute(material.reference) ? [material.reference] : [],
			),
		];
		binding.deniedReadRoots = [...work.forbiddenMutableReadPaths];
		try {
			await this.sessions.create({
				runId: work.runId,
				nodeId: work.node.definition.node_id,
				participantId: participant.participantId,
				createInput: {
					workspace: this.options.workspace,
					sessionDirectory: this.options.sessionDirectory,
					systemPrompt: buildNodeSystemPrompt(work),
					contextFiles: [renderNodeContractFile(work.node)],
					getCurrentContext: () => binding.currentContext,
					getAdditionalReadRoots: () => binding.additionalReadRoots,
					getDeniedReadRoots: () => binding.deniedReadRoots,
					permissions: work.node.definition.agents[0].permissions,
					participant,
					runDefaultModel: this.options.model,
					runDefaultThinkingLevel: this.options.thinkingLevel,
					controlTools: [binding.tool],
				},
			});
			await this.sessions.dispatch(
				work.runId,
				work.node.definition.node_id,
				participant.participantId,
				work.roundId,
				buildNodeRoundPrompt(work),
			);
		} catch (error) {
			if (error instanceof NodeWorkerError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throw new NodeWorkerError("transient", message, true, {
				cause: error,
			});
		}
	}
}
