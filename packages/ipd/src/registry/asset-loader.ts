import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { compileAgentCard } from "../ir/agent-card.ts";
import { freezeDeep, hashJson } from "../ir/hash.ts";
import { type CompiledAgentCard, type WorkflowDefinition, WorkflowDefinitionSchema } from "../ir/schemas.ts";
import type { AgentCardCompileContext, IpdDiagnostic, WorkflowAssetRecord } from "../ir/types.ts";
import { validateSchema } from "../ir/validation.ts";
import { InMemoryAgentCardRegistry } from "./agent-card-registry.ts";
import { InMemoryWorkflowAssetRegistry } from "./workflow-asset-registry.ts";

const ASSET_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);

async function discoverAssetFiles(directory: string, diagnostics: IpdDiagnostic[]): Promise<string[]> {
	const files: string[] = [];
	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		diagnostics.push({
			code: "asset_read_failed",
			path: "/",
			message: error instanceof Error ? error.message : String(error),
			source: directory,
		});
		return [];
	}
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await discoverAssetFiles(path, diagnostics)));
		} else if (entry.isFile() && ASSET_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
			files.push(path);
		}
	}
	return files;
}

async function parseAssetFile(
	path: string,
): Promise<{ ok: true; value: unknown } | { ok: false; diagnostic: IpdDiagnostic }> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		return {
			ok: false,
			diagnostic: {
				code: "asset_read_failed",
				path: "/",
				message: error instanceof Error ? error.message : String(error),
				source: path,
			},
		};
	}
	try {
		const value: unknown = extname(path).toLowerCase() === ".json" ? JSON.parse(content) : parseYaml(content);
		return {
			ok: true,
			value,
		};
	} catch (error) {
		return {
			ok: false,
			diagnostic: {
				code: "asset_parse_failed",
				path: "/",
				message: error instanceof Error ? error.message : String(error),
				source: path,
			},
		};
	}
}

export type LoadAgentCardAssetsResult =
	| {
			ok: true;
			cards: readonly CompiledAgentCard[];
			registry: InMemoryAgentCardRegistry;
			diagnostics: [];
	  }
	| { ok: false; diagnostics: IpdDiagnostic[] };

export async function loadAgentCardAssets(
	directories: readonly string[],
	context: AgentCardCompileContext,
): Promise<LoadAgentCardAssetsResult> {
	const diagnostics: IpdDiagnostic[] = [];
	const registry = new InMemoryAgentCardRegistry();
	const files = (
		await Promise.all(directories.map((directory) => discoverAssetFiles(resolve(directory), diagnostics)))
	)
		.flat()
		.sort();

	for (const file of files) {
		const parsed = await parseAssetFile(file);
		if (!parsed.ok) {
			diagnostics.push(parsed.diagnostic);
			continue;
		}
		const compiled = compileAgentCard(parsed.value, file, context);
		diagnostics.push(...compiled.diagnostics);
		if (!compiled.value) continue;
		const collision = registry.add(compiled.value);
		if (collision) diagnostics.push(collision);
	}

	return diagnostics.length > 0
		? { ok: false, diagnostics }
		: { ok: true, cards: registry.list(), registry, diagnostics: [] };
}

export type LoadWorkflowAssetsResult =
	| {
			ok: true;
			assets: readonly WorkflowAssetRecord[];
			registry: InMemoryWorkflowAssetRegistry;
			diagnostics: [];
	  }
	| { ok: false; diagnostics: IpdDiagnostic[] };

export async function loadWorkflowAssets(directories: readonly string[]): Promise<LoadWorkflowAssetsResult> {
	const diagnostics: IpdDiagnostic[] = [];
	const registry = new InMemoryWorkflowAssetRegistry();
	const files = (
		await Promise.all(directories.map((directory) => discoverAssetFiles(resolve(directory), diagnostics)))
	)
		.flat()
		.sort();

	for (const file of files) {
		const parsed = await parseAssetFile(file);
		if (!parsed.ok) {
			diagnostics.push(parsed.diagnostic);
			continue;
		}
		const validated = validateSchema<WorkflowDefinition>(WorkflowDefinitionSchema, parsed.value, file);
		if (!validated.ok) {
			diagnostics.push(...validated.diagnostics);
			continue;
		}
		const workflow = freezeDeep(structuredClone(validated.value));
		const record = { workflow, hash: hashJson(workflow), source: file };
		const collision = registry.add(record);
		if (collision) diagnostics.push(collision);
	}

	return diagnostics.length > 0
		? { ok: false, diagnostics }
		: { ok: true, assets: registry.list(), registry, diagnostics: [] };
}
