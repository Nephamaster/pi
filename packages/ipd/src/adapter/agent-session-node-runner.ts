import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { extname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSessionFromServices,
	createAgentSessionServices,
	createReadToolDefinition,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
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
	type SubmitArtifact,
	SubmitArtifactSchema,
	type SubmitDecision,
	SubmitDecisionSchema,
	type SubmitReview,
	SubmitReviewSchema,
} from "./structured-submissions.ts";
import { createWorkflowSubmissionTools, WorkflowSubmissionBuilder } from "./workflow-submission-builder.ts";

interface ActiveSession {
	session: AgentSession;
	abortRequested: boolean;
}

interface StructuredRunResult<T> {
	submission?: T;
	failure?: NodeRunFailure;
	trace: NodeRunTrace;
}

interface SubmissionCapture<T> {
	readonly value: T | undefined;
	readonly attempts: number;
	readonly valid: boolean;
}

export interface AgentSessionNodeRunnerOptions {
	modelRuntime: ModelRuntime;
	agentDir: string;
	sessionDir: string;
	now?: () => number;
	idFactory?: () => string;
	customTools?: readonly ToolDefinition[];
	maxExecutionToolCalls?: number;
}

const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"]);
const MAX_STRUCTURED_SUBMISSION_ERRORS = 10;
const MAX_PLANNER_TOOL_CALLS = 64;
const DEFAULT_MAX_EXECUTION_TOOL_CALLS = 96;
const execFile = promisify(execFileCallback);
const UNSUPPORTED_TEXT_EXTENSIONS = new Set([".bin", ".docx", ".pptx", ".xlsx", ".zip"]);

