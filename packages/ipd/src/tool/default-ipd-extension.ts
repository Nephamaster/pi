// 装配默认资产、控制面和 Runtime 并注册 IPD 扩展。
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	ModelRuntime,
	type Skill,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { BUILTIN_IO_TOOLS, type LegacyNodeToolAdapter } from "../adapter/pi-node-session-factory.ts";
import { PiNodeWorker } from "../adapter/pi-node-worker.ts";
import { type IpdSessionSettings, loadIpdSessionSettings } from "../adapter/session-policy.ts";
import { compileWorkflow } from "../compiler/compiler.ts";
import type { CompilerDiagnostic } from "../contracts/baseline.ts";
import { IpdControlPlane } from "../control/control-plane.ts";
import { type PiControlRoleOptions, PiProcessSelector, PiWorkflowDesigner } from "../control/pi-control-roles.ts";
import { WorkflowDraftManager } from "../control/workflow-draft.ts";
import { DockerCli } from "../environment/docker-adapter.ts";
import { NetworkedDockerEnvironmentProvider } from "../environment/docker-network-provider.ts";
import { EnvironmentManager } from "../environment/manager.ts";
import { loadRegisteredDockerProfile, MissingDockerProfileError } from "../environment/profile-loader.ts";
import { createEnvironmentToolDescriptors } from "../environment/tool-backend.ts";
import {
	createArtifactFileSetCheckExecutor,
	createArtifactIntegrityCheckExecutor,
	MechanicalChecker,
} from "../gate/mechanical-checker.ts";
import { hashJson, toJsonValue } from "../ir/hash.ts";
import { AssetAssembler, toCompilerAssetCatalog } from "../registry/asset-assembler.ts";
import { CheckExecutorRegistry } from "../registry/check-executor-registry.ts";
import { hashSkillPackage, snapshotSkillPackage } from "../registry/skill-package.ts";
import { FileWorkflowAssetStore } from "../registry/workflow-asset-store.ts";
import { IpdService } from "../runtime/ipd-service.ts";
import { FileRunStore } from "../runtime/run-store.ts";
import { SubmissionStore } from "../runtime/submission-store.ts";
import { FileIpdTelemetry } from "../runtime/telemetry.ts";
import { WorkflowRuntime } from "../runtime/workflow-runtime.ts";
import { IpdDashboardServer } from "../visualization/dashboard-server.ts";
import { registerIpdCreateRunTool } from "./ipd-extension.ts";

const OUTER_IPD_TOOLS = new Set([
	"ipd",
	"ipd_get_run",
	"ipd_cancel_run",
	"ipd_pause_run",
	"ipd_resume_run",
	"ipd_read_events",
	"ipd_get_result",
]);

const DEFAULT_DOCKER_PROFILE_TEMPLATES = [
	["code-node24", "profile.template.json"],
	["code-node24", "profile.internet.template.json"],
	["office-pptx", "profile.template.json"],
	["office-pptx", "profile.internet.template.json"],
] as const;

function executableTools(pi: ExtensionAPI): ToolDefinition[] {
	if (!("getToolDefinitions" in pi))
		throw new Error("Current Pi build does not expose executable Tool definitions required by IPD");
	const provider = pi as ExtensionAPI & { getToolDefinitions(): ToolDefinition[] };
	return provider.getToolDefinitions();
}

