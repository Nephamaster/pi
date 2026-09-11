// 定义 Compiler 报告、有效参与者和冻结执行基线。
import type { CompiledAgentCard } from "./agent-card.ts";
import type { LockedAssetRef } from "./primitives.ts";
import type { CriterionDefinition, WorkflowDefinition, WorkflowNode } from "./workflow.ts";

export interface CompilerDiagnostic {
	code: string;
	severity: "error" | "warning";
	path: string;
	message: string;
	nodeId?: string;
	processRequirementId?: string;
}

export interface CompilerReport {
	runId: string;
	rulesVersion: string;
	complete: boolean;
	workflowHash?: string;
	taskInputHash?: string;
	processSelectionHash?: string;
	processSpecHash?: string;
	diagnostics: CompilerDiagnostic[];
}

export interface EffectiveParticipant {
	participantId: string;
	agentCard: CompiledAgentCard;
	lockedSkills: LockedSkill[];
	lockedTools: LockedTool[];
	lockedKnowledgeBases: LockedAssetRef[];
}

export interface LockedSkill {
	id: string;
	hash: string;
	source: string;
	filePath: string;
	baseDir: string;
	description: string;
	allowedTools: string[];
	requiredTools?: string[];
	requiredCommands?: string[];
}

export interface LockedTool {
	id: string;
	hash: string;
	source: string;
}

export interface EffectiveNode {
	definition: WorkflowNode;
	criteria: CriterionDefinition[];
	agents: EffectiveParticipant[];
}

export interface ExecutionGraphIndex {
	forward: Record<string, string[]>;
	reverse: Record<string, string[]>;
	reviewsByOutput: Record<string, string[]>;
	reworkTargetsByReview: Record<string, string[]>;
}

export interface ExecutionBaseline {
	baselineId: string;
	runId: string;
	workflow: WorkflowDefinition;
	workflowHash: string;
	processSpecRef: LockedAssetRef;
	nodes: EffectiveNode[];
	graph: ExecutionGraphIndex;
	report: CompilerReport;
}
