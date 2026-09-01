import type { ReviewSubmission } from "../adapter/node-runner.ts";
import type { GateDefinition } from "../ir/schemas.ts";
import type { JsonValue } from "../ir/types.ts";

export interface CriterionAggregation {
	decision: "PASS" | "REWORK" | "BLOCKED" | "ARBITRATE";
	feedback: string[];
	evidence: JsonValue;
}

export class CriterionAggregator {
	aggregate(gate: GateDefinition, reviews: readonly ReviewSubmission[]): CriterionAggregation {
		const feedback: string[] = [];
		const results: Record<string, string[]> = {};
		let arbitration = false;
		let blocked = false;
		let failed = false;

		for (const criterion of gate.semanticCriteria) {
			const criterionResults = reviews.flatMap((review) =>
				review.criteria.filter((item) => item.criterionId === criterion.id),
			);
			results[criterion.id] = criterionResults.map((item) => item.result);
			if (criterionResults.length === 0) {
				arbitration = true;
				feedback.push(`Criterion ${criterion.id} has no Reviewer result`);
				continue;
			}
			const distinct = new Set(criterionResults.map((item) => item.result));
			if (distinct.size > 1 || distinct.has("INCONCLUSIVE")) arbitration = true;
			else if (distinct.has("BLOCKED")) blocked = true;
			else if (distinct.has("FAIL")) failed = true;
			for (const item of criterionResults) feedback.push(...item.requiredRework);
		}

		const decision = arbitration ? "ARBITRATE" : blocked ? "BLOCKED" : failed ? "REWORK" : "PASS";
		return {
			decision,
			feedback: [...new Set(feedback)],
			evidence: { criterionResults: results },
		};
	}
}
