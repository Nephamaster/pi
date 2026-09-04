import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CompiledAgentCard,
	type CompiledWorkflow,
	compileWorkflow,
	createSkillSnapshot,
	type DecisionNodeRunInput,
	type DecisionNodeRunResult,
	type ExecutionNodeRunInput,
	type ExecutionNodeRunResult,
	type GateCriterionEvaluation,
	type GateEvaluationInput,
	type GateEvaluationResult,
	type GateEvaluator,
	GraphEngine,
	type NodeRunner,
	SqliteIpdLedger,
	StaffBudgetController,
	type StaffDecisionSubmission,
	type WorkflowDefinition,
} from "../src/index.ts";
import {
	cardRef,
	compileCard,
	createCompileContext,
	createTestCards,
	createValidWorkflow,
	TEST_SKILL,
} from "./fixtures.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeNodeRunner implements NodeRunner {
	readonly calls: Array<{
		nodeId: string;
		attemptId: string;
		inputArtifactIds: string[];
		reworkInstructions: string[];
		tokenBudget?: number;
	}> = [];
	readonly decisionCalls: DecisionNodeRunInput[] = [];
	readonly events: string[] = [];
	readonly aborted: string[] = [];
	maxActive = 0;
	private active = 0;
	private readonly barrierNodes: Set<string>;
	private barrierReleased = false;
	private readonly barrierWaiters: Array<() => void> = [];
	private readonly blockedNodes: Set<string>;
	private readonly failureOnceNodes: Set<string>;
	private readonly providerFailureOnceNodes: Set<string>;
	private readonly toolLimitOnceNodes: Set<string>;
	private readonly configurationFailureOnceNodes: Set<string>;
	private readonly blockedWaiters = new Map<string, () => void>();
	private readonly delayMs: number;
	private readonly staffSubmission?: StaffDecisionSubmission;

	constructor(options: {
		workspace: string;
		barrierNodes?: string[];
		blockedNodes?: string[];
		failureOnceNodes?: string[];
		providerFailureOnceNodes?: string[];
		toolLimitOnceNodes?: string[];
		configurationFailureOnceNodes?: string[];
		delayMs?: number;
		staffSubmission?: StaffDecisionSubmission;
	}) {
		this.barrierNodes = new Set(options.barrierNodes ?? []);
		this.blockedNodes = new Set(options.blockedNodes ?? []);
		this.failureOnceNodes = new Set(options.failureOnceNodes ?? []);
		this.providerFailureOnceNodes = new Set(options.providerFailureOnceNodes ?? []);
		this.toolLimitOnceNodes = new Set(options.toolLimitOnceNodes ?? []);
		this.configurationFailureOnceNodes = new Set(options.configurationFailureOnceNodes ?? []);
		this.delayMs = options.delayMs ?? 0;
		this.staffSubmission = options.staffSubmission;
	}

	async runExecutionNode(input: ExecutionNodeRunInput): Promise<ExecutionNodeRunResult> {
		this.calls.push({
			nodeId: input.node.id,
			attemptId: input.attemptId,
			inputArtifactIds: input.inputArtifacts.map((artifact) => artifact.id),
			reworkInstructions: [...input.reworkInstructions],
			tokenBudget: input.tokenBudget,
		});
		this.events.push(`start:${input.node.id}:${input.attemptId}`);
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			await this.waitAtBarrier(input.node.id);
			if (this.blockedNodes.has(input.node.id) && !input.signal?.aborted) {
				await new Promise<void>((resolve) => {
					this.blockedWaiters.set(input.attemptId, resolve);
					input.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
			}
			if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
			if (input.signal?.aborted || this.aborted.includes(input.attemptId)) {
				return {
					ok: false,
					failure: { code: "aborted", message: "Fake Node aborted" },
					trace: this.trace(input),
				};
			}
			if (this.failureOnceNodes.delete(input.node.id)) {
				return {
					ok: false,
					failure: { code: "blocked", message: `Missing information for ${input.node.id}` },
					trace: this.trace(input),
				};
			}
			if (this.providerFailureOnceNodes.delete(input.node.id)) {
				return {
					ok: false,
					failure: { code: "provider_error", message: `Provider failed for ${input.node.id}` },
					trace: this.trace(input),
				};
			}
			if (this.toolLimitOnceNodes.delete(input.node.id)) {
				return {
					ok: false,
					failure: { code: "tool_limit_exceeded", message: `Tool limit reached for ${input.node.id}` },
					trace: this.trace(input),
				};
			}
			if (this.configurationFailureOnceNodes.delete(input.node.id)) {
				return {
					ok: false,
					failure: { code: "configuration_error", message: `Invalid configuration for ${input.node.id}` },
					trace: this.trace(input),
				};
			}
			const outputDirectory = input.node.permissions.writeScopes[0] ?? "outputs";
			await mkdir(join(input.cwd, outputDirectory), { recursive: true });
			const primary = `${outputDirectory}/${input.node.id}-${input.attemptId}-primary.txt`;
			const review = `${outputDirectory}/${input.node.id}-${input.attemptId}-review.txt`;
			await writeFile(join(input.cwd, primary), `primary:${input.node.id}:${input.attemptId}`);
			await writeFile(join(input.cwd, review), `review:${input.node.id}:${input.attemptId}`);
			return {
				ok: true,
				submission: {
					id: `candidate:${input.attemptId}`,
					runId: input.runId,
					nodeId: input.node.id,
					attemptId: input.attemptId,
					contractId: input.node.output.id,
					createdAt: 1,
					inputs: input.inputArtifacts.map((artifact) => artifact.id),
					files: [
						{ path: primary, mimeType: "text/plain" },
						{ path: review, mimeType: "text/plain" },
					],
					metadata: {},
				},
				trace: this.trace(input),
			};
		} finally {
			this.active--;
			this.events.push(`end:${input.node.id}:${input.attemptId}`);
		}
	}

	async runDecisionNode(input: DecisionNodeRunInput): Promise<DecisionNodeRunResult> {
		this.decisionCalls.push(input);
		if (input.kind === "staff" && this.staffSubmission) {
			return { ok: true, kind: input.kind, submission: this.staffSubmission, trace: this.trace(input) };
		}
		return {
			ok: false,
			kind: input.kind,
			failure: { code: "configuration_error", message: "FakeNodeRunner does not run Decision Nodes" },
			trace: this.trace(input),
		};
	}

	async abort(instanceId: string): Promise<void> {
		this.aborted.push(instanceId);
		this.blockedWaiters.get(instanceId)?.();
	}

	private trace(input: ExecutionNodeRunInput | DecisionNodeRunInput) {
		return {
			runId: input.runId,
			instanceId: input.instanceId,
			provider: input.runDefaultModel.provider,
			model: input.runDefaultModel.id,
			startedAt: 1,
			endedAt: 2,
			durationMs: 1,
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 0,
				costUsd: 0,
				toolCalls: 0,
			},
		};
	}

	private async waitAtBarrier(nodeId: string): Promise<void> {
		if (!this.barrierNodes.has(nodeId) || this.barrierReleased) return;
		await new Promise<void>((resolve) => {
			this.barrierWaiters.push(resolve);
			const started = new Set(
				this.calls.filter((call) => this.barrierNodes.has(call.nodeId)).map((call) => call.nodeId),
			);
			if (started.size === this.barrierNodes.size) {
				this.barrierReleased = true;
				for (const release of this.barrierWaiters.splice(0)) release();
			}
		});
	}
}

