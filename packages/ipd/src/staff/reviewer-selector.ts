import type { GateDefinition } from "../ir/schemas.ts";
import type { AgentCardRef, CompiledAgentCard, IpdDiagnostic } from "../ir/types.ts";

export interface ReviewerAssignment {
	requirementId: string;
	reviewerIndex: number;
	agentCard: CompiledAgentCard;
	semanticCriterionIds: string[];
}

export class ReviewerSelectionError extends Error {
	readonly diagnostics: IpdDiagnostic[];

	constructor(diagnostics: IpdDiagnostic[]) {
		super("Gate Reviewer requirements cannot be satisfied");
		this.name = "ReviewerSelectionError";
		this.diagnostics = diagnostics;
	}
}

function cardKey(card: { id: string; version: string; hash: string }): string {
	return `${card.id}@${card.version}#${card.hash}`;
}

function hasCapabilities(card: CompiledAgentCard, capabilities: readonly string[]): boolean {
	return capabilities.every((capability) => card.capabilities.includes(capability));
}

export class ReviewerSelector {
	select(
		gate: GateDefinition,
		agentCards: readonly CompiledAgentCard[],
		excluded: readonly AgentCardRef[],
	): ReviewerAssignment[] {
		const excludedKeys = new Set(excluded.map(cardKey));
		const available = [...agentCards]
			.filter((card) => !excludedKeys.has(cardKey(card)))
			.filter((card) => card.permissions.readScopes.length > 0)
			.sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version));
		const used = new Set<string>();
		const assignments: ReviewerAssignment[] = [];
		const diagnostics: IpdDiagnostic[] = [];
		const assignedCriteria = new Set<string>();

		for (const [requirementIndex, requirement] of gate.reviewers.entries()) {
			const matching = available.filter(
				(card) => !used.has(cardKey(card)) && hasCapabilities(card, requirement.capabilities),
			);
			if (matching.length < requirement.minCount) {
				diagnostics.push({
					code: "reviewer_unavailable",
					path: `/reviewers/${requirementIndex}`,
					message: `Reviewer requirement ${requirement.id} needs ${requirement.minCount}, found ${matching.length}`,
				});
				continue;
			}
			const criterionIds = gate.semanticCriteria
				.filter((criterion) =>
					criterion.reviewerCapabilities.every((capability) => requirement.capabilities.includes(capability)),
				)
				.map((criterion) => criterion.id);
			for (const criterionId of criterionIds) assignedCriteria.add(criterionId);
			for (let reviewerIndex = 0; reviewerIndex < requirement.minCount; reviewerIndex++) {
				const card = matching[reviewerIndex];
				used.add(cardKey(card));
				assignments.push({
					requirementId: requirement.id,
					reviewerIndex,
					agentCard: card,
					semanticCriterionIds: criterionIds,
				});
			}
		}

		for (const [index, criterion] of gate.semanticCriteria.entries()) {
			if (!assignedCriteria.has(criterion.id)) {
				diagnostics.push({
					code: "reviewer_unavailable",
					path: `/semanticCriteria/${index}`,
					message: `No Reviewer requirement covers Criterion ${criterion.id}`,
				});
			}
		}
		if (diagnostics.length > 0) throw new ReviewerSelectionError(diagnostics);
		return assignments;
	}
}
