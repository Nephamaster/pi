export type ToolEffect = "read_only" | "run_workspace_write" | "external_idempotent" | "external_non_idempotent";

export interface ToolEffectDeclaration {
	name: string;
	ipdEffect?: ToolEffect;
}

export function declareToolEffect<TTool extends { name: string }>(
	tool: TTool,
	effect: ToolEffect,
): TTool & { ipdEffect: ToolEffect } {
	return { ...tool, ipdEffect: effect };
}

const BUILTIN_TOOL_EFFECTS: Readonly<Record<string, ToolEffect>> = {
	read: "read_only",
	grep: "read_only",
	find: "read_only",
	ls: "read_only",
	web_search: "read_only",
	fetch_content: "read_only",
	get_search_content: "read_only",
	source_check: "read_only",
	write: "run_workspace_write",
	edit: "run_workspace_write",
	bash: "run_workspace_write",
	powershell: "run_workspace_write",
};

export function createToolEffectRegistry(
	tools: readonly ToolEffectDeclaration[] = [],
): ReadonlyMap<string, ToolEffect> {
	const effects = new Map(Object.entries(BUILTIN_TOOL_EFFECTS));
	for (const tool of tools) {
		effects.set(tool.name, tool.ipdEffect ?? effects.get(tool.name) ?? "external_non_idempotent");
	}
	return effects;
}

export function externalToolEffects(
	toolNames: readonly string[],
	effects: ReadonlyMap<string, ToolEffect>,
): Array<{ tool: string; effect: "external_idempotent" | "external_non_idempotent" }> {
	return toolNames.flatMap((tool) => {
		const effect = effects.get(tool) ?? "external_non_idempotent";
		return effect === "external_idempotent" || effect === "external_non_idempotent" ? [{ tool, effect }] : [];
	});
}