class FakeStaffDecisionRunner implements NodeRunner {
	readonly calls: DecisionNodeRunInput[] = [];
	private readonly submissions: StaffDecisionSubmission[];

	constructor(submission: StaffDecisionSubmission | StaffDecisionSubmission[]) {
		this.submissions = Array.isArray(submission) ? [...submission] : [submission];
	}

	async runExecutionNode(input: ExecutionNodeRunInput): Promise<ExecutionNodeRunResult> {
		return {
			ok: false,
			failure: { code: "configuration_error", message: "Budget runner does not execute Nodes" },
			trace: this.trace(input),
		};
	}

	async runDecisionNode(input: DecisionNodeRunInput): Promise<DecisionNodeRunResult> {
		this.calls.push(input);
		if (input.kind !== "staff") {
			return {
				ok: false,
				kind: input.kind,
				failure: { code: "configuration_error", message: "Budget runner only handles Staff Decisions" },
				trace: this.trace(input),
			};
		}
		const submission = this.submissions[Math.min(this.calls.length - 1, this.submissions.length - 1)];
		return { ok: true, kind: input.kind, submission, trace: this.trace(input) };
	}

	async abort(): Promise<void> {}

	private trace(input: ExecutionNodeRunInput | DecisionNodeRunInput) {
		return {
			runId: input.runId,
			instanceId: input.instanceId,
			provider: input.runDefaultModel.provider,
			model: input.runDefaultModel.id,
			startedAt: 1,
			endedAt: 2,
			durationMs: 1,
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 0,
				costUsd: 0,
				toolCalls: 1,
			},
		};
	}
}

class FakeGateEvaluator implements GateEvaluator {
	readonly calls: string[] = [];
	readonly reviewerTokenBudgets: Array<number | undefined> = [];
	readonly aborted: string[] = [];
	private readonly reviewer: CompiledAgentCard;
	private readonly decisions = new Map<string, GateEvaluationResult["decision"][]>();

	constructor(reviewer: CompiledAgentCard) {
		this.reviewer = reviewer;
	}

	setDecisions(key: string, decisions: GateEvaluationResult["decision"][]): void {
		this.decisions.set(key, [...decisions]);
	}

	async evaluate(input: GateEvaluationInput): Promise<GateEvaluationResult> {
		const key = input.node?.id ?? "final";
		this.calls.push(key);
		this.reviewerTokenBudgets.push(input.reviewerTokenBudget);
		const decision = this.decisions.get(key)?.shift() ?? "PASS";
		const mechanical = input.gate.mechanicalCriteria.map((criterion) => ({
			criterionId: criterion.id,
			result: "PASS" as const,
			evidence: { check: criterion.checkId },
			rationale: "Mechanical criterion passed",
		}));
		const semanticResult: GateCriterionEvaluation["result"] =
			decision === "PASS" ? "PASS" : decision === "BLOCKED" ? "BLOCKED" : "FAIL";
		const semantic = input.gate.semanticCriteria.map((criterion) => ({
			criterionId: criterion.id,
			result: semanticResult,
			evidence: { artifactIds: input.artifacts.map((artifact) => artifact.manifest.id) },
			rationale: `Semantic criterion returned ${semanticResult}`,
			reviewerAgentCardRef: cardRef(this.reviewer),
			reviewerInstanceId: `${input.gateRunId}:fake-reviewer`,
			reviewerResult: { decision: semanticResult },
		}));
		return {
			decision,
			mechanical,
			semantic,
			feedback: decision === "PASS" ? [] : [`${key} requires rework`],
			evidence: { decision },
		};
	}

