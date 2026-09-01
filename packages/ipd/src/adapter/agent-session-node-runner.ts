import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSessionFromServices,
	createAgentSessionServices,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import type { WorkflowDefinition } from "../ir/schemas.ts";
import { scopeContains } from "../ir/scopes.ts";
import type { CompiledAgentCard } from "../ir/types.ts";
import type {
	DecisionNodeRunInput,
	DecisionNodeRunResult,
	ExecutionNodeRunInput,
	ExecutionNodeRunResult,
	NodeRunFailure,
	NodeRunner,
	NodeRunTrace,
	ReviewSubmission,
	SkillSnapshot,
	StaffDecisionSubmission,
} from "./node-runner.ts";
import { buildDecisionPrompt, buildExecutionPrompt, type NodePromptPackage } from "./prompts.ts";
import {
	createSubmissionTool,
	SingleSubmission,
	type SubmissionTool,
	type SubmitArtifact,
	SubmitArtifactSchema,
	type SubmitDecision,
	SubmitDecisionSchema,
	type SubmitReview,
	SubmitReviewSchema,
	SubmitWorkflowSchema,
} from "./structured-submissions.ts";

interface ActiveSession {
	session: AgentSession;
	abortRequested: boolean;
}

interface StructuredRunResult<T> {
	submission?: T;
	failure?: NodeRunFailure;
	trace: NodeRunTrace;
}

export interface AgentSessionNodeRunnerOptions {
	modelRuntime: ModelRuntime;
	agentDir: string;
	sessionDir: string;
	now?: () => number;
	idFactory?: () => string;
	customTools?: readonly ToolDefinition[];
}

const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"]);

function failure(code: NodeRunFailure["code"], message: string): NodeRunFailure {
	return { code, message };
}

function validateSkillSnapshots(skills: readonly SkillSnapshot[]): string | undefined {
	for (const skill of skills) {
		const expected = createHash("sha256").update(skill.content).digest("hex");
		if (expected !== skill.hash) return `Skill Snapshot Hash mismatch: ${skill.name}`;
	}
	return undefined;
}

function resolveModel(
	card: CompiledAgentCard,
	runDefaultModel: Model<Api>,
	runDefaultThinkingLevel: ThinkingLevel,
	modelRuntime: ModelRuntime,
): { model: Model<Api>; thinkingLevel: ThinkingLevel } | { error: string } {
	const thinkingLevel = card.model.thinkingLevel === "inherit" ? runDefaultThinkingLevel : card.model.thinkingLevel;
	if (card.model.selection === "run_default") return { model: runDefaultModel, thinkingLevel };
	const model = modelRuntime.getModel(card.model.provider, card.model.id);
	return model
		? { model, thinkingLevel }
		: { error: `Configured AgentCard model is unavailable: ${card.model.provider}/${card.model.id}` };
}

function validateExecutionConfiguration(input: ExecutionNodeRunInput): string | undefined {
	if (
		input.node.agentCardRef.id !== input.agentCard.id ||
		input.node.agentCardRef.version !== input.agentCard.version ||
		input.node.agentCardRef.hash !== input.agentCard.hash
	) {
		return "Execution Node AgentCard does not match its frozen reference";
	}
	for (const tool of input.node.tools) {
		if (!input.agentCard.tools.includes(tool)) return `Execution Node tool is not allowed by AgentCard: ${tool}`;
	}
	if (input.node.permissions.workspace === "write" && input.agentCard.permissions.workspace !== "write") {
		return "Execution Node requests write access from a read-only AgentCard";
	}
	for (const scope of input.node.permissions.readScopes) {
		if (!input.agentCard.permissions.readScopes.some((allowed) => scopeContains(allowed, scope))) {
			return `Execution Node read scope exceeds AgentCard: ${scope}`;
		}
	}
	for (const scope of input.node.permissions.writeScopes) {
		if (!input.agentCard.permissions.writeScopes.some((allowed) => scopeContains(allowed, scope))) {
			return `Execution Node write scope exceeds AgentCard: ${scope}`;
		}
	}
	if (input.node.permissions.externalActions && !input.agentCard.permissions.externalActions) {
		return "Execution Node requests external actions that AgentCard forbids";
	}
	const providedSkills = new Set(input.skills.map((skill) => skill.name));
	for (const skill of input.node.skills) {
		if (!providedSkills.has(skill)) return `Execution Node Skill Snapshot is missing: ${skill}`;
	}
	for (const skill of input.skills) {
		if (!input.node.skills.includes(skill.name))
			return `Execution Node received an unassigned Skill Snapshot: ${skill.name}`;
	}
	return validateSkillSnapshots(input.skills);
}

