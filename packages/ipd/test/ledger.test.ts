import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { type CompiledWorkflow, compileWorkflow, IpdLedgerError, SqliteIpdLedger } from "../src/index.ts";
import {
	cardRef,
	createCompileContext,
	createTestCards,
	createValidWorkflow,
	TEST_SKILL,
	TEST_SKILL_HASH,
} from "./fixtures.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createDatabasePath(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-ipd-ledger-"));
	roots.push(root);
	return join(root, "ipd.sqlite");
}

function createCompiledWorkflow(): CompiledWorkflow {
	const cards = createTestCards();
	const result = compileWorkflow(createValidWorkflow(cards), createCompileContext(cards));
	if (!result.ok) throw new Error(result.diagnostics.map((item) => item.message).join("\n"));
	return result.value;
}

function createRun(ledger: SqliteIpdLedger, runId = "run-1") {
	return ledger.createRun({
		runId,
		traceId: `trace-${runId}`,
		idempotencyKey: `create-${runId}`,
		task: "Produce a reviewed artifact",
		skill: { name: TEST_SKILL, hash: TEST_SKILL_HASH },
		globalBudget: { tokens: 100_000 },
	});
}

function freezeRun(ledger: SqliteIpdLedger, workflow: CompiledWorkflow, runId = "run-1"): void {
	createRun(ledger, runId);
	ledger.transitionRun({ runId, idempotencyKey: `${runId}-compiling`, status: "compiling" });
	ledger.freezeWorkflow({ runId, idempotencyKey: `${runId}-freeze`, workflow });
}

function expectLedgerCode(callback: () => unknown, code: IpdLedgerError["code"]): void {
	try {
		callback();
		throw new Error(`Expected IpdLedgerError ${code}`);
	} catch (error) {
		expect(error).toBeInstanceOf(IpdLedgerError);
		expect((error as IpdLedgerError).code).toBe(code);
	}
}

function recordPassingGate(options: {
	ledger: SqliteIpdLedger;
	runId: string;
	gateRunId: string;
	gateId: string;
	reviewerId: string;
	reviewerCard: ReturnType<typeof createTestCards>["reviewer"];
	nodeId?: string;
	attemptId?: string;
	artifactId?: string;
}): void {
	const { ledger, runId, gateRunId, gateId, reviewerId, reviewerCard, nodeId, attemptId, artifactId } = options;
	ledger.createGateRun({
		runId,
		idempotencyKey: `${gateRunId}-create`,
		gateRunId,
		gateId,
		nodeId,
		attemptId,
		artifactId,
	});
	ledger.transitionGate({
		runId,
		idempotencyKey: `${gateRunId}-mechanical-start`,
		gateRunId,
		status: "mechanical_checking",
	});
	ledger.recordCriterionResult({
		runId,
		idempotencyKey: `${gateRunId}-mechanical-result`,
		criterionResultId: `${gateRunId}-mechanical-result`,
		gateRunId,
		criterionId: `${gateId}-mechanical`,
		kind: "mechanical",
		result: "PASS",
		evidence: { report: "artifact exists" },
		rationale: "All required files exist",
	});
	ledger.transitionGate({
		runId,
		idempotencyKey: `${gateRunId}-semantic-start`,
		gateRunId,
		status: "semantic_reviewing",
	});
	ledger.createReviewer({
		runId,
		idempotencyKey: `${reviewerId}-create`,
		reviewerInstanceId: reviewerId,
		gateRunId,
		agentCardRef: cardRef(reviewerCard),
		sessionId: `${reviewerId}-session`,
		sessionFile: `/sessions/${reviewerId}.jsonl`,
	});
	ledger.transitionReviewer({
		runId,
		idempotencyKey: `${reviewerId}-running`,
		reviewerInstanceId: reviewerId,
		status: "running",
	});
	ledger.recordCriterionResult({
		runId,
		idempotencyKey: `${gateRunId}-semantic-result`,
		criterionResultId: `${gateRunId}-semantic-result`,
		gateRunId,
		criterionId: `${gateId}-semantic`,
		kind: "semantic",
		result: "PASS",
		reviewerInstanceId: reviewerId,
		evidence: { artifact: artifactId ?? "final" },
		rationale: "The artifact satisfies its semantic objective",
	});
	ledger.transitionReviewer({
		runId,
		idempotencyKey: `${reviewerId}-completed`,
		reviewerInstanceId: reviewerId,
		status: "completed",
		result: { decision: "PASS" },
	});
	ledger.transitionGate({
		runId,
		idempotencyKey: `${gateRunId}-passed`,
		gateRunId,
		status: "passed",
		decision: { decision: "PASS" },
	});
}

