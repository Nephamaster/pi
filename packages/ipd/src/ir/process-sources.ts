// Exact ProcessSpec entries shared by authoring and provenance validation.
import type { ProcessSpec } from "../contracts/process-spec.ts";

export interface ProcessSource {
	source_ref: string;
	source_quote: string;
	source_kind: string;
}
export function processSources(spec: ProcessSpec): ProcessSource[] {
	return [
		...spec.required_activities.map((item) => ({
			source_ref: item.activity_id,
			source_quote: item.description,
			source_kind: "process_activity",
		})),
		...spec.required_deliverables.map((item) => ({
			source_ref: item.deliverable_id,
			source_quote: item.description,
			source_kind: "process_deliverable",
		})),
		...spec.required_reviews.flatMap((item) => [
			{ source_ref: item.review_id, source_quote: item.description, source_kind: "process_review" },
			...item.criteria.map((criterion) => ({
				source_ref: criterion.process_criterion_id,
				source_quote: criterion.description,
				source_kind: "process_criterion",
			})),
		]),
		...spec.workflow_rules.map((item) => ({
			source_ref: item.rule_id,
			source_quote: item.description,
			source_kind: "process_rule",
		})),
	];
}
