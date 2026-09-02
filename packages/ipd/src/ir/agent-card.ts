import { freezeDeep, hashJson } from "./hash.ts";
import { type AgentCardAsset, AgentCardAssetSchema, type CompiledAgentCard } from "./schemas.ts";
import { normalizeScope, scopeContains } from "./scopes.ts";
import type { AgentCardCompileContext, IpdDiagnostic, ParsedAsset } from "./types.ts";
import { validateSchema } from "./validation.ts";

export const AGENT_CARD_DEFAULTS = {
	version: "1.0.0",
	model: {
		selection: "run_default",
		thinkingLevel: "inherit",
	},
	applicableScenarios: [] as string[],
	principles: [] as string[],
	deliverables: [] as string[],
	promptProfile: {
		approach: [] as string[],
		communication: [] as string[],
		verification: [] as string[],
	},
	knowledgeBases: [] as Array<{ id: string; description: string; paths: string[] }>,
	skills: [] as string[],
	tools: ["read"],
	permissions: {
		workspace: "read",
		readScopes: ["."],
		writeScopes: [] as string[],
		externalActions: false,
	},
	defaultBudget: {
		tokens: 12_000,
		timeoutMs: 900_000,
	},
} as const;

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function resolveScopes(
	values: readonly string[],
	path: string,
	source: string,
	diagnostics: IpdDiagnostic[],
): string[] {
	const scopes: string[] = [];
	for (const [index, value] of values.entries()) {
		const normalized = normalizeScope(value);
		if (normalized === undefined) {
			diagnostics.push({
				code: "invalid_scope",
				path: `${path}/${index}`,
				message: `Scope must be a relative workspace path: ${value}`,
				source,
			});
			continue;
		}
		scopes.push(normalized);
	}
	return unique(scopes);
}

function validateReferences(
	asset: AgentCardAsset,
	context: AgentCardCompileContext,
	source: string,
	diagnostics: IpdDiagnostic[],
): void {
	for (const [index, skill] of (asset.skills ?? []).entries()) {
		if (!context.skillNames.has(skill)) {
			diagnostics.push({
				code: "unknown_skill",
				path: `/skills/${index}`,
				message: `Unknown AgentCard skill: ${skill}`,
				source,
			});
		}
	}
	for (const [index, tool] of (asset.tools ?? AGENT_CARD_DEFAULTS.tools).entries()) {
		if (!context.toolNames.has(tool)) {
			diagnostics.push({
				code: "unknown_tool",
				path: `/tools/${index}`,
				message: `Unknown AgentCard tool: ${tool}`,
				source,
			});
		}
	}
}