describe("SqliteIpdLedger", () => {
	it("appends same-Run Workflow revisions without rewriting the frozen history", async () => {
		const databasePath = await createDatabasePath();
		const workflow = createCompiledWorkflow();
		const cards = createTestCards();
		const ledger = new SqliteIpdLedger({ databasePath });
		try {
			freezeRun(ledger, workflow);
			ledger.transitionRun({ runId: "run-1", idempotencyKey: "run-start", status: "running" });
			ledger.transitionRun({ runId: "run-1", idempotencyKey: "run-replanning", status: "replanning" });
			const amendedDefinition = structuredClone(workflow.definition);
			amendedDefinition.version = "1.1.0";
			amendedDefinition.name = "Amended Test Workflow";
			const compiledAmendment = compileWorkflow(amendedDefinition, createCompileContext(cards));
			if (!compiledAmendment.ok) {
				throw new Error(compiledAmendment.diagnostics.map((item) => item.message).join("\n"));
			}
			const amended = ledger.amendWorkflow({
				runId: "run-1",
				idempotencyKey: "workflow-amendment-2",
				workflow: compiledAmendment.value,
			});

			expect(amended.revision).toBe(2);
			const snapshot = ledger.getRunSnapshot("run-1");
			expect(snapshot.run.status).toBe("ready");
			expect(snapshot.workflow).toMatchObject({ revision: 2, version: "1.1.0" });
			expect(snapshot.workflowHistory.map((item) => ({ revision: item.revision, hash: item.hash }))).toEqual([
				{ revision: 1, hash: workflow.hash },
				{ revision: 2, hash: compiledAmendment.value.hash },
			]);
			expect(snapshot.events.map((event) => event.type)).toContain("workflow_amended");
		} finally {
			ledger.close();
		}
	});

	it("reuses an accepted upstream Node when only its pass route targets a replacement Node", async () => {
		const databasePath = await createDatabasePath();
		const cards = createTestCards();
		const definition = createValidWorkflow(cards);
		const upstream = structuredClone(definition.nodes[0]);
		upstream.id = "upstream";
		upstream.output.id = "upstream-output";
		upstream.output.artifactType = "upstream-artifact";
		upstream.gate.id = "upstream-gate";
		upstream.gate.mechanicalCriteria[0].id = "upstream-gate-mechanical";
		upstream.gate.semanticCriteria[0].id = "upstream-gate-semantic";
		upstream.gate.reviewers[0].id = "upstream-gate-reviewer";
		upstream.gate.routes.pass = "downstream";
		upstream.gate.routes.rework = "upstream";
		upstream.rework.targetNodeId = "upstream";
		const downstream = structuredClone(definition.nodes[0]);
		downstream.id = "downstream";
		downstream.dependsOn = ["upstream"];
		downstream.inputs = [
			{ name: "upstream", fromNodeId: "upstream", artifactType: "upstream-artifact", required: true },
		];
		downstream.output.id = "downstream-output";
		downstream.output.artifactType = "downstream-artifact";
		downstream.gate.id = "downstream-gate";
		downstream.gate.mechanicalCriteria[0].id = "downstream-gate-mechanical";
		downstream.gate.semanticCriteria[0].id = "downstream-gate-semantic";
		downstream.gate.reviewers[0].id = "downstream-gate-reviewer";
		downstream.gate.routes.rework = "downstream";
		downstream.rework.targetNodeId = "downstream";
		definition.nodes = [upstream, downstream];
		definition.finalArtifactNodeIds = ["downstream"];
		definition.finalGate.routes.rework = "downstream";
		const compiled = compileWorkflow(definition, createCompileContext(cards));
		if (!compiled.ok) throw new Error(compiled.diagnostics.map((item) => item.message).join("\n"));

		const ledger = new SqliteIpdLedger({ databasePath });
		try {
			freezeRun(ledger, compiled.value);
			ledger.transitionRun({ runId: "run-1", idempotencyKey: "run-start", status: "running" });
			ledger.createNodeAttempt({
				runId: "run-1",
				idempotencyKey: "upstream-attempt-create",
				attemptId: "upstream-attempt",
				nodeId: "upstream",
				attemptNumber: 1,
				agentCardRef: cardRef(cards.executor),
			});
			ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "upstream-attempt-ready",
				attemptId: "upstream-attempt",
				status: "ready",
			});
			ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "upstream-attempt-running",
				attemptId: "upstream-attempt",
				status: "running",
			});
			ledger.recordArtifact({
				runId: "run-1",
				idempotencyKey: "upstream-artifact-create",
				artifactId: "upstream-artifact",
				nodeId: "upstream",
				attemptId: "upstream-attempt",
				contractId: "upstream-output",
				manifest: { files: [{ path: "outputs/upstream.txt" }] },
			});
			ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "upstream-gate-checking",
				attemptId: "upstream-attempt",
				status: "gate_checking",
			});
			recordPassingGate({
				ledger,
				runId: "run-1",
				gateRunId: "upstream-gate-run",
				gateId: "upstream-gate",
				reviewerId: "upstream-reviewer",
				reviewerCard: cards.reviewer,
				nodeId: "upstream",
				attemptId: "upstream-attempt",
				artifactId: "upstream-artifact",
			});
			ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "upstream-gate-reviewing",
				attemptId: "upstream-attempt",
				status: "gate_reviewing",
			});
			ledger.transitionArtifact({
				runId: "run-1",
				idempotencyKey: "upstream-artifact-accepted",
				artifactId: "upstream-artifact",
				status: "accepted",
			});
			ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "upstream-succeeded",
				attemptId: "upstream-attempt",
				status: "succeeded",
			});
			ledger.createNodeAttempt({
				runId: "run-1",
				idempotencyKey: "downstream-attempt-create",
				attemptId: "downstream-attempt",
				nodeId: "downstream",
				attemptNumber: 1,
				agentCardRef: cardRef(cards.executor),
			});
			ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "downstream-attempt-ready",
				attemptId: "downstream-attempt",
				status: "ready",
			});
			ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "downstream-attempt-running",
				attemptId: "downstream-attempt",
				status: "running",
			});
			ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "downstream-attempt-failed",
				attemptId: "downstream-attempt",
				status: "failed",
			});
			ledger.transitionRun({ runId: "run-1", idempotencyKey: "run-replanning", status: "replanning" });

			const amended = structuredClone(definition);
			amended.version = "1.1.0";
			amended.nodes[0].gate.routes.pass = "downstream-v2";
			const replacement = amended.nodes[1];
			replacement.id = "downstream-v2";
			replacement.output.id = "downstream-v2-output";
			replacement.gate.id = "downstream-v2-gate";
			replacement.gate.mechanicalCriteria[0].id = "downstream-v2-gate-mechanical";
			replacement.gate.semanticCriteria[0].id = "downstream-v2-gate-semantic";
			replacement.gate.reviewers[0].id = "downstream-v2-gate-reviewer";
			replacement.gate.routes.rework = "downstream-v2";
			replacement.rework.targetNodeId = "downstream-v2";
			amended.finalArtifactNodeIds = ["downstream-v2"];
			amended.finalGate.routes.rework = "downstream-v2";
			const compiledAmendment = compileWorkflow(amended, createCompileContext(cards));
			if (!compiledAmendment.ok) {
				throw new Error(compiledAmendment.diagnostics.map((item) => item.message).join("\n"));
			}
			expect(ledger.validateWorkflowAmendment("run-1", compiledAmendment.value)).toEqual([]);
			expect(
				ledger.amendWorkflow({
					runId: "run-1",
					idempotencyKey: "safe-route-retarget",
					workflow: compiledAmendment.value,
				}).revision,
			).toBe(2);
		} finally {
			ledger.close();
		}
	});

	it("stores a complete Run with atomic snapshots and contiguous events", async () => {
		const databasePath = await createDatabasePath();
		const workflow = createCompiledWorkflow();
		const cards = createTestCards();
		const ledger = new SqliteIpdLedger({ databasePath });
		try {
			freezeRun(ledger, workflow);
			ledger.transitionRun({ runId: "run-1", idempotencyKey: "run-start", status: "running" });
			ledger.createNodeAttempt({
				runId: "run-1",
				idempotencyKey: "attempt-create",
				attemptId: "attempt-1",
				nodeId: "produce",
				attemptNumber: 1,
				agentCardRef: cardRef(cards.executor),
				sessionId: "execution-session",
				sessionFile: "/sessions/execution.jsonl",
			});
			ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "attempt-ready",
				attemptId: "attempt-1",
				status: "ready",
			});
			ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "attempt-running",
				attemptId: "attempt-1",
				status: "running",
			});
			ledger.recordArtifact({
				runId: "run-1",
				idempotencyKey: "artifact-create",
				artifactId: "artifact-1",
				nodeId: "produce",
				attemptId: "attempt-1",
				contractId: "content-output",
				manifest: { files: [{ path: "outputs/result.txt" }] },
			});
			ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "attempt-gate-checking",
				attemptId: "attempt-1",
				status: "gate_checking",
			});
			recordPassingGate({
				ledger,
				runId: "run-1",
				gateRunId: "gate-run-1",
				gateId: "produce-gate",
				reviewerId: "reviewer-1",
				reviewerCard: cards.reviewer,
				nodeId: "produce",
				attemptId: "attempt-1",
				artifactId: "artifact-1",
			});
			ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "attempt-gate-reviewing",
				attemptId: "attempt-1",
				status: "gate_reviewing",
			});
			ledger.transitionArtifact({
				runId: "run-1",
				idempotencyKey: "artifact-accept",
				artifactId: "artifact-1",
				status: "accepted",
			});
			ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "attempt-succeeded",
				attemptId: "attempt-1",
				status: "succeeded",
			});

			recordPassingGate({
				ledger,
				runId: "run-1",
				gateRunId: "final-gate-run",
				gateId: "final-gate",
				reviewerId: "final-reviewer",
				reviewerCard: cards.reviewer,
			});
			ledger.recordDecision({
				runId: "run-1",
				idempotencyKey: "decision-create",
				decisionId: "decision-1",
				type: "final_acceptance",
				action: "complete_run",
				rationale: "The final Gate passed",
				gateRunId: "final-gate-run",
				evidence: { gate: "final-gate-run" },
			});
			ledger.createEscalation({
				runId: "run-1",
				idempotencyKey: "escalation-create",
				escalationId: "escalation-1",
				target: "user",
				question: "Confirm the title",
				context: { title: "Draft" },
			});
			ledger.answerEscalation({
				runId: "run-1",
				idempotencyKey: "escalation-answer",
				escalationId: "escalation-1",
				answer: "Confirmed",
			});
			ledger.recordBudgetUsage({
				runId: "run-1",
				idempotencyKey: "usage-create",
				usageId: "usage-1",
				category: "execution",
				nodeId: "produce",
				attemptId: "attempt-1",
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 25,
				cacheWriteTokens: 10,
				totalTokens: 185,
				costUsd: 0.1,
				durationMs: 1_000,
				details: { model: "test" },
			});
			ledger.transitionRun({ runId: "run-1", idempotencyKey: "run-succeeded", status: "succeeded" });

			const snapshot = ledger.getRunSnapshot("run-1");
			expect(snapshot.run.status).toBe("succeeded");
			expect(snapshot.workflow?.hash).toBe(workflow.hash);
			expect(snapshot.agentCards).toHaveLength(workflow.agentCards.size);
			expect(snapshot.nodes).toHaveLength(1);
			expect(snapshot.artifacts[0].status).toBe("accepted");
			expect(snapshot.gates).toHaveLength(2);
			expect(snapshot.reviewers).toHaveLength(2);
			expect(snapshot.criteria).toHaveLength(4);
			expect(snapshot.decisions).toHaveLength(1);
			expect(snapshot.escalations[0].status).toBe("answered");
			expect(snapshot.budgetUsage[0].totalTokens).toBe(185);
			expect(snapshot.events.map((event) => event.sequence)).toEqual(snapshot.events.map((_, index) => index + 1));
			expect(ledger.verifyRunConsistency("run-1")).toEqual({ ok: true, diagnostics: [] });
		} finally {
			ledger.close();
		}
	});

	it("makes mutating operations idempotent and rejects key reuse", async () => {
		const databasePath = await createDatabasePath();
		const ledger = new SqliteIpdLedger({ databasePath });
		try {
			const first = createRun(ledger);
			const repeated = createRun(ledger);
			expect(repeated).toEqual(first);
			expect(ledger.getRunSnapshot("run-1").events).toHaveLength(1);

			const transitioned = ledger.transitionRun({
				runId: "run-1",
				idempotencyKey: "same-transition",
				status: "compiling",
			});
			const repeatedTransition = ledger.transitionRun({
				runId: "run-1",
				idempotencyKey: "same-transition",
				status: "compiling",
			});
			expect(repeatedTransition).toEqual(transitioned);
			expect(ledger.getRunSnapshot("run-1").events).toHaveLength(2);

			expectLedgerCode(
				() =>
					ledger.transitionRun({
						runId: "run-1",
						idempotencyKey: "same-transition",
						status: "failed",
					}),
				"idempotency_conflict",
			);
		} finally {
			ledger.close();
		}
	});

	it("rolls back invalid transitions and Gate bypass attempts", async () => {
		const databasePath = await createDatabasePath();
		const workflow = createCompiledWorkflow();
		const cards = createTestCards();
		const ledger = new SqliteIpdLedger({ databasePath });
		try {
			createRun(ledger);
			expectLedgerCode(
				() => ledger.transitionRun({ runId: "run-1", idempotencyKey: "invalid", status: "succeeded" }),
				"invalid_transition",
			);
			expect(ledger.getRunSnapshot("run-1").events).toHaveLength(1);

			ledger.transitionRun({ runId: "run-1", idempotencyKey: "compiling", status: "compiling" });
			ledger.freezeWorkflow({ runId: "run-1", idempotencyKey: "freeze", workflow });
			ledger.createNodeAttempt({
				runId: "run-1",
				idempotencyKey: "attempt-create",
				attemptId: "attempt-1",
				nodeId: "produce",
				attemptNumber: 1,
				agentCardRef: cardRef(cards.executor),
			});
			ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "attempt-ready",
				attemptId: "attempt-1",
				status: "ready",
			});
			ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "attempt-running",
				attemptId: "attempt-1",
				status: "running",
			});
			ledger.recordArtifact({
				runId: "run-1",
				idempotencyKey: "artifact-create",
				artifactId: "artifact-1",
				nodeId: "produce",
				attemptId: "attempt-1",
				contractId: "content-output",
				manifest: { file: "outputs/result.txt" },
			});
			expectLedgerCode(
				() =>
					ledger.transitionArtifact({
						runId: "run-1",
						idempotencyKey: "artifact-bypass",
						artifactId: "artifact-1",
						status: "accepted",
					}),
				"invalid_transition",
			);
			expect(ledger.getRunSnapshot("run-1").artifacts[0].status).toBe("candidate");

			ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "attempt-gate-checking",
				attemptId: "attempt-1",
				status: "gate_checking",
			});
			ledger.createGateRun({
				runId: "run-1",
				idempotencyKey: "gate-create",
				gateRunId: "gate-run-1",
				gateId: "produce-gate",
				nodeId: "produce",
				attemptId: "attempt-1",
				artifactId: "artifact-1",
			});
			ledger.transitionGate({
				runId: "run-1",
				idempotencyKey: "gate-mechanical",
				gateRunId: "gate-run-1",
				status: "mechanical_checking",
			});
			expectLedgerCode(
				() =>
					ledger.transitionGate({
						runId: "run-1",
						idempotencyKey: "gate-semantic-bypass",
						gateRunId: "gate-run-1",
						status: "semantic_reviewing",
					}),
				"invalid_transition",
			);
			ledger.recordCriterionResult({
				runId: "run-1",
				idempotencyKey: "mechanical-result",
				criterionResultId: "mechanical-result",
				gateRunId: "gate-run-1",
				criterionId: "produce-gate-mechanical",
				kind: "mechanical",
				result: "PASS",
				evidence: { report: true },
				rationale: "Mechanical evidence passed",
			});
			ledger.transitionGate({
				runId: "run-1",
				idempotencyKey: "gate-semantic",
				gateRunId: "gate-run-1",
				status: "semantic_reviewing",
			});
			expectLedgerCode(
				() =>
					ledger.transitionGate({
						runId: "run-1",
						idempotencyKey: "gate-pass-bypass",
						gateRunId: "gate-run-1",
						status: "passed",
					}),
				"invalid_transition",
			);
		} finally {
			ledger.close();
		}
	});

	it("keeps candidate, rejected, and accepted Artifact versions across rework Attempts", async () => {
		const databasePath = await createDatabasePath();
		const workflow = createCompiledWorkflow();
		const cards = createTestCards();
		const ledger = new SqliteIpdLedger({ databasePath });
		try {
			freezeRun(ledger, workflow);
			for (const attemptNumber of [1, 2, 3]) {
				const attemptId = `attempt-${attemptNumber}`;
				ledger.createNodeAttempt({
					runId: "run-1",
					idempotencyKey: `${attemptId}-create`,
					attemptId,
					nodeId: "produce",
					attemptNumber,
					agentCardRef: cardRef(cards.executor),
				});
				ledger.transitionNode({
					runId: "run-1",
					idempotencyKey: `${attemptId}-ready`,
					attemptId,
					status: "ready",
				});
				ledger.transitionNode({
					runId: "run-1",
					idempotencyKey: `${attemptId}-running`,
					attemptId,
					status: "running",
				});
				ledger.recordArtifact({
					runId: "run-1",
					idempotencyKey: `artifact-${attemptNumber}-create`,
					artifactId: `artifact-${attemptNumber}`,
					nodeId: "produce",
					attemptId,
					contractId: "content-output",
					manifest: { version: attemptNumber },
				});
				ledger.transitionNode({
					runId: "run-1",
					idempotencyKey: `${attemptId}-gate-checking`,
					attemptId,
					status: "gate_checking",
				});
				if (attemptNumber < 3) {
					ledger.transitionNode({
						runId: "run-1",
						idempotencyKey: `${attemptId}-rework`,
						attemptId,
						status: "rework_pending",
					});
				}
			}
			ledger.transitionArtifact({
				runId: "run-1",
				idempotencyKey: "artifact-1-rejected",
				artifactId: "artifact-1",
				status: "rejected",
			});
			recordPassingGate({
				ledger,
				runId: "run-1",
				gateRunId: "third-gate",
				gateId: "produce-gate",
				reviewerId: "third-reviewer",
				reviewerCard: cards.reviewer,
				nodeId: "produce",
				attemptId: "attempt-3",
				artifactId: "artifact-3",
			});
			ledger.transitionArtifact({
				runId: "run-1",
				idempotencyKey: "artifact-3-accepted",
				artifactId: "artifact-3",
				status: "accepted",
			});

			const statuses = ledger.getRunSnapshot("run-1").artifacts.map((artifact) => artifact.status);
			expect(statuses).toEqual(["rejected", "candidate", "accepted"]);
		} finally {
			ledger.close();
		}
	});

	it("reopens the database with the same authoritative snapshot", async () => {
		const databasePath = await createDatabasePath();
		const workflow = createCompiledWorkflow();
		const first = new SqliteIpdLedger({ databasePath });
		freezeRun(first, workflow);
		const before = first.getRunSnapshot("run-1");
		first.close();

		const reopened = new SqliteIpdLedger({ databasePath });
		try {
			const after = reopened.getRunSnapshot("run-1");
			expect(after).toEqual(before);
			expect(reopened.verifyRunConsistency("run-1")).toEqual({ ok: true, diagnostics: [] });
		} finally {
			reopened.close();
		}
	});

	it("reports persisted sequence corruption", async () => {
		const databasePath = await createDatabasePath();
		const ledger = new SqliteIpdLedger({ databasePath });
		createRun(ledger);
		ledger.close();

		const raw = new DatabaseSync(databasePath);
		raw.prepare("UPDATE run_sequences SET next_sequence = 99 WHERE run_id = ?").run("run-1");
		raw.close();

		const reopened = new SqliteIpdLedger({ databasePath });
		try {
			const report = reopened.verifyRunConsistency("run-1");
			expect(report.ok).toBe(false);
			expect(report.diagnostics.map((item) => item.code)).toContain("ledger_inconsistent");
		} finally {
			reopened.close();
		}
	});
});
