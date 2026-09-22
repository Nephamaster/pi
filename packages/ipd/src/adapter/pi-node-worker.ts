// 使用持续 Pi Session 执行节点轮次并捕获结构化提交。
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunResourceReference, RunState, WorkProgressReference } from "../contracts/runtime.ts";
import { quoteCommand } from "../environment/bridge/protocol.ts";
import { EnvironmentError } from "../environment/contracts.ts";
import type { EnvironmentManager } from "../environment/manager.ts";
import { hashEnvironmentSource, hashWorkspaceState } from "../environment/paths.ts";
import type { EnvironmentToolContext } from "../environment/tool-backend.ts";
import { createEnvironmentToolDefinitions, verifyEnvironmentProbes } from "../environment/tool-backend.ts";
import { buildNodeRoundPrompt, buildNodeSystemPrompt } from "../runtime/node-prompts.ts";
import {
	type NodeRoundWork,
	NodeSubmissionProtocolError,
	type NodeWorker,
	NodeWorkerError,
} from "../runtime/node-worker.ts";
import type { ResourceAdmission } from "../runtime/resource-admission.ts";
import { renderCurrentRoundContext, renderNodeContextFiles } from "./node-context.ts";
import { NodeSessionAdapter, type NodeSessionEventEnvelope } from "./node-session-adapter.ts";
import {
	type LegacyNodeToolAdapter,
	openRetainedSession,
	type PiNodeSessionCreateInput,
	PiNodeSessionFactory,
	type RetainedSessionReference,
} from "./pi-node-session-factory.ts";
import type { ProviderRequestObservation } from "./provider-request-admission.ts";
import type { IpdSessionSettings } from "./session-policy.ts";
import type { ReportNodeBlocked, SubmitArtifact, SubmitReview } from "./structured-submissions.ts";
import {
	createSubmissionTool,
	normalizeArtifactPaths,
	ReportNodeBlockedSchema,
	SubmissionCapture,
	SubmitArtifactSchema,
	SubmitReviewSchema,
} from "./structured-submissions.ts";

interface WorkerBinding {
	kind: "execution" | "review";
	capture: SubmissionCapture<SubmitArtifact> | SubmissionCapture<SubmitReview>;
	blockedCapture?: SubmissionCapture<ReportNodeBlocked>;
	tools: ToolDefinition[];
	currentContext?: string;
	additionalReadRoots: string[];
	deniedReadRoots: string[];
	environment?: EnvironmentToolContext;
	providerRequestRecorder?: (observation: ProviderRequestObservation) => Promise<boolean>;
	externalOperationRecorder?: NodeRoundWork["externalOperations"];
}

export interface PiNodeWorkerOptions {
	admission?: ResourceAdmission;
	legacyToolAdapter?: LegacyNodeToolAdapter;
	agentDir: string;
	workspace: string;
	sessionDirectory: string;
	modelRuntime: ModelRuntime;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	customTools?: readonly ToolDefinition[];
	environmentManager?: EnvironmentManager;
	sessionSettings?: IpdSessionSettings;
	onSessionEvent?: (event: NodeSessionEventEnvelope) => void;
}

export function classifyWorkerError(error: unknown): NodeWorkerError {
	if (error instanceof NodeWorkerError) return error;
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof EnvironmentError)
		return new NodeWorkerError(error.code, message, error.retryable, {
			cause: error,
			details: { environmentCode: error.code },
		});
	if (/abort|cancel|no longer active/i.test(message))
		return new NodeWorkerError("cancelled", message, false, { cause: error });
	if (/IPD provider request admission rejected|ipd_(?:request|message)_.*exceeded/i.test(message))
		return new NodeWorkerError("request_capacity", message, false, {
			cause: error,
			details: { providerRequestRejected: true },
		});
	if (/IPD Bash sandbox requires|Required environment command is unavailable/i.test(message))
		return new NodeWorkerError("environment_unavailable", message, false, { cause: error });
	if (
		/Locked Skill content changed|Configured model is unavailable|Node Session .* (lost|released)|does not expose|required by IPD/i.test(
			message,
		)
	)
		return new NodeWorkerError("configuration", message, false, { cause: error });
	return new NodeWorkerError("transient", message, false, { cause: error });
}

