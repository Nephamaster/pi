import type { NodeRunner, ReviewSubmission } from "../adapter/node-runner.ts";
import { buildReviewBundle, type ReviewBundle } from "../artifact/review-bundle.ts";
import { toJsonValue } from "../ir/hash.ts";
import type { GateDefinition } from "../ir/schemas.ts";
import type { JsonValue } from "../ir/types.ts";
import type { ArtifactViewRegistry } from "../registry/artifact-view-registry.ts";
import { type ReviewerAssignment, ReviewerSelectionError, ReviewerSelector } from "../staff/reviewer-selector.ts";
import { CriterionAggregator } from "./criterion-aggregator.ts";
import type {
	GateCriterionEvaluation,
	GateEvaluationInput,
	GateEvaluationResult,
	GateEvaluator,
} from "./gate-evaluator.ts";
import type { MechanicalChecker } from "./mechanical-checker.ts";

export interface DynamicGateEvaluatorOptions {
	mechanicalChecker: MechanicalChecker;
	artifactViews: ArtifactViewRegistry;
	nodeRunner: NodeRunner;
	reviewerSelector?: ReviewerSelector;
	criterionAggregator?: CriterionAggregator;
	now?: () => number;
}

interface CompletedReview {
	instanceId: string;
	agentCardRef: NonNullable<GateCriterionEvaluation["reviewerAgentCardRef"]>;
	submission: ReviewSubmission;
	trace: NonNullable<GateCriterionEvaluation["reviewerTrace"]>;
}

export class DynamicGateEvaluator implements GateEvaluator {
	private readonly mechanicalChecker: MechanicalChecker;
	private readonly artifactViews: ArtifactViewRegistry;
	private readonly nodeRunner: NodeRunner;
	private readonly reviewerSelector: ReviewerSelector;
	private readonly criterionAggregator: CriterionAggregator;
	private readonly now: () => number;
	private readonly activeReviewers = new Map<string, Set<string>>();

	constructor(options: DynamicGateEvaluatorOptions) {
		this.mechanicalChecker = options.mechanicalChecker;
		this.artifactViews = options.artifactViews;
		this.nodeRunner = options.nodeRunner;
		this.reviewerSelector = options.reviewerSelector ?? new ReviewerSelector();
		this.criterionAggregator = options.criterionAggregator ?? new CriterionAggregator();
		this.now = options.now ?? Date.now;
	}

