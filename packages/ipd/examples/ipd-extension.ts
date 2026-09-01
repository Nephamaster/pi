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
	IpdToolCommandSchema,
	IpdToolController,
	IpdToolControllerError,
	type IpdToolExecutionError,
	type IpdToolResult,
} from "../src/index.ts";

export type IpdExtensionDetails = IpdToolResult | { error: IpdToolExecutionError };

export interface IpdExtensionOptions {
	runtimeFactory?: (context: ExtensionContext) => Promise<IpdRuntime>;
}

function executionSignal(toolSignal: AbortSignal | undefined, contextSignal: AbortSignal | undefined) {
	if (toolSignal && contextSignal && toolSignal !== contextSignal) return AbortSignal.any([toolSignal, contextSignal]);
	return toolSignal ?? contextSignal;
}

function resultText(result: IpdToolResult): string {
	if (result.question) {
		return `${result.summary}\n需要用户回答：${result.question.prompt}\nEscalation ID：${result.question.escalationId}`;
	}
	if (result.artifacts && result.artifacts.length > 0) {
		return `${result.summary}\n已验收 Artifact：${result.artifacts.map((artifact) => artifact.id).join("、")}`;
	}
	return result.summary;
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
			createDefaultIpdRuntime({ agentDir: getAgentDir(), modelRegistry: ctx.modelRegistry });
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

	pi.registerTool(
		defineTool({
			name: "ipd",
			label: "IPD 长程任务",
			description: "启动、恢复、查询或取消一个由 Skill 驱动并经过逐节点质量门验收的 IPD 长程任务。",
			promptSnippet: "使用 IPD 运行需要多角色执行和质量门验收的长程任务",
			promptGuidelines: [
				"start 必须提供当前 Pi 上下文中存在的 skillName。",
				"当结果为 waiting_user 时，向用户展示 question，并用相同 runId 和 escalationId 调用 resume。",
				"不要从文本推断状态；以结构化 details.status、details.question 和 details.artifacts 为准。",
			],
			parameters: IpdToolCommandSchema,
			executionMode: "parallel",
			async execute(toolCallId, command, signal, _onUpdate, ctx) {
				try {
					const result = await (
						await controller(ctx)
					).execute(toolCallId, command, {
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
