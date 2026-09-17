// 根据冻结参与者配置创建受限的 Pi AgentSession。
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSessionFromServices,
	createAgentSessionServices,
	type InlineExtension,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import type { EffectiveParticipant } from "../contracts/baseline.ts";
import type { NodePermissionsSchema } from "../contracts/workflow.ts";
import type { EnvironmentPaths } from "../environment/contracts.ts";
import type { EnvironmentToolContext } from "../environment/tool-backend.ts";
import { hashSkillPackage } from "../registry/skill-package.ts";
import { NodeWorkerError } from "../runtime/node-worker.ts";
import { createControlReadTool } from "./control-read.ts";
import { createExternalReadResultAdapter } from "./external-read-results.ts";
import { createCurrentRoundContextExtension, type VirtualContextFile } from "./node-context.ts";
import type { NodeSessionFactory } from "./node-session-adapter.ts";
import { type IpdSessionSettings, projectIpdSessionSettings } from "./session-policy.ts";
import { createSubmissionResultExtension } from "./structured-submissions.ts";

export const BUILTIN_IO_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"write",
	"edit",
	"grep",
	"find",
	"ls",
	"bash",
	"powershell",
]);

export interface PiNodeSessionCreateInput {
	controlRole?: boolean;
	nodeId: string;
	workspace: string;
	sessionDirectory: string;
	systemPrompt: string;
	contextFiles?: readonly VirtualContextFile[];
	getCurrentContext?: () => string | undefined;
	getAdditionalReadRoots?: () => readonly string[];
	getDeniedReadRoots?: () => readonly string[];
	allowReadOwnWritePaths?: boolean;
	permissions?: Static<typeof NodePermissionsSchema>;
	participant: EffectiveParticipant;
	runDefaultModel: Model<Api>;
	runDefaultThinkingLevel: ThinkingLevel;
	controlTools?: readonly ToolDefinition[];
	environmentTools?: readonly ToolDefinition[];
	environmentCwd?: string;
	environmentPaths?: EnvironmentPaths;
	getEnvironmentContext?: () => EnvironmentToolContext;
}

export type LegacyNodeToolAdapter = (
	input: PiNodeSessionCreateInput,
	verify: () => Promise<void>,
) => {
	tools: readonly ToolDefinition[];
	extensions: InlineExtension[];
	nativeFileTools: true;
};

export interface PiNodeSessionFactoryOptions {
	legacyToolAdapter?: LegacyNodeToolAdapter;
	agentDir: string;
	modelRuntime: ModelRuntime;
	customTools?: readonly ToolDefinition[];
	/** Trusted host policy, shared by control and execution roles; never loaded from node files. */
	sessionSettings?: IpdSessionSettings;
}

export class PiNodeSessionFactory implements NodeSessionFactory<PiNodeSessionCreateInput> {
	private readonly legacyToolAdapter?: LegacyNodeToolAdapter;
	private readonly agentDir: string;
	private readonly modelRuntime: ModelRuntime;
	private readonly customTools: readonly ToolDefinition[];
	private readonly sessionSettings: IpdSessionSettings;

	constructor(options: PiNodeSessionFactoryOptions) {
		this.agentDir = options.agentDir;
		this.legacyToolAdapter = options.legacyToolAdapter;
		this.modelRuntime = options.modelRuntime;
		this.customTools = options.customTools ?? [];
		this.sessionSettings = projectIpdSessionSettings(options.sessionSettings);
	}

	async validate(input: PiNodeSessionCreateInput): Promise<void> {
		if (input.environmentCwd) return;
		for (const skill of input.participant.lockedSkills) {
			if ((await hashSkillPackage(skill.baseDir)) !== skill.hash)
				throw new NodeWorkerError("configuration", `Locked Skill content changed: ${skill.id}`);
		}
	}

