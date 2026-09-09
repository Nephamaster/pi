import type { CompiledAgentCard } from "../contracts/agent-card.ts";
import type { CompilerDiagnostic, ExecutionGraphIndex, LockedSkill, LockedTool } from "../contracts/baseline.ts";
import type { LockedAssetRef } from "../contracts/primitives.ts";
import type { WorkflowDefinition } from "../contracts/workflow.ts";
import type { CheckRegistry } from "../registry/check-registry.ts";

export interface CompilerAssetCatalog {
	agentCards: readonly CompiledAgentCard[];
	skills: readonly LockedSkill[];
	tools: readonly LockedTool[];
	knowledgeBases: readonly LockedAssetRef[];
	checks: CheckRegistry;
}

export interface ValidatedWorkflow {
	workflow: WorkflowDefinition;
	diagnostics: CompilerDiagnostic[];
	agentByNode: Map<string, CompiledAgentCard>;
	graph: ExecutionGraphIndex;
}
