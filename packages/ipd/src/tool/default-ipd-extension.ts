// 装配默认资产、控制面和 Runtime 并注册 IPD 扩展。
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	ModelRuntime,
	type Skill,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { PiNodeWorker } from "../adapter/pi-node-worker.ts";
import { compileWorkflow } from "../compiler/compiler.ts";
import { IpdControlPlane } from "../control/control-plane.ts";
import { type PiControlRoleOptions, PiProcessSelector, PiWorkflowDesigner } from "../control/pi-control-roles.ts";
import { WorkflowDraftManager } from "../control/workflow-draft.ts";
import { createArtifactIntegrityCheckExecutor, MechanicalChecker } from "../gate/mechanical-checker.ts";
import { hashJson, toJsonValue } from "../ir/hash.ts";
import { AssetAssembler, toCompilerAssetCatalog } from "../registry/asset-assembler.ts";
import { CheckExecutorRegistry } from "../registry/check-executor-registry.ts";
import { FileWorkflowAssetStore } from "../registry/workflow-asset-store.ts";
import { IpdService } from "../runtime/ipd-service.ts";
import { RetryingNodeWorker } from "../runtime/node-worker.ts";
import { FileRunStore } from "../runtime/run-store.ts";
import { SubmissionStore } from "../runtime/submission-store.ts";
import { WorkflowRuntime } from "../runtime/workflow-runtime.ts";
import { registerIpdCreateRunTool } from "./ipd-extension.ts";

const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "powershell"]);

function executableTools(pi: ExtensionAPI): ToolDefinition[] {
	if (!("getToolDefinitions" in pi))
		throw new Error("Current Pi build does not expose executable Tool definitions required by IPD");
	const provider = pi as ExtensionAPI & { getToolDefinitions(): ToolDefinition[] };
	return provider.getToolDefinitions();
}

