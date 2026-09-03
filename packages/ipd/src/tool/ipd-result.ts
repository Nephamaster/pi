import type { ArtifactManifest } from "../artifact/manifest.ts";
import type { JsonValue } from "../ir/types.ts";
import type { EscalationRecord, GateRunRecord, NodeInstanceRecord, RunRecord, RunSnapshot } from "../ledger/types.ts";
import type { IpdFailure } from "../runtime/failure.ts";

export type IpdToolStatus = "running" | "waiting_user" | "succeeded" | "failed" | "cancelled";

export interface BudgetSnapshot {
	budgetMode: "bounded" | "unbounded";
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUsd: number;
	durationMs: number;
	softTokenLimit?: number;
	hardTokenLimit?: number;
	byCategory: Record<"staff" | "execution" | "review" | "rework", number>;
}

export interface IpdToolQuestion {
	escalationId: string;
	prompt: string;
	context: string;
}

export interface IpdProgress {
	phase: RunRecord["status"];
	workflowRevision?: number;
	activeNodeIds: string[];
	readyNodeIds: string[];
	waitingNodeIds: string[];
	lastEvent?: { sequence: number; type: string; timestamp: number };
	changedSinceSequence?: boolean;
	runRoot?: string;
}

export type IpdToolResultDetails =
	| { detail: "summary"; run: RunRecord; escalations: EscalationRecord[] }
	| {
			detail: "nodes";
			run: RunRecord;
			nodes: NodeInstanceRecord[];
			gates: GateRunRecord[];
			escalations: EscalationRecord[];
	  }
	| { detail: "full"; snapshot: RunSnapshot };

export interface IpdToolResult {
	runId: string;
	status: IpdToolStatus;
	summary: string;
	question?: IpdToolQuestion;
	artifacts?: ArtifactManifest[];
	failure?: IpdFailure;
	progress: IpdProgress;
	usage: BudgetSnapshot;
	details: IpdToolResultDetails;
}

export interface IpdToolExecutionError {
	code: string;
	message: string;
	diagnostics?: JsonValue;
}