	async evaluate(input: GateEvaluationInput): Promise<GateEvaluationResult> {
		if (input.artifacts.length === 0) {
			return {
				decision: "BLOCKED",
				mechanical: input.gate.mechanicalCriteria.map((criterion) => ({
					criterionId: criterion.id,
					result: "BLOCKED",
					evidence: { error: "Gate has no Artifact" },
					rationale: "Gate evaluation requires at least one Artifact",
				})),
				semantic: [],
				feedback: ["Provide the required Artifact"],
				evidence: { error: "missing_artifact" },
			};
		}

		const primary = input.artifacts[0];
		const mechanical = await this.mechanicalChecker.evaluate(
			input.gate.mechanicalCriteria,
			{
				workspace: input.cwd,
				contract: primary.contract,
				manifest: primary.manifest,
				artifacts: input.artifacts,
			},
			input.signal,
		);
		const mechanicalCriteria: GateCriterionEvaluation[] = mechanical.criteria.map((criterion) => ({
			criterionId: criterion.criterionId,
			result: criterion.result,
			evidence: criterion.evidence,
			rationale: criterion.message,
		}));
		if (mechanical.result !== "PASS") {
			return {
				decision: mechanical.result === "FAIL" ? "REWORK" : "BLOCKED",
				mechanical: mechanicalCriteria,
				semantic: [],
				feedback: mechanical.criteria.filter((item) => item.result !== "PASS").map((item) => item.message),
				evidence: { mechanical: toJsonValue(mechanical.criteria) },
			};
		}

		const reviewBundles = await Promise.all(
			input.artifacts.map((artifact) =>
				buildReviewBundle({
					workspace: input.cwd,
					contract: artifact.contract,
					manifest: artifact.manifest,
					registry: this.artifactViews,
					now: this.now,
				}),
			),
		);
		const bundleFailure = reviewBundles.find((result) => !result.ok);
		if (bundleFailure && !bundleFailure.ok) {
			const failedMechanical = [...mechanicalCriteria];
			failedMechanical[0] = {
				...failedMechanical[0],
				result: "FAIL",
				evidence: { reviewBundleDiagnostics: toJsonValue(bundleFailure.diagnostics) },
				rationale: "Artifact does not provide a valid semantic Review Bundle",
			};
			return {
				decision: "REWORK",
				mechanical: failedMechanical,
				semantic: [],
				feedback: bundleFailure.diagnostics.map((item) => item.message),
				evidence: { reviewBundleDiagnostics: toJsonValue(bundleFailure.diagnostics) },
			};
		}
		const bundle: ReviewBundle = {
			artifactId: input.final ? `${input.runId}:final` : input.artifacts[0].manifest.id,
			generatedAt: this.now(),
			materials: reviewBundles.flatMap((result) => (result.ok ? result.bundle.materials : [])),
		};

		let assignments: ReviewerAssignment[];
		try {
			assignments = this.reviewerSelector.select(input.gate, input.agentCards, input.executorAgentCardRefs);
		} catch (error) {
			if (!(error instanceof ReviewerSelectionError)) throw error;
			return {
				decision: "BLOCKED",
				mechanical: mechanicalCriteria,
				semantic: [],
				feedback: error.diagnostics.map((item) => item.message),
				evidence: { reviewerDiagnostics: toJsonValue(error.diagnostics) },
			};
		}

		const active = new Set<string>();
		this.activeReviewers.set(input.gateRunId, active);
		let reviews: CompletedReview[];
		try {
			reviews = await Promise.all(
				assignments.map(async (assignment) => {
					const instanceId = `${input.gateRunId}:reviewer:${assignment.requirementId}:${assignment.reviewerIndex}`;
					active.add(instanceId);
					const gate = this.gateForAssignment(input.gate, assignment.semanticCriterionIds);
					const result = await this.nodeRunner.runDecisionNode({
						kind: "reviewer",
						runId: input.runId,
						instanceId,
						task: input.task,
						workflowHash: input.workflowHash,
						cwd: input.cwd,
						sessionDirectory: input.sessionDirectory,
						agentCard: assignment.agentCard,
						skills: [input.skill],
						runDefaultModel: input.runDefaultModel,
						runDefaultThinkingLevel: input.runDefaultThinkingLevel,
						budgetMode: input.reviewerBudgetMode,
						tokenBudget: input.reviewerTokenBudget,
						timeoutMs: input.reviewerTimeoutMs,
						gate,
						reviewBundle: bundle,
						context: {
							requirementId: assignment.requirementId,
							final: input.final,
							artifactIds: input.artifacts.map((artifact) => artifact.manifest.id),
							previousEvaluations: input.previousEvaluations ?? null,
						},
						signal: input.signal,
					});
					active.delete(instanceId);
					if (result.ok && result.kind === "reviewer") {
						return {
							instanceId,
							agentCardRef: {
								id: assignment.agentCard.id,
								version: assignment.agentCard.version,
								hash: assignment.agentCard.hash,
							},
							submission: result.submission,
							trace: result.trace,
						};
					}
					const message = !result.ok ? result.failure.message : "Reviewer returned an unexpected Decision kind";
					return {
						instanceId,
						agentCardRef: {
							id: assignment.agentCard.id,
							version: assignment.agentCard.version,
							hash: assignment.agentCard.hash,
						},
						submission: this.blockedReview(gate, message),
						trace: result.trace,
					};
				}),
			);
		} finally {
			this.activeReviewers.delete(input.gateRunId);
		}

		const semantic = reviews.flatMap((review) =>
			review.submission.criteria.map((criterion) => ({
				criterionId: criterion.criterionId,
				result: criterion.result,
				evidence: criterion.evidence,
				rationale: criterion.rationale,
				reviewerAgentCardRef: review.agentCardRef,
				reviewerInstanceId: review.instanceId,
				reviewerResult: toJsonValue(review.submission),
				reviewerTrace: review.trace,
			})),
		);
		const aggregation = this.criterionAggregator.aggregate(
			input.gate,
			reviews.map((review) => review.submission),
		);
		if (aggregation.decision !== "ARBITRATE") {
			return {
				decision: aggregation.decision,
				mechanical: mechanicalCriteria,
				semantic,
				feedback: aggregation.feedback,
				evidence: {
					aggregation: aggregation.evidence,
					reviews: toJsonValue(reviews.map((review) => review.submission)),
				},
			};
		}

		return this.arbitrate(input, mechanicalCriteria, semantic, reviews, aggregation.feedback, aggregation.evidence);
	}