function createSafeReadTool(cwd: string): ToolDefinition {
	const base = createReadToolDefinition(cwd);
	const safe: ReturnType<typeof createReadToolDefinition> = {
		...base,
		description: `${base.description} PDF files are converted with pdftotext. Office archives and unknown binary files must use a Skill or Artifact View instead of raw text read.`,
		async execute(toolCallId, parameters, signal, onUpdate, context) {
			const extension = extname(parameters.path).toLowerCase();
			if (extension === ".pdf") {
				const path = isAbsolute(parameters.path) ? parameters.path : resolve(cwd, parameters.path);
				try {
					const { stdout } = await execFile("pdftotext", ["-layout", path, "-"], {
						encoding: "utf8",
						maxBuffer: 2_000_000,
						signal,
					});
					const lines = stdout.split("\n");
					const start = Math.max(0, Math.floor(parameters.offset ?? 1) - 1);
					const limit = Math.max(1, Math.floor(parameters.limit ?? 2_000));
					const selected = lines.slice(start, start + limit);
					return {
						content: [{ type: "text", text: selected.join("\n") }],
						details: undefined,
					};
				} catch (error) {
					throw new Error(
						`PDF text extraction failed for ${parameters.path}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			if (UNSUPPORTED_TEXT_EXTENSIONS.has(extension)) {
				throw new Error(
					`Binary file ${parameters.path} cannot be read as text. Use the assigned Skill converter or an Artifact View derivative.`,
				);
			}
			return base.execute(toolCallId, parameters, signal, onUpdate, context);
		},
	};
	return safe as unknown as ToolDefinition;
}

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
	for (const capability of input.node.requiredCapabilities) {
		if (!input.agentCard.capabilities.includes(capability)) {
			return `Execution Node capability is not provided by AgentCard: ${capability}`;
		}
	}
	const knowledgeBases = new Map(
		input.agentCard.knowledgeBases.map((knowledgeBase) => [knowledgeBase.id, knowledgeBase]),
	);
	for (const knowledgeBaseRef of input.node.knowledgeBaseRefs) {
		const knowledgeBase = knowledgeBases.get(knowledgeBaseRef);
		if (!knowledgeBase) return `Execution Node knowledge base is not provided by AgentCard: ${knowledgeBaseRef}`;
		for (const path of knowledgeBase.paths) {
			if (!input.node.permissions.readScopes.some((scope) => scopeContains(scope, path))) {
				return `Execution Node read scope does not cover knowledge base ${knowledgeBaseRef}: ${path}`;
			}
		}
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

function validateArtifactSubmission(submission: SubmitArtifact): string | undefined {
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
	private readonly maxExecutionToolCalls: number;
	private readonly active = new Map<string, ActiveSession>();

	constructor(options: AgentSessionNodeRunnerOptions) {
		this.modelRuntime = options.modelRuntime;
		this.agentDir = resolve(options.agentDir);
		this.sessionDir = resolve(options.sessionDir);
		this.now = options.now ?? Date.now;
		this.idFactory = options.idFactory ?? randomUUID;
		this.customTools = [...(options.customTools ?? [])];
		this.maxExecutionToolCalls = options.maxExecutionToolCalls ?? DEFAULT_MAX_EXECUTION_TOOL_CALLS;
		if (!Number.isInteger(this.maxExecutionToolCalls) || this.maxExecutionToolCalls < 1) {
			throw new Error("maxExecutionToolCalls must be a positive integer");
		}
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
		const executed = await this.runStructured(
			input,
			buildExecutionPrompt(input),
			["submit_artifact"],
			[tool],
			capture,
		);
		if (!executed.submission) {
			return {
				ok: false,
				failure: executed.failure ?? failure("missing_submission", "Execution Node submitted no Artifact"),
				trace: executed.trace,
			};
		}
		const submissionError = validateArtifactSubmission(executed.submission);
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
			const capture = new WorkflowSubmissionBuilder(input.checks, input.workflowConstraints, input.initialWorkflow);
			const tools = createWorkflowSubmissionTools(capture);
			const executed = await this.runStructured(
				input,
				prompt,
				tools.map((tool) => tool.name),
				tools,
				capture,
			);
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
			const executed = await this.runStructured(input, prompt, ["submit_review"], [tool], capture);
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
		const executed = await this.runStructured(input, prompt, ["submit_decision"], [tool], capture);
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

	private async runStructured<TSubmission>(
		input: ExecutionNodeRunInput | DecisionNodeRunInput,
		prompt: NodePromptPackage,
		submissionToolNames: readonly string[],
		submissionTools: readonly ToolDefinition[],
		capture: SubmissionCapture<TSubmission>,
	): Promise<StructuredRunResult<TSubmission>> {
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
			input.budgetMode !== "unbounded" && input.tokenBudget !== undefined && input.tokenBudget > 0
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
		let guardFailure: NodeRunFailure | undefined;
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
			const sessionManager = SessionManager.create(input.cwd, input.sessionDirectory ?? this.sessionDir);
			const submissionToolNameSet = new Set(submissionToolNames);
			const effectiveTools = input.agentCard.tools.filter((tool) => !submissionToolNameSet.has(tool));
			if (input.kind === "execution") {
				const nodeTools = new Set(input.node.tools);
				effectiveTools.splice(0, effectiveTools.length, ...effectiveTools.filter((tool) => nodeTools.has(tool)));
			}
			const effectiveCustomTools = this.customTools.filter((tool) => effectiveTools.includes(tool.name));
			const internalToolOverrides = effectiveTools.includes("read") ? [createSafeReadTool(input.cwd)] : [];
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				model: selectedModel,
				thinkingLevel: modelSelection.thinkingLevel,
				tools: [...effectiveTools, ...submissionToolNames],
				customTools: [...effectiveCustomTools, ...internalToolOverrides, ...submissionTools],
			});
			session = created.session;
			const active: ActiveSession = { session, abortRequested: false };
			this.active.set(input.instanceId, active);
			let generatedTokens = 0;
			let plannerToolCalls = 0;
			let executionToolCalls = 0;
			let submissionErrorTurns = 0;
			let tokenWarning80Sent = false;
			let tokenWarning90Sent = false;
			const queueWarning = (message: string) => {
				void session?.steer(message).catch(() => undefined);
			};
			const stopForGuard = (nextFailure: NodeRunFailure) => {
				if (guardFailure) return;
				guardFailure = nextFailure;
				active.abortRequested = true;
				void session?.abort();
			};
			const unsubscribeSession = session.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					generatedTokens += event.message.usage.output;
					if (
						input.budgetMode !== "unbounded" &&
						input.tokenBudget !== undefined &&
						generatedTokens > input.tokenBudget
					) {
						stopForGuard(
							failure(
								"budget_exceeded",
								`${input.kind === "workflow_planner" ? "Planner" : "Node"} generated ${generatedTokens} tokens and exceeded its cumulative ${input.tokenBudget} token budget`,
							),
						);
					} else if (
						input.kind === "execution" &&
						input.budgetMode !== "unbounded" &&
						input.tokenBudget !== undefined
					) {
						const ratio = generatedTokens / input.tokenBudget;
						if (ratio >= 0.9 && !tokenWarning90Sent) {
							tokenWarning90Sent = true;
							queueWarning(
								"Runtime token budget is at 90%. Stop broad searches and optional validation. Finish the minimum required files and call submit_artifact now.",
							);
						} else if (ratio >= 0.8 && !tokenWarning80Sent) {
							tokenWarning80Sent = true;
							queueWarning(
								"Runtime token budget is at 80%. Stop expanding scope, preserve current work, and reserve the remaining budget for verification and submit_artifact.",
							);
						}
					}
				}
				if (input.kind === "workflow_planner" && event.type === "tool_execution_start") {
					plannerToolCalls++;
					if (plannerToolCalls > MAX_PLANNER_TOOL_CALLS) {
						stopForGuard(
							failure(
								"invalid_submission",
								`Planner exceeded the ${MAX_PLANNER_TOOL_CALLS} tool-call limit without finalizing a Workflow`,
							),
						);
					}
				}
				if (input.kind === "execution" && event.type === "tool_execution_start") {
					executionToolCalls++;
					if (executionToolCalls === Math.ceil(this.maxExecutionToolCalls * 0.8)) {
						queueWarning(
							`Runtime Tool budget is at 80% (${executionToolCalls}/${this.maxExecutionToolCalls}). Stop optional commands and prepare submit_artifact.`,
						);
					}
					if (executionToolCalls > this.maxExecutionToolCalls) {
						stopForGuard(
							failure(
								"tool_limit_exceeded",
								`Execution Node exceeded the ${this.maxExecutionToolCalls} Tool-call limit without submitting an Artifact`,
							),
						);
					}
				}
				if (event.type === "turn_end") {
					const submissionResults = event.toolResults.filter((result) =>
						submissionToolNameSet.has(result.toolName),
					);
					if (submissionResults.length === 0) return;
					if (submissionResults.some((result) => result.isError)) {
						submissionErrorTurns++;
					} else {
						submissionErrorTurns = 0;
					}
					if (submissionErrorTurns >= MAX_STRUCTURED_SUBMISSION_ERRORS) {
						stopForGuard(
							failure(
								"invalid_submission",
								`Structured submission failed in ${submissionErrorTurns} consecutive assistant turns; aborting instead of retrying indefinitely`,
							),
						);
					}
				}
			});
			const onAbort = () => {
				externallyAborted = true;
				active.abortRequested = true;
				void session?.abort();
			};
			input.signal?.addEventListener("abort", onAbort, { once: true });
			const timeoutMs =
				input.budgetMode === "unbounded" ? undefined : (input.timeoutMs ?? input.agentCard.defaultBudget.timeoutMs);
			const deadlineWarnings =
				input.kind === "execution" && timeoutMs !== undefined
					? [
							setTimeout(
								() =>
									queueWarning(
										"Runtime deadline is at 80%. Stop expanding scope and reserve the remaining time for final verification and submit_artifact.",
									),
								Math.max(1, Math.floor(timeoutMs * 0.8)),
							),
							setTimeout(
								() =>
									queueWarning(
										"Runtime deadline is at 90%. Do not run broad scans or optional checks. Submit the current reviewable Artifact now.",
									),
								Math.max(1, Math.floor(timeoutMs * 0.9)),
							),
						]
					: [];
			const timeout =
				timeoutMs === undefined
					? undefined
					: setTimeout(() => {
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
				if (timeout !== undefined) clearTimeout(timeout);
				for (const warning of deadlineWarnings) clearTimeout(warning);
				input.signal?.removeEventListener("abort", onAbort);
				unsubscribeSession();
				this.active.delete(input.instanceId);
			}

			const trace = this.createTrace(input, session, selectedModel, startedAt);
			if (timedOut) return { failure: failure("timeout", `Node exceeded ${timeoutMs ?? 0} ms`), trace };
			if (externallyAborted) return { failure: failure("aborted", "Node was aborted"), trace };
			if (guardFailure) return { failure: guardFailure, trace };
			if (active.abortRequested) return { failure: failure("aborted", "Node was aborted"), trace };
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
					failure: failure(
						code,
						`Expected a completed ${submissionToolNames.at(-1) ?? "submission"}, received ${capture.attempts} finalization attempts`,
					),
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