function dashboardPort(): number {
	const raw = process.env.PI_IPD_DASHBOARD_PORT?.trim();
	if (!raw) return 0;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid PI_IPD_DASHBOARD_PORT: ${raw}`);
	return port;
}

function runtimeInteger(name: string, fallback: number, minimum: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < minimum) throw new Error(`Invalid ${name}: ${raw}`);
	return value;
}

function environmentMode(): "docker" | "legacy-srt" {
	const value = process.env.PI_IPD_ENVIRONMENT_MODE?.trim() || "docker";
	if (value !== "docker" && value !== "legacy-srt") throw new Error(`Invalid PI_IPD_ENVIRONMENT_MODE: ${value}`);
	return value;
}

function diagnosticCategory(diagnostic: CompilerDiagnostic): string {
	if (
		diagnostic.code.includes("capability") ||
		diagnostic.code.includes("staff") ||
		diagnostic.code === "process_activity_unsatisfied" ||
		diagnostic.code === "process_review_unsatisfied"
	)
		return "staffing";
	if (
		diagnostic.code.startsWith("asset_") ||
		diagnostic.code.startsWith("skill_") ||
		diagnostic.code.includes("permission") ||
		diagnostic.code.includes("knowledge_base")
	)
		return "resource";
	if (diagnostic.code.startsWith("process_")) return "process";
	if (diagnostic.code.includes("criterion") || diagnostic.code.includes("review")) return "quality";
	return "workflow";
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

export interface DefaultIpdExtensionOptions {
	environmentMode?: "docker" | "legacy-srt";
	legacyToolAdapter?: LegacyNodeToolAdapter;
}

export function registerDefaultIpdExtension(pi: ExtensionAPI, options: DefaultIpdExtensionOptions = {}): void {
	let activeSkills: Skill[] = [];
	const services = new Map<string, Promise<IpdService>>();

	pi.on("before_agent_start", (event) => {
		activeSkills = [...(event.systemPromptOptions.skills ?? [])];
	});
	pi.on("session_shutdown", async () => {
		await Promise.allSettled(
			[...services.entries()].map(async ([key, pending]) => {
				const service = await pending;
				await service.close();
				if (!service.hasManagedRuns()) services.delete(key);
			}),
		);
	});

	registerIpdCreateRunTool(pi, async (context, runId) => {
		if (runId) {
			for (const pending of services.values()) {
				const existing = await pending.catch(() => undefined);
				if (existing?.ownsRun(runId, context.cwd)) return existing;
			}
		}
		const model = context.model as Model<Api> | undefined;
		if (!model) throw new Error("Current Pi session has no configured model");
		const sessionSettings = loadIpdSessionSettings(context.cwd, getAgentDir());
		const commandContext = context as ExtensionContext & {
			getSystemPromptOptions?: () => { skills?: readonly Skill[] };
		};
		const effectiveSkills = commandContext.getSystemPromptOptions?.().skills ?? activeSkills;
		const toolDefinitions = executableTools(pi).filter((tool) => !OUTER_IPD_TOOLS.has(tool.name));
		const skillHashes = await Promise.all(
			effectiveSkills.map(async (skill) => ({ path: skill.filePath, hash: await hashSkillPackage(skill.baseDir) })),
		);
		const key = JSON.stringify({
			cwd: context.cwd,
			model: `${model.provider}/${model.id}`,
			thinkingLevel: context.thinkingLevel ?? "off",
			projectTrusted: context.isProjectTrusted(),
			sessionSettings,
			environmentMode: options.environmentMode ?? environmentMode(),
			skills: skillHashes.sort((left, right) => left.path.localeCompare(right.path)),
			tools: toolDefinitions
				.map((tool) => ({
					name: tool.name,
					hash: hashJson({
						description: tool.description,
						parameters: tool.parameters,
						promptSnippet: tool.promptSnippet,
						promptGuidelines: tool.promptGuidelines,
					}),
				}))
				.sort((left, right) => left.name.localeCompare(right.name)),
		});
		const existing = services.get(key);
		if (existing) return existing;
		const service = createDefaultService(context, model, effectiveSkills, toolDefinitions, sessionSettings, options);
		services.set(key, service);
		void service.catch(() => {
			if (services.get(key) === service) services.delete(key);
		});
		return service;
	});
}

async function createDefaultService(
	context: ExtensionContext,
	model: Model<Api>,
	skills: readonly Skill[],
	toolDefinitions: readonly ToolDefinition[],
	sessionSettings: IpdSessionSettings,
	options: DefaultIpdExtensionOptions,
): Promise<IpdService> {
	const agentDir = getAgentDir();
	const selectedEnvironmentMode = options.environmentMode ?? environmentMode();
	if (selectedEnvironmentMode === "legacy-srt" && !options.legacyToolAdapter)
		throw new Error("legacy-srt requires the explicit @earendil-works/pi-ipd/legacy entry");
	const runtimeToolDefinitions = [
		...toolDefinitions,
		...(selectedEnvironmentMode === "docker" ? createEnvironmentToolDescriptors() : []),
	];
	const runtimeModels = await modelRuntime(context);
	const assembled = await new AssetAssembler().assembleDefault({
		agentDir,
		projectRoot: context.cwd,
		projectTrusted: context.isProjectTrusted(),
		skills,
		tools: runtimeToolDefinitions,
		hasModel: (provider, id) =>
			runtimeModels.getModel(provider, id) !== undefined && runtimeModels.hasConfiguredAuth(provider),
	});
	const skillSnapshotRoot = join(context.cwd, ".pi", "ipd", "skill-snapshots");
	assembled.skills = await Promise.all(
		assembled.skills.map(async (skill) => {
			const baseDir = await snapshotSkillPackage(skill.baseDir, skillSnapshotRoot, skill.hash);
			return { ...skill, baseDir, filePath: join(baseDir, relative(skill.baseDir, skill.filePath)) };
		}),
	);
	const checks = new CheckExecutorRegistry();
	for (const executor of [createArtifactIntegrityCheckExecutor(), createArtifactFileSetCheckExecutor()]) {
		const collision = checks.add(executor);
		if (collision) throw new Error(collision.message);
	}
	let environmentProfiles: Awaited<ReturnType<typeof loadRegisteredDockerProfile>>[] = [];
	const unavailableProfiles: string[] = [];
	let environmentManager: EnvironmentManager | undefined;
	let assets = toCompilerAssetCatalog(assembled, checks);
	if (selectedEnvironmentMode === "docker") {
		const projectIdentity = hashJson(context.cwd).slice(0, 16);
		const docker = new DockerCli({
			dockerConfigDirectory: join("/tmp", "pi-ipd-docker-config", projectIdentity),
			managementTimeoutMs: runtimeInteger("PI_IPD_DOCKER_TIMEOUT_MS", 120_000, 1),
		});
		const loadedProfiles = await Promise.all(
			DEFAULT_DOCKER_PROFILE_TEMPLATES.map(async ([directory, file]) => {
				try {
					return await loadRegisteredDockerProfile(
						fileURLToPath(new URL(`../../environments/${directory}/${file}`, import.meta.url)),
						docker,
						undefined,
						true,
					);
				} catch (error) {
					if (!(error instanceof MissingDockerProfileError)) throw error;
					unavailableProfiles.push(error.message);
					return undefined;
				}
			}),
		);
		environmentProfiles = loadedProfiles.filter((profile) => profile !== undefined);
		const environmentPolicy = {
			allowedProfiles: environmentProfiles.map(({ profile }) => ({ id: profile.id, version: profile.version })),
			defaultProfile: { id: "code-node24", version: "1.0.0" },
		};
		assets = toCompilerAssetCatalog(assembled, checks, [], {
			profiles: environmentProfiles,
			policy: environmentPolicy,
		});
		environmentManager = new EnvironmentManager([
			new NetworkedDockerEnvironmentProvider({
				docker,
				storageRoot: join("/tmp", "pi-ipd-environments", projectIdentity),
			}),
		]);
	}
	const selectorCard = assembled.agentCards.find((card) => card.id === "ipd-process-selector");
	const designerCard = assembled.agentCards.find((card) => card.id === "agency-project-management-project-shepherd");
	const selectionSkill = assembled.skills.find((skill) => skill.id === "process-selection");
	const designSkill = assembled.skills.find((skill) => skill.id === "workflow-design");
	const readTool = assembled.tools.find((tool) => tool.id === "read");
	if (!selectorCard || !designerCard || !selectionSkill || !designSkill || !readTool) {
		const missingControlAssets = [
			!selectorCard ? "AgentCard:ipd-process-selector" : undefined,
			!designerCard ? "AgentCard:agency-project-management-project-shepherd" : undefined,
			!selectionSkill ? "Skill:process-selection" : undefined,
			!designSkill ? "Skill:workflow-design" : undefined,
			!readTool ? "Tool:read" : undefined,
		].filter((item): item is string => item !== undefined);
		const unavailable = assembled.unavailableAgentCards
			.map((item) => `${item.source}: ${item.reasons.join(", ")}`)
			.join("; ");
		throw new Error(
			`Default IPD control assets are incomplete: ${missingControlAssets.join(", ")}${unavailable ? `. Unavailable AgentCards: ${unavailable}` : ""}`,
		);
	}
	const telemetry = new FileIpdTelemetry(join(context.cwd, ".pi", "ipd", "telemetry.ndjson"));
	const store = new FileRunStore({
		telemetryContext: telemetry.context(),
		onMutationMetric: (metric) => telemetry.record({ source: "run_store", ...metric }),
	});
	const workflowAssets = new FileWorkflowAssetStore({ directory: join(context.cwd, ".pi", "ipd", "workflow") });
	const customTools = runtimeToolDefinitions.filter((tool) => !BUILTIN_IO_TOOLS.has(tool.name));
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
		sessionSettings,
		onSessionEvent: (event) => telemetry.recordSessionEvent(event),
	});
	const assetSummary = toJsonValue({
		unavailableProfiles,
		skills: assembled.skills.map((skill) => ({
			id: skill.id,
			description: skill.description,
			associatedTools: assembled.skillTools[skill.id] ?? [],
			requiredTools: skill.requiredTools,
			requiredCommands: skill.requiredCommands,
		})),
		tools: assembled.tools.map((tool) => tool.id),
		unavailableAgentCards: assembled.unavailableAgentCards,
		mechanicalChecks: checks.list().map((check) => ({ id: check.id, parameters: check.parameters })),
		environmentProfiles: environmentProfiles.map(({ ref, profile }) => ({
			ref,
			provider: profile.provider,
			capabilities: profile.capabilities,
			commands: profile.commands,
			network: profile.network,
		})),
	});
	const executionIdentity = toJsonValue({
		model: { provider: model.provider, id: model.id },
		thinkingLevel: context.thinkingLevel ?? "off",
		sessionSettings,
		environmentMode: selectedEnvironmentMode,
		environmentProfiles: environmentProfiles.map(({ ref }) => ref),
	});
	const dashboard = new IpdDashboardServer({
		projectRoot: context.cwd,
		processSpecs: assembled.processSpecs,
		getRun: (runId) => store.read(runId),
		getRunVersion: (runId) => store.version(runId),
		host: process.env.PI_IPD_DASHBOARD_HOST ?? "127.0.0.1",
		port: dashboardPort(),
	});
	return new IpdService({
		store,
		projectRoot: context.cwd,
		processSpecs: assembled.processSpecs,
		assets,
		workflowAssets,
		executionIdentity,
		visualizer: dashboard,
		onClose: () => telemetry.flush(),
		cleanupTimeoutMs: runtimeInteger("PI_IPD_STOP_TIMEOUT_MS", 5000, 1),
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
											code: diagnostic.code,
											path: diagnostic.path,
											message: diagnostic.message,
											nodeId: diagnostic.nodeId,
											processRequirementId: diagnostic.processRequirementId,
											category: diagnosticCategory(diagnostic),
										}));
							},
							onValidation: async (validation) => {
								await store.mutate(
									runId,
									`workflow-validation:${validation.revision}:${hashJson(validation.diagnostics)}`,
									{ revision: validation.revision, valid: validation.valid },
									(draft, event) => {
										draft.lastWorkflowValidation = structuredClone(validation);
										event.emit("workflow_draft_validated", {
											revision: validation.revision,
											valid: validation.valid,
											diagnosticCount: validation.diagnostics.length,
										});
										return true;
									},
								);
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
				new PiNodeWorker({
					legacyToolAdapter: selectedEnvironmentMode === "legacy-srt" ? options.legacyToolAdapter : undefined,
					agentDir,
					workspace: directory.workspace,
					sessionDirectory: directory.sessions,
					modelRuntime: runtimeModels,
					model,
					thinkingLevel: context.thinkingLevel ?? "off",
					customTools,
					environmentManager,
					sessionSettings,
					onSessionEvent: (event) => telemetry.recordSessionEvent(event),
				}),
				new SubmissionStore(),
				new MechanicalChecker(checks),
				{
					maxConcurrentNodes: runtimeInteger("PI_IPD_MAX_CONCURRENT_NODES", 4, 1),
					maxQualityReworkRounds: runtimeInteger("PI_IPD_MAX_QUALITY_REWORK_ROUNDS", 10, 0),
					roundTimeoutMs: runtimeInteger("PI_IPD_ROUND_TIMEOUT_MS", 30 * 60 * 1000, 1),
					stopTimeoutMs: runtimeInteger("PI_IPD_STOP_TIMEOUT_MS", 5000, 1),
					softRoundTimeoutMs: runtimeInteger("PI_IPD_SOFT_ROUND_TIMEOUT_MS", 0, 0) || undefined,
					onMetric: (metric) => telemetry.record({ source: "workflow_runtime", ...metric }),
				},
			),
	});
}

export default registerDefaultIpdExtension;
