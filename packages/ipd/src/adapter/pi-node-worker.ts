// 使用持续 Pi Session 执行节点轮次并捕获结构化提交。
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { EnvironmentError } from "../environment/contracts.ts";
import type { EnvironmentManager } from "../environment/manager.ts";
import { hashEnvironmentSource } from "../environment/paths.ts";
import type { EnvironmentToolContext } from "../environment/tool-backend.ts";
import { createEnvironmentToolDefinitions } from "../environment/tool-backend.ts";
import { buildNodeRoundPrompt, buildNodeSystemPrompt } from "../runtime/node-prompts.ts";
import {
	type NodeRoundWork,
	NodeSubmissionProtocolError,
	type NodeWorker,
	NodeWorkerError,
} from "../runtime/node-worker.ts";
import { renderCurrentRoundContext, renderNodeContextFiles } from "./node-context.ts";
import { NodeSessionAdapter } from "./node-session-adapter.ts";
import { type PiNodeSessionCreateInput, PiNodeSessionFactory } from "./pi-node-session-factory.ts";
import type { ReportNodeBlocked, SubmitArtifact, SubmitReview } from "./structured-submissions.ts";
import {
	createSubmissionTool,
	ReportNodeBlockedSchema,
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
	blockedCapture?: SubmissionCapture<ReportNodeBlocked>;
	tools: ToolDefinition[];
	currentContext?: string;
	additionalReadRoots: string[];
	deniedReadRoots: string[];
	environment?: EnvironmentToolContext;
}

export interface PiNodeWorkerOptions {
	agentDir: string;
	workspace: string;
	sessionDirectory: string;
	modelRuntime: ModelRuntime;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	customTools?: readonly ToolDefinition[];
	environmentManager?: EnvironmentManager;
}

const keyOf = (work: NodeRoundWork) =>
	`${work.runId}\0${work.node.definition.node_id}\0${work.node.agents[0].participantId}`;

