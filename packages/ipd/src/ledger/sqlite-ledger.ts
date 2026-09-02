import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { canonicalJson, hashJson } from "../ir/hash.ts";
import type { CompiledAgentCard, JsonValue, WorkflowDefinition } from "../ir/types.ts";
import { IpdLedgerError } from "./errors.ts";
import { applyIpdMigrations } from "./migrations.ts";
import {
	assertArtifactTransition,
	assertGateTransition,
	assertNodeTransition,
	assertReviewerTransition,
	assertRunTransition,
} from "./state-machine.ts";
import type {
	AgentCardSnapshotRecord,
	AnswerEscalationInput,
	ArtifactRecord,
	ArtifactStatus,
	BudgetUsageRecord,
	ConsistencyReport,
	CreateEscalationInput,
	CreateGateRunInput,
	CreateNodeAttemptInput,
	CreateReviewerInput,
	CreateRunInput,
	CriterionResultRecord,
	DecisionRecord,
	EscalationRecord,
	FreezeWorkflowInput,
	GateRunRecord,
	GateStatus,
	IpdEventRecord,
	NodeInstanceRecord,
	NodeStatus,
	RecordArtifactInput,
	RecordBudgetSignalInput,
	RecordBudgetUsageInput,
	RecordCriterionInput,
	RecordDecisionInput,
	ReviewerInstanceRecord,
	ReviewerStatus,
	RunRecord,
	RunSnapshot,
	RunStatus,
	TransitionArtifactInput,
	TransitionGateInput,
	TransitionNodeInput,
	TransitionReviewerInput,
	TransitionRunInput,
	WorkflowVersionRecord,
} from "./types.ts";

interface RunRow {
	id: string;
	trace_id: string;
	status: RunStatus;
	task: string;
	skill_name: string;
	skill_hash: string;
	global_budget_json: string;
	workflow_id: string | null;
	workflow_version: string | null;
	workflow_hash: string | null;
	created_at: number;
	updated_at: number;
	version: number;
	failure_json: string | null;
	create_idempotency_key: string;
	create_request_hash: string;
}

interface WorkflowRow {
	run_id: string;
	workflow_id: string;
	version: string;
	hash: string;
	source: WorkflowDefinition["source"];
	definition_json: string;
	created_at: number;
}

interface AgentCardRow {
	run_id: string;
	card_id: string;
	version: string;
	hash: string;
	card_json: string;
	created_at: number;
}

interface NodeRow {
	attempt_id: string;
	run_id: string;
	node_id: string;
	attempt_number: number;
	status: NodeStatus;
	agent_card_id: string;
	agent_card_version: string;
	agent_card_hash: string;
	session_id: string | null;
	session_file: string | null;
	created_at: number;
	updated_at: number;
	error_json: string | null;
}

interface ArtifactRow {
	id: string;
	run_id: string;
	node_id: string;
	attempt_id: string;
	contract_id: string;
	status: ArtifactStatus;
	manifest_json: string;
	manifest_hash: string;
	created_at: number;
	updated_at: number;
}

interface GateRow {
	id: string;
	run_id: string;
	node_id: string | null;
	attempt_id: string | null;
	artifact_id: string | null;
	gate_id: string;
	status: GateStatus;
	created_at: number;
	updated_at: number;
	decision_json: string | null;
}

interface ReviewerRow {
	id: string;
	run_id: string;
	gate_run_id: string;
	agent_card_id: string;
	agent_card_version: string;
	agent_card_hash: string;
	status: ReviewerStatus;
	session_id: string | null;
	session_file: string | null;
	created_at: number;
	updated_at: number;
	result_json: string | null;
}

interface CriterionRow {
	id: string;
	run_id: string;
	gate_run_id: string;
	criterion_id: string;
	kind: CriterionResultRecord["kind"];
	result: CriterionResultRecord["result"];
	reviewer_instance_id: string | null;
	evidence_json: string;
	rationale: string;
	created_at: number;
}

interface DecisionRow {
	id: string;
	run_id: string;
	type: string;
	action: string;
	rationale: string;
	node_id: string | null;
	gate_run_id: string | null;
	reviewer_instance_id: string | null;
	evidence_json: string;
	created_at: number;
}

interface EscalationRow {
	id: string;
	run_id: string;
	node_id: string | null;
	status: EscalationRecord["status"];
	target: EscalationRecord["target"];
	question: string;
	context_json: string;
	answer: string | null;
	created_at: number;
	updated_at: number;
}

interface BudgetRow {
	id: string;
	run_id: string;
	category: BudgetUsageRecord["category"];
	node_id: string | null;
	attempt_id: string | null;
	reviewer_instance_id: string | null;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	total_tokens: number;
	cost_usd: number;
	duration_ms: number;
	details_json: string;
	created_at: number;
}

interface EventRow {
	run_id: string;
	sequence: number;
	event_id: string;
	trace_id: string;
	type: string;
	timestamp: number;
	payload_json: string;
	node_id: string | null;
	attempt_id: string | null;
	gate_run_id: string | null;
	reviewer_instance_id: string | null;
}

interface IdempotencyRow {
	operation: string;
	request_hash: string;
	result_json: string;
}

interface SequenceRow {
	next_sequence: number;
}

type IdTable =
	| "node_instances"
	| "artifacts"
	| "gate_runs"
	| "reviewer_instances"
	| "criterion_results"
	| "decisions"
	| "escalations"
	| "budget_usage";

const ID_COLUMNS: Readonly<Record<IdTable, "id" | "attempt_id">> = {
	node_instances: "attempt_id",
	artifacts: "id",
	gate_runs: "id",
	reviewer_instances: "id",
	criterion_results: "id",
	decisions: "id",
	escalations: "id",
	budget_usage: "id",
};

export interface SqliteIpdLedgerOptions {
	databasePath: string;
	now?: () => number;
	idFactory?: () => string;
}

function parseJson<T>(value: string): T {
	return JSON.parse(value) as T;
}

function optionalJson<T>(value: string | null): T | undefined {
	return value === null ? undefined : parseJson<T>(value);
}

function decodeRun(row: RunRow): RunRecord {
	const workflowRef =
		row.workflow_id && row.workflow_version && row.workflow_hash
			? { id: row.workflow_id, version: row.workflow_version, hash: row.workflow_hash }
			: undefined;
	return {
		id: row.id,
		traceId: row.trace_id,
		status: row.status,
		task: row.task,
		skill: { name: row.skill_name, hash: row.skill_hash },
		globalBudget: parseJson<JsonValue>(row.global_budget_json),
		workflowRef,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		version: row.version,
		failure: optionalJson<JsonValue>(row.failure_json),
	};
}

function decodeWorkflow(row: WorkflowRow): WorkflowVersionRecord {
	return {
		runId: row.run_id,
		id: row.workflow_id,
		version: row.version,
		hash: row.hash,
		source: row.source,
		definition: parseJson<WorkflowDefinition>(row.definition_json),
		createdAt: row.created_at,
	};
}

function decodeAgentCard(row: AgentCardRow): AgentCardSnapshotRecord {
	return {
		runId: row.run_id,
		ref: { id: row.card_id, version: row.version, hash: row.hash },
		card: parseJson<CompiledAgentCard>(row.card_json),
		createdAt: row.created_at,
	};
}