export function compileAgentCard(
	value: unknown,
	source: string,
	context: AgentCardCompileContext,
): ParsedAsset<CompiledAgentCard> {
	const parsed = validateSchema<AgentCardAsset>(AgentCardAssetSchema, value, source);
	if (!parsed.ok) return { diagnostics: parsed.diagnostics };

	const asset = parsed.value;
	const diagnostics: IpdDiagnostic[] = [];
	validateReferences(asset, context, source, diagnostics);

	const selection = asset.model?.selection ?? AGENT_CARD_DEFAULTS.model.selection;
	const thinkingLevel = asset.model?.thinkingLevel ?? AGENT_CARD_DEFAULTS.model.thinkingLevel;
	let model: CompiledAgentCard["model"];
	if (selection === "explicit") {
		const provider = asset.model?.provider;
		const id = asset.model?.id;
		if (!provider || !id) {
			diagnostics.push({
				code: "explicit_model_incomplete",
				path: "/model",
				message: "Explicit AgentCard models require both provider and id",
				source,
			});
			model = { selection: "run_default", thinkingLevel };
		} else {
			if (!context.hasModel(provider, id)) {
				diagnostics.push({
					code: "unknown_model",
					path: "/model",
					message: `Unknown or unavailable model: ${provider}/${id}`,
					source,
				});
			}
			model = { selection: "explicit", provider, id, thinkingLevel };
		}
	} else {
		model = { selection: "run_default", thinkingLevel };
	}

	const workspace = asset.permissions?.workspace ?? AGENT_CARD_DEFAULTS.permissions.workspace;
	const readScopes = resolveScopes(
		asset.permissions?.readScopes ?? AGENT_CARD_DEFAULTS.permissions.readScopes,
		"/permissions/readScopes",
		source,
		diagnostics,
	);
	const writeScopes = resolveScopes(
		asset.permissions?.writeScopes ?? AGENT_CARD_DEFAULTS.permissions.writeScopes,
		"/permissions/writeScopes",
		source,
		diagnostics,
	);
	const knowledgeBaseIds = new Set<string>();
	const knowledgeBases = (asset.knowledgeBases ?? AGENT_CARD_DEFAULTS.knowledgeBases).map((knowledgeBase, index) => {
		if (knowledgeBaseIds.has(knowledgeBase.id)) {
			diagnostics.push({
				code: "duplicate_id",
				path: `/knowledgeBases/${index}/id`,
				message: `Duplicate AgentCard knowledge base: ${knowledgeBase.id}`,
				source,
			});
		}
		knowledgeBaseIds.add(knowledgeBase.id);
		const paths = resolveScopes(knowledgeBase.paths ?? [], `/knowledgeBases/${index}/paths`, source, diagnostics);
		for (const [pathIndex, path] of paths.entries()) {
			if (!readScopes.some((scope) => scopeContains(scope, path))) {
				diagnostics.push({
					code: "permission_exceeded",
					path: `/knowledgeBases/${index}/paths/${pathIndex}`,
					message: `Knowledge base path exceeds AgentCard read scopes: ${path}`,
					source,
				});
			}
		}
		return { id: knowledgeBase.id, description: knowledgeBase.description, paths };
	});
	if (workspace === "read" && writeScopes.length > 0) {
		diagnostics.push({
			code: "permission_exceeded",
			path: "/permissions/writeScopes",
			message: "Read-only AgentCards cannot declare write scopes",
			source,
		});
	}
	if (workspace === "write" && writeScopes.length === 0) {
		diagnostics.push({
			code: "invalid_scope",
			path: "/permissions/writeScopes",
			message: "Writable AgentCards must declare at least one write scope",
			source,
		});
	}

	if (diagnostics.length > 0) return { diagnostics };

	const normalized = {
		id: asset.id,
		version: asset.version ?? AGENT_CARD_DEFAULTS.version,
		name: asset.name,
		description: asset.description,
		responsibilities: [...asset.responsibilities],
		nonResponsibilities: [...asset.nonResponsibilities],
		capabilities: unique(asset.capabilities),
		applicableScenarios: unique(asset.applicableScenarios ?? AGENT_CARD_DEFAULTS.applicableScenarios),
		principles: unique(asset.principles ?? AGENT_CARD_DEFAULTS.principles),
		deliverables: unique(asset.deliverables ?? AGENT_CARD_DEFAULTS.deliverables),
		promptProfile: {
			approach: unique(asset.promptProfile?.approach ?? AGENT_CARD_DEFAULTS.promptProfile.approach),
			communication: unique(asset.promptProfile?.communication ?? AGENT_CARD_DEFAULTS.promptProfile.communication),
			verification: unique(asset.promptProfile?.verification ?? AGENT_CARD_DEFAULTS.promptProfile.verification),
		},
		knowledgeBases,
		model,
		skills: unique(asset.skills ?? AGENT_CARD_DEFAULTS.skills),
		tools: unique(asset.tools ?? AGENT_CARD_DEFAULTS.tools),
		permissions: {
			workspace,
			readScopes,
			writeScopes,
			externalActions: asset.permissions?.externalActions ?? AGENT_CARD_DEFAULTS.permissions.externalActions,
		},
		defaultBudget: {
			tokens: asset.defaultBudget?.tokens ?? AGENT_CARD_DEFAULTS.defaultBudget.tokens,
			timeoutMs: asset.defaultBudget?.timeoutMs ?? AGENT_CARD_DEFAULTS.defaultBudget.timeoutMs,
		},
	};
	const card: CompiledAgentCard = freezeDeep({ ...normalized, hash: hashJson(normalized), source });
	return { value: card, diagnostics: [] };
}
