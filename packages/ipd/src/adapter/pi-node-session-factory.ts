// 根据冻结参与者配置创建受限的 Pi AgentSession。
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import type { EffectiveParticipant } from "../contracts/baseline.ts";
import type { NodePermissionsSchema } from "../contracts/workflow.ts";
import type { EnvironmentPaths } from "../environment/contracts.ts";
import { hashSkillPackage } from "../registry/skill-package.ts";
import { createCurrentRoundContextExtension, type VirtualContextFile } from "./node-context.ts";
import { createNodeFileScopeExtension } from "./node-file-scope.ts";
import { createNodeSandboxedBashTool } from "./node-sandbox.ts";
import type { NodeSessionFactory, NodeSessionHandle } from "./node-session-adapter.ts";

export interface PiNodeSessionCreateInput {
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
}

export interface PiNodeSessionFactoryOptions {
	agentDir: string;
	modelRuntime: ModelRuntime;
	customTools?: readonly ToolDefinition[];
}

export class PiNodeSessionFactory implements NodeSessionFactory<PiNodeSessionCreateInput> {
	private readonly agentDir: string;
	private readonly modelRuntime: ModelRuntime;
	private readonly customTools: readonly ToolDefinition[];

	constructor(options: PiNodeSessionFactoryOptions) {
		this.agentDir = options.agentDir;
		this.modelRuntime = options.modelRuntime;
		this.customTools = options.customTools ?? [];
	}

	async create(input: PiNodeSessionCreateInput): Promise<NodeSessionHandle> {
		const verifyLockedSkills = async (): Promise<void> => {
			if (input.environmentCwd) return;
			for (const skill of input.participant.lockedSkills) {
				if ((await hashSkillPackage(skill.baseDir)) !== skill.hash)
					throw new Error(`Locked Skill content changed: ${skill.id}`);
			}
		};
		await verifyLockedSkills();
		const cardModel = input.participant.agentCard.model;
		let model: Model<Api> | undefined;
		if (cardModel.selection === "run_default") model = input.runDefaultModel;
		else {
			model = this.modelRuntime.getModel(cardModel.provider, cardModel.id);
			if (!model) throw new Error(`Configured model is unavailable: ${cardModel.provider}/${cardModel.id}`);
		}
		const thinkingLevel =
			cardModel.thinkingLevel === "inherit" ? input.runDefaultThinkingLevel : cardModel.thinkingLevel;
		const permissions = input.permissions ?? {
			read_paths: input.participant.agentCard.permissions.readScopes,
			write_paths:
				input.participant.agentCard.permissions.workspace === "write"
					? input.participant.agentCard.permissions.writeScopes
					: [],
			external_actions: input.participant.agentCard.permissions.externalActions,
		};
		const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
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
					...(input.environmentTools
						? []
						: [
								{
									name: "ipd-node-file-scope",
									hidden: true,
									factory: createNodeFileScopeExtension({
										workspace: input.workspace,
										permissions,
										additionalReadRoots: () => [
											...input.participant.lockedSkills.map((skill) => skill.baseDir),
											...(input.getAdditionalReadRoots?.() ?? []),
										],
										deniedReadRoots: input.getDeniedReadRoots,
										allowReadOwnWritePaths: input.allowReadOwnWritePaths,
										beforeRead: verifyLockedSkills,
									}),
								},
							]),
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
		if (serviceError) throw new Error(serviceError.message);
		const allowedTools = [
			...input.participant.lockedTools.map((tool) => tool.id),
			...(input.controlTools ?? []).map((tool) => tool.name),
		];
		const allowedToolNames = new Set(allowedTools);
		const customTools = [...this.customTools, ...(input.controlTools ?? [])].filter((tool) =>
			allowedToolNames.has(tool.name),
		);
		for (const tool of input.environmentTools ?? []) {
			if (!allowedToolNames.has(tool.name)) continue;
			const existing = customTools.findIndex((candidate) => candidate.name === tool.name);
			if (existing >= 0) customTools.splice(existing, 1);
			customTools.push(tool);
		}
		if (!input.environmentTools && allowedToolNames.has("bash")) {
			const nonBashTools = customTools.filter((tool) => tool.name !== "bash");
			customTools.length = 0;
			customTools.push(
				...nonBashTools,
				createNodeSandboxedBashTool({
					workspace: input.workspace,
					sessionDirectory: input.sessionDirectory,
					nodeId: input.nodeId,
					participantId: input.participant.participantId,
					permissions,
					additionalReadRoots: () => [
						...input.participant.lockedSkills.map((skill) => skill.baseDir),
						...(input.getAdditionalReadRoots?.() ?? []),
					],
					deniedReadRoots: input.getDeniedReadRoots,
					allowReadOwnWritePaths: input.allowReadOwnWritePaths,
					requiredCommands: [
						...new Set(input.participant.lockedSkills.flatMap((skill) => skill.requiredCommands ?? [])),
					],
					beforeExec: verifyLockedSkills,
				}),
			);
		}
		const created = await createAgentSessionFromServices({
			services: input.environmentCwd ? { ...services, cwd: input.environmentCwd } : services,
			sessionManager: SessionManager.create(input.workspace, input.sessionDirectory),
			model,
			thinkingLevel,
			tools: allowedTools,
			customTools,
		});
		const session = created.session;
		return {
			get sessionId() {
				return session.sessionId;
			},
			get isIdle() {
				return session.isIdle;
			},
			async prompt(text) {
				await verifyLockedSkills();
				await session.prompt(text);
				const lastMessage = session.messages.at(-1);
				if (lastMessage?.role === "assistant" && lastMessage.stopReason === "error")
					throw new Error(lastMessage.errorMessage ?? "Model request failed without an error message");
			},
			abort: () => session.abort(),
			dispose: () => session.dispose(),
			subscribe: (listener) => session.subscribe(listener),
		};
	}
}