export class PiNodeWorker implements NodeWorker {
	private readonly options: PiNodeWorkerOptions;
	private readonly sessions: NodeSessionAdapter<PiNodeSessionCreateInput, WorkerBinding>;
	private readonly retainedSessions = new Map<string, RetainedSessionReference>();

	constructor(options: PiNodeWorkerOptions) {
		this.options = options;
		this.sessions = new NodeSessionAdapter(
			new PiNodeSessionFactory({
				agentDir: options.agentDir,
				modelRuntime: options.modelRuntime,
				customTools: options.customTools,
				legacyToolAdapter: options.legacyToolAdapter,
				sessionSettings: options.sessionSettings,
			}),
			options.onSessionEvent,
		);
	}

	async prepareRound(work: NodeRoundWork, signal?: AbortSignal): Promise<void> {
		if (!work.environmentBinding || !this.options.environmentManager) return;
		const binding = this.binding(work, work.node.definition.kind);
		const paths = work.environmentBinding.paths;
		const lease = await this.options.environmentManager.prepare(
			work.runId,
			work.environmentBinding,
			signal,
			async () => this.notifyResources(work),
		);
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
					virtualPath: `${paths.skills}/${skill.id}/${skill.hash}`,
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
					virtualPath: `${paths.inputs}/${input.input_id}`,
					sourcePath: output.sealedRoot,
				});
				continue;
			}
			const material = work.taskContext.materials.find((candidate) => candidate.material_id === input.material_id);
			if (!material || !isAbsolute(material.reference)) continue;
			inputs.push({
				bindingId: input.input_id,
				contentHash: await hashEnvironmentSource(material.reference),
				virtualPath: `${paths.inputs}/${input.input_id}`,
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
					"write",
					"export",
					...(work.node.agents[0].lockedTools.some((tool) => tool.id === "bash") ? (["exec"] as const) : []),
					...(work.node.agents[0].lockedTools.some((tool) => tool.id === "environment_process_start")
						? (["process"] as const)
						: []),
				],
			},
			signal,
		);
		binding.environment = this.options.environmentManager.context(lease.leaseId, round.roundId);
		const commands = [
			...new Set(
				work.node.agents[0].lockedSkills.flatMap((skill) => [
					...(skill.requiredCommands ?? []),
					...(skill.environmentRequirements?.commands ?? []),
				]),
			),
		];
		const probes = work.node.agents[0].lockedSkills.flatMap((skill) =>
			(skill.environmentRequirements?.probes ?? []).map((probe) => ({
				...probe,
				id: `${skill.id}:${probe.id}`,
				command: probe.command.map((arg) =>
					arg.replaceAll("$SKILL_DIR", `${paths.skills}/${skill.id}/${skill.hash}`),
				),
			})),
		);
		if (commands.length || probes.length) {
			await verifyEnvironmentProbes(
				{ hostWorkspace: this.options.workspace, getContext: () => binding.environment! },
				[
					...commands.map((command) => ({
						id: `command:${command}`,
						version: "1.0.0",
						command: ["/bin/bash", "--noprofile", "--norc", "-c", `command -v ${quoteCommand([command])}`],
						timeoutSeconds: 10,
					})),
					...probes,
				],
				signal,
			);
		}
		await this.notifyResources(work);
	}

	async exportSubmission(
		work: NodeRoundWork,
		submission: SubmitArtifact,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		const binding = this.sessions.getState(
			work.runId,
			work.node.definition.node_id,
			work.node.agents[0].participantId,
		);
		if (!binding?.environment) return undefined;
		if (work.node.definition.kind !== "execution")
			throw new NodeSubmissionProtocolError("Only execution nodes can export Artifact submissions");
		const projectProbes = work.node.agents[0].lockedSkills.flatMap((skill) =>
			(skill.environmentRequirements?.projectProbes ?? []).map((probe) => ({
				...probe,
				id: `${skill.id}:${probe.id}`,
				command: probe.command.map((arg) =>
					arg.replaceAll("$SKILL_DIR", `${binding.environment!.binding.paths.skills}/${skill.id}/${skill.hash}`),
				),
			})),
		);
		try {
			await verifyEnvironmentProbes(
				{ hostWorkspace: this.options.workspace, getContext: () => binding.environment! },
				projectProbes,
				signal,
			);
		} catch (error) {
			if (signal?.aborted) throw classifyWorkerError(error);
			if (error instanceof EnvironmentError && error.code !== "profile_incompatible")
				throw classifyWorkerError(error);
			throw new NodeSubmissionProtocolError(
				`Project dependencies are not ready for submission: ${error instanceof Error ? error.message : String(error)}. Repair them inside the private workspace and resubmit.`,
			);
		}
		const outputRoots = new Map(work.node.definition.outputs.map((output) => [output.output_id, output.path_prefix]));
		for (const output of submission.outputs)
			if (!outputRoots.has(output.output_id))
				throw new NodeSubmissionProtocolError(
					`Submission references undeclared output ${output.output_id}; declared outputs: ${[...outputRoots.keys()].join(", ")}`,
				);
		const destination = await mkdtemp(join(tmpdir(), "pi-ipd-export-"));
		try {
			const result = await binding.environment.provider.exportOutputs(
				binding.environment.lease,
				binding.environment.round,
				{
					destination,
					outputs: submission.outputs.flatMap((output) => {
						const outputRoot = outputRoots.get(output.output_id);
						if (!outputRoot) throw new NodeSubmissionProtocolError(`Undeclared output ${output.output_id}`);
						return output.files.map((file) => ({
							outputId: output.output_id,
							outputRoot,
							logicalPath: file.path,
						}));
					}),
				},
				signal,
			);
			return result.root;
		} catch (error) {
			await rm(destination, { recursive: true, force: true });
			if (error instanceof NodeSubmissionProtocolError) throw error;
			throw classifyWorkerError(error);
		}
	}

	async runExecution(work: NodeRoundWork): Promise<SubmitArtifact | { kind: "blocked"; report: ReportNodeBlocked }> {
		const binding = this.binding(work, "execution");
		const { value, blocked } = await this.dispatch(work, binding);
		if (value && blocked)
			throw new NodeSubmissionProtocolError("Execution node submitted both an Artifact and a block");
		if (blocked) return { kind: "blocked", report: blocked };
		if (!value) throw new NodeSubmissionProtocolError("Execution node did not call submit_artifact");
		// Export and sealing must consume the same workspace-relative file identities.
		return normalizeArtifactPaths(
			value as SubmitArtifact,
			binding.environment?.binding.paths.workspace ?? this.options.workspace,
		);
	}

	async runReview(work: NodeRoundWork): Promise<SubmitReview> {
		const binding = this.binding(work, "review");
		const { value } = await this.dispatch(work, binding);
		if (!value) throw new NodeSubmissionProtocolError("Review node did not call submit_review");
		return value as SubmitReview;
	}

	async exportReviewEvidence(work: NodeRoundWork, paths: readonly string[], signal?: AbortSignal): Promise<string> {
		const environment = this.sessions.getState(
			work.runId,
			work.node.definition.node_id,
			work.node.agents[0].participantId,
		)?.environment;
		if (!environment)
			throw new NodeSubmissionProtocolError(
				"Reviewer verification export requires a controlled Environment Provider",
			);
		const destination = await mkdtemp(join(tmpdir(), "pi-ipd-review-evidence-"));
		try {
			const exported = await environment.provider.exportOutputs(
				environment.lease,
				environment.round,
				{
					destination,
					outputs: paths.map((path) => ({
						outputId: "review-evidence",
						outputRoot: "outputs/review-evidence",
						logicalPath: path,
					})),
				},
				signal,
			);
			return exported.root;
		} catch (error) {
			await rm(destination, { recursive: true, force: true });
			throw error;
		}
	}

	stopRound(runId: string, nodeId: string, participantId: string, roundId: string): Promise<void> {
		return this.sessions.stop(runId, nodeId, participantId, roundId);
	}

	private binding(work: NodeRoundWork, kind: "execution" | "review"): WorkerBinding {
		const existing = this.sessions.getState(
			work.runId,
			work.node.definition.node_id,
			work.node.agents[0].participantId,
		);
		if (existing) {
			if (existing.kind !== kind)
				throw new NodeWorkerError("configuration", "Node kind changed after Session binding", false);
			return this.sessions.bindState(
				work.runId,
				work.node.definition.node_id,
				work.node.agents[0].participantId,
				() => existing,
			);
		}
		const capture =
			kind === "execution" ? new SubmissionCapture<SubmitArtifact>() : new SubmissionCapture<SubmitReview>();
		const declaredOutputIds =
			work.node.definition.kind === "execution"
				? work.node.definition.outputs.map((output) => output.output_id)
				: [];
		const submissionTool =
			kind === "execution"
				? createSubmissionTool({
						name: "submit_artifact",
						label: "Submit Artifact",
						description: `Submit one complete candidate result for the current execution round. Use exactly these output IDs: ${declaredOutputIds.join(", ")}. Include the evidence actually produced for those outputs. Successful invocation captures the candidate for Runtime validation; it does not mean the Artifact passed checks, review, or approval.`,
						parameters: SubmitArtifactSchema,
						capture: capture as SubmissionCapture<SubmitArtifact>,
						validate: (value) => {
							const submitted = [
								...value.outputs.map((output) => output.output_id),
								...(value.preserved_outputs ?? []).map((output) => output.output_id),
							];
							const invalid = submitted.filter((id) => !declaredOutputIds.includes(id));
							const missing = declaredOutputIds.filter((id) => !submitted.includes(id));
							const duplicate = submitted.filter((id, index) => submitted.indexOf(id) !== index);
							return invalid.length || missing.length || duplicate.length
								? [
										`Output IDs must match the node contract. Expected: ${declaredOutputIds.join(", ")}. Unknown: ${invalid.join(", ") || "none"}. Missing: ${missing.join(", ") || "none"}. Duplicate: ${duplicate.join(", ") || "none"}. Correct the IDs and submit again.`,
									]
								: [];
						},
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
		return this.sessions.bindState(work.runId, work.node.definition.node_id, participant.participantId, () => ({
			kind,
			capture,
			blockedCapture,
			tools,
			additionalReadRoots: [],
			deniedReadRoots: [],
		}));
	}

	async releaseRun(runId: string): Promise<void> {
		const results = await Promise.allSettled([
			this.sessions.releaseRun(runId),
			this.options.environmentManager?.releaseRun(runId),
		]);
		const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
		if (errors.length)
			throw new AggregateError(
				errors.map((result) => result.reason),
				"Node resources could not be released",
			);
	}

	async pauseRun(runId: string): Promise<WorkProgressReference[]> {
		const sessions = await this.sessions.pauseRun(runId);
		const environments = (await this.options.environmentManager?.suspendRun(runId)) ?? [];
		const result: WorkProgressReference[] = environments.map((item) => ({ ...item }));
		for (const session of sessions) {
			const reference = result.find(
				(item) => item.nodeId === session.nodeId && item.participantId === session.participantId,
			) ?? { nodeId: session.nodeId, participantId: session.participantId, workspace: this.options.workspace };
			Object.assign(reference, {
				sessionId: session.sessionId,
				sessionFile: session.sessionFile,
				entryId: session.entryId,
			});
			if (!result.includes(reference)) result.push(reference);
		}
		for (const reference of result)
			if (!reference.environment) reference.workspaceHash = await hashWorkspaceState(reference.workspace);
		return result;
	}

	inspectRun(runId: string): RunResourceReference[] {
		const resources = new Map<string, RunResourceReference>();
		const resource = (nodeId: string, participantId: string) => {
			const key = `${nodeId}\0${participantId}`;
			const existing = resources.get(key) ?? { nodeId, participantId };
			resources.set(key, existing);
			return existing;
		};
		for (const session of this.sessions.inspectRun(runId))
			Object.assign(resource(session.nodeId, session.participantId), {
				sessionId: session.sessionId,
				sessionFile: session.sessionFile,
				entryId: session.entryId,
			});
		for (const environment of this.options.environmentManager?.inspectRun(runId) ?? [])
			Object.assign(resource(environment.nodeId, environment.participantId), {
				leaseId: environment.leaseId,
				providerHandle: environment.providerHandle,
				bindingId: environment.bindingId,
				generation: environment.generation,
			});
		return [...resources.values()];
	}

	async recoverInterrupted(state: RunState): Promise<WorkProgressReference[]> {
		if (state.activeResources.length === 0)
			throw new NodeWorkerError("environment_lost", "Interrupted Run has no durable resource references");
		const progress: WorkProgressReference[] = [];
		for (const resource of state.activeResources) {
			const retainedSession = this.retainSessionReference(state, resource, true);
			let saved: WorkProgressReference;
			if (resource.leaseId) {
				if (!resource.bindingId || resource.generation === undefined || !this.options.environmentManager)
					throw new NodeWorkerError("environment_lost", "Interrupted environment reference is incomplete");
				const binding = state.baseline?.environmentBindings.find(
					(candidate) =>
						candidate.nodeId === resource.nodeId && candidate.participantId === resource.participantId,
				);
				if (!binding) throw new NodeWorkerError("environment_lost", "Frozen environment binding is unavailable");
				try {
					saved = await this.options.environmentManager.quarantine(state.runId, binding, {
						leaseId: resource.leaseId,
						providerHandle: resource.providerHandle ?? "",
						generation: resource.generation,
						bindingId: resource.bindingId,
					});
				} catch (error) {
					if (!(error instanceof EnvironmentError) || error.code !== "path_not_found") throw error;
					saved = {
						nodeId: resource.nodeId,
						participantId: resource.participantId,
						workspace: this.options.workspace,
						workspaceHash: await hashWorkspaceState(this.options.workspace),
					};
				}
			} else {
				saved = {
					nodeId: resource.nodeId,
					participantId: resource.participantId,
					workspace: this.options.workspace,
					workspaceHash: await hashWorkspaceState(this.options.workspace),
				};
			}
			if (retainedSession) Object.assign(saved, retainedSession);
			progress.push(saved);
		}
		return progress;
	}

	async validateResume(state: RunState): Promise<void> {
		const progress = state.workProgress ?? [];
		for (const reference of progress) {
			if (reference.workspaceHash && (await hashWorkspaceState(reference.workspace)) !== reference.workspaceHash)
				throw new NodeWorkerError("environment_lost", "Retained work changed after the checkpoint");
			this.retainSessionReference(state, reference);
			if (reference.environment) {
				if (!this.options.environmentManager)
					throw new NodeWorkerError("environment_lost", "Environment manager is unavailable");
				const environmentBinding = state.baseline?.environmentBindings.find(
					(candidate) =>
						candidate.nodeId === reference.nodeId && candidate.participantId === reference.participantId,
				);
				if (!environmentBinding)
					throw new NodeWorkerError("environment_lost", "Frozen environment binding is unavailable");
				await this.options.environmentManager.recover(state.runId, environmentBinding, reference.environment);
				const sessionBinding = this.sessions.getState(state.runId, reference.nodeId, reference.participantId);
				for (const input of sessionBinding?.environment?.round.inputs ?? [])
					if ((await hashEnvironmentSource(input.sourcePath)) !== input.contentHash)
						throw new NodeWorkerError("environment_lost", "An input changed while work was paused");
			}
		}
	}

	private retainedSessionKey(runId: string, nodeId: string, participantId: string): string {
		return `${runId}\0${nodeId}\0${participantId}`;
	}

	private retainSessionReference(
		state: RunState,
		reference: Pick<WorkProgressReference, "nodeId" | "participantId" | "sessionId" | "sessionFile" | "entryId">,
		allowAdvancedHistory = false,
	): RetainedSessionReference | undefined {
		if (!reference.sessionId) return undefined;
		if (!reference.sessionFile)
			throw new NodeWorkerError("session_lost", "Retained Session file reference is unavailable");
		const retained = {
			sessionId: reference.sessionId,
			sessionFile: reference.sessionFile,
			entryId: reference.entryId,
		};
		const session = this.sessions.inspect(state.runId, reference.nodeId, reference.participantId);
		if (session) {
			if (
				session.status !== "idle" ||
				session.sessionId !== retained.sessionId ||
				session.sessionFile !== retained.sessionFile ||
				session.entryId !== retained.entryId
			)
				throw new NodeWorkerError("session_lost", "Original Session or history boundary is unavailable");
			return { ...retained, entryId: session.entryId };
		}
		const manager = openRetainedSession(retained, this.options.workspace, this.options.sessionDirectory, {
			allowAdvancedHistory,
		});
		if (allowAdvancedHistory) retained.entryId = manager.getLeafId() ?? undefined;
		this.retainedSessions.set(
			this.retainedSessionKey(state.runId, reference.nodeId, reference.participantId),
			retained,
		);
		return retained;
	}

	private async notifyResources(work: NodeRoundWork): Promise<void> {
		if (!work.onResourcesChanged) return;
		if (!(await work.onResourcesChanged(this.inspectRun(work.runId))))
			throw new NodeWorkerError("cancelled", "Execution resources are no longer owned by the current Attempt");
	}

	requestCheckpoint(work: NodeRoundWork): Promise<void> {
		return this.sessions.requestCheckpoint(
			work.runId,
			work.node.definition.node_id,
			work.node.agents[0].participantId,
		);
	}

	private async dispatch(
		work: NodeRoundWork,
		binding: WorkerBinding,
	): Promise<{ value?: SubmitArtifact | SubmitReview; blocked?: ReportNodeBlocked }> {
		const participant = work.node.agents[0];

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
						getExternalOperationRecorder: () => binding.externalOperationRecorder,
					})
				: undefined;
			const retainedSessionKey = this.retainedSessionKey(
				work.runId,
				work.node.definition.node_id,
				participant.participantId,
			);
			await this.sessions.create({
				runId: work.runId,
				nodeId: work.node.definition.node_id,
				participantId: participant.participantId,
				createInput: {
					resourceAdmission: this.options.admission
						? { admission: this.options.admission, rootId: work.runId }
						: undefined,
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
					environmentCwd: binding.environment?.binding.paths.workspace,
					environmentPaths: binding.environment?.binding.paths,
					getEnvironmentContext: binding.environment ? () => binding.environment! : undefined,
					getProviderRequestRecorder: () => binding.providerRequestRecorder,
					restoreSession: this.retainedSessions.get(retainedSessionKey),
				},
			});
			await this.notifyResources(work);
			this.retainedSessions.delete(retainedSessionKey);
			work.signal?.throwIfAborted();
			return await this.sessions.dispatch(
				work.runId,
				work.node.definition.node_id,
				participant.participantId,
				work.roundId,
				buildNodeRoundPrompt(work),
				{
					generation: work.generation,
					prepare: async () => {
						binding.capture.beginRound();
						binding.blockedCapture?.beginRound();
						binding.currentContext = renderCurrentRoundContext(work);
						binding.additionalReadRoots = [
							...work.inputSubmissions.flatMap((submission) =>
								submission.outputs.map((output) => output.sealedRoot),
							),
							...work.taskContext.materials.flatMap((material) =>
								isAbsolute(material.reference) ? [material.reference] : [],
							),
						];
						binding.deniedReadRoots = [...work.forbiddenMutableReadPaths];
						binding.providerRequestRecorder = work.onProviderRequest;
						binding.externalOperationRecorder = work.externalOperations;
						await work.onDispatchDelivering?.();
						await work.onDispatchStarted?.();
					},
					result: () => ({ value: binding.capture.value, blocked: binding.blockedCapture?.value }),
				},
			);
		} catch (error) {
			if (error instanceof NodeWorkerError || error instanceof NodeSubmissionProtocolError) throw error;
			throw classifyWorkerError(error);
		}
	}
}
