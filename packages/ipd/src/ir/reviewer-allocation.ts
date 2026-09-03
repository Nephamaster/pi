import type { GateDefinition } from "./schemas.ts";
import type { CompiledAgentCard, IpdDiagnostic } from "./types.ts";

export interface ReviewerAssignment {
	requirementId: string;
	reviewerIndex: number;
	agentCard: CompiledAgentCard;
	semanticCriterionIds: string[];
}

interface ReviewerSlot {
	requirementIndex: number;
	reviewerIndex: number;
	candidates: CompiledAgentCard[];
}

function cardKey(card: { id: string; version: string; hash: string }): string {
	return `${card.id}@${card.version}#${card.hash}`;
}

function hasCapabilities(card: CompiledAgentCard, capabilities: readonly string[]): boolean {
	return capabilities.every((capability) => card.capabilities.includes(capability));
}

function diagnosticPath(base: string, suffix: string): string {
	return `${base}${suffix}` || "/";
}

export function allocateReviewers(
	gate: GateDefinition,
	agentCards: readonly CompiledAgentCard[],
	excludedCardKeys: ReadonlySet<string>,
	path = "",
): { assignments: ReviewerAssignment[]; diagnostics: IpdDiagnostic[] } {
	const available = [...agentCards]
		.filter((card) => !excludedCardKeys.has(cardKey(card)))
		.filter((card) => card.permissions.readScopes.length > 0)
		.sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version));
	const slots = gate.reviewers.flatMap((requirement, requirementIndex) =>
		Array.from(
			{ length: requirement.minCount },
			(_, reviewerIndex): ReviewerSlot => ({
				requirementIndex,
				reviewerIndex,
				candidates: available.filter((card) => hasCapabilities(card, requirement.capabilities)),
			}),
		),
	);
	const cardToSlot = new Map<string, number>();
	const slotToCard = new Map<number, CompiledAgentCard>();
	const assign = (slotIndex: number, visitedCards: Set<string>): boolean => {
		for (const card of slots[slotIndex].candidates) {
			const key = cardKey(card);
			if (visitedCards.has(key)) continue;
			visitedCards.add(key);
			const occupiedSlot = cardToSlot.get(key);
			if (occupiedSlot === undefined || assign(occupiedSlot, visitedCards)) {
				cardToSlot.set(key, slotIndex);
				slotToCard.set(slotIndex, card);
				return true;
			}
		}
		return false;
	};
	for (const slotIndex of slots.keys()) assign(slotIndex, new Set());

	const diagnostics: IpdDiagnostic[] = [];
	const assignments: ReviewerAssignment[] = [];
	const assignedCriteria = new Set<string>();
	for (const [requirementIndex, requirement] of gate.reviewers.entries()) {
		const requirementSlots = slots
			.map((slot, slotIndex) => ({ slot, slotIndex, card: slotToCard.get(slotIndex) }))
			.filter(({ slot }) => slot.requirementIndex === requirementIndex);
		const matched = requirementSlots.filter(
			(item): item is typeof item & { card: CompiledAgentCard } => item.card !== undefined,
		);
		if (matched.length < requirement.minCount) {
			const allCapable = agentCards.filter(
				(card) => card.permissions.readScopes.length > 0 && hasCapabilities(card, requirement.capabilities),
			);
			diagnostics.push({
				code: allCapable.length >= requirement.minCount ? "reviewer_not_independent" : "reviewer_unavailable",
				path: diagnosticPath(path, `/reviewers/${requirementIndex}`),
				message: `Reviewer requirement ${requirement.id} needs ${requirement.minCount} mutually exclusive matching AgentCard(s), assigned ${matched.length}`,
			});
			continue;
		}
		const criterionIds = gate.semanticCriteria
			.filter((criterion) =>
				criterion.reviewerCapabilities.every((capability) => requirement.capabilities.includes(capability)),
			)
			.map((criterion) => criterion.id);
		for (const criterionId of criterionIds) assignedCriteria.add(criterionId);
		for (const { slot, card } of matched) {
			assignments.push({
				requirementId: requirement.id,
				reviewerIndex: slot.reviewerIndex,
				agentCard: card,
				semanticCriterionIds: criterionIds,
			});
		}
	}

	for (const [index, criterion] of gate.semanticCriteria.entries()) {
		if (!assignedCriteria.has(criterion.id)) {
			diagnostics.push({
				code: "reviewer_unavailable",
				path: diagnosticPath(path, `/semanticCriteria/${index}/reviewerCapabilities`),
				message: `No satisfiable Reviewer requirement covers Criterion ${criterion.id}`,
			});
		}
	}
	return { assignments, diagnostics };
}