async function modelRuntime(context: ExtensionContext): Promise<ModelRuntime> {
	const agentDir = getAgentDir();
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
	for (const providerId of context.modelRegistry.getRegisteredProviderIds()) {
		const native = context.modelRegistry.getRegisteredNativeProvider(providerId);
		if (native) runtime.registerNativeProvider(native);
		const provider = context.modelRegistry.getRegisteredProviderConfig(providerId);
		if (provider) runtime.registerProvider(providerId, provider);
	}
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

export function registerDefaultIpdExtension(pi: ExtensionAPI): void {
	let activeSkills: Skill[] = [];
	let cached: { key: string; service: Promise<IpdService> } | undefined;

	pi.on("before_agent_start", (event) => {
		activeSkills = [...(event.systemPromptOptions.skills ?? [])];
	});

	registerIpdCreateRunTool(pi, async (context) => {
		const model = context.model as Model<Api> | undefined;
		if (!model) throw new Error("Current Pi session has no configured model");
		const key = `${context.cwd}\0${model.provider}\0${model.id}\0${activeSkills.map((skill) => skill.filePath).join("\0")}`;
		if (cached?.key === key) return cached.service;
		const service = createDefaultService(pi, context, model, activeSkills);
		cached = { key, service };
		return service;
	});
}

async function createDefaultService(
	pi: ExtensionAPI,
	context: ExtensionContext,
	model: Model<Api>,
	skills: readonly Skill[],
): Promise<IpdService> {
	const agentDir = getAgentDir();
	const runtimeModels = await modelRuntime(context);
	const toolDefinitions = executableTools(pi).filter((tool) => tool.name !== "ipd");
	const assembled = await new AssetAssembler().assembleDefault({
		agentDir,
		projectRoot: context.cwd,
		projectTrusted: context.isProjectTrusted(),
		skills,
		tools: toolDefinitions,
		hasModel: (provider, id) =>
			runtimeModels.getModel(provider, id) !== undefined && runtimeModels.hasConfiguredAuth(provider),
	});
	const checks = new CheckExecutorRegistry();
	const collision = checks.add(createArtifactIntegrityCheckExecutor());
	if (collision) throw new Error(collision.message);
	const assets = toCompilerAssetCatalog(assembled, checks);
	const selectorCard = assembled.agentCards.find((card) => card.id === "ipd-process-selector");
	const designerCard = assembled.agentCards.find((card) => card.id === "agency-project-management-project-shepherd");
	const selectionSkill = assembled.skills.find((skill) => skill.id === "process-selection");
	const designSkill = assembled.skills.find((skill) => skill.id === "workflow-design");
	const readTool = assembled.tools.find((tool) => tool.id === "read");
	if (!selectorCard || !designerCard || !selectionSkill || !designSkill || !readTool)
		throw new Error("Default IPD control assets are incomplete");
	const store = new FileRunStore();
	const workflowAssets = new FileWorkflowAssetStore({ directory: join(context.cwd, ".pi", "ipd", "workflow") });
	const customTools = toolDefinitions.filter((tool) => !BUILTIN_TOOLS.has(tool.name));
	const managerByRun = new Map<string, WorkflowDraftManager>();
	const roleOptions = (runId: string, card: typeof selectorCard): PiControlRoleOptions => ({
		agentDir,
		workspace: join(context.cwd, ".pi", "ipd", "runs", runId, "workspace"),
		sessionDirectory: join(context.cwd, ".pi", "ipd", "runs", runId, "sessions"),
		modelRuntime: runtimeModels,
		model,
		thinkingLevel: context.thinkingLevel ?? "off",
		agentCard: card,
		tools: [readTool],
	});
	const assetSummary = toJsonValue({
		skills: assembled.skills.map((skill) => ({
			id: skill.id,
			description: skill.description,
			associatedTools: assembled.skillTools[skill.id] ?? [],
		})),
		tools: assembled.tools.map((tool) => tool.id),
		unavailableAgentCards: assembled.unavailableAgentCards,
		mechanicalChecks: checks.list().map((check) => ({ id: check.id, parameters: check.parameters })),
	});
	const executionIdentity = toJsonValue({
		model: { provider: model.provider, id: model.id },
		thinkingLevel: context.thinkingLevel ?? "off",
	});
	return new IpdService({
		store,
		projectRoot: context.cwd,
		processSpecs: assembled.processSpecs,
		assets,
		executionIdentity,
		createControlPlane: (runId, runSkill) => {
			return new IpdControlPlane(
				store,
				new PiProcessSelector(roleOptions(runId, selectorCard), selectionSkill),
				new PiWorkflowDesigner({
					optionsForRun: () => roleOptions(runId, designerCard),
					managerForRun: (_currentRunId, task, selection, spec) => {
						const existing = managerByRun.get(runId);
						if (existing) return existing;
						const manager = new WorkflowDraftManager({
							file: join(context.cwd, ".pi", "ipd", "runs", runId, "workflow-draft.json"),
							trustedReferences: {
								task_input_ref: { id: task.task_input_id, hash: hashJson(task) },
								process_selection_ref: { id: selection.process_selection_id, hash: hashJson(selection) },
							},
							validator: (workflow) => {
								const result = compileWorkflow({
									runId,
									workflow,
									taskInput: task,
									processSelection: selection,
									processSpec: spec,
									assets,
									executionIdentity,
								});
								return result.ok
									? []
									: result.report.diagnostics.map((diagnostic) => ({
											path: diagnostic.path,
											message: diagnostic.message,
										}));
							},
						});
						managerByRun.set(runId, manager);
						return manager;
					},
					designSkill,
					runSkill,
					assetSummary,
					agentCards: assembled.agentCards,
				}),
				workflowAssets,
			);
		},
		createRuntime: (directory) =>
			new WorkflowRuntime(
				store,
				directory,
				new RetryingNodeWorker(
					new PiNodeWorker({
						agentDir,
						workspace: directory.workspace,
						sessionDirectory: directory.sessions,
						modelRuntime: runtimeModels,
						model,
						thinkingLevel: context.thinkingLevel ?? "off",
						customTools,
					}),
				),
				new SubmissionStore(),
				new MechanicalChecker(checks),
			),
	});
}

export default registerDefaultIpdExtension;
