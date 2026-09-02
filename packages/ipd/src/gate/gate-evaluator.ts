import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { NodeRunTrace, SkillSnapshot } from "../adapter/node-runner.ts";
import type { ArtifactContract, ArtifactManifest } from "../artifact/manifest.ts";
import type { ExecutionNodeDefinition, GateDefinition } from "../ir/schemas.ts";
import type { AgentCardRef, CompiledAgentCard, JsonValue } from "../ir/types.ts";

export interface GateArtifactInput {
	manifest: ArtifactManifest;
	contract: ArtifactContract;
}

export interface GateCriterionEvaluation {
	criterionId: string;
	result: "PASS" | "FAIL" | "INCONCLUSIVE" | "BLOCKED";
	evidence: JsonValue;
	rationale: string;
	reviewerAgentCardRef?: AgentCardRef;
	reviewerInstanceId?: string;
	reviewerResult?: JsonValue;
	reviewerTrace?: NodeRunTrace;
}

export interface GateEvaluationInput {
	runId: string;
	gateRunId: string;
	gate: GateDefinition;
	node?: ExecutionNodeDefinition;
	artifacts: GateArtifactInput[];
	final: boolean;
	task: string;
	workflowHash: string;
	cwd: string;
	skill: SkillSnapshot;
	agentCards: CompiledAgentCard[];
	staffAgentCards: CompiledAgentCard[];
	executorAgentCardRefs: AgentCardRef[];
	runDefaultModel: Model<Api>;
	runDefaultThinkingLevel: ThinkingLevel;
	reviewerTokenBudget?: number;
	reviewerTimeoutMs?: number;
	previousEvaluations?: JsonValue;
	signal?: AbortSignal;
}

export interface GateEvaluationResult {
	decision: "PASS" | "REWORK" | "FAIL" | "INCONCLUSIVE" | "BLOCKED";
	mechanical: GateCriterionEvaluation[];
	semantic: GateCriterionEvaluation[];
	feedback: string[];
	evidence: JsonValue;
	staffDecision?: {
		instanceId: string;
		agentCardRef: AgentCardRef;
		action: string;
		rationale: string;
		evidence: JsonValue;
		trace: NodeRunTrace;
	};
}

export interface GateEvaluator {
	evaluate(input: GateEvaluationInput): Promise<GateEvaluationResult>;
	abort(gateRunId: string): Promise<void>;
}
