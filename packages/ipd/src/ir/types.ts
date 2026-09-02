import type { TSchema } from "typebox";
import type { AgentCardRef, CompiledAgentCard, JsonValue, SkillRef, WorkflowDefinition } from "./schemas.ts";

export type IpdDiagnosticCode =
	| "schema_invalid"
	| "asset_read_failed"
	| "asset_parse_failed"
	| "asset_collision"
	| "invalid_scope"
	| "explicit_model_incomplete"
	| "unknown_model"
	| "unknown_agent_card"
	| "unknown_skill"
	| "skill_mismatch"
	| "unknown_tool"
	| "unknown_check"
	| "check_parameters_invalid"
	| "duplicate_id"
	| "unknown_dependency"
	| "success_graph_cycle"
	| "unreachable_node"
	| "artifact_producer_invalid"
	| "artifact_type_mismatch"
	| "permission_exceeded"
	| "mechanical_only_node"
	| "gate_route_invalid"
	| "rework_route_invalid"
	| "reviewer_unavailable"
	| "reviewer_not_independent"
	| "staff_core_mismatch"
	| "required_capability_missing"
	| "knowledge_base_unknown"
	| "knowledge_base_permission_exceeded"
	| "employee_role_conflict"
	| "budget_invalid"
	| "final_artifact_invalid"
	| "final_coverage_incomplete"
	| "ledger_inconsistent"
	| "artifact_path_invalid"
	| "artifact_missing"
	| "artifact_role_missing"
	| "artifact_type_invalid"
	| "artifact_content_invalid"
	| "artifact_size_mismatch"
	| "artifact_hash_mismatch"
	| "review_bundle_missing"
	| "artifact_view_failed";

export interface IpdDiagnostic {
	code: IpdDiagnosticCode;
	path: string;
	message: string;
	source?: string;
}

export interface AgentCardCompileContext {
	skillNames: ReadonlySet<string>;
	toolNames: ReadonlySet<string>;
	hasModel(provider: string, modelId: string): boolean;
}

export interface CheckDefinition {
	id: string;
	parameters: TSchema;
}

export interface WorkflowCompileContext {
	agentCards: readonly CompiledAgentCard[];
	fixedStaffCore: readonly AgentCardRef[];
	runSkill: SkillRef;
	skillNames: ReadonlySet<string>;
	toolNames: ReadonlySet<string>;
	checks: readonly CheckDefinition[];
	workflowAssetIds: ReadonlySet<string>;
}

export interface CompiledWorkflow {
	definition: WorkflowDefinition;
	hash: string;
	topologicalOrder: string[];
	agentCards: ReadonlyMap<string, CompiledAgentCard>;
}

export type CompileWorkflowResult = { ok: true; value: CompiledWorkflow } | { ok: false; diagnostics: IpdDiagnostic[] };

export interface AgentCardAssetRecord {
	card: CompiledAgentCard;
	ref: AgentCardRef;
}

export interface WorkflowAssetRecord {
	workflow: WorkflowDefinition;
	hash: string;
	source: string;
}

export interface ParsedAsset<T> {
	value?: T;
	diagnostics: IpdDiagnostic[];
}

export type { AgentCardRef, CompiledAgentCard, JsonValue, SkillRef, WorkflowDefinition };