function validateArtifactSubmission(input: ExecutionNodeRunInput, submission: SubmitArtifact): string | undefined {
	const roles = submission.files.map((file) => file.role);
	for (const role of input.node.output.requiredRoles) {
		if (!roles.includes(role)) return `Artifact submission is missing required ${role} content`;
	}
	const paths = submission.files.map((file) => file.path);
	if (new Set(paths).size !== paths.length) return "Artifact submission contains duplicate file paths";
	return undefined;
}

function validateReviewSubmission(
	input: Extract<DecisionNodeRunInput, { kind: "reviewer" }>,
	submission: SubmitReview,
) {
	const expected = new Set(input.gate.semanticCriteria.map((criterion) => criterion.id));
	const actual = submission.criteria.map((criterion) => criterion.criterionId);
	if (new Set(actual).size !== actual.length) return "Review submission contains duplicate Criterion results";
	if (actual.some((criterionId) => !expected.has(criterionId)))
		return "Review submission contains an unknown Criterion";
	if (Array.from(expected).some((criterionId) => !actual.includes(criterionId))) {
		return "Review submission does not cover every semantic Criterion";
	}
	if (submission.decision === "PASS" && submission.criteria.some((criterion) => criterion.result !== "PASS")) {
		return "Review submission cannot PASS while a Criterion is not PASS";
	}
	return undefined;
}

export class AgentSessionNodeRunner implements NodeRunner {
	private readonly modelRuntime: ModelRuntime;
	private readonly agentDir: string;
	private readonly sessionDir: string;
	private readonly now: () => number;
	private readonly idFactory: () => string;
	private readonly customTools: readonly ToolDefinition[];
	private readonly active = new Map<string, ActiveSession>();

	constructor(options: AgentSessionNodeRunnerOptions) {
		this.modelRuntime = options.modelRuntime;
		this.agentDir = resolve(options.agentDir);
		this.sessionDir = resolve(options.sessionDir);
		this.now = options.now ?? Date.now;
		this.idFactory = options.idFactory ?? randomUUID;
		this.customTools = [...(options.customTools ?? [])];
	}

	async runExecutionNode(input: ExecutionNodeRunInput): Promise<ExecutionNodeRunResult> {
		const configurationError = validateExecutionConfiguration(input);
		if (configurationError) {
			return {
				ok: false,
				failure: failure("configuration_error", configurationError),
				trace: this.emptyTrace(input),
			};
		}
		const toolError = this.validateToolAvailability(input.node.tools);
		if (toolError) {
			return { ok: false, failure: failure("configuration_error", toolError), trace: this.emptyTrace(input) };
		}
		const capture = new SingleSubmission<SubmitArtifact>();
		const tool = createSubmissionTool({
			name: "submit_artifact",
			label: "Submit Artifact",
			description:
				"Submit the candidate Artifact files. Call exactly once after completing and self-checking the node.",
			parameters: SubmitArtifactSchema,
			capture,
		});
		const executed = await this.runStructured(input, buildExecutionPrompt(input), "submit_artifact", tool, capture);
		if (!executed.submission) {
			return {
				ok: false,
				failure: executed.failure ?? failure("missing_submission", "Execution Node submitted no Artifact"),
				trace: executed.trace,
			};
		}
		const submissionError = validateArtifactSubmission(input, executed.submission);
		if (submissionError) {
			return { ok: false, failure: failure("invalid_submission", submissionError), trace: executed.trace };
		}
		return {
			ok: true,
			submission: {
				id: this.idFactory(),
				runId: input.runId,
				nodeId: input.node.id,
				attemptId: input.attemptId,
				contractId: input.node.output.id,
				createdAt: this.now(),
				inputs: input.inputArtifacts.map((artifact) => artifact.id),
				files: executed.submission.files,
				metadata: {
					summary: executed.submission.summary,
					value: executed.submission.metadata,
				},
			},
			trace: executed.trace,
		};
	}