	async abort(gateRunId: string): Promise<void> {
		const active = this.activeReviewers.get(gateRunId);
		if (!active) return;
		await Promise.all(Array.from(active, (instanceId) => this.nodeRunner.abort(instanceId)));
	}

	private async arbitrate(
		input: GateEvaluationInput,
		mechanical: GateCriterionEvaluation[],
		semantic: GateCriterionEvaluation[],
		reviews: CompletedReview[],
		feedback: string[],
		aggregationEvidence: JsonValue,
	): Promise<GateEvaluationResult> {
		const excluded = new Set(input.executorAgentCardRefs.map((ref) => `${ref.id}@${ref.version}#${ref.hash}`));
		const eligibleStaff = [...input.staffAgentCards]
			.filter((card) => !excluded.has(`${card.id}@${card.version}#${card.hash}`))
			.sort((left, right) => left.id.localeCompare(right.id));
		const staff = eligibleStaff.find((card) => card.capabilities.includes("quality-governance")) ?? eligibleStaff[0];
		if (!staff) {
			return {
				decision: "BLOCKED",
				mechanical,
				semantic,
				feedback: [...feedback, "No independent Staff Core AgentCard is available for arbitration"],
				evidence: { aggregation: aggregationEvidence },
			};
		}
		const instanceId = `${input.gateRunId}:staff-arbitration`;
		const result = await this.nodeRunner.runDecisionNode({
			kind: "staff",
			runId: input.runId,
			instanceId,
			task: input.task,
			workflowHash: input.workflowHash,
			cwd: input.cwd,
			sessionDirectory: input.sessionDirectory,
			agentCard: staff,
			skills: [input.skill],
			runDefaultModel: input.runDefaultModel,
			runDefaultThinkingLevel: input.runDefaultThinkingLevel,
			budgetMode: input.reviewerBudgetMode,
			timeoutMs: input.reviewerTimeoutMs,
			allowedActions: ["route_rework", "block_gate", "fail_run"],
			context: {
				gateId: input.gate.id,
				aggregation: aggregationEvidence,
				reviews: toJsonValue(reviews.map((review) => review.submission)),
			},
			signal: input.signal,
		});
		if (!result.ok || result.kind !== "staff") {
			return {
				decision: "BLOCKED",
				mechanical,
				semantic,
				feedback: [...feedback, !result.ok ? result.failure.message : "Unexpected Staff Decision kind"],
				evidence: { aggregation: aggregationEvidence },
			};
		}
		const decision =
			result.submission.action === "route_rework"
				? "REWORK"
				: result.submission.action === "fail_run"
					? "FAIL"
					: "BLOCKED";
		return {
			decision,
			mechanical,
			semantic,
			feedback: [...feedback, result.submission.rationale],
			evidence: {
				aggregation: aggregationEvidence,
				staffDecision: toJsonValue(result.submission),
			},
			staffDecision: {
				instanceId,
				agentCardRef: { id: staff.id, version: staff.version, hash: staff.hash },
				action: result.submission.action,
				rationale: result.submission.rationale,
				evidence: result.submission.evidence,
				trace: result.trace,
			},
		};
	}

	private gateForAssignment(gate: GateDefinition, criterionIds: readonly string[]): GateDefinition {
		return {
			...gate,
			semanticCriteria: gate.semanticCriteria.filter((criterion) => criterionIds.includes(criterion.id)),
		};
	}

	private blockedReview(gate: GateDefinition, message: string): ReviewSubmission {
		return {
			decision: "BLOCKED",
			criteria: gate.semanticCriteria.map((criterion) => ({
				criterionId: criterion.id,
				result: "BLOCKED",
				evidence: { error: message },
				rationale: message,
				requiredRework: [],
			})),
			unresolvedRisks: [message],
		};
	}
}