	async abort(gateRunId: string): Promise<void> {
		this.aborted.push(gateRunId);
	}
}

async function createFixture(options?: {
	workflow?: (workflow: WorkflowDefinition, cards: ReturnType<typeof createTestCards>) => void;
	barrierNodes?: string[];
	blockedNodes?: string[];
	failureOnceNodes?: string[];
	providerFailureOnceNodes?: string[];
	toolLimitOnceNodes?: string[];
	configurationFailureOnceNodes?: string[];
	staffSubmission?: StaffDecisionSubmission;
	delayMs?: number;
	executorCard?: CompiledAgentCard;
}) {
	const root = await mkdtemp(join(tmpdir(), "pi-ipd-graph-"));
	roots.push(root);
	const cards = createTestCards();
	if (options?.executorCard) cards.executor = options.executorCard;
	const skill = createSkillSnapshot({
		name: TEST_SKILL,
		path: join(root, "SKILL.md"),
		baseDir: root,
		content: "Execute the controlled test Workflow.",
	});
	const workflow = createValidWorkflow(cards);
	workflow.skill = { name: skill.name, hash: skill.hash };
	options?.workflow?.(workflow, cards);
	const compileContext = createCompileContext(cards);
	compileContext.runSkill = { name: skill.name, hash: skill.hash };
	const compiledResult = compileWorkflow(workflow, compileContext);
	if (!compiledResult.ok) throw new Error(compiledResult.diagnostics.map((item) => item.message).join("\n"));
	const compiled: CompiledWorkflow = compiledResult.value;
	const ledger = new SqliteIpdLedger({ databasePath: join(root, "ipd.sqlite") });
	ledger.createRun({
		runId: "run-1",
		traceId: "trace-1",
		idempotencyKey: "create-run",
		task: "Execute the test Workflow",
		skill: { name: skill.name, hash: skill.hash },
		globalBudget: { tokens: 100_000 },
	});
	ledger.transitionRun({ runId: "run-1", idempotencyKey: "compiling", status: "compiling" });
	ledger.freezeWorkflow({ runId: "run-1", idempotencyKey: "freeze", workflow: compiled });
	const nodeRunner = new FakeNodeRunner({
		workspace: root,
		barrierNodes: options?.barrierNodes,
		blockedNodes: options?.blockedNodes,
		failureOnceNodes: options?.failureOnceNodes,
		providerFailureOnceNodes: options?.providerFailureOnceNodes,
		toolLimitOnceNodes: options?.toolLimitOnceNodes,
		configurationFailureOnceNodes: options?.configurationFailureOnceNodes,
		delayMs: options?.delayMs,
		staffSubmission: options?.staffSubmission,
	});
	const gateEvaluator = new FakeGateEvaluator(cards.reviewer);
	const engine = new GraphEngine({ ledger, nodeRunner, gateEvaluator });
	const context = {
		cwd: root,
		skill,
		runDefaultModel: fauxProvider().getModel(),
		runDefaultThinkingLevel: "off" as const,
	};
	return { root, cards, skill, workflow, compiled, ledger, nodeRunner, gateEvaluator, engine, context };
}

function cloneNode(workflow: WorkflowDefinition, id: string, artifactType: string, writeScopes: string[]) {
	const node = structuredClone(workflow.nodes[0]);
	node.id = id;
	node.objective = `Produce ${id}`;
	node.output.id = `${id}-output`;
	node.output.artifactType = artifactType;
	node.knowledgeBaseRefs = [];
	node.permissions.writeScopes = writeScopes;
	node.gate.id = `${id}-gate`;
	node.gate.mechanicalCriteria[0].id = `${id}-mechanical`;
	node.gate.semanticCriteria[0].id = `${id}-semantic`;
	node.gate.reviewers[0].id = `${id}-reviewer`;
	node.gate.routes.rework = id;
	node.rework.targetNodeId = id;
	return node;
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Condition was not reached");
}

function recordSyntheticUsage(ledger: SqliteIpdLedger, totalTokens: number, usageId = "synthetic-usage"): void {
	ledger.recordBudgetUsage({
		runId: "run-1",
		idempotencyKey: `test:usage:${usageId}`,
		usageId,
		category: "execution",
		inputTokens: totalTokens,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens,
		costUsd: 0,
		durationMs: 1,
		details: { source: "test" },
	});
}