function decodeNode(row: NodeRow): NodeInstanceRecord {
	return {
		attemptId: row.attempt_id,
		runId: row.run_id,
		nodeId: row.node_id,
		attemptNumber: row.attempt_number,
		status: row.status,
		agentCardRef: { id: row.agent_card_id, version: row.agent_card_version, hash: row.agent_card_hash },
		sessionId: row.session_id ?? undefined,
		sessionFile: row.session_file ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		error: optionalJson<JsonValue>(row.error_json),
	};
}

function decodeArtifact(row: ArtifactRow): ArtifactRecord {
	return {
		id: row.id,
		runId: row.run_id,
		nodeId: row.node_id,
		attemptId: row.attempt_id,
		contractId: row.contract_id,
		status: row.status,
		manifest: parseJson<JsonValue>(row.manifest_json),
		manifestHash: row.manifest_hash,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function decodeGate(row: GateRow): GateRunRecord {
	return {
		id: row.id,
		runId: row.run_id,
		nodeId: row.node_id ?? undefined,
		attemptId: row.attempt_id ?? undefined,
		artifactId: row.artifact_id ?? undefined,
		gateId: row.gate_id,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		decision: optionalJson<JsonValue>(row.decision_json),
	};
}

function decodeReviewer(row: ReviewerRow): ReviewerInstanceRecord {
	return {
		id: row.id,
		runId: row.run_id,
		gateRunId: row.gate_run_id,
		agentCardRef: { id: row.agent_card_id, version: row.agent_card_version, hash: row.agent_card_hash },
		status: row.status,
		sessionId: row.session_id ?? undefined,
		sessionFile: row.session_file ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		result: optionalJson<JsonValue>(row.result_json),
	};
}

function decodeCriterion(row: CriterionRow): CriterionResultRecord {
	return {
		id: row.id,
		runId: row.run_id,
		gateRunId: row.gate_run_id,
		criterionId: row.criterion_id,
		kind: row.kind,
		result: row.result,
		reviewerInstanceId: row.reviewer_instance_id ?? undefined,
		evidence: parseJson<JsonValue>(row.evidence_json),
		rationale: row.rationale,
		createdAt: row.created_at,
	};
}

function decodeDecision(row: DecisionRow): DecisionRecord {
	return {
		id: row.id,
		runId: row.run_id,
		type: row.type,
		action: row.action,
		rationale: row.rationale,
		nodeId: row.node_id ?? undefined,
		gateRunId: row.gate_run_id ?? undefined,
		reviewerInstanceId: row.reviewer_instance_id ?? undefined,
		evidence: parseJson<JsonValue>(row.evidence_json),
		createdAt: row.created_at,
	};
}

function decodeEscalation(row: EscalationRow): EscalationRecord {
	return {
		id: row.id,
		runId: row.run_id,
		nodeId: row.node_id ?? undefined,
		status: row.status,
		target: row.target,
		question: row.question,
		context: parseJson<JsonValue>(row.context_json),
		answer: row.answer ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function decodeBudget(row: BudgetRow): BudgetUsageRecord {
	return {
		id: row.id,
		runId: row.run_id,
		category: row.category,
		nodeId: row.node_id ?? undefined,
		attemptId: row.attempt_id ?? undefined,
		reviewerInstanceId: row.reviewer_instance_id ?? undefined,
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		cacheReadTokens: row.cache_read_tokens,
		cacheWriteTokens: row.cache_write_tokens,
		totalTokens: row.total_tokens,
		costUsd: row.cost_usd,
		durationMs: row.duration_ms,
		details: parseJson<JsonValue>(row.details_json),
		createdAt: row.created_at,
	};
}

function decodeEvent(row: EventRow): IpdEventRecord {
	return {
		eventId: row.event_id,
		sequence: row.sequence,
		runId: row.run_id,
		traceId: row.trace_id,
		type: row.type,
		timestamp: row.timestamp,
		payload: parseJson<JsonValue>(row.payload_json),
		nodeId: row.node_id ?? undefined,
		attemptId: row.attempt_id ?? undefined,
		gateRunId: row.gate_run_id ?? undefined,
		reviewerInstanceId: row.reviewer_instance_id ?? undefined,
	};
}

function cardHashValue(card: CompiledAgentCard): JsonValue {
	return {
		id: card.id,
		version: card.version,
		name: card.name,
		description: card.description,
		responsibilities: card.responsibilities,
		nonResponsibilities: card.nonResponsibilities,
		capabilities: card.capabilities,
		applicableScenarios: card.applicableScenarios,
		principles: card.principles,
		deliverables: card.deliverables,
		promptProfile: card.promptProfile,
		knowledgeBases: card.knowledgeBases,
		model: card.model,
		skills: card.skills,
		tools: card.tools,
		permissions: card.permissions,
		defaultBudget: card.defaultBudget,
	};
}

export class SqliteIpdLedger implements Disposable {
	private readonly db: DatabaseSync;
	private readonly now: () => number;
	private readonly idFactory: () => string;
	private closed = false;

	constructor(options: SqliteIpdLedgerOptions) {
		if (options.databasePath !== ":memory:") mkdirSync(dirname(options.databasePath), { recursive: true });
		this.db = new DatabaseSync(options.databasePath);
		this.now = options.now ?? Date.now;
		this.idFactory = options.idFactory ?? randomUUID;
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.db.exec("PRAGMA busy_timeout = 5000");
		applyIpdMigrations(this.db);
	}

	[Symbol.dispose](): void {
		this.close();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}

	private assertOpen(): void {
		if (this.closed) throw new IpdLedgerError("closed", "IPD Ledger is closed");
	}

	private transaction<T>(callback: () => T): T {
		this.assertOpen();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = callback();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// Preserve the original transaction error.
			}
			throw error;
		}
	}

	private get<TRow extends object>(sql: string, ...params: SQLInputValue[]): TRow | undefined {
		return this.db.prepare(sql).get(...params) as TRow | undefined;
	}

	private all<TRow extends object>(sql: string, ...params: SQLInputValue[]): TRow[] {
		return this.db.prepare(sql).all(...params) as TRow[];
	}

	private requireRunRow(runId: string): RunRow {
		const row = this.get<RunRow>("SELECT * FROM ipd_runs WHERE id = ?", runId);
		if (!row) throw new IpdLedgerError("not_found", `Run not found: ${runId}`);
		return row;
	}

	private requireActiveRunRow(runId: string): RunRow {
		const row = this.requireRunRow(runId);
		if (["succeeded", "failed", "cancelled"].includes(row.status)) {
			throw new IpdLedgerError("invalid_transition", `Run is terminal: ${runId} (${row.status})`);
		}
		return row;
	}

	private assertNewId(table: IdTable, id: string, label: string): void {
		const row = this.get<{ present: number }>(`SELECT 1 AS present FROM ${table} WHERE ${ID_COLUMNS[table]} = ?`, id);
		if (row) throw new IpdLedgerError("already_exists", `${label} already exists: ${id}`);
	}

	private requireNodeRow(runId: string, attemptId: string): NodeRow {
		const row = this.get<NodeRow>(
			"SELECT * FROM node_instances WHERE run_id = ? AND attempt_id = ?",
			runId,
			attemptId,
		);
		if (!row) throw new IpdLedgerError("not_found", `Node Attempt not found: ${attemptId}`);
		return row;
	}

	private requireArtifactRow(runId: string, artifactId: string): ArtifactRow {
		const row = this.get<ArtifactRow>("SELECT * FROM artifacts WHERE run_id = ? AND id = ?", runId, artifactId);
		if (!row) throw new IpdLedgerError("not_found", `Artifact not found: ${artifactId}`);
		return row;
	}

	private requireGateRow(runId: string, gateRunId: string): GateRow {
		const row = this.get<GateRow>("SELECT * FROM gate_runs WHERE run_id = ? AND id = ?", runId, gateRunId);
		if (!row) throw new IpdLedgerError("not_found", `Gate Run not found: ${gateRunId}`);
		return row;
	}

	private requireReviewerRow(runId: string, reviewerInstanceId: string): ReviewerRow {
		const row = this.get<ReviewerRow>(
			"SELECT * FROM reviewer_instances WHERE run_id = ? AND id = ?",
			runId,
			reviewerInstanceId,
		);
		if (!row) throw new IpdLedgerError("not_found", `Reviewer Instance not found: ${reviewerInstanceId}`);
		return row;
	}

	private appendEvent(
		runId: string,
		type: string,
		payload: JsonValue,
		refs: {
			nodeId?: string;
			attemptId?: string;
			gateRunId?: string;
			reviewerInstanceId?: string;
		} = {},
	): IpdEventRecord {
		const run = this.requireRunRow(runId);
		const sequence = this.get<SequenceRow>("SELECT next_sequence FROM run_sequences WHERE run_id = ?", runId);
		if (!sequence) throw new IpdLedgerError("corrupt", `Run sequence missing: ${runId}`);
		const event: IpdEventRecord = {
			eventId: this.idFactory(),
			sequence: sequence.next_sequence,
			runId,
			traceId: run.trace_id,
			type,
			timestamp: this.now(),
			payload,
			...refs,
		};
		this.db
			.prepare(
				`INSERT INTO ipd_events (
run_id, sequence, event_id, trace_id, type, timestamp, payload_json,
node_id, attempt_id, gate_run_id, reviewer_instance_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				event.runId,
				event.sequence,
				event.eventId,
				event.traceId,
				event.type,
				event.timestamp,
				canonicalJson(event.payload),
				event.nodeId ?? null,
				event.attemptId ?? null,
				event.gateRunId ?? null,
				event.reviewerInstanceId ?? null,
			);
		this.db.prepare("UPDATE run_sequences SET next_sequence = ? WHERE run_id = ?").run(event.sequence + 1, runId);
		return event;
	}

	private idempotent<T>(runId: string, key: string, operation: string, request: unknown, execute: () => T): T {
		const requestHash = hashJson(request);
		const existing = this.get<IdempotencyRow>(
			"SELECT operation, request_hash, result_json FROM idempotency_keys WHERE run_id = ? AND key = ?",
			runId,
			key,
		);
		if (existing) {
			if (existing.operation !== operation || existing.request_hash !== requestHash) {
				throw new IpdLedgerError("idempotency_conflict", `Idempotency key reused with different input: ${key}`);
			}
			return parseJson<T>(existing.result_json);
		}
		const result = execute();
		const resultJson = canonicalJson(result);
		this.db
			.prepare(
				"INSERT INTO idempotency_keys (run_id, key, operation, request_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(runId, key, operation, requestHash, resultJson, this.now());
		return parseJson<T>(resultJson);
	}

	private assertGateCanEnter(runId: string, gateRunId: string, status: GateStatus): void {
		const criteria = this.all<CriterionRow>(
			"SELECT * FROM criterion_results WHERE run_id = ? AND gate_run_id = ?",
			runId,
			gateRunId,
		);
		const mechanical = criteria.filter((criterion) => criterion.kind === "mechanical");
		const semantic = criteria.filter((criterion) => criterion.kind === "semantic");
		if (
			status === "semantic_reviewing" &&
			(mechanical.length === 0 || mechanical.some((criterion) => criterion.result !== "PASS"))
		) {
			throw new IpdLedgerError(
				"invalid_transition",
				"Gate cannot begin semantic review until every mechanical Criterion passes",
			);
		}
		if (
			status === "mechanical_failed" &&
			(mechanical.length === 0 || mechanical.every((criterion) => criterion.result === "PASS"))
		) {
			throw new IpdLedgerError(
				"invalid_transition",
				"Gate cannot become mechanical_failed without a non-passing mechanical Criterion",
			);
		}
		if (
			status === "passed" &&
			(mechanical.length === 0 || semantic.length === 0 || criteria.some((criterion) => criterion.result !== "PASS"))
		) {
			throw new IpdLedgerError(
				"invalid_transition",
				"Gate cannot pass without passing mechanical and semantic Criterion evidence",
			);
		}
		if (status === "passed") {
			for (const criterion of semantic) {
				if (!criterion.reviewer_instance_id) {
					throw new IpdLedgerError("invalid_transition", "Passing semantic evidence requires a Reviewer Instance");
				}
				const reviewer = this.requireReviewerRow(runId, criterion.reviewer_instance_id);
				if (reviewer.status !== "completed") {
					throw new IpdLedgerError(
						"invalid_transition",
						`Gate cannot pass before Reviewer ${reviewer.id} completes`,
					);
				}
			}
		}
	}

	private assertRunCanSucceed(runId: string): void {
		const workflowRow = this.get<WorkflowRow>("SELECT * FROM workflow_versions WHERE run_id = ?", runId);
		if (!workflowRow) throw new IpdLedgerError("invalid_transition", "Run cannot succeed without a frozen Workflow");
		const workflow = parseJson<WorkflowDefinition>(workflowRow.definition_json);
		for (const nodeId of workflow.finalArtifactNodeIds) {
			const latest = this.get<NodeRow>(
				`SELECT * FROM node_instances
WHERE run_id = ? AND node_id = ? ORDER BY attempt_number DESC LIMIT 1`,
				runId,
				nodeId,
			);
			if (!latest || latest.status !== "succeeded") {
				throw new IpdLedgerError("invalid_transition", `Final Artifact Node has not succeeded: ${nodeId}`);
			}
		}
		const finalGate = this.get<GateRow>(
			"SELECT * FROM gate_runs WHERE run_id = ? AND node_id IS NULL AND status = 'passed' LIMIT 1",
			runId,
		);
		if (!finalGate) throw new IpdLedgerError("invalid_transition", "Run cannot succeed before the final Gate passes");
	}

	createRun(input: CreateRunInput): RunRecord {
		return this.transaction(() => {
			const requestHash = hashJson(input);
			const existing = this.get<RunRow>(
				"SELECT * FROM ipd_runs WHERE create_idempotency_key = ?",
				input.idempotencyKey,
			);
			if (existing) {
				if (existing.create_request_hash !== requestHash) {
					throw new IpdLedgerError(
						"idempotency_conflict",
						`Run create idempotency key reused with different input: ${input.idempotencyKey}`,
					);
				}
				return decodeRun(existing);
			}
			if (this.get<RunRow>("SELECT * FROM ipd_runs WHERE id = ?", input.runId)) {
				throw new IpdLedgerError("already_exists", `Run already exists: ${input.runId}`);
			}
			const timestamp = this.now();
			this.db
				.prepare(
					`INSERT INTO ipd_runs (
id, trace_id, status, task, skill_name, skill_hash, global_budget_json,
created_at, updated_at, version, create_idempotency_key, create_request_hash
) VALUES (?, ?, 'planning', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
				)
				.run(
					input.runId,
					input.traceId,
					input.task,
					input.skill.name,
					input.skill.hash,
					canonicalJson(input.globalBudget),
					timestamp,
					timestamp,
					input.idempotencyKey,
					requestHash,
				);
			this.db.prepare("INSERT INTO run_sequences (run_id, next_sequence) VALUES (?, 1)").run(input.runId);
			this.appendEvent(input.runId, "run_created", {
				task: input.task,
				skill: input.skill,
				status: "planning",
			});
			return decodeRun(this.requireRunRow(input.runId));
		});
	}

	getRun(runId: string): RunRecord | undefined {
		this.assertOpen();
		const row = this.get<RunRow>("SELECT * FROM ipd_runs WHERE id = ?", runId);
		return row ? decodeRun(row) : undefined;
	}

	transitionRun(input: TransitionRunInput): RunRecord {
		return this.transaction(() =>
			this.idempotent(input.runId, input.idempotencyKey, "transition_run", input, () => {
				const current = this.requireRunRow(input.runId);
				assertRunTransition(current.status, input.status);
				if (input.status === "succeeded") this.assertRunCanSucceed(input.runId);
				const timestamp = this.now();
				this.db
					.prepare(
						"UPDATE ipd_runs SET status = ?, failure_json = ?, updated_at = ?, version = version + 1 WHERE id = ?",
					)
					.run(
						input.status,
						input.failure === undefined ? null : canonicalJson(input.failure),
						timestamp,
						input.runId,
					);
				this.appendEvent(input.runId, "run_status_changed", {
					from: current.status,
					to: input.status,
					failure: input.failure ?? null,
				});
				return decodeRun(this.requireRunRow(input.runId));
			}),
		);
	}

	freezeWorkflow(input: FreezeWorkflowInput): WorkflowVersionRecord {
		return this.transaction(() =>
			this.idempotent(
				input.runId,
				input.idempotencyKey,
				"freeze_workflow",
				{ runId: input.runId, workflowHash: input.workflow.hash },
				() => {
					const run = this.requireRunRow(input.runId);
					if (run.status !== "compiling") {
						throw new IpdLedgerError("invalid_transition", "Workflow can only be frozen from compiling state");
					}
					assertRunTransition(run.status, "ready");
					if (this.get<WorkflowRow>("SELECT * FROM workflow_versions WHERE run_id = ?", input.runId)) {
						throw new IpdLedgerError("already_exists", `Workflow already frozen for Run ${input.runId}`);
					}
					const timestamp = this.now();
					const definition = input.workflow.definition;
					this.db
						.prepare(
							`INSERT INTO workflow_versions (
run_id, workflow_id, version, hash, source, definition_json, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?)`,
						)
						.run(
							input.runId,
							definition.id,
							definition.version,
							input.workflow.hash,
							definition.source,
							canonicalJson(definition),
							timestamp,
						);
					for (const card of input.workflow.agentCards.values()) {
						this.db
							.prepare(
								`INSERT INTO agent_card_snapshots (
run_id, card_id, version, hash, card_json, created_at
) VALUES (?, ?, ?, ?, ?, ?)`,
							)
							.run(input.runId, card.id, card.version, card.hash, canonicalJson(card), timestamp);
					}
					this.db
						.prepare(
							`UPDATE ipd_runs SET
workflow_id = ?, workflow_version = ?, workflow_hash = ?, status = 'ready', updated_at = ?, version = version + 1
WHERE id = ?`,
						)
						.run(definition.id, definition.version, input.workflow.hash, timestamp, input.runId);
					this.appendEvent(input.runId, "workflow_frozen", {
						workflow: { id: definition.id, version: definition.version, hash: input.workflow.hash },
						agentCardCount: input.workflow.agentCards.size,
					});
					const row = this.get<WorkflowRow>("SELECT * FROM workflow_versions WHERE run_id = ?", input.runId);
					if (!row) throw new IpdLedgerError("corrupt", `Frozen Workflow missing for Run ${input.runId}`);
					return decodeWorkflow(row);
				},
			),
		);
	}

	createNodeAttempt(input: CreateNodeAttemptInput): NodeInstanceRecord {
		return this.transaction(() =>
			this.idempotent(input.runId, input.idempotencyKey, "create_node_attempt", input, () => {
				const run = this.requireActiveRunRow(input.runId);
				if (run.status !== "ready" && run.status !== "running") {
					throw new IpdLedgerError(
						"invalid_transition",
						`Node Attempts can only start while a Run is ready or running, not ${run.status}`,
					);
				}
				this.assertNewId("node_instances", input.attemptId, "Node Attempt");
				const workflowRow = this.get<WorkflowRow>("SELECT * FROM workflow_versions WHERE run_id = ?", input.runId);
				if (!workflowRow)
					throw new IpdLedgerError("invalid_transition", "Workflow must be frozen before creating nodes");
				const definition = parseJson<WorkflowDefinition>(workflowRow.definition_json);
				const node = definition.nodes.find((candidate) => candidate.id === input.nodeId);
				if (!node) throw new IpdLedgerError("not_found", `Workflow Node not found: ${input.nodeId}`);
				if (
					node.agentCardRef.id !== input.agentCardRef.id ||
					node.agentCardRef.version !== input.agentCardRef.version ||
					node.agentCardRef.hash !== input.agentCardRef.hash
				) {
					throw new IpdLedgerError("corrupt", `Node AgentCard does not match frozen Workflow: ${input.nodeId}`);
				}
				const previous = this.get<{ max_attempt: number | null }>(
					"SELECT MAX(attempt_number) AS max_attempt FROM node_instances WHERE run_id = ? AND node_id = ?",
					input.runId,
					input.nodeId,
				);
				const expectedAttempt = (previous?.max_attempt ?? 0) + 1;
				if (input.attemptNumber !== expectedAttempt) {
					throw new IpdLedgerError(
						"invalid_transition",
						`Node ${input.nodeId} expected Attempt ${expectedAttempt}, received ${input.attemptNumber}`,
					);
				}
				if (expectedAttempt > 1) {
					const latest = this.get<NodeRow>(
						`SELECT * FROM node_instances
WHERE run_id = ? AND node_id = ? ORDER BY attempt_number DESC LIMIT 1`,
						input.runId,
						input.nodeId,
					);
					if (!latest || !["rework_pending", "blocked", "failed", "interrupted"].includes(latest.status)) {
						throw new IpdLedgerError(
							"invalid_transition",
							`Node ${input.nodeId} cannot start a new Attempt while the previous Attempt is ${latest?.status ?? "missing"}`,
						);
					}
				}
				const timestamp = this.now();
				this.db
					.prepare(
						`INSERT INTO node_instances (
attempt_id, run_id, node_id, attempt_number, status,
agent_card_id, agent_card_version, agent_card_hash,
session_id, session_file, created_at, updated_at
) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						input.attemptId,
						input.runId,
						input.nodeId,
						input.attemptNumber,
						input.agentCardRef.id,
						input.agentCardRef.version,
						input.agentCardRef.hash,
						input.sessionId ?? null,
						input.sessionFile ?? null,
						timestamp,
						timestamp,
					);
				this.appendEvent(
					input.runId,
					"node_attempt_created",
					{ nodeId: input.nodeId, attemptNumber: input.attemptNumber, status: "pending" },
					{ nodeId: input.nodeId, attemptId: input.attemptId },
				);
				return decodeNode(this.requireNodeRow(input.runId, input.attemptId));
			}),
		);
	}

	transitionNode(input: TransitionNodeInput): NodeInstanceRecord {
		return this.transaction(() =>
			this.idempotent(input.runId, input.idempotencyKey, "transition_node", input, () => {
				this.requireActiveRunRow(input.runId);
				const current = this.requireNodeRow(input.runId, input.attemptId);
				assertNodeTransition(current.status, input.status);
				if (input.status === "succeeded") {
					const accepted = this.get<ArtifactRow>(
						"SELECT * FROM artifacts WHERE run_id = ? AND attempt_id = ? AND status = 'accepted' LIMIT 1",
						input.runId,
						input.attemptId,
					);
					if (!accepted) {
						throw new IpdLedgerError(
							"invalid_transition",
							"Node Attempt cannot succeed without an accepted Artifact",
						);
					}
				}
				const timestamp = this.now();
				this.db
					.prepare(
						`UPDATE node_instances SET
status = ?, session_id = COALESCE(?, session_id), session_file = COALESCE(?, session_file),
error_json = ?, updated_at = ?
WHERE run_id = ? AND attempt_id = ?`,
					)
					.run(
						input.status,
						input.sessionId ?? null,
						input.sessionFile ?? null,
						input.error === undefined ? null : canonicalJson(input.error),
						timestamp,
						input.runId,
						input.attemptId,
					);
				this.appendEvent(
					input.runId,
					"node_status_changed",
					{ from: current.status, to: input.status, error: input.error ?? null },
					{ nodeId: current.node_id, attemptId: input.attemptId },
				);
				return decodeNode(this.requireNodeRow(input.runId, input.attemptId));
			}),
		);
	}

	recordArtifact(input: RecordArtifactInput): ArtifactRecord {
		return this.transaction(() =>
			this.idempotent(input.runId, input.idempotencyKey, "record_artifact", input, () => {
				this.requireActiveRunRow(input.runId);
				this.assertNewId("artifacts", input.artifactId, "Artifact");
				const attempt = this.requireNodeRow(input.runId, input.attemptId);
				if (attempt.node_id !== input.nodeId) {
					throw new IpdLedgerError("corrupt", `Artifact Node does not match Attempt ${input.attemptId}`);
				}
				if (attempt.status !== "running") {
					throw new IpdLedgerError(
						"invalid_transition",
						"Candidate Artifacts can only be submitted by a running Attempt",
					);
				}
				const timestamp = this.now();
				const manifestHash = hashJson(input.manifest);
				this.db
					.prepare(
						`INSERT INTO artifacts (
id, run_id, node_id, attempt_id, contract_id, status, manifest_json, manifest_hash, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?)`,
					)
					.run(
						input.artifactId,
						input.runId,
						input.nodeId,
						input.attemptId,
						input.contractId,
						canonicalJson(input.manifest),
						manifestHash,
						timestamp,
						timestamp,
					);
				this.appendEvent(
					input.runId,
					"artifact_recorded",
					{ artifactId: input.artifactId, contractId: input.contractId, manifestHash, status: "candidate" },
					{ nodeId: input.nodeId, attemptId: input.attemptId },
				);
				return decodeArtifact(this.requireArtifactRow(input.runId, input.artifactId));
			}),
		);
	}

	transitionArtifact(input: TransitionArtifactInput): ArtifactRecord {
		return this.transaction(() =>
			this.idempotent(input.runId, input.idempotencyKey, "transition_artifact", input, () => {
				this.requireActiveRunRow(input.runId);
				const current = this.requireArtifactRow(input.runId, input.artifactId);
				assertArtifactTransition(current.status, input.status);
				if (input.status === "accepted") {
					const passedGate = this.get<GateRow>(
						"SELECT * FROM gate_runs WHERE run_id = ? AND artifact_id = ? AND status = 'passed' LIMIT 1",
						input.runId,
						input.artifactId,
					);
					if (!passedGate) {
						throw new IpdLedgerError("invalid_transition", "Artifact cannot be accepted before its Gate passes");
					}
				}
				const timestamp = this.now();
				this.db
					.prepare("UPDATE artifacts SET status = ?, updated_at = ? WHERE run_id = ? AND id = ?")
					.run(input.status, timestamp, input.runId, input.artifactId);
				this.appendEvent(
					input.runId,
					"artifact_status_changed",
					{ artifactId: input.artifactId, from: current.status, to: input.status },
					{ nodeId: current.node_id, attemptId: current.attempt_id },
				);
				return decodeArtifact(this.requireArtifactRow(input.runId, input.artifactId));
			}),
		);
	}

	createGateRun(input: CreateGateRunInput): GateRunRecord {
		return this.transaction(() =>
			this.idempotent(input.runId, input.idempotencyKey, "create_gate_run", input, () => {
				this.requireActiveRunRow(input.runId);
				this.assertNewId("gate_runs", input.gateRunId, "Gate Run");
				if (input.nodeId !== undefined) {
					if (!input.attemptId || !input.artifactId) {
						throw new IpdLedgerError("corrupt", "Node Gate Runs require Attempt and Artifact references");
					}
					const attempt = this.requireNodeRow(input.runId, input.attemptId);
					const artifact = this.requireArtifactRow(input.runId, input.artifactId);
					if (
						attempt.node_id !== input.nodeId ||
						artifact.node_id !== input.nodeId ||
						artifact.attempt_id !== input.attemptId
					) {
						throw new IpdLedgerError("corrupt", "Gate references do not identify one Node Attempt Artifact");
					}
					if (attempt.status !== "gate_checking" || artifact.status !== "candidate") {
						throw new IpdLedgerError(
							"invalid_transition",
							"Node Gate Runs require a gate_checking Attempt and candidate Artifact",
						);
					}
				} else if (input.attemptId !== undefined || input.artifactId !== undefined) {
					throw new IpdLedgerError("corrupt", "Final Gate Runs cannot reference one Node Attempt or Artifact");
				}
				const timestamp = this.now();
				this.db
					.prepare(
						`INSERT INTO gate_runs (
id, run_id, node_id, attempt_id, artifact_id, gate_id, status, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
					)
					.run(
						input.gateRunId,
						input.runId,
						input.nodeId ?? null,
						input.attemptId ?? null,
						input.artifactId ?? null,
						input.gateId,
						timestamp,
						timestamp,
					);
				this.appendEvent(
					input.runId,
					"gate_run_created",
					{ gateRunId: input.gateRunId, gateId: input.gateId, status: "pending" },
					{
						nodeId: input.nodeId,
						attemptId: input.attemptId,
						gateRunId: input.gateRunId,
					},
				);
				return decodeGate(this.requireGateRow(input.runId, input.gateRunId));
			}),
		);
	}

	transitionGate(input: TransitionGateInput): GateRunRecord {
		return this.transaction(() =>
			this.idempotent(input.runId, input.idempotencyKey, "transition_gate", input, () => {
				this.requireActiveRunRow(input.runId);
				const current = this.requireGateRow(input.runId, input.gateRunId);
				assertGateTransition(current.status, input.status);
				this.assertGateCanEnter(input.runId, input.gateRunId, input.status);
				const timestamp = this.now();
				this.db
					.prepare(
						"UPDATE gate_runs SET status = ?, decision_json = ?, updated_at = ? WHERE run_id = ? AND id = ?",
					)
					.run(
						input.status,
						input.decision === undefined ? null : canonicalJson(input.decision),
						timestamp,
						input.runId,
						input.gateRunId,
					);
				this.appendEvent(
					input.runId,
					"gate_status_changed",
					{ from: current.status, to: input.status, decision: input.decision ?? null },
					{
						nodeId: current.node_id ?? undefined,
						attemptId: current.attempt_id ?? undefined,
						gateRunId: input.gateRunId,
					},
				);
				return decodeGate(this.requireGateRow(input.runId, input.gateRunId));
			}),
		);
	}

	createReviewer(input: CreateReviewerInput): ReviewerInstanceRecord {
		return this.transaction(() =>
			this.idempotent(input.runId, input.idempotencyKey, "create_reviewer", input, () => {
				this.requireActiveRunRow(input.runId);
				this.assertNewId("reviewer_instances", input.reviewerInstanceId, "Reviewer Instance");
				const gate = this.requireGateRow(input.runId, input.gateRunId);
				if (gate.status !== "semantic_reviewing") {
					throw new IpdLedgerError("invalid_transition", "Reviewers can only start during semantic review");
				}
				const card = this.get<AgentCardRow>(
					`SELECT * FROM agent_card_snapshots
WHERE run_id = ? AND card_id = ? AND version = ? AND hash = ?`,
					input.runId,
					input.agentCardRef.id,
					input.agentCardRef.version,
					input.agentCardRef.hash,
				);
				if (!card)
					throw new IpdLedgerError("not_found", `Reviewer AgentCard Snapshot not found: ${input.agentCardRef.id}`);
				const timestamp = this.now();
				this.db
					.prepare(
						`INSERT INTO reviewer_instances (
id, run_id, gate_run_id, agent_card_id, agent_card_version, agent_card_hash,
status, session_id, session_file, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
					)
					.run(
						input.reviewerInstanceId,
						input.runId,
						input.gateRunId,
						input.agentCardRef.id,
						input.agentCardRef.version,
						input.agentCardRef.hash,
						input.sessionId ?? null,
						input.sessionFile ?? null,
						timestamp,
						timestamp,
					);
				this.appendEvent(
					input.runId,
					"reviewer_created",
					{ reviewerInstanceId: input.reviewerInstanceId, status: "pending" },
					{ gateRunId: input.gateRunId, reviewerInstanceId: input.reviewerInstanceId },
				);
				return decodeReviewer(this.requireReviewerRow(input.runId, input.reviewerInstanceId));
			}),
		);
	}

	transitionReviewer(input: TransitionReviewerInput): ReviewerInstanceRecord {
		return this.transaction(() =>
			this.idempotent(input.runId, input.idempotencyKey, "transition_reviewer", input, () => {
				this.requireActiveRunRow(input.runId);
				const current = this.requireReviewerRow(input.runId, input.reviewerInstanceId);
				assertReviewerTransition(current.status, input.status);
				if (input.status === "completed" && input.result === undefined) {
					throw new IpdLedgerError("invalid_transition", "Completed Reviewers must submit a structured result");
				}
				const timestamp = this.now();
				this.db
					.prepare(
						`UPDATE reviewer_instances SET
status = ?, result_json = ?, session_id = COALESCE(?, session_id),
session_file = COALESCE(?, session_file), updated_at = ?
WHERE run_id = ? AND id = ?`,
					)
					.run(
						input.status,
						input.result === undefined ? null : canonicalJson(input.result),
						input.sessionId ?? null,
						input.sessionFile ?? null,
						timestamp,
						input.runId,
						input.reviewerInstanceId,
					);
				this.appendEvent(
					input.runId,
					"reviewer_status_changed",
					{ from: current.status, to: input.status, result: input.result ?? null },
					{ gateRunId: current.gate_run_id, reviewerInstanceId: input.reviewerInstanceId },
				);
				return decodeReviewer(this.requireReviewerRow(input.runId, input.reviewerInstanceId));
			}),
		);
	}

	recordCriterionResult(input: RecordCriterionInput): CriterionResultRecord {
		return this.transaction(() =>
			this.idempotent(input.runId, input.idempotencyKey, "record_criterion", input, () => {
				this.requireActiveRunRow(input.runId);
				this.assertNewId("criterion_results", input.criterionResultId, "Criterion Result");
				this.requireGateRow(input.runId, input.gateRunId);
				if (input.kind === "semantic" && !input.reviewerInstanceId) {
					throw new IpdLedgerError("corrupt", "Semantic Criterion results require a Reviewer Instance");
				}
				if (input.kind === "mechanical" && input.reviewerInstanceId !== undefined) {
					throw new IpdLedgerError("corrupt", "Mechanical Criterion results cannot reference a Reviewer");
				}
				if (input.reviewerInstanceId) {
					const reviewer = this.requireReviewerRow(input.runId, input.reviewerInstanceId);
					if (reviewer.gate_run_id !== input.gateRunId) {
						throw new IpdLedgerError("corrupt", "Criterion Reviewer belongs to a different Gate Run");
					}
					if (input.kind === "semantic" && reviewer.status !== "running") {
						throw new IpdLedgerError("invalid_transition", "Semantic Criterion requires a running Reviewer");
					}
				}
				const timestamp = this.now();
				this.db
					.prepare(
						`INSERT INTO criterion_results (
id, run_id, gate_run_id, criterion_id, kind, result,
reviewer_instance_id, evidence_json, rationale, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						input.criterionResultId,
						input.runId,
						input.gateRunId,
						input.criterionId,
						input.kind,
						input.result,
						input.reviewerInstanceId ?? null,
						canonicalJson(input.evidence),
						input.rationale,
						timestamp,
					);
				this.appendEvent(
					input.runId,
					"criterion_recorded",
					{
						criterionResultId: input.criterionResultId,
						criterionId: input.criterionId,
						kind: input.kind,
						result: input.result,
					},
					{
						gateRunId: input.gateRunId,
						reviewerInstanceId: input.reviewerInstanceId,
					},
				);
				const row = this.get<CriterionRow>(
					"SELECT * FROM criterion_results WHERE run_id = ? AND id = ?",
					input.runId,
					input.criterionResultId,
				);
				if (!row) throw new IpdLedgerError("corrupt", `Criterion result missing: ${input.criterionResultId}`);
				return decodeCriterion(row);
			}),
		);
	}

	recordDecision(input: RecordDecisionInput): DecisionRecord {
		return this.transaction(() =>
			this.idempotent(input.runId, input.idempotencyKey, "record_decision", input, () => {
				this.requireActiveRunRow(input.runId);
				this.assertNewId("decisions", input.decisionId, "Decision");
				if (input.gateRunId) this.requireGateRow(input.runId, input.gateRunId);
				if (input.reviewerInstanceId) this.requireReviewerRow(input.runId, input.reviewerInstanceId);
				const timestamp = this.now();
				this.db
					.prepare(
						`INSERT INTO decisions (
id, run_id, type, action, rationale, node_id, gate_run_id,
reviewer_instance_id, evidence_json, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						input.decisionId,
						input.runId,
						input.type,
						input.action,
						input.rationale,
						input.nodeId ?? null,
						input.gateRunId ?? null,
						input.reviewerInstanceId ?? null,
						canonicalJson(input.evidence),
						timestamp,
					);
				this.appendEvent(
					input.runId,
					"decision_recorded",
					{ decisionId: input.decisionId, type: input.type, action: input.action },
					{
						nodeId: input.nodeId,
						gateRunId: input.gateRunId,
						reviewerInstanceId: input.reviewerInstanceId,
					},
				);
				const row = this.get<DecisionRow>(
					"SELECT * FROM decisions WHERE run_id = ? AND id = ?",
					input.runId,
					input.decisionId,
				);
				if (!row) throw new IpdLedgerError("corrupt", `Decision missing: ${input.decisionId}`);
				return decodeDecision(row);
			}),
		);
	}

	createEscalation(input: CreateEscalationInput): EscalationRecord {
		return this.transaction(() =>
			this.idempotent(input.runId, input.idempotencyKey, "create_escalation", input, () => {
				this.requireActiveRunRow(input.runId);
				this.assertNewId("escalations", input.escalationId, "Escalation");
				const timestamp = this.now();
				this.db
					.prepare(
						`INSERT INTO escalations (
id, run_id, node_id, status, target, question, context_json, created_at, updated_at
) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
					)
					.run(
						input.escalationId,
						input.runId,
						input.nodeId ?? null,
						input.target,
						input.question,
						canonicalJson(input.context),
						timestamp,
						timestamp,
					);
				this.appendEvent(
					input.runId,
					"escalation_created",
					{ escalationId: input.escalationId, target: input.target, status: "open" },
					{ nodeId: input.nodeId },
				);
				const row = this.get<EscalationRow>(
					"SELECT * FROM escalations WHERE run_id = ? AND id = ?",
					input.runId,
					input.escalationId,
				);
				if (!row) throw new IpdLedgerError("corrupt", `Escalation missing: ${input.escalationId}`);
				return decodeEscalation(row);
			}),
		);
	}

	answerEscalation(input: AnswerEscalationInput): EscalationRecord {
		return this.transaction(() =>
			this.idempotent(input.runId, input.idempotencyKey, "answer_escalation", input, () => {
				this.requireActiveRunRow(input.runId);
				const current = this.get<EscalationRow>(
					"SELECT * FROM escalations WHERE run_id = ? AND id = ?",
					input.runId,
					input.escalationId,
				);
				if (!current) throw new IpdLedgerError("not_found", `Escalation not found: ${input.escalationId}`);
				if (current.status !== "open") {
					throw new IpdLedgerError("invalid_transition", `Escalation is already ${current.status}`);
				}
				const timestamp = this.now();
				this.db
					.prepare(
						"UPDATE escalations SET status = 'answered', answer = ?, updated_at = ? WHERE run_id = ? AND id = ?",
					)
					.run(input.answer, timestamp, input.runId, input.escalationId);
				this.appendEvent(
					input.runId,
					"escalation_answered",
					{ escalationId: input.escalationId, status: "answered" },
					{ nodeId: current.node_id ?? undefined },
				);
				const row = this.get<EscalationRow>(
					"SELECT * FROM escalations WHERE run_id = ? AND id = ?",
					input.runId,
					input.escalationId,
				);
				if (!row) throw new IpdLedgerError("corrupt", `Escalation missing: ${input.escalationId}`);
				return decodeEscalation(row);
			}),
		);
	}

	recordBudgetUsage(input: RecordBudgetUsageInput): BudgetUsageRecord {
		return this.transaction(() =>
			this.idempotent(input.runId, input.idempotencyKey, "record_budget_usage", input, () => {
				this.requireActiveRunRow(input.runId);
				this.assertNewId("budget_usage", input.usageId, "Budget Usage");
				const numericValues = [
					input.inputTokens,
					input.outputTokens,
					input.cacheReadTokens,
					input.cacheWriteTokens,
					input.totalTokens,
					input.costUsd,
					input.durationMs,
				];
				if (numericValues.some((value) => !Number.isFinite(value) || value < 0)) {
					throw new IpdLedgerError("corrupt", "Budget usage values must be finite and non-negative");
				}
				const timestamp = this.now();
				this.db
					.prepare(
						`INSERT INTO budget_usage (
id, run_id, category, node_id, attempt_id, reviewer_instance_id,
input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
total_tokens, cost_usd, duration_ms, details_json, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						input.usageId,
						input.runId,
						input.category,
						input.nodeId ?? null,
						input.attemptId ?? null,
						input.reviewerInstanceId ?? null,
						input.inputTokens,
						input.outputTokens,
						input.cacheReadTokens,
						input.cacheWriteTokens,
						input.totalTokens,
						input.costUsd,
						input.durationMs,
						canonicalJson(input.details),
						timestamp,
					);
				this.appendEvent(
					input.runId,
					"budget_usage_recorded",
					{ usageId: input.usageId, category: input.category, totalTokens: input.totalTokens },
					{
						nodeId: input.nodeId,
						attemptId: input.attemptId,
						reviewerInstanceId: input.reviewerInstanceId,
					},
				);
				const row = this.get<BudgetRow>(
					"SELECT * FROM budget_usage WHERE run_id = ? AND id = ?",
					input.runId,
					input.usageId,
				);
				if (!row) throw new IpdLedgerError("corrupt", `Budget usage missing: ${input.usageId}`);
				return decodeBudget(row);
			}),
		);
	}

	recordBudgetSignal(input: RecordBudgetSignalInput): IpdEventRecord {
		return this.transaction(() =>
			this.idempotent(input.runId, input.idempotencyKey, "record_budget_signal", input, () => {
				this.requireActiveRunRow(input.runId);
				return this.appendEvent(input.runId, input.type, input.payload);
			}),
		);
	}

	getRunSnapshot(runId: string): RunSnapshot {
		this.assertOpen();
		const run = this.requireRunRow(runId);
		const workflow = this.get<WorkflowRow>("SELECT * FROM workflow_versions WHERE run_id = ?", runId);
		return {
			run: decodeRun(run),
			workflow: workflow ? decodeWorkflow(workflow) : undefined,
			agentCards: this.all<AgentCardRow>(
				"SELECT * FROM agent_card_snapshots WHERE run_id = ? ORDER BY card_id, version, hash",
				runId,
			).map(decodeAgentCard),
			nodes: this.all<NodeRow>(
				"SELECT * FROM node_instances WHERE run_id = ? ORDER BY node_id, attempt_number",
				runId,
			).map(decodeNode),
			artifacts: this.all<ArtifactRow>(
				"SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at, id",
				runId,
			).map(decodeArtifact),
			gates: this.all<GateRow>("SELECT * FROM gate_runs WHERE run_id = ? ORDER BY created_at, id", runId).map(
				decodeGate,
			),
			reviewers: this.all<ReviewerRow>(
				"SELECT * FROM reviewer_instances WHERE run_id = ? ORDER BY created_at, id",
				runId,
			).map(decodeReviewer),
			criteria: this.all<CriterionRow>(
				"SELECT * FROM criterion_results WHERE run_id = ? ORDER BY created_at, id",
				runId,
			).map(decodeCriterion),
			decisions: this.all<DecisionRow>(
				"SELECT * FROM decisions WHERE run_id = ? ORDER BY created_at, id",
				runId,
			).map(decodeDecision),
			escalations: this.all<EscalationRow>(
				"SELECT * FROM escalations WHERE run_id = ? ORDER BY created_at, id",
				runId,
			).map(decodeEscalation),
			budgetUsage: this.all<BudgetRow>(
				"SELECT * FROM budget_usage WHERE run_id = ? ORDER BY created_at, id",
				runId,
			).map(decodeBudget),
			events: this.all<EventRow>("SELECT * FROM ipd_events WHERE run_id = ? ORDER BY sequence", runId).map(
				decodeEvent,
			),
		};
	}

	verifyRunConsistency(runId: string): ConsistencyReport {
		const snapshot = this.getRunSnapshot(runId);
		const diagnostics: ConsistencyReport["diagnostics"] = [];
		const inconsistent = (path: string, message: string): void => {
			diagnostics.push({ code: "ledger_inconsistent", path, message });
		};

		for (const [index, event] of snapshot.events.entries()) {
			const expected = index + 1;
			if (event.sequence !== expected) {
				inconsistent(`/events/${index}/sequence`, `Expected Event sequence ${expected}, found ${event.sequence}`);
			}
			if (event.traceId !== snapshot.run.traceId) {
				inconsistent(`/events/${index}/traceId`, `Event ${event.eventId} has a different trace ID`);
			}
		}
		const sequence = this.get<SequenceRow>("SELECT next_sequence FROM run_sequences WHERE run_id = ?", runId);
		const expectedNext = snapshot.events.length + 1;
		if (!sequence || sequence.next_sequence !== expectedNext) {
			inconsistent(
				"/events",
				`Expected next Event sequence ${expectedNext}, found ${sequence?.next_sequence ?? "missing"}`,
			);
		}

		if (snapshot.run.workflowRef) {
			if (!snapshot.workflow) {
				inconsistent("/workflow", "Run references a missing frozen Workflow");
			} else {
				const ref = snapshot.run.workflowRef;
				if (
					ref.id !== snapshot.workflow.id ||
					ref.version !== snapshot.workflow.version ||
					ref.hash !== snapshot.workflow.hash
				) {
					inconsistent("/workflow", "Run Workflow reference does not match the frozen Workflow row");
				}
				if (hashJson(snapshot.workflow.definition) !== snapshot.workflow.hash) {
					inconsistent("/workflow/hash", "Frozen Workflow content does not match its Hash");
				}
			}
		} else if (!["planning", "compiling"].includes(snapshot.run.status)) {
			inconsistent("/run/workflowRef", `Run in ${snapshot.run.status} state has no frozen Workflow`);
		}

		const cardRefs = new Set<string>();
		for (const [index, record] of snapshot.agentCards.entries()) {
			const card = record.card;
			const ref = `${record.ref.id}@${record.ref.version}#${record.ref.hash}`;
			cardRefs.add(ref);
			if (card.id !== record.ref.id || card.version !== record.ref.version || card.hash !== record.ref.hash) {
				inconsistent(`/agentCards/${index}`, `AgentCard Snapshot ${ref} has mismatched identity fields`);
			} else if (hashJson(cardHashValue(card)) !== record.ref.hash) {
				inconsistent(`/agentCards/${index}/hash`, `AgentCard Snapshot ${ref} does not match its Hash`);
			}
		}

		for (const [index, node] of snapshot.nodes.entries()) {
			const ref = `${node.agentCardRef.id}@${node.agentCardRef.version}#${node.agentCardRef.hash}`;
			if (!cardRefs.has(ref)) {
				inconsistent(
					`/nodes/${index}/agentCardRef`,
					`Node Attempt references an unavailable AgentCard Snapshot: ${ref}`,
				);
			}
			if (node.status === "succeeded") {
				const accepted = snapshot.artifacts.some(
					(artifact) => artifact.attemptId === node.attemptId && artifact.status === "accepted",
				);
				if (!accepted) inconsistent(`/nodes/${index}/status`, "Succeeded Node Attempt has no accepted Artifact");
			}
		}

		for (const [index, artifact] of snapshot.artifacts.entries()) {
			if (hashJson(artifact.manifest) !== artifact.manifestHash) {
				inconsistent(`/artifacts/${index}/manifestHash`, `Artifact ${artifact.id} Manifest Hash is invalid`);
			}
			if (artifact.status === "accepted") {
				const passed = snapshot.gates.some((gate) => gate.artifactId === artifact.id && gate.status === "passed");
				if (!passed) inconsistent(`/artifacts/${index}/status`, "Accepted Artifact has no passed Gate");
			}
		}

		for (const [index, gate] of snapshot.gates.entries()) {
			if (gate.status !== "passed") continue;
			const criteria = snapshot.criteria.filter((criterion) => criterion.gateRunId === gate.id);
			const hasMechanical = criteria.some((criterion) => criterion.kind === "mechanical");
			const hasSemantic = criteria.some((criterion) => criterion.kind === "semantic");
			if (!hasMechanical || !hasSemantic || criteria.some((criterion) => criterion.result !== "PASS")) {
				inconsistent(`/gates/${index}/status`, "Passed Gate lacks passing mechanical and semantic evidence");
			}
		}

		for (const [index, reviewer] of snapshot.reviewers.entries()) {
			const ref = `${reviewer.agentCardRef.id}@${reviewer.agentCardRef.version}#${reviewer.agentCardRef.hash}`;
			if (!cardRefs.has(ref)) {
				inconsistent(
					`/reviewers/${index}/agentCardRef`,
					`Reviewer references an unavailable AgentCard Snapshot: ${ref}`,
				);
			}
		}

		if (snapshot.run.status === "succeeded") {
			if (!snapshot.workflow) {
				inconsistent("/run/status", "Succeeded Run has no Workflow");
			} else {
				for (const nodeId of snapshot.workflow.definition.finalArtifactNodeIds) {
					const attempts = snapshot.nodes.filter((node) => node.nodeId === nodeId);
					const latest = attempts.at(-1);
					if (!latest || latest.status !== "succeeded") {
						inconsistent("/run/status", `Final Artifact Node ${nodeId} has not succeeded`);
					}
				}
			}
			if (!snapshot.gates.some((gate) => gate.nodeId === undefined && gate.status === "passed")) {
				inconsistent("/run/status", "Succeeded Run has no passed final Gate");
			}
		}

		return { ok: diagnostics.length === 0, diagnostics };
	}
}
