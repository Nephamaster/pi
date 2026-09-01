import { readFile } from "node:fs/promises";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createSkillSnapshot, type SkillSnapshot } from "../adapter/node-runner.ts";
import { hashJson, toJsonValue } from "../ir/hash.ts";
import type { IpdRuntime, IpdRuntimeExecutionContext } from "../runtime/ipd-runtime.ts";
import type { IpdToolCommand } from "./ipd-command.ts";
import type { IpdToolResult } from "./ipd-result.ts";

export interface IpdAvailableSkill {
	name: string;
	filePath: string;
	baseDir: string;
}

export interface IpdToolControllerContext {
	cwd: string;
	projectTrusted: boolean;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	skills: readonly IpdAvailableSkill[];
	signal?: AbortSignal;
}

export class IpdToolControllerError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "IpdToolControllerError";
		this.code = code;
	}
}

interface CachedExecution {
	requestHash: string;
	result: Promise<IpdToolResult>;
}

export class IpdToolController {
	private readonly runtime: IpdRuntime;
	private readonly executions = new Map<string, CachedExecution>();

	constructor(runtime: IpdRuntime) {
		this.runtime = runtime;
	}

	execute(toolCallId: string, command: IpdToolCommand, context: IpdToolControllerContext): Promise<IpdToolResult> {
		const requestHash = hashJson({ command: toJsonValue(command), cwd: context.cwd });
		const existing = this.executions.get(toolCallId);
		if (existing) {
			if (existing.requestHash !== requestHash) {
				throw new IpdToolControllerError(
					"idempotency_conflict",
					`IPD Tool call ID was reused with different input: ${toolCallId}`,
				);
			}
			return existing.result;
		}
		const result = this.executeUncached(command, context);
		this.executions.set(toolCallId, { requestHash, result });
		return result;
	}

	private async executeUncached(command: IpdToolCommand, context: IpdToolControllerContext): Promise<IpdToolResult> {
		if (command.action === "status") return this.runtime.status(command.runId, command.detail);
		if (command.action === "cancel") return this.runtime.cancel(command.runId, command.reason);
		const executionContext = await this.executionContext(context);
		if (command.action === "resume") {
			return this.runtime.resume(command.runId, command.escalationId, command.answer, executionContext);
		}
		const skill = executionContext.availableSkills.find((candidate) => candidate.name === command.skillName);
		if (!skill) {
			throw new IpdToolControllerError("unknown_skill", `当前 Pi 上下文中不存在 Skill：${command.skillName}`);
		}
		return this.runtime.start({
			task: command.task,
			skill,
			workflowTemplateId: command.workflowTemplateId,
			tokenBudget: command.tokenBudget,
			expectedDurationMs: command.expectedDurationMs,
			hardTokenLimit: command.hardTokenLimit,
			context: executionContext,
		});
	}

	private async executionContext(context: IpdToolControllerContext): Promise<IpdRuntimeExecutionContext> {
		if (!context.model) throw new IpdToolControllerError("model_unavailable", "当前 Pi 会话没有可用模型");
		const availableSkills = await Promise.all(context.skills.map((skill) => this.snapshotSkill(skill)));
		return {
			cwd: context.cwd,
			projectTrusted: context.projectTrusted,
			availableSkills,
			runDefaultModel: context.model,
			runDefaultThinkingLevel: context.thinkingLevel ?? "off",
			signal: context.signal,
		};
	}

	private async snapshotSkill(skill: IpdAvailableSkill): Promise<SkillSnapshot> {
		let content: string;
		try {
			content = await readFile(skill.filePath, "utf8");
		} catch (error) {
			throw new IpdToolControllerError("skill_read_failed", error instanceof Error ? error.message : String(error));
		}
		return createSkillSnapshot({
			name: skill.name,
			path: skill.filePath,
			baseDir: skill.baseDir,
			content,
		});
	}
}