	async create(input: PiNodeSessionCreateInput): Promise<AgentSession> {
		const verifyLockedSkills = () => this.validate(input);
		await verifyLockedSkills();
		const cardModel = input.participant.agentCard.model;
		let model: Model<Api> | undefined;
		if (cardModel.selection === "run_default") model = input.runDefaultModel;
		else {
			model = this.modelRuntime.getModel(cardModel.provider, cardModel.id);
			if (!model)
				throw new NodeWorkerError(
					"configuration",
					`Configured model is unavailable: ${cardModel.provider}/${cardModel.id}`,
				);
		}
		const thinkingLevel =
			cardModel.thinkingLevel === "inherit" ? input.runDefaultThinkingLevel : cardModel.thinkingLevel;
		const legacy =
			!input.environmentTools && !input.controlRole
				? this.legacyToolAdapter?.(input, verifyLockedSkills)
				: undefined;
		const backendTools =
			input.environmentTools ??
			legacy?.tools ??
			(input.controlRole
				? [
						createControlReadTool(
							input.workspace,
							input.participant.lockedSkills.map((skill) => skill.baseDir),
							verifyLockedSkills,
						),
					]
				: []);
		const allowedToolNames = new Set([
			...input.participant.lockedTools.map((tool) => tool.id),
			...(input.controlTools ?? []).map((tool) => tool.name),
		]);
		for (const tool of input.participant.lockedTools)
			for (const dependency of tool.requiredTools ?? []) {
				if (!input.participant.lockedTools.some((candidate) => candidate.id === dependency))
					throw new NodeWorkerError(
						"configuration",
						`Tool ${tool.id} requires bound companion tool ${dependency}`,
					);
			}
		for (const id of allowedToolNames) {
			if (
				input.environmentTools &&
				!BUILTIN_IO_TOOLS.has(id) &&
				!backendTools.some((tool) => tool.name === id) &&
				!input.controlTools?.some((tool) => tool.name === id) &&
				input.participant.lockedTools.find((tool) => tool.id === id)?.execution !== "control_read"
			)
				throw new NodeWorkerError(
					"configuration",
					`Tool ${id} has no environment backend or trusted external-service authorization`,
				);
			if (!BUILTIN_IO_TOOLS.has(id)) continue;
			if (legacy?.nativeFileTools && id !== "bash" && id !== "powershell") continue;
			if (!backendTools.some((tool) => tool.name === id))
				throw new NodeWorkerError(
					"configuration",
					`Tool ${id} requires an explicit execution backend; host fallback is disabled`,
				);
		}
		const settingsManager = SettingsManager.inMemory(this.sessionSettings, { projectTrusted: false });
		const services = await createAgentSessionServices({
			cwd: input.workspace,
			agentDir: this.agentDir,
			settingsManager,
			modelRuntime: this.modelRuntime,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				additionalSkillPaths: input.participant.lockedSkills.map((skill) => skill.filePath),
				skillsOverride: input.environmentCwd
					? (base) => ({
							diagnostics: base.diagnostics,
							skills: base.skills.map((skill) => {
								const locked = input.participant.lockedSkills.find((candidate) => candidate.id === skill.name);
								if (!locked) return skill;
								const baseDir = `${input.environmentPaths?.skills ?? "/ipd/skills"}/${locked.id}/${locked.hash}`;
								return { ...skill, baseDir, filePath: `${baseDir}/SKILL.md` };
							}),
						})
					: undefined,
				agentsFilesOverride: () => ({ agentsFiles: [...(input.contextFiles ?? [])] }),
				extensionFactories: [
					{
						name: "ipd-submission-result",
						hidden: true,
						factory: createSubmissionResultExtension(input.controlTools ?? []),
					},
					...(legacy?.extensions ?? []),
					...(input.getCurrentContext
						? [
								{
									name: "ipd-current-round-context",
									hidden: true,
									factory: createCurrentRoundContextExtension(input.getCurrentContext),
								},
							]
						: []),
				],
				appendSystemPrompt: [input.systemPrompt],
			},
		});
		const serviceError = services.diagnostics.find((diagnostic) => diagnostic.type === "error");
		if (serviceError) throw new NodeWorkerError("configuration", serviceError.message);
		const adaptExternal = input.getEnvironmentContext
			? createExternalReadResultAdapter(input.getEnvironmentContext)
			: undefined;
		const customTools = [...this.customTools, ...(input.controlTools ?? [])]
			.filter((tool) => allowedToolNames.has(tool.name))
			.map((tool) =>
				adaptExternal &&
				input.participant.lockedTools.some(
					(locked) => locked.id === tool.name && locked.execution === "control_read",
				)
					? adaptExternal(tool)
					: tool,
			);
		for (const tool of backendTools) {
			if (!allowedToolNames.has(tool.name)) continue;
			const existing = customTools.findIndex((candidate) => candidate.name === tool.name);
			if (existing >= 0) customTools.splice(existing, 1);
			customTools.push(tool);
		}
		const created = await createAgentSessionFromServices({
			services: input.environmentCwd ? { ...services, cwd: input.environmentCwd } : services,
			sessionManager: SessionManager.create(input.workspace, input.sessionDirectory),
			model,
			thinkingLevel,
			tools: [...allowedToolNames],
			customTools,
		});
		created.session.sessionManager.appendCustomEntry("ipd_execution_configuration", {
			contextProtocol: "system-sections-v1",
			externalResultProtocol: "receipt-and-pdf-v1",
			nodeId: input.nodeId,
			model: {
				provider: model.provider,
				id: model.id,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			},
			thinkingLevel,
			compaction: settingsManager.getCompactionSettings(model),
			retry: settingsManager.getRetrySettings(),
			httpIdleTimeoutMs: settingsManager.getHttpIdleTimeoutMs(),
		});
		return created.session;
	}
}
