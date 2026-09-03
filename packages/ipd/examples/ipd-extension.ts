import type { Api, Model } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	createDefaultIpdRuntime,
	type IpdAvailableSkill,
	IpdRuntime,
	IpdRuntimeError,
	IpdToolCommandParametersSchema,
	IpdToolController,
	IpdToolControllerError,
	type IpdToolExecutionError,
	type IpdToolResult,
	parseIpdToolCommand,
} from "../src/index.ts";

export type IpdExtensionDetails = IpdToolResult | { error: IpdToolExecutionError };

export interface IpdExtensionOptions {
	runtimeFactory?: (context: ExtensionContext) => Promise<IpdRuntime>;
}

const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);

function executionSignal(toolSignal: AbortSignal | undefined, contextSignal: AbortSignal | undefined) {
	if (toolSignal && contextSignal && toolSignal !== contextSignal) return AbortSignal.any([toolSignal, contextSignal]);
	return toolSignal ?? contextSignal;
}

function resultText(result: IpdToolResult): string {
	const lines = [result.summary];
	if (result.failure) {
		lines.push(
			`失败：${result.failure.code} [${result.failure.category}] ${result.failure.message}（retryable=${result.failure.retryable}）`,
		);
		if (result.failure.nodeId) lines.push(`失败节点：${result.failure.nodeId}`);
		if (result.failure.attemptId) lines.push(`失败 Attempt：${result.failure.attemptId}`);
		if (result.failure.gateRunId) lines.push(`失败 Gate：${result.failure.gateRunId}`);
	}
	if (result.question) {
		lines.push(`需要用户回答：${result.question.prompt}`, `Escalation ID：${result.question.escalationId}`);
	}
	if (result.artifacts && result.artifacts.length > 0) {
		lines.push(`已验收 Artifact：${result.artifacts.map((artifact) => artifact.id).join("、")}`);
	}
	return lines.join("\n");
}

function executionError(error: unknown): IpdToolExecutionError {
	if (error instanceof IpdRuntimeError) {
		return {
			code: error.code,
			message: error.message,
			diagnostics: error.diagnostics ? JSON.parse(JSON.stringify(error.diagnostics)) : undefined,
		};
	}
	if (error instanceof IpdToolControllerError) return { code: error.code, message: error.message };
	return { code: "internal_error", message: error instanceof Error ? error.message : String(error) };
}