export function classifyWorkerError(error: unknown): NodeWorkerError {
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof EnvironmentError)
		return new NodeWorkerError(error.code, message, error.retryable, { cause: error });
	if (/abort|cancel|no longer active/i.test(message))
		return new NodeWorkerError("cancelled", message, false, { cause: error });
	if (/IPD Bash sandbox requires|Required environment command is unavailable/i.test(message))
		return new NodeWorkerError("environment_unavailable", message, false, { cause: error });
	if (
		/Locked Skill content changed|Configured model is unavailable|Node Session .* (lost|released)|does not expose|required by IPD/i.test(
			message,
		)
	)
		return new NodeWorkerError("configuration", message, false, { cause: error });
	return new NodeWorkerError("transient", message, true, { cause: error });
}

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

	async prepareRound(work: NodeRoundWork, signal?: AbortSignal): Promise<void> {
		if (!work.environmentBinding || !this.options.environmentManager) return;
		const binding = this.binding(work, work.node.definition.kind);
		const lease = await this.options.environmentManager.prepare(work.runId, work.environmentBinding, signal);
		const contextFiles = renderNodeContextFiles(work);
		await this.options.environmentManager.bindStaticAssets(
			lease.leaseId,
			[
				...contextFiles.map((file) => ({
					assetId: file.path,
					contentHash: createHash("sha256").update(file.content).digest("hex"),
					virtualPath: file.path,
					content: Buffer.from(file.content),
				})),
				...work.node.agents[0].lockedSkills.map((skill) => ({
					assetId: `skill:${skill.id}`,
					contentHash: skill.hash,
					virtualPath: `/ipd/skills/${skill.id}/${skill.hash}`,
					sourcePath: skill.baseDir,
				})),
			],
			signal,
		);
		const inputs = [];
		for (const input of work.node.definition.inputs) {
			if (input.kind === "node_output") {
				const record = work.inputBindings.find((candidate) => candidate.inputId === input.input_id);
				const submission = record
					? work.inputSubmissions.find((candidate) => candidate.submissionId === record.submissionId)
					: undefined;
				const output = submission?.outputs.find((candidate) => candidate.outputId === record?.outputId);
				if (!record || !submission || !output) continue;
				inputs.push({
					bindingId: input.input_id,
					contentHash: await hashEnvironmentSource(output.sealedRoot),
					virtualPath: `/ipd/inputs/${input.input_id}`,
					sourcePath: output.sealedRoot,
				});
				continue;
			}
			const material = work.taskContext.materials.find((candidate) => candidate.material_id === input.material_id);
			if (!material || !isAbsolute(material.reference)) continue;
			inputs.push({
				bindingId: input.input_id,
				contentHash: await hashEnvironmentSource(material.reference),
				virtualPath: `/ipd/inputs/${input.input_id}`,
				sourcePath: material.reference,
			});
		}
		const round = await this.options.environmentManager.bindRound(
			lease.leaseId,
			{
				roundId: work.roundId,
				inputs,
				allowedOperations: [
					"read",
					...(work.node.definition.kind === "execution" ? (["write", "export"] as const) : []),
					...(work.node.agents[0].lockedTools.some((tool) => tool.id === "bash") ? (["exec"] as const) : []),
					...(work.node.agents[0].lockedTools.some((tool) => tool.id === "environment_process_start")
						? (["process"] as const)
						: []),
				],
			},
			signal,
		);
		binding.environment = this.options.environmentManager.context(lease.leaseId, round.roundId);
	}

	async exportSubmission(
		work: NodeRoundWork,
		submission: SubmitArtifact,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		const binding = this.bindings.get(keyOf(work));
		if (!binding?.environment) return undefined;
		const destination = await mkdtemp(join(tmpdir(), "pi-ipd-export-"));
		try {
			const result = await binding.environment.provider.exportOutputs(
				binding.environment.lease,
				binding.environment.round,
				{
					destination,
					outputs: submission.outputs.flatMap((output) =>
						output.files.map((file) => ({ outputId: output.output_id, logicalPath: file.path })),
					),
				},
				signal,
			);
			return result.root;
		} catch (error) {
			await rm(destination, { recursive: true, force: true });
			throw classifyWorkerError(error);
		}
	}

	async runExecution(work: NodeRoundWork): Promise<SubmitArtifact | { kind: "blocked"; report: ReportNodeBlocked }> {
		const binding = this.binding(work, "execution");
		binding.capture.beginRound();
		binding.blockedCapture?.beginRound();
		await this.dispatch(work, binding);
		const value = binding.capture.value;
		const blocked = binding.blockedCapture?.value;
		if (value && blocked)
			throw new NodeSubmissionProtocolError("Execution node submitted both an Artifact and a block");
		if (blocked) return { kind: "blocked", report: blocked };
		if (!value) throw new NodeSubmissionProtocolError("Execution node did not call submit_artifact");
		return value as SubmitArtifact;
	}

	async runReview(work: NodeRoundWork): Promise<SubmitReview> {
		const binding = this.binding(work, "review");
		binding.capture.beginRound();
		await this.dispatch(work, binding);
		const value = binding.capture.value;
		if (!value) throw new NodeSubmissionProtocolError("Review node did not call submit_review");
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
		const submissionTool =
			kind === "execution"
				? createSubmissionTool({
						name: "submit_artifact",
						label: "Submit Artifact",
						description:
							"Submit one complete candidate result for the current execution round. Include every output declared by the node contract and the evidence actually produced for those outputs. Successful invocation captures the candidate for Runtime validation; it does not mean the Artifact passed checks, review, or approval.",
						parameters: SubmitArtifactSchema,
						capture: capture as SubmissionCapture<SubmitArtifact>,
					})
				: createSubmissionTool({
						name: "submit_review",
						label: "Submit Review",
						description:
							"Submit the criterion-level review result for the exact sealed targets assigned to this review round. Every assigned criterion must have exactly one result. The tool captures a review candidate; Runtime validates it and controls approval, rework, and downstream release.",
						parameters: SubmitReviewSchema,
						capture: capture as SubmissionCapture<SubmitReview>,
					});
		const blockedCapture = kind === "execution" ? new SubmissionCapture<ReportNodeBlocked>() : undefined;
		const tools: ToolDefinition[] = [submissionTool];
		if (blockedCapture)
			tools.push(
				createSubmissionTool({
					name: "report_node_blocked",
					label: "Report Node Blocked",
					description:
						"Report a business block only after attempting reasonable in-sandbox recovery when required facts, materials, access, authorization, environment dependencies, or another necessary condition remains unavailable and no valid Artifact can be produced. Do not use this for malformed submissions or transient technical failures. Runtime records the block and its recovery conditions.",
					parameters: ReportNodeBlockedSchema,
					capture: blockedCapture,
				}),
			);
		const participant = work.node.agents[0];
		const binding = {
			runId: work.runId,
			nodeId: work.node.definition.node_id,
			participantId: participant.participantId,
			kind,
			capture,
			blockedCapture,
			tools,
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
		await this.options.environmentManager?.releaseRun(runId);
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
			const environmentTools = binding.environment
				? createEnvironmentToolDefinitions({
						hostWorkspace: this.options.workspace,
						getContext: () => {
							if (!binding.environment)
								throw new EnvironmentError(
									"environment_lost",
									"Environment is not bound to the current node round",
								);
							return binding.environment;
						},
					})
				: undefined;
			await this.sessions.create({
				runId: work.runId,
				nodeId: work.node.definition.node_id,
				participantId: participant.participantId,
				createInput: {
					nodeId: work.node.definition.node_id,
					workspace: this.options.workspace,
					sessionDirectory: this.options.sessionDirectory,
					systemPrompt: buildNodeSystemPrompt(),
					contextFiles: renderNodeContextFiles(work),
					getCurrentContext: () => binding.currentContext,
					getAdditionalReadRoots: () => binding.additionalReadRoots,
					getDeniedReadRoots: () => binding.deniedReadRoots,
					allowReadOwnWritePaths: binding.kind === "execution",
					permissions: work.node.definition.agents[0].permissions,
					participant,
					runDefaultModel: this.options.model,
					runDefaultThinkingLevel: this.options.thinkingLevel,
					controlTools: binding.tools,
					environmentTools,
					environmentCwd: binding.environment ? "/workspace" : undefined,
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
			if (error instanceof NodeWorkerError || error instanceof NodeSubmissionProtocolError) throw error;
			throw classifyWorkerError(error);
		}
	}
}
