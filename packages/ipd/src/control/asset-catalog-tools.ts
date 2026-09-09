import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { renderAgentSelectionProfile } from "../adapter/render-agent-profile.ts";
import type { CompiledAgentCard } from "../contracts/agent-card.ts";
import { NonEmptyStringSchema, VersionSchema } from "../contracts/primitives.ts";
import type { ProcessSpec } from "../contracts/process-spec.ts";
import { canonicalJson } from "../ir/hash.ts";

function searchTerms(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[\s,，;；、/]+/)
		.filter(Boolean);
}

function score(query: string, value: string): number {
	if (query.trim() === "*") return 1;
	const normalized = value.toLowerCase();
	return searchTerms(query).reduce((total, term) => total + (normalized.includes(term) ? 1 : 0), 0);
}

const SearchSchema = Type.Object(
	{
		query: NonEmptyStringSchema,
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
	},
	{ additionalProperties: false },
);

const ExactAssetSchema = Type.Object(
	{ id: NonEmptyStringSchema, version: VersionSchema },
	{ additionalProperties: false },
);

export function createProcessSpecCatalogTools(specs: readonly ProcessSpec[]): ToolDefinition[] {
	return [
		defineTool({
			name: "search_process_specs",
			label: "Search ProcessSpecs",
			description:
				'List or search the registered ProcessSpec catalog by task and governance keywords. Use "*" for the compact catalog. Results are summaries; read serious candidates before selecting one.',
			parameters: SearchSchema,
			executionMode: "sequential",
			async execute(_toolCallId, input) {
				const results = specs
					.map((spec) => ({
						spec,
						score: score(
							input.query,
							[
								spec.process_spec_id,
								spec.name,
								spec.description,
								...spec.applicable_when,
								...spec.not_applicable_when,
							].join("\n"),
						),
					}))
					.filter((item) => item.score > 0)
					.sort(
						(left, right) =>
							right.score - left.score || left.spec.process_spec_id.localeCompare(right.spec.process_spec_id),
					)
					.slice(0, input.limit ?? 5)
					.map(({ spec }) => ({
						id: spec.process_spec_id,
						version: spec.version,
						name: spec.name,
						applicable_when: spec.applicable_when,
						not_applicable_when: spec.not_applicable_when,
						required_activity_count: spec.required_activities.length,
						required_review_count: spec.required_reviews.length,
					}));
				return {
					content: [{ type: "text", text: canonicalJson(results) }],
					details: { results },
				};
			},
		}),
		defineTool<typeof ExactAssetSchema, { found: boolean; spec?: ProcessSpec }>({
			name: "get_process_spec",
			label: "Get ProcessSpec",
			description: "Read one exact registered ProcessSpec version before deciding whether it applies.",
			parameters: ExactAssetSchema,
			executionMode: "sequential",
			async execute(_toolCallId, input) {
				const spec = specs.find(
					(candidate) => candidate.process_spec_id === input.id && candidate.version === input.version,
				);
				if (!spec)
					return {
						content: [{ type: "text", text: `ProcessSpec not found: ${input.id}@${input.version}` }],
						details: { found: false },
						isError: true,
					};
				return {
					content: [{ type: "text", text: canonicalJson(spec) }],
					details: { found: true, spec },
				};
			},
		}),
	];
}

export function createAgentCardCatalogTools(cards: readonly CompiledAgentCard[]): ToolDefinition[] {
	return [
		defineTool({
			name: "search_agent_cards",
			label: "Search AgentCards",
			description:
				'List or search registered employees by responsibility, capability, scenario, and professional method. Use "*" for the compact catalog. Results are compact candidates; inspect a candidate before binding it.',
			parameters: SearchSchema,
			executionMode: "sequential",
			async execute(_toolCallId, input) {
				const results = cards
					.map((card) => ({
						card,
						score: score(
							input.query,
							[
								card.id,
								card.name,
								card.description,
								...card.applicableScenarios,
								...card.responsibilities,
								...card.capabilities,
								...card.principles,
								...card.promptProfile.approach,
							].join("\n"),
						),
					}))
					.filter((item) => item.score > 0)
					.sort(
						(left, right) =>
							right.score - left.score ||
							left.card.id.localeCompare(right.card.id) ||
							left.card.version.localeCompare(right.card.version),
					)
					.slice(0, input.limit ?? 8)
					.map(({ card }) => ({
						id: card.id,
						version: card.version,
						name: card.name,
						description: card.description,
						capabilities: card.capabilities,
					}));
				return {
					content: [{ type: "text", text: canonicalJson(results) }],
					details: { results },
				};
			},
		}),
		defineTool<typeof ExactAssetSchema, { found: boolean; id?: string; version?: string; hash?: string }>({
			name: "get_agent_card",
			label: "Get AgentCard",
			description:
				"Read the rich selection profile for one exact employee version. This profile supports employee selection and is not a node work contract.",
			parameters: ExactAssetSchema,
			executionMode: "sequential",
			async execute(_toolCallId, input) {
				const card = cards.find((candidate) => candidate.id === input.id && candidate.version === input.version);
				if (!card)
					return {
						content: [{ type: "text", text: `AgentCard not found: ${input.id}@${input.version}` }],
						details: { found: false },
						isError: true,
					};
				return {
					content: [{ type: "text", text: renderAgentSelectionProfile(card) }],
					details: { found: true, id: card.id, version: card.version, hash: card.hash },
				};
			},
		}),
	];
}
