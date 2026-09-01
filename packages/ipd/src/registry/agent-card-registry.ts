import type { AgentCardRef, CompiledAgentCard, IpdDiagnostic } from "../ir/types.ts";

export interface AgentCardRegistry {
	list(): readonly CompiledAgentCard[];
	get(ref: AgentCardRef): CompiledAgentCard | undefined;
	getById(id: string): readonly CompiledAgentCard[];
}

export class InMemoryAgentCardRegistry implements AgentCardRegistry {
	private readonly cards = new Map<string, CompiledAgentCard>();

	add(card: CompiledAgentCard): IpdDiagnostic | undefined {
		const key = `${card.id}@${card.version}`;
		const existing = this.cards.get(key);
		if (existing) {
			return {
				code: "asset_collision",
				path: "/id",
				message: `AgentCard ${key} is defined by both ${existing.source} and ${card.source}`,
				source: card.source,
			};
		}
		this.cards.set(key, card);
		return undefined;
	}

	list(): readonly CompiledAgentCard[] {
		return Array.from(this.cards.values()).sort(
			(left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version),
		);
	}

	get(ref: AgentCardRef): CompiledAgentCard | undefined {
		const card = this.cards.get(`${ref.id}@${ref.version}`);
		return card?.hash === ref.hash ? card : undefined;
	}

	getById(id: string): readonly CompiledAgentCard[] {
		return this.list().filter((card) => card.id === id);
	}
}