export function registerIpdExtension(pi: ExtensionAPI, options: IpdExtensionOptions = {}): void {
	let activeSkills: IpdAvailableSkill[] = [];
	let runtimePromise: Promise<IpdRuntime> | undefined;
	let controllerPromise: Promise<IpdToolController> | undefined;

	const runtime = (ctx: ExtensionContext): Promise<IpdRuntime> => {
		runtimePromise ??=
			options.runtimeFactory?.(ctx) ??
			createDefaultIpdRuntime({
				agentDir: getAgentDir(),
				modelRegistry: ctx.modelRegistry,
				customTools: pi
					.getToolDefinitions()
					.filter((tool) => tool.name !== "ipd" && !BUILTIN_TOOL_NAMES.has(tool.name)),
			});
		return runtimePromise;
	};
	const controller = (ctx: ExtensionContext): Promise<IpdToolController> => {
		controllerPromise ??= runtime(ctx).then((value) => new IpdToolController(value));
		return controllerPromise;
	};

	pi.on("before_agent_start", (event) => {
		activeSkills = (event.systemPromptOptions.skills ?? []).map((skill) => ({
			name: skill.name,
			filePath: skill.filePath,
			baseDir: skill.baseDir,
		}));
	});
	pi.on("session_shutdown", async () => {
		if (runtimePromise) (await runtimePromise).close();
	});
	pi.registerCommand("ipd-resume", {
		description: "由用户回答 IPD Escalation 并恢复 Run",
		handler: async (args, ctx) => {
			const [runId, escalationId, ...extra] = args.trim().split(/\s+/);
			if (!runId || !escalationId || extra.length > 0) {
				ctx.ui.notify("用法：/ipd-resume <runId> <escalationId>", "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("当前模式不支持可信用户输入界面", "error");
				return;
			}
			let current: IpdToolResult;
			try {
				current = (await runtime(ctx)).status(runId, "summary");
			} catch (error) {
				ctx.ui.notify(executionError(error).message, "error");
				return;
			}
			if (current.status !== "waiting_user" || current.question?.escalationId !== escalationId) {
				ctx.ui.notify("Run 当前没有匹配的开放用户 Escalation", "error");
				return;
			}
			const answer = await ctx.ui.input(current.question.prompt, "请输入你的回答");
			if (!answer?.trim()) {
				ctx.ui.notify("未提交回答，Run 保持 waiting_user", "info");
				return;
			}
			const confirmed = await ctx.ui.confirm(
				"确认恢复 IPD Run",
				`Run: ${runId}\nEscalation: ${escalationId}\n\n${answer.trim()}`,
			);
			if (!confirmed) {
				ctx.ui.notify("已取消，Run 保持 waiting_user", "info");
				return;
			}
			activeSkills = (ctx.getSystemPromptOptions().skills ?? []).map((skill) => ({
				name: skill.name,
				filePath: skill.filePath,
				baseDir: skill.baseDir,
			}));
			try {
				const result = await (
					await controller(ctx)
				).resumeAsUser(runId, escalationId, answer.trim(), {
					cwd: ctx.cwd,
					projectTrusted: ctx.isProjectTrusted(),
					model: ctx.model as Model<Api> | undefined,
					thinkingLevel: ctx.thinkingLevel,
					skills: activeSkills,
					signal: ctx.signal,
				});
				ctx.ui.notify(resultText(result), result.status === "failed" ? "error" : "info");
			} catch (error) {
				ctx.ui.notify(executionError(error).message, "error");
			}
		},
	});

	pi.registerTool(
		defineTool({
			name: "ipd",
			label: "IPD 长程任务",
			description: "启动、接管、查询或取消一个由 Skill 驱动并经过逐节点质量门验收的 IPD 长程任务。",
			promptSnippet: "使用 IPD 运行需要多角色执行和质量门验收的长程任务",
			promptGuidelines: [
				"start 必须提供当前 Pi 上下文中存在的 skillName。",
				"默认不设预算：用户未明确要求 Token/时间上限时使用 ifBudget=false，并且不要传 tokenBudget、timeBudgetMs 或 hardTokenLimit。只有用户明确要求预算时才使用 ifBudget=true，并同时提供 tokenBudget 和 timeBudgetMs。",
				"可用 action 只有 start、resume_run、status、watch、cancel；进程中断后的同 Run 恢复使用 resume_run。",
				"当结果为 waiting_user 时，只向用户展示 question 和命令 /ipd-resume <runId> <escalationId>。不得代替用户回答，也不得尝试通过 Tool 恢复 Escalation。",
				"不要从文本推断状态；以结构化 details.status、details.question 和 details.artifacts 为准。",
				"当 details.failure.retryable 为 false 时，不要自动创建新的 Run。",
			],
			parameters: IpdToolCommandParametersSchema,
			constrainedSampling: { type: "json_schema", strict: "prefer" },
			prepareArguments: parseIpdToolCommand,
			executionMode: "parallel",
			async execute(toolCallId, command, signal, _onUpdate, ctx) {
				try {
					const parsedCommand = parseIpdToolCommand(command);
					const result = await (
						await controller(ctx)
					).execute(toolCallId, parsedCommand, {
						cwd: ctx.cwd,
						projectTrusted: ctx.isProjectTrusted(),
						model: ctx.model as Model<Api> | undefined,
						thinkingLevel: ctx.thinkingLevel,
						skills: activeSkills,
						signal: executionSignal(signal, ctx.signal),
					});
					return {
						content: [{ type: "text", text: resultText(result) }],
						details: result satisfies IpdExtensionDetails,
					};
				} catch (error) {
					const structured = executionError(error);
					return {
						content: [{ type: "text", text: `IPD Tool 调用失败：${structured.message}` }],
						details: { error: structured } satisfies IpdExtensionDetails,
						isError: true,
					};
				}
			},
		}),
	);
}

export default function ipdExtension(pi: ExtensionAPI): void {
	registerIpdExtension(pi);
}