	async runDecisionNode(input: DecisionNodeRunInput): Promise<DecisionNodeRunResult> {
		const skillError = validateSkillSnapshots(input.skills);
		if (skillError) {
			return {
				ok: false,
				kind: input.kind,
				failure: failure("configuration_error", skillError),
				trace: this.emptyTrace(input),
			};
		}
		const toolError = this.validateToolAvailability(input.agentCard.tools);
		if (toolError) {
			return {
				ok: false,
				kind: input.kind,
				failure: failure("configuration_error", toolError),
				trace: this.emptyTrace(input),
			};
		}
		const prompt = buildDecisionPrompt(input);
		if (input.kind === "workflow_planner") {
			const capture = new SingleSubmission<WorkflowDefinition>();
			const tool = createSubmissionTool({
				name: "submit_workflow",
				label: "Submit Workflow",
				description: "Submit the complete candidate WorkflowDefinition exactly once.",
				parameters: SubmitWorkflowSchema,
				capture,
			});
			const executed = await this.runStructured(input, prompt, "submit_workflow", tool, capture);
			return executed.submission
				? { ok: true, kind: input.kind, submission: executed.submission, trace: executed.trace }
				: {
						ok: false,
						kind: input.kind,
						failure: executed.failure ?? failure("missing_submission", "Planner submitted no Workflow"),
						trace: executed.trace,
					};
		}
		if (input.kind === "reviewer") {
			const capture = new SingleSubmission<SubmitReview>();
			const tool = createSubmissionTool({
				name: "submit_review",
				label: "Submit Review",
				description: "Submit evidence-backed results for every assigned semantic Criterion exactly once.",
				parameters: SubmitReviewSchema,
				capture,
			});
			const executed = await this.runStructured(input, prompt, "submit_review", tool, capture);
			if (!executed.submission) {
				return {
					ok: false,
					kind: input.kind,
					failure: executed.failure ?? failure("missing_submission", "Reviewer submitted no Review"),
					trace: executed.trace,
				};
			}
			const submissionError = validateReviewSubmission(input, executed.submission);
			return submissionError
				? {
						ok: false,
						kind: input.kind,
						failure: failure("invalid_submission", submissionError),
						trace: executed.trace,
					}
				: {
						ok: true,
						kind: input.kind,
						submission: executed.submission as ReviewSubmission,
						trace: executed.trace,
					};
		}

		const capture = new SingleSubmission<SubmitDecision>();
		const tool = createSubmissionTool({
			name: "submit_decision",
			label: "Submit Decision",
			description: "Submit one allowed Staff Core action with rationale and evidence exactly once.",
			parameters: SubmitDecisionSchema,
			capture,
		});
		const executed = await this.runStructured(input, prompt, "submit_decision", tool, capture);
		if (!executed.submission) {
			return {
				ok: false,
				kind: input.kind,
				failure: executed.failure ?? failure("missing_submission", "Staff Core submitted no Decision"),
				trace: executed.trace,
			};
		}
		if (!input.allowedActions.includes(executed.submission.action)) {
			return {
				ok: false,
				kind: input.kind,
				failure: failure("invalid_submission", `Staff action is not allowed: ${executed.submission.action}`),
				trace: executed.trace,
			};
		}
		return {
			ok: true,
			kind: input.kind,
			submission: executed.submission as StaffDecisionSubmission,
			trace: executed.trace,
		};
	}

	async abort(instanceId: string): Promise<void> {
		const active = this.active.get(instanceId);
		if (!active) return;
		active.abortRequested = true;
		await active.session.abort();
		await active.session.waitForIdle();
	}

