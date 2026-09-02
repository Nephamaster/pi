import { join } from "node:path";
import { type ModelRegistry, ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createDefaultArtifactViewRegistry } from "../artifact/review-bundle.ts";
import { DynamicGateEvaluator } from "../gate/dynamic-gate-evaluator.ts";
import { createArtifactIntegrityCheckExecutor, MechanicalChecker } from "../gate/mechanical-checker.ts";
import type { CompiledAgentCard, IpdDiagnostic } from "../ir/types.ts";
import { SqliteIpdLedger } from "../ledger/sqlite-ledger.ts";
import { loadAgentCardAssets, loadWorkflowAssets } from "../registry/asset-loader.ts";
import { CheckExecutorRegistry } from "../registry/check-executor-registry.ts";
import { FileWorkflowAssetStore } from "../registry/workflow-asset-store.ts";
import { StaffBudgetController } from "../runtime/budget-manager.ts";
import { GraphEngine } from "../runtime/graph-engine.ts";
import {
	IpdRuntime,
	type IpdRuntimeAssetContext,
	type IpdRuntimeAssetProvider,
	IpdRuntimeError,
	type PreparedIpdRuntimeAssets,
} from "../runtime/ipd-runtime.ts";
import { WorkflowPlanner } from "../staff/workflow-planner.ts";
import { AgentSessionNodeRunner } from "./agent-session-node-runner.ts";

const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"];

export interface CreateDefaultIpdRuntimeOptions {
	agentDir: string;
	modelRegistry?: ModelRegistry;
	ledgerPath?: string;
	customTools?: readonly ToolDefinition[];
}

function diagnosticMessage(diagnostics: readonly IpdDiagnostic[]): string {
	return diagnostics.map((item) => `${item.source ?? "asset"}${item.path}: ${item.message}`).join("\n");
}

export interface FixedStaffCoreSelection {
	plannerCard: CompiledAgentCard;
	staffCoreCards: readonly CompiledAgentCard[];
}

export function selectFixedStaffCore(cards: readonly CompiledAgentCard[]): FixedStaffCoreSelection {
	const staffCorePool = [...cards]
		.filter((card) => card.capabilities.includes("staff-core"))
		.sort((left, right) => left.id.localeCompare(right.id));
	if (staffCorePool.length === 0) {
		throw new IpdRuntimeError("staff_agent_missing", "AgentCard Pool 中没有固定 staff-core 成员");
	}
	const plannerCard = staffCorePool.find((card) => card.capabilities.includes("workflow-planning"));
	if (!plannerCard) {
		throw new IpdRuntimeError("staff_agent_missing", "固定 Staff Core 中没有 workflow-planning 成员");
	}
	return {
		plannerCard,
		staffCoreCards: [plannerCard, ...staffCorePool.filter((card) => card.hash !== plannerCard.hash)],
	};
}

class FileIpdRuntimeAssetProvider implements IpdRuntimeAssetProvider {
	private readonly agentDir: string;
	private readonly modelRuntime: ModelRuntime;
	private readonly nodeRunner: AgentSessionNodeRunner;
	private readonly ledger: SqliteIpdLedger;
	private readonly checks: CheckExecutorRegistry;
	private readonly toolNames: ReadonlySet<string>;

	constructor(options: {
		agentDir: string;
		modelRuntime: ModelRuntime;
		nodeRunner: AgentSessionNodeRunner;
		ledger: SqliteIpdLedger;
		checks: CheckExecutorRegistry;
		toolNames: ReadonlySet<string>;
	}) {
		this.agentDir = options.agentDir;
		this.modelRuntime = options.modelRuntime;
		this.nodeRunner = options.nodeRunner;
		this.ledger = options.ledger;
		this.checks = options.checks;
		this.toolNames = options.toolNames;
	}

