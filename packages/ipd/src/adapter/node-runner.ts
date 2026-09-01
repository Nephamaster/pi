import { createHash } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ArtifactManifest, ArtifactSubmission } from "../artifact/manifest.ts";
import type { ReviewBundle } from "../artifact/review-bundle.ts";
import type { ExecutionNodeDefinition, GateDefinition, WorkflowDefinition } from "../ir/schemas.ts";
import type { CompiledAgentCard, JsonValue } from "../ir/types.ts";

export interface SkillSnapshot {
	name: string;
	path: string;
	baseDir: string;
	content: string;
	hash: string;
}

export function createSkillSnapshot(input: Omit<SkillSnapshot, "hash">): SkillSnapshot {
	return { ...input, hash: createHash("sha256").update(input.content).digest("hex") };
}

export interface NodeRunTrace {
	runId: string;
	instanceId: string;
	sessionId?: string;
	sessionFile?: string;
	provider: string;
	model: string;
	startedAt: number;
	endedAt: number;
	durationMs: number;
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		totalTokens: number;
		costUsd: number;
		toolCalls: number;
	};
}

export type NodeRunFailureCode =
	| "configuration_error"
	| "auth_error"
	| "provider_error"
	| "blocked"
	| "missing_submission"
	| "invalid_submission"
	| "timeout"
	| "aborted";

export interface NodeRunFailure {
	code: NodeRunFailureCode;
	message: string;
}

interface CommonRunInput {
	runId: string;
	instanceId: string;
	task: string;
	workflowHash: string;
	cwd: string;
	agentCard: CompiledAgentCard;
	skills: SkillSnapshot[];
	runDefaultModel: Model<Api>;
	runDefaultThinkingLevel: ThinkingLevel;
	tokenBudget?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface ExecutionNodeRunInput extends CommonRunInput {
	kind: "execution";
	attemptId: string;
	node: ExecutionNodeDefinition;
	inputArtifacts: ArtifactManifest[];
	reworkInstructions: string[];
}

export interface WorkflowPlannerRunInput extends CommonRunInput {
	kind: "workflow_planner";
	context: JsonValue;
}

export interface ReviewerRunInput extends CommonRunInput {
	kind: "reviewer";
	gate: GateDefinition;
	reviewBundle: ReviewBundle;
	context: JsonValue;
}

export interface StaffDecisionRunInput extends CommonRunInput {
	kind: "staff";
	allowedActions: string[];
	context: JsonValue;
}

export type DecisionNodeRunInput = WorkflowPlannerRunInput | ReviewerRunInput | StaffDecisionRunInput;

export type ReviewSubmission = {
	decision: "PASS" | "FAIL" | "INCONCLUSIVE" | "BLOCKED";
	criteria: Array<{
		criterionId: string;
		result: "PASS" | "FAIL" | "INCONCLUSIVE" | "BLOCKED";
		evidence: JsonValue;
		rationale: string;
		requiredRework: string[];
	}>;
	unresolvedRisks: string[];
};

export interface StaffDecisionSubmission {
	action: string;
	rationale: string;
	evidence: JsonValue;
}

export type ExecutionNodeRunResult =
	| { ok: true; submission: ArtifactSubmission; trace: NodeRunTrace }
	| { ok: false; failure: NodeRunFailure; trace: NodeRunTrace };

export type DecisionNodeRunResult =
	| { ok: true; kind: "workflow_planner"; submission: WorkflowDefinition; trace: NodeRunTrace }
	| { ok: true; kind: "reviewer"; submission: ReviewSubmission; trace: NodeRunTrace }
	| { ok: true; kind: "staff"; submission: StaffDecisionSubmission; trace: NodeRunTrace }
	| { ok: false; kind: DecisionNodeRunInput["kind"]; failure: NodeRunFailure; trace: NodeRunTrace };

export interface NodeRunner {
	runExecutionNode(input: ExecutionNodeRunInput): Promise<ExecutionNodeRunResult>;
	runDecisionNode(input: DecisionNodeRunInput): Promise<DecisionNodeRunResult>;
	abort(instanceId: string): Promise<void>;
}