describe("GraphEngine", () => {
	it("runs a single-node Workflow through its node Gate and final Gate", async () => {
		const fixture = await createFixture();
		try {
			const result = await fixture.engine.run("run-1", fixture.context);
			expect(result.status).toBe("succeeded");
			expect(result.snapshot.nodes.map((node) => node.status)).toEqual(["succeeded"]);
			expect(result.snapshot.artifacts.map((artifact) => artifact.status)).toEqual(["accepted"]);
			expect(result.snapshot.gates.map((gate) => gate.status)).toEqual(["passed", "passed"]);
			expect(
				existsSync(
					join(
						fixture.root,
						".pi",
						"ipd",
						"runs",
						"run-1",
						"final",
						"produce",
						"outputs",
						"produce-run-1:node:produce:attempt:1-primary.txt",
					),
				),
			).toBe(true);
			expect(fixture.ledger.verifyRunConsistency("run-1")).toEqual({ ok: true, diagnostics: [] });
		} finally {
			fixture.ledger.close();
		}
	});

	it("fans out non-conflicting work in parallel and waits before convergence", async () => {
		const fixture = await createFixture({
			barrierNodes: ["alpha", "beta"],
			workflow(workflow) {
				const alpha = cloneNode(workflow, "alpha", "alpha", ["outputs/alpha"]);
				const beta = cloneNode(workflow, "beta", "beta", ["outputs/beta"]);
				const merge = cloneNode(workflow, "merge", "merged", ["outputs/merge"]);
				alpha.permissions.readScopes = ["."];
				beta.permissions.readScopes = ["."];
				merge.permissions.readScopes = ["outputs/alpha", "outputs/beta"];
				merge.dependsOn = ["alpha", "beta"];
				merge.inputs = [
					{ name: "alpha", fromNodeId: "alpha", artifactType: "alpha", required: true },
					{ name: "beta", fromNodeId: "beta", artifactType: "beta", required: true },
				];
				workflow.nodes = [alpha, beta, merge];
				workflow.finalArtifactNodeIds = ["merge"];
				workflow.finalGate.routes.rework = "merge";
			},
		});
		try {
			const result = await fixture.engine.run("run-1", fixture.context);
			expect(result.status).toBe("succeeded");
			expect(fixture.nodeRunner.maxActive).toBeGreaterThanOrEqual(2);
			const mergeStart = fixture.nodeRunner.events.findIndex((event) => event.startsWith("start:merge:"));
			const alphaEnd = fixture.nodeRunner.events.findIndex((event) => event.startsWith("end:alpha:"));
			const betaEnd = fixture.nodeRunner.events.findIndex((event) => event.startsWith("end:beta:"));
			expect(mergeStart).toBeGreaterThan(alphaEnd);
			expect(mergeStart).toBeGreaterThan(betaEnd);
			const mergeCall = fixture.nodeRunner.calls.find((call) => call.nodeId === "merge");
			expect(mergeCall?.inputArtifactIds).toHaveLength(2);
		} finally {
			fixture.ledger.close();
		}
	});

	it("does not serialize non-conflicting writers merely because one Node uses Bash", async () => {
		const bashExecutor = compileCard({
			id: "bash-executor",
			name: "Bash Executor",
			description: "Produces an isolated Artifact with approved local commands",
			responsibilities: ["Produce the assigned Artifact"],
			nonResponsibilities: ["Approve its own Artifact"],
			capabilities: ["content"],
			tools: ["read", "write", "bash"],
			permissions: {
				workspace: "write",
				readScopes: ["."],
				writeScopes: ["outputs"],
				externalActions: false,
			},
		});
		const fixture = await createFixture({
			executorCard: bashExecutor,
			barrierNodes: ["data", "design"],
			workflow(workflow) {
				const data = cloneNode(workflow, "data", "data", ["outputs/data"]);
				const design = cloneNode(workflow, "design", "design", ["outputs/design"]);
				data.tools = ["read", "write", "bash"];
				workflow.nodes = [data, design];
				workflow.finalArtifactNodeIds = ["data", "design"];
				workflow.finalGate.routes.rework = "data";
			},
		});
		try {
			const result = await fixture.engine.run("run-1", fixture.context);
			expect(result.status).toBe("succeeded");
			expect(fixture.nodeRunner.maxActive).toBeGreaterThanOrEqual(2);
		} finally {
			fixture.ledger.close();
		}
	});

	it("serializes conflicting writers", async () => {
		const fixture = await createFixture({
			delayMs: 10,
			workflow(workflow) {
				const alpha = cloneNode(workflow, "alpha", "alpha", ["outputs"]);
				const beta = cloneNode(workflow, "beta", "beta", ["outputs"]);
				workflow.nodes = [alpha, beta];
				workflow.finalArtifactNodeIds = ["alpha", "beta"];
				workflow.finalGate.routes.rework = "alpha";
			},
		});
		try {
			const result = await fixture.engine.run("run-1", fixture.context);
			expect(result.status).toBe("succeeded");
			expect(fixture.nodeRunner.maxActive).toBe(1);
		} finally {
			fixture.ledger.close();
		}
	});

	it("keeps a candidate private, reworks it, and unlocks downstream only after PASS", async () => {
		const fixture = await createFixture({
			workflow(workflow) {
				const upstream = cloneNode(workflow, "upstream", "upstream", ["outputs/upstream"]);
				upstream.rework.maxAttempts = 2;
				const downstream = cloneNode(workflow, "downstream", "downstream", ["outputs/downstream"]);
				downstream.dependsOn = ["upstream"];
				downstream.inputs = [
					{ name: "upstream", fromNodeId: "upstream", artifactType: "upstream", required: true },
				];
				workflow.nodes = [upstream, downstream];
				workflow.finalArtifactNodeIds = ["downstream"];
				workflow.finalGate.routes.rework = "downstream";
			},
		});
		fixture.gateEvaluator.setDecisions("upstream", ["REWORK", "PASS"]);
		try {
			const result = await fixture.engine.run("run-1", fixture.context);
			expect(result.status).toBe("succeeded");
			const upstreamAttempts = result.snapshot.nodes.filter((node) => node.nodeId === "upstream");
			expect(upstreamAttempts.map((node) => node.status)).toEqual(["rework_pending", "succeeded"]);
			expect(upstreamAttempts[0].error).toMatchObject({ category: "quality_failure" });
			expect(
				result.snapshot.artifacts
					.filter((artifact) => artifact.nodeId === "upstream")
					.map((artifact) => artifact.status),
			).toEqual(["rejected", "accepted"]);
			const downstreamCall = fixture.nodeRunner.calls.find((call) => call.nodeId === "downstream");
			expect(downstreamCall?.inputArtifactIds).toEqual(["run-1:node:upstream:attempt:2:artifact"]);
			expect(fixture.nodeRunner.calls.filter((call) => call.nodeId === "upstream")[1].reworkInstructions).toEqual([
				"upstream requires rework",
			]);
			const rejectedAttemptId = "run-1:node:upstream:attempt:1";
			const acceptedAttemptId = "run-1:node:upstream:attempt:2";
			expect(
				existsSync(
					join(
						fixture.root,
						".pi",
						"ipd",
						"runs",
						"run-1",
						"workspace",
						"outputs",
						"upstream",
						`upstream-${rejectedAttemptId}-primary.txt`,
					),
				),
			).toBe(false);
			expect(
				existsSync(
					join(
						fixture.root,
						".pi",
						"ipd",
						"runs",
						"run-1",
						"work",
						"upstream",
						"attempt-1",
						"workspace",
						"outputs",
						"upstream",
						`upstream-${rejectedAttemptId}-primary.txt`,
					),
				),
			).toBe(true);
			expect(
				existsSync(
					join(
						fixture.root,
						".pi",
						"ipd",
						"runs",
						"run-1",
						"workspace",
						"outputs",
						"upstream",
						`upstream-${acceptedAttemptId}-primary.txt`,
					),
				),
			).toBe(true);
		} finally {
			fixture.ledger.close();
		}
	});

	it("persists technical failure separately from quality and blocked routes", async () => {
		const fixture = await createFixture({
			providerFailureOnceNodes: ["produce"],
			workflow(workflow) {
				workflow.nodes[0].rework.maxAttempts = 1;
			},
		});
		try {
			const result = await fixture.engine.run("run-1", fixture.context);
			expect(result.status).toBe("failed");
			expect(result.snapshot.nodes).toHaveLength(1);
			expect(result.snapshot.nodes[0]).toMatchObject({ status: "failed" });
			expect(result.snapshot.nodes[0].error).toMatchObject({ category: "provider_error" });
		} finally {
			fixture.ledger.close();
		}
	});

	it("retries a retryable technical failure from the running state", async () => {
		const fixture = await createFixture({ providerFailureOnceNodes: ["produce"] });
		try {
			const result = await fixture.engine.run("run-1", fixture.context);
			expect(result.status).toBe("succeeded");
			expect(result.snapshot.nodes.map((node) => node.status)).toEqual(["rework_pending", "succeeded"]);
			expect(result.snapshot.nodes[0].error).toMatchObject({ category: "provider_error", retryable: true });
			expect(fixture.nodeRunner.calls).toHaveLength(2);
		} finally {
			fixture.ledger.close();
		}
	});

	it("retries a Tool-limit failure while Attempts remain instead of requesting a Workflow amendment", async () => {
		const fixture = await createFixture({ toolLimitOnceNodes: ["produce"] });
		try {
			const result = await fixture.engine.run("run-1", fixture.context);
			expect(result.status).toBe("succeeded");
			expect(result.snapshot.nodes.map((node) => node.status)).toEqual(["rework_pending", "succeeded"]);
			expect(result.snapshot.nodes[0].error).toMatchObject({
				code: "tool_limit_exceeded",
				category: "tool_error",
				retryable: true,
			});
			expect(result.snapshot.escalations).toEqual([]);
			expect(result.snapshot.decisions).not.toContainEqual(
				expect.objectContaining({ type: "workflow_amendment_request" }),
			);
		} finally {
			fixture.ledger.close();
		}
	});

	it("does not mislabel a non-retryable early failure as exhausted Attempts", async () => {
		const fixture = await createFixture({ configurationFailureOnceNodes: ["produce"] });
		try {
			const result = await fixture.engine.run("run-1", fixture.context);
			expect(result.status).toBe("failed");
			expect(result.snapshot.nodes).toHaveLength(1);
			expect(result.snapshot.run.failure).toMatchObject({
				code: "configuration_error",
				category: "validation_error",
			});
			expect(result.snapshot.escalations).toEqual([]);
			expect(result.snapshot.decisions).not.toContainEqual(
				expect.objectContaining({ type: "workflow_amendment_request" }),
			);
		} finally {
			fixture.ledger.close();
		}
	});

	it("routes exhausted Attempts to failure", async () => {
		const fixture = await createFixture({
			workflow(workflow) {
				workflow.nodes[0].rework.maxAttempts = 1;
			},
		});
		fixture.gateEvaluator.setDecisions("produce", ["REWORK"]);
		try {
			const result = await fixture.engine.run("run-1", fixture.context);
			expect(result.status).toBe("failed");
			expect(result.snapshot.nodes[0].status).toBe("failed");
		} finally {
			fixture.ledger.close();
		}
	});

	it("routes exhausted Attempts to a stable user wait when configured", async () => {
		const fixture = await createFixture({
			workflow(workflow) {
				workflow.nodes[0].rework.maxAttempts = 1;
				workflow.nodes[0].routes.exhausted = "user";
			},
		});
		fixture.gateEvaluator.setDecisions("produce", ["REWORK"]);
		try {
			const result = await fixture.engine.run("run-1", fixture.context);
			expect(result.status).toBe("waiting_user");
			expect(result.snapshot.escalations).toHaveLength(1);
			expect(result.snapshot.escalations[0].target).toBe("user");
			await expect(
				fixture.engine.resume(
					"run-1",
					result.snapshot.escalations[0].id,
					"retry_node",
					"Retry beyond the frozen limit",
					fixture.context,
				),
			).rejects.toMatchObject({ code: "invalid_resume" });
			expect(fixture.ledger.getRunSnapshot("run-1").escalations[0].status).toBe("open");
			const resumed = await fixture.engine.resume(
				"run-1",
				result.snapshot.escalations[0].id,
				"request_replan",
				"Create a revised Workflow instead of exceeding the frozen Attempt limit",
				fixture.context,
			);
			expect(resumed.status).toBe("replanning");
			expect(resumed.snapshot.run.failure).toBeUndefined();
			expect(resumed.snapshot.decisions).toContainEqual(
				expect.objectContaining({ type: "workflow_amendment_request", action: "request_replan" }),
			);
			expect(resumed.snapshot.nodes).toHaveLength(1);
		} finally {
			fixture.ledger.close();
		}
	});

	it("routes exhausted Staff governance to replan without creating an impossible retry", async () => {
		const fixture = await createFixture({
			staffSubmission: {
				action: "request_replan",
				rationale: "The frozen Attempt limit is exhausted; create a new Workflow version",
				evidence: { next: "replan" },
			},
			workflow(workflow) {
				workflow.nodes[0].rework.maxAttempts = 1;
				workflow.nodes[0].routes.exhausted = "staff";
			},
		});
		fixture.gateEvaluator.setDecisions("produce", ["REWORK"]);
		try {
			const result = await fixture.engine.run("run-1", fixture.context);
			expect(result.status).toBe("replanning");
			expect(result.snapshot.run.failure).toBeUndefined();
			expect(result.snapshot.decisions).toContainEqual(
				expect.objectContaining({
					type: "attempts_exhausted_resolution",
					action: "request_replan",
				}),
			);
			expect(result.snapshot.decisions).toContainEqual(
				expect.objectContaining({ type: "workflow_amendment_request", action: "request_replan" }),
			);
			expect(result.snapshot.escalations).toEqual([]);
		} finally {
			fixture.ledger.close();
		}
	});

	it("cancels active work and never starts downstream Nodes", async () => {
		const fixture = await createFixture({
			blockedNodes: ["upstream"],
			workflow(workflow) {
				const upstream = cloneNode(workflow, "upstream", "upstream", ["outputs/upstream"]);
				const downstream = cloneNode(workflow, "downstream", "downstream", ["outputs/downstream"]);
				downstream.dependsOn = ["upstream"];
				downstream.inputs = [
					{ name: "upstream", fromNodeId: "upstream", artifactType: "upstream", required: true },
				];
				workflow.nodes = [upstream, downstream];
				workflow.finalArtifactNodeIds = ["downstream"];
				workflow.finalGate.routes.rework = "downstream";
			},
		});
		try {
			const running = fixture.engine.run("run-1", fixture.context);
			await waitForCondition(() => fixture.nodeRunner.calls.some((call) => call.nodeId === "upstream"));
			const result = await fixture.engine.cancel("run-1", "Test cancellation");
			await running;
			expect(result.status).toBe("cancelled");
			expect(fixture.nodeRunner.calls.map((call) => call.nodeId)).toEqual(["upstream"]);
			expect(result.snapshot.nodes[0].status).toBe("cancelled");
		} finally {
			fixture.ledger.close();
		}
	});

	it("marks interrupted read-only work and safely creates a new Attempt", async () => {
		const readOnlyExecutor = compileCard({
			id: "executor",
			name: "Read-only Executor",
			description: "Produces a deterministic read-only result",
			responsibilities: ["Produce output"],
			nonResponsibilities: [],
			capabilities: ["content"],
			tools: ["read"],
		});
		const fixture = await createFixture({
			executorCard: readOnlyExecutor,
			workflow(workflow) {
				workflow.nodes[0].tools = ["read"];
				workflow.nodes[0].permissions = {
					workspace: "read",
					readScopes: ["."],
					writeScopes: [],
					externalActions: false,
				};
			},
		});
		try {
			fixture.ledger.transitionRun({ runId: "run-1", idempotencyKey: "start-before-crash", status: "running" });
			fixture.ledger.createNodeAttempt({
				runId: "run-1",
				idempotencyKey: "attempt-1-create",
				attemptId: "run-1:node:produce:attempt:1",
				nodeId: "produce",
				attemptNumber: 1,
				agentCardRef: cardRef(readOnlyExecutor),
			});
			fixture.ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "attempt-1-ready",
				attemptId: "run-1:node:produce:attempt:1",
				status: "ready",
			});
			fixture.ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "attempt-1-running",
				attemptId: "run-1:node:produce:attempt:1",
				status: "running",
			});

			const result = await fixture.engine.run("run-1", fixture.context);
			expect(result.status).toBe("succeeded");
			expect(result.snapshot.nodes.map((node) => node.status)).toEqual(["interrupted", "succeeded"]);
			expect(result.snapshot.nodes.map((node) => node.attemptNumber)).toEqual([1, 2]);
		} finally {
			fixture.ledger.close();
		}
	});

	it("replays interrupted Run-workspace writes in a new Attempt", async () => {
		const fixture = await createFixture({
			workflow(workflow) {
				workflow.nodes[0].rework.maxAttempts = 1;
			},
		});
		try {
			fixture.ledger.transitionRun({ runId: "run-1", idempotencyKey: "start-before-crash", status: "running" });
			fixture.ledger.createNodeAttempt({
				runId: "run-1",
				idempotencyKey: "attempt-1-create",
				attemptId: "run-1:node:produce:attempt:1",
				nodeId: "produce",
				attemptNumber: 1,
				agentCardRef: fixture.workflow.nodes[0].agentCardRef,
			});
			fixture.ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "attempt-1-ready",
				attemptId: "run-1:node:produce:attempt:1",
				status: "ready",
			});
			fixture.ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "attempt-1-running",
				attemptId: "run-1:node:produce:attempt:1",
				status: "running",
			});

			const result = await fixture.engine.run("run-1", fixture.context);
			expect(result.status).toBe("succeeded");
			expect(result.snapshot.nodes.map((node) => node.status)).toEqual(["interrupted", "succeeded"]);
			expect(fixture.nodeRunner.calls).toHaveLength(1);
		} finally {
			fixture.ledger.close();
		}
	});

	it("requires reconciliation before replaying an interrupted external action", async () => {
		const externalExecutor = compileCard({
			id: "executor",
			name: "External Executor",
			description: "Produces an artifact after an approved external action",
			responsibilities: ["Perform the approved action and record its result"],
			nonResponsibilities: ["Approve its own artifact"],
			capabilities: ["content"],
			tools: ["read", "write"],
			permissions: {
				workspace: "write",
				readScopes: ["."],
				writeScopes: ["outputs"],
				externalActions: true,
			},
		});
		const fixture = await createFixture({
			executorCard: externalExecutor,
			workflow(workflow) {
				workflow.nodes[0].permissions.externalActions = true;
			},
		});
		try {
			fixture.ledger.transitionRun({ runId: "run-1", idempotencyKey: "start-before-crash", status: "running" });
			fixture.ledger.createNodeAttempt({
				runId: "run-1",
				idempotencyKey: "attempt-1-create",
				attemptId: "run-1:node:produce:attempt:1",
				nodeId: "produce",
				attemptNumber: 1,
				agentCardRef: cardRef(externalExecutor),
			});
			fixture.ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "attempt-1-ready",
				attemptId: "run-1:node:produce:attempt:1",
				status: "ready",
			});
			fixture.ledger.transitionNode({
				runId: "run-1",
				idempotencyKey: "attempt-1-running",
				attemptId: "run-1:node:produce:attempt:1",
				status: "running",
			});

			const waiting = await fixture.engine.run("run-1", fixture.context);
			expect(waiting.status).toBe("waiting_user");
			expect(fixture.nodeRunner.calls).toEqual([]);
			expect(waiting.snapshot.escalations[0]).toMatchObject({
				target: "user",
				context: { reason: "unknown_outcome", externalActions: true },
			});

			const resumed = await fixture.engine.resume(
				"run-1",
				waiting.snapshot.escalations[0].id,
				"retry_node",
				"The prior action did not complete; reconcile state and retry safely",
				fixture.context,
			);
			expect(resumed.status).toBe("succeeded");
			expect(resumed.snapshot.nodes.map((node) => node.status)).toEqual(["interrupted", "succeeded"]);
			expect(fixture.nodeRunner.calls[0].reworkInstructions).toContain(
				"The prior action did not complete; reconcile state and retry safely",
			);
		} finally {
			fixture.ledger.close();
		}
	});

	it("runs blocked work through ST, rejects a mismatched Escalation, and resumes the original Node", async () => {
		const fixture = await createFixture({
			failureOnceNodes: ["produce"],
			staffSubmission: {
				action: "ask_user",
				rationale: "Provide the approved source",
				evidence: { missing: "approved source" },
			},
		});
		try {
			const waiting = await fixture.engine.run("run-1", fixture.context);
			expect(waiting.status).toBe("waiting_user");
			expect(waiting.snapshot.nodes[0].error).toMatchObject({ category: "blocked" });
			expect(fixture.nodeRunner.decisionCalls.map((call) => call.kind)).toEqual(["staff"]);
			const escalation = waiting.snapshot.escalations[0];
			expect(escalation).toMatchObject({ status: "open", target: "user", nodeId: "produce" });

			await expect(
				fixture.engine.resume(
					"run-1",
					"wrong-escalation",
					"retry_node",
					"Use the approved source",
					fixture.context,
				),
			).rejects.toMatchObject({ code: "invalid_resume" });
			expect(fixture.ledger.getRunSnapshot("run-1").run.status).toBe("waiting_user");

			const resumed = await fixture.engine.resume(
				"run-1",
				escalation.id,
				"retry_node",
				"Use the approved source",
				fixture.context,
			);
			expect(resumed.status).toBe("succeeded");
			expect(resumed.snapshot.nodes.map((node) => node.status)).toEqual(["blocked", "succeeded"]);
			expect(fixture.nodeRunner.calls[1].reworkInstructions).toContain("Use the approved source");
			expect(resumed.snapshot.escalations[0]).toMatchObject({
				status: "answered",
				answer: "Use the approved source",
			});
		} finally {
			fixture.ledger.close();
		}
	});

	it("lets ST continue after the soft budget is reached and records the threshold event", async () => {
		const fixture = await createFixture();
		const budgetRunner = new FakeStaffDecisionRunner({
			action: "continue_over_budget",
			rationale: "The remaining work is bounded",
			evidence: {},
		});
		const engine = new GraphEngine({
			ledger: fixture.ledger,
			nodeRunner: fixture.nodeRunner,
			gateEvaluator: fixture.gateEvaluator,
			budgetController: new StaffBudgetController({ ledger: fixture.ledger, nodeRunner: budgetRunner }),
		});
		recordSyntheticUsage(fixture.ledger, 100_000);
		try {
			const result = await engine.run("run-1", fixture.context);
			expect(result.status).toBe("succeeded");
			expect(budgetRunner.calls).toHaveLength(1);
			expect(result.snapshot.decisions).toContainEqual(
				expect.objectContaining({ type: "budget_control_100", action: "continue_over_budget" }),
			);
			expect(result.snapshot.events.map((event) => event.type)).toContain("budget_reached");
		} finally {
			fixture.ledger.close();
		}
	});

	it("applies an ST reduction to subsequent Reviewer token budgets", async () => {
		const fixture = await createFixture();
		const budgetRunner = new FakeStaffDecisionRunner({
			action: "reduce_future_budget",
			rationale: "Use a smaller bounded review context",
			evidence: { reviewerTokenBudget: 1_234 },
		});
		const engine = new GraphEngine({
			ledger: fixture.ledger,
			nodeRunner: fixture.nodeRunner,
			gateEvaluator: fixture.gateEvaluator,
			budgetController: new StaffBudgetController({ ledger: fixture.ledger, nodeRunner: budgetRunner }),
		});
		recordSyntheticUsage(fixture.ledger, 80_000);
		try {
			const result = await engine.run("run-1", fixture.context);
			expect(result.status).toBe("succeeded");
			expect(fixture.gateEvaluator.reviewerTokenBudgets).toEqual([1_234, 1_234]);
			expect(result.snapshot.events.map((event) => event.type)).toContain("budget_warning");
		} finally {
			fixture.ledger.close();
		}
	});

	it("feeds a soft-budget Escalation answer into a new Staff Decision attempt", async () => {
		const fixture = await createFixture();
		const budgetRunner = new FakeStaffDecisionRunner([
			{
				action: "reduce_future_budget",
				rationale: "Reduce review cost, but the evidence is incomplete",
				evidence: {},
			},
			{
				action: "continue_over_budget",
				rationale: "The user explicitly approved continuing without a review reduction",
				evidence: {},
			},
		]);
		const engine = new GraphEngine({
			ledger: fixture.ledger,
			nodeRunner: fixture.nodeRunner,
			gateEvaluator: fixture.gateEvaluator,
			budgetController: new StaffBudgetController({ ledger: fixture.ledger, nodeRunner: budgetRunner }),
		});
		recordSyntheticUsage(fixture.ledger, 80_000);
		try {
			const waiting = await engine.run("run-1", fixture.context);
			expect(waiting.status).toBe("waiting_user");
			const escalation = waiting.snapshot.escalations[0];
			const resumed = await engine.resume(
				"run-1",
				escalation.id,
				"continue_run",
				"Continue over budget without reducing the Reviewer budget",
				fixture.context,
			);
			expect(resumed.status).toBe("succeeded");
			expect(budgetRunner.calls).toHaveLength(2);
			expect(budgetRunner.calls[0].instanceId).not.toBe(budgetRunner.calls[1].instanceId);
			expect(budgetRunner.calls[1].context).toMatchObject({
				userAnswer: "Continue over budget without reducing the Reviewer budget",
			});
			expect(resumed.snapshot.decisions).toContainEqual(
				expect.objectContaining({ type: "budget_control_80", action: "continue_over_budget" }),
			);
		} finally {
			fixture.ledger.close();
		}
	});

	it("stops before starting a Node when the user Hard Limit is reached", async () => {
		const fixture = await createFixture({
			workflow(workflow) {
				if (workflow.globalBudget.mode === "bounded") workflow.globalBudget.hardTokenLimit = 100_000;
			},
		});
		const budgetRunner = new FakeStaffDecisionRunner({
			action: "continue_over_budget",
			rationale: "This must not be called",
			evidence: {},
		});
		const engine = new GraphEngine({
			ledger: fixture.ledger,
			nodeRunner: fixture.nodeRunner,
			gateEvaluator: fixture.gateEvaluator,
			budgetController: new StaffBudgetController({ ledger: fixture.ledger, nodeRunner: budgetRunner }),
		});
		recordSyntheticUsage(fixture.ledger, 100_000);
		try {
			const result = await engine.run("run-1", fixture.context);
			expect(result.status).toBe("waiting_user");
			expect(fixture.nodeRunner.calls).toEqual([]);
			expect(budgetRunner.calls).toEqual([]);
			expect(result.snapshot.events.map((event) => event.type)).toContain("hard_limit_reached");
			expect(result.snapshot.escalations[0].context).toMatchObject({
				failure: { category: "budget_exceeded" },
			});
			const resumed = await engine.resume(
				"run-1",
				result.snapshot.escalations[0].id,
				"continue_run",
				"Keep the existing absolute limit",
				fixture.context,
			);
			expect(resumed.status).toBe("waiting_user");
			expect(resumed.snapshot.escalations.map((item) => item.status)).toEqual(["answered", "open"]);
			expect(fixture.nodeRunner.calls).toEqual([]);
		} finally {
			fixture.ledger.close();
		}
	});
});
