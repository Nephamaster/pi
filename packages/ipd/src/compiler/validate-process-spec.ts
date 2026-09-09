import type { CompiledAgentCard } from "../contracts/agent-card.ts";
import type { ProcessSpec } from "../contracts/process-spec.ts";

export interface ProcessSpecDiagnostic {
	code: string;
	path: string;
	message: string;
}

function addDuplicates(
	diagnostics: ProcessSpecDiagnostic[],
	values: readonly string[],
	path: string,
	label: string,
): void {
	const seen = new Set<string>();
	for (const [index, value] of values.entries()) {
		if (seen.has(value))
			diagnostics.push({
				code: "process_spec_id_duplicate",
				path: `${path}/${index}`,
				message: `Duplicate ${label}: ${value}`,
			});
		seen.add(value);
	}
}

export function validateProcessSpecSemantics(spec: ProcessSpec): ProcessSpecDiagnostic[] {
	const diagnostics: ProcessSpecDiagnostic[] = [];
	const activities = new Set(spec.required_activities.map((item) => item.activity_id));
	const deliverables = new Set(spec.required_deliverables.map((item) => item.deliverable_id));
	addDuplicates(
		diagnostics,
		[
			...spec.required_activities.map((item) => item.activity_id),
			...spec.required_deliverables.map((item) => item.deliverable_id),
			...spec.required_reviews.map((item) => item.review_id),
			...spec.workflow_rules.map((item) => item.rule_id),
		],
		"/requirements",
		"process requirement ID",
	);
	addDuplicates(
		diagnostics,
		spec.required_deliverables.flatMap((item) =>
			item.evidence_requirements.map((requirement) => requirement.evidence_requirement_id),
		),
		"/required_deliverables",
		"evidence requirement ID",
	);
	addDuplicates(
		diagnostics,
		spec.required_reviews.flatMap((item) => item.criteria.map((criterion) => criterion.process_criterion_id)),
		"/required_reviews",
		"process criterion ID",
	);
	for (const [index, deliverable] of spec.required_deliverables.entries()) {
		if (!activities.has(deliverable.activity_id))
			diagnostics.push({
				code: "process_spec_activity_unknown",
				path: `/required_deliverables/${index}/activity_id`,
				message: `Unknown required activity: ${deliverable.activity_id}`,
			});
	}
	for (const [index, review] of spec.required_reviews.entries()) {
		if (!deliverables.has(review.deliverable_id))
			diagnostics.push({
				code: "process_spec_deliverable_unknown",
				path: `/required_reviews/${index}/deliverable_id`,
				message: `Unknown required deliverable: ${review.deliverable_id}`,
			});
	}
	return diagnostics;
}

function matchingCards(cards: readonly CompiledAgentCard[], capabilities: readonly string[]): CompiledAgentCard[] {
	return cards.filter((card) => capabilities.every((capability) => card.capabilities.includes(capability)));
}

export function validateProcessSpecStaffing(
	spec: ProcessSpec,
	cards: readonly CompiledAgentCard[],
): ProcessSpecDiagnostic[] {
	const diagnostics: ProcessSpecDiagnostic[] = [];
	const activities = new Map(spec.required_activities.map((activity) => [activity.activity_id, activity]));
	const deliverables = new Map(
		spec.required_deliverables.map((deliverable) => [deliverable.deliverable_id, deliverable]),
	);
	for (const [index, activity] of spec.required_activities.entries()) {
		if (matchingCards(cards, activity.required_capabilities).length === 0)
			diagnostics.push({
				code: "process_spec_activity_unstaffed",
				path: `/required_activities/${index}/required_capabilities`,
				message: `No AgentCard can staff activity ${activity.activity_id}`,
			});
	}
	for (const [index, review] of spec.required_reviews.entries()) {
		const reviewers = matchingCards(cards, review.reviewer_capabilities);
		const deliverable = deliverables.get(review.deliverable_id);
		const activity = deliverable ? activities.get(deliverable.activity_id) : undefined;
		const producers = activity ? matchingCards(cards, activity.required_capabilities) : [];
		const independentlyStaffed =
			!review.independent_agent ||
			reviewers.some((reviewer) => producers.some((producer) => producer.id !== reviewer.id));
		if (reviewers.length === 0 || !independentlyStaffed)
			diagnostics.push({
				code: "process_spec_review_unstaffed",
				path: `/required_reviews/${index}/reviewer_capabilities`,
				message: `No valid independent AgentCard assignment can staff review ${review.review_id}`,
			});
	}
	return diagnostics;
}
