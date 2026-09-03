import { allocateReviewers, type ReviewerAssignment } from "../ir/reviewer-allocation.ts";
import type { GateDefinition } from "../ir/schemas.ts";
import type { AgentCardRef, CompiledAgentCard, IpdDiagnostic } from "../ir/types.ts";

export type { ReviewerAssignment } from "../ir/reviewer-allocation.ts";

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

export class ReviewerSelector {
	select(
		gate: GateDefinition,
		agentCards: readonly CompiledAgentCard[],
		excluded: readonly AgentCardRef[],
	): ReviewerAssignment[] {
		const { assignments, diagnostics } = allocateReviewers(gate, agentCards, new Set(excluded.map(cardKey)));
		if (diagnostics.length > 0) throw new ReviewerSelectionError(diagnostics);
		return assignments;
	}
}