	async prepare(context: IpdRuntimeAssetContext): Promise<PreparedIpdRuntimeAssets> {
		const cardDirectories = [join(this.agentDir, "ipd", "agent-cards")];
		const workflowDirectories = [join(this.agentDir, "ipd", "workflows")];
		if (context.projectTrusted) {
			cardDirectories.push(join(context.cwd, ".pi", "ipd", "agent-cards"));
			workflowDirectories.push(join(context.cwd, ".pi", "ipd", "workflows"));
		}
		const cards = await loadAgentCardAssets(cardDirectories, {
			skillNames: new Set(context.availableSkills.map((skill) => skill.name)),
			toolNames: this.toolNames,
			hasModel: (provider, modelId) =>
				this.modelRuntime.getModel(provider, modelId) !== undefined &&
				this.modelRuntime.hasConfiguredAuth(provider),
		});
		if (!cards.ok) {
			throw new IpdRuntimeError(
				"agent_card_assets_invalid",
				diagnosticMessage(cards.diagnostics),
				cards.diagnostics,
			);
		}
		if (cards.cards.length === 0) {
			throw new IpdRuntimeError("agent_card_assets_missing", "AgentCard 目录中没有可用配置");
		}
		const { plannerCard, staffCoreCards } = selectFixedStaffCore(cards.cards);

		const workflows = await loadWorkflowAssets(workflowDirectories);
		if (!workflows.ok) {
			throw new IpdRuntimeError(
				"workflow_assets_invalid",
				diagnosticMessage(workflows.diagnostics),
				workflows.diagnostics,
			);
		}
		const generatedDirectory = context.projectTrusted
			? join(context.cwd, ".pi", "ipd", "workflows", "generated")
			: join(this.agentDir, "ipd", "workflows", "generated");
		return {
			agentCards: cards.cards,
			plannerCard,
			staffCoreCards,
			workflowAssets: workflows.assets,
			planner: new WorkflowPlanner({
				ledger: this.ledger,
				nodeRunner: this.nodeRunner,
				assetStore: new FileWorkflowAssetStore({ directory: generatedDirectory }),
				toolNames: this.toolNames,
				checks: this.checks.list(),
			}),
		};
	}
}

export async function createDefaultIpdRuntime(options: CreateDefaultIpdRuntimeOptions): Promise<IpdRuntime> {
	const modelRuntime = await ModelRuntime.create({
		authPath: join(options.agentDir, "auth.json"),
		modelsPath: join(options.agentDir, "models.json"),
		allowModelNetwork: false,
	});
	for (const providerId of options.modelRegistry?.getRegisteredProviderIds() ?? []) {
		const nativeProvider = options.modelRegistry?.getRegisteredNativeProvider(providerId);
		if (nativeProvider) modelRuntime.registerNativeProvider(nativeProvider);
		const providerConfig = options.modelRegistry?.getRegisteredProviderConfig(providerId);
		if (providerConfig) modelRuntime.registerProvider(providerId, providerConfig);
	}
	await modelRuntime.refresh({ allowNetwork: false });

	const customTools = [...(options.customTools ?? [])];
	const toolNames = new Set([...BUILTIN_TOOL_NAMES, ...customTools.map((tool) => tool.name)]);
	const ledger = new SqliteIpdLedger({
		databasePath: options.ledgerPath ?? join(options.agentDir, "ipd", "ipd.sqlite"),
	});
	const nodeRunner = new AgentSessionNodeRunner({
		modelRuntime,
		agentDir: options.agentDir,
		sessionDir: join(options.agentDir, "ipd", "sessions"),
		customTools,
	});
	const checks = new CheckExecutorRegistry();
	const checkCollision = checks.add(createArtifactIntegrityCheckExecutor());
	if (checkCollision) throw new IpdRuntimeError("check_collision", checkCollision.message, [checkCollision]);
	const gateEvaluator = new DynamicGateEvaluator({
		mechanicalChecker: new MechanicalChecker(checks),
		artifactViews: createDefaultArtifactViewRegistry(),
		nodeRunner,
	});
	const graphEngine = new GraphEngine({
		ledger,
		nodeRunner,
		gateEvaluator,
		budgetController: new StaffBudgetController({ ledger, nodeRunner }),
	});
	return new IpdRuntime({
		ledger,
		graphEngine,
		assetProvider: new FileIpdRuntimeAssetProvider({
			agentDir: options.agentDir,
			modelRuntime,
			nodeRunner,
			ledger,
			checks,
			toolNames,
		}),
	});
}