	private async runStructured<TParameters extends TSchema>(
		input: ExecutionNodeRunInput | DecisionNodeRunInput,
		prompt: NodePromptPackage,
		submissionToolName: string,
		submissionTool: SubmissionTool<TParameters>,
		capture: SingleSubmission<Static<TParameters>>,
	): Promise<StructuredRunResult<Static<TParameters>>> {
		const startedAt = this.now();
		const modelSelection = resolveModel(
			input.agentCard,
			input.runDefaultModel,
			input.runDefaultThinkingLevel,
			this.modelRuntime,
		);
		if ("error" in modelSelection) {
			return {
				failure: failure("configuration_error", modelSelection.error),
				trace: this.emptyTrace(input, startedAt),
			};
		}
		const selectedModel =
			input.tokenBudget !== undefined && input.tokenBudget > 0
				? { ...modelSelection.model, maxTokens: Math.min(modelSelection.model.maxTokens, input.tokenBudget) }
				: modelSelection.model;
		if (this.active.has(input.instanceId)) {
			return {
				failure: failure("configuration_error", `Node Instance is already active: ${input.instanceId}`),
				trace: this.emptyTrace(input, startedAt),
			};
		}

		let session: AgentSession | undefined;
		let timedOut = false;
		let externallyAborted = input.signal?.aborted ?? false;
		let caughtError: unknown;
		try {
			const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
			const services = await createAgentSessionServices({
				cwd: input.cwd,
				agentDir: this.agentDir,
				settingsManager,
				modelRuntime: this.modelRuntime,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					systemPrompt: prompt.systemPrompt,
				},
			});
			const serviceError = services.diagnostics.find((diagnostic) => diagnostic.type === "error");
			if (serviceError) {
				return {
					failure: failure("configuration_error", serviceError.message),
					trace: this.emptyTrace(input, startedAt),
				};
			}
			const sessionManager = SessionManager.create(input.cwd, this.sessionDir);
			const effectiveTools = input.agentCard.tools.filter((tool) => tool !== submissionToolName);
			if (input.kind === "execution") {
				const nodeTools = new Set(input.node.tools);
				effectiveTools.splice(0, effectiveTools.length, ...effectiveTools.filter((tool) => nodeTools.has(tool)));
			}
			const effectiveCustomTools = this.customTools.filter((tool) => effectiveTools.includes(tool.name));
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				model: selectedModel,
				thinkingLevel: modelSelection.thinkingLevel,
				tools: [...effectiveTools, submissionToolName],
				customTools: [...effectiveCustomTools, submissionTool],
			});
			session = created.session;
			const active: ActiveSession = { session, abortRequested: false };
			this.active.set(input.instanceId, active);
			const onAbort = () => {
				externallyAborted = true;
				active.abortRequested = true;
				void session?.abort();
			};
			input.signal?.addEventListener("abort", onAbort, { once: true });
			const timeoutMs = input.timeoutMs ?? input.agentCard.defaultBudget.timeoutMs;
			const timeout = setTimeout(() => {
				timedOut = true;
				active.abortRequested = true;
				void session?.abort();
			}, timeoutMs);
			try {
				if (externallyAborted) await session.abort();
				else await session.prompt(prompt.userPrompt, { images: prompt.images });
			} catch (error) {
				caughtError = error;
			} finally {
				clearTimeout(timeout);
				input.signal?.removeEventListener("abort", onAbort);
				this.active.delete(input.instanceId);
			}

			const trace = this.createTrace(input, session, selectedModel, startedAt);
			if (timedOut) return { failure: failure("timeout", `Node exceeded ${timeoutMs} ms`), trace };
			if (externallyAborted || active.abortRequested)
				return { failure: failure("aborted", "Node was aborted"), trace };
			if (caughtError) {
				const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
				const code = /auth|api key|login/i.test(message) ? "auth_error" : "provider_error";
				return { failure: failure(code, message), trace };
			}
			if (session.state.errorMessage) {
				return { failure: failure("provider_error", session.state.errorMessage), trace };
			}
			if (!capture.valid) {
				const code = capture.attempts === 0 ? "missing_submission" : "invalid_submission";
				return {
					failure: failure(code, `Expected exactly one ${submissionToolName} call, received ${capture.attempts}`),
					trace,
				};
			}
			return { submission: capture.value, trace };
		} catch (error) {
			const trace = session
				? this.createTrace(input, session, selectedModel, startedAt)
				: this.emptyTrace(input, startedAt);
			const message = error instanceof Error ? error.message : String(error);
			const code = /auth|api key|login/i.test(message) ? "auth_error" : "configuration_error";
			return { failure: failure(code, message), trace };
		} finally {
			this.active.delete(input.instanceId);
			session?.dispose();
		}
	}

	private validateToolAvailability(toolNames: readonly string[]): string | undefined {
		const customToolNames = new Set(this.customTools.map((tool) => tool.name));
		for (const toolName of toolNames) {
			if (!BUILTIN_TOOL_NAMES.has(toolName) && !customToolNames.has(toolName)) {
				return `Tool is configured but no runtime ToolDefinition is available: ${toolName}`;
			}
		}
		return undefined;
	}

	private emptyTrace(
		input: ExecutionNodeRunInput | DecisionNodeRunInput,
		startedAt: number = this.now(),
	): NodeRunTrace {
		const endedAt = this.now();
		return {
			runId: input.runId,
			instanceId: input.instanceId,
			provider: input.runDefaultModel.provider,
			model: input.runDefaultModel.id,
			startedAt,
			endedAt,
			durationMs: Math.max(0, endedAt - startedAt),
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 0,
				costUsd: 0,
				toolCalls: 0,
			},
		};
	}

	private createTrace(
		input: ExecutionNodeRunInput | DecisionNodeRunInput,
		session: AgentSession,
		model: Model<Api>,
		startedAt: number,
	): NodeRunTrace {
		const endedAt = this.now();
		const stats = session.getSessionStats();
		return {
			runId: input.runId,
			instanceId: input.instanceId,
			sessionId: stats.sessionId,
			sessionFile: stats.sessionFile,
			provider: model.provider,
			model: model.id,
			startedAt,
			endedAt,
			durationMs: Math.max(0, endedAt - startedAt),
			usage: {
				inputTokens: stats.tokens.input,
				outputTokens: stats.tokens.output,
				cacheReadTokens: stats.tokens.cacheRead,
				cacheWriteTokens: stats.tokens.cacheWrite,
				totalTokens: stats.tokens.total,
				costUsd: stats.cost,
				toolCalls: stats.toolCalls,
			},
		};
	}
}
