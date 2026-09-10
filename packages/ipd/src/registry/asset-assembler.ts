// 从包、用户和项目来源装配可执行的 IPD 资产目录。
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir, type Skill, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import type { CompilerAssetCatalog } from "../compiler/types.ts";
import { validateProcessSpecSemantics } from "../compiler/validate-process-spec.ts";
import type { CompiledAgentCard } from "../contracts/agent-card.ts";
import type { LockedSkill, LockedTool } from "../contracts/baseline.ts";
import type { LockedAssetRef } from "../contracts/primitives.ts";
import { type ProcessSpec, ProcessSpecSchema } from "../contracts/process-spec.ts";
import { compileAgentCard } from "../ir/agent-card.ts";
import { hashJson } from "../ir/hash.ts";
import { validateSchema } from "../ir/validation.ts";
import type { CheckRegistry } from "./check-registry.ts";
import { hashSkillPackage } from "./skill-package.ts";

export interface AssetAssemblerOptions {
	agentCardDirectories: readonly string[];
	processSpecDirectories: readonly string[];
	skills: readonly Skill[];
	tools: readonly ToolDefinition[];
	builtinToolNames?: readonly string[];
	hasModel(provider: string, modelId: string): boolean;
}

export interface AssembledAssets {
	agentCards: CompiledAgentCard[];
	processSpecs: ProcessSpec[];
	skills: LockedSkill[];
	tools: LockedTool[];
	skillTools: Record<string, string[]>;
	unavailableAgentCards: Array<{ source: string; reasons: string[] }>;
}

export interface DefaultAssetAssemblyInput {
	agentDir: string;
	projectRoot: string;
	projectTrusted: boolean;
	skills: readonly Skill[];
	tools: readonly ToolDefinition[];
	hasModel(provider: string, modelId: string): boolean;
}

function parseDocument(content: string, path: string): unknown {
	return extname(path) === ".json" ? JSON.parse(content) : parseYaml(content);
}

function frontmatterToolList(content: string, field: "allowed-tools" | "required-tools"): string[] {
	if (!content.startsWith("---")) return [];
	const end = content.indexOf("\n---", 3);
	if (end < 0) return [];
	const parsed = parseYaml(content.slice(3, end));
	if (typeof parsed !== "object" || parsed === null) return [];
	const value = (parsed as Record<string, unknown>)[field];
	const tools = Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: typeof value === "string"
			? value.split(/\s+/).filter(Boolean)
			: [];
	return [...new Set(tools.map((item) => item.trim()).filter(Boolean))];
}

async function assetFiles(directories: readonly string[]): Promise<string[]> {
	const files: string[] = [];
	for (const directory of directories) {
		let entries: Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		for (const entry of entries) {
			if (entry.isFile() && [".json", ".yaml", ".yml"].includes(extname(entry.name)))
				files.push(join(directory, entry.name));
		}
	}
	return files.sort();
}

export class AssetAssembler {
	assembleDefault(input: DefaultAssetAssemblyInput): Promise<AssembledAssets> {
		const agentCardDirectories = [
			fileURLToPath(new URL("../../assets/agent-cards", import.meta.url)),
			fileURLToPath(new URL("../../assets/agency-role-library/agent-cards", import.meta.url)),
			join(input.agentDir, "ipd", "agent-cards"),
		];
		const processSpecDirectories = [
			fileURLToPath(new URL("../../assets/process-specs", import.meta.url)),
			join(input.agentDir, "ipd", "process-specs"),
		];
		if (input.projectTrusted) {
			agentCardDirectories.push(join(input.projectRoot, ".pi", "ipd", "agent-cards"));
			processSpecDirectories.push(join(input.projectRoot, ".pi", "ipd", "process-specs"));
		}
		return this.assemble({
			agentCardDirectories,
			processSpecDirectories,
			skills: [
				...loadSkillsFromDir({
					dir: fileURLToPath(new URL("../../assets/skills", import.meta.url)),
					source: "package",
				}).skills,
				...input.skills,
			],
			tools: input.tools,
			hasModel: input.hasModel,
		});
	}

	async assemble(options: AssetAssemblerOptions): Promise<AssembledAssets> {
		const duplicateSkill = options.skills.find(
			(skill, index) => options.skills.findIndex((candidate) => candidate.name === skill.name) !== index,
		);
		if (duplicateSkill) throw new Error(`Duplicate Skill ${duplicateSkill.name}`);
		const toolAssets = new Map<string, LockedTool>();
		for (const id of new Set(options.builtinToolNames ?? []))
			toolAssets.set(id, { id, hash: hashJson({ id, source: "pi-builtin" }), source: "pi-builtin" });
		for (const tool of options.tools) {
			toolAssets.set(tool.name, {
				id: tool.name,
				hash: hashJson({
					name: tool.name,
					label: tool.label,
					description: tool.description,
					parameters: tool.parameters,
					promptSnippet: tool.promptSnippet,
					promptGuidelines: tool.promptGuidelines,
				}),
				source: "pi-tool-registry",
			});
		}
		const tools = [...toolAssets.values()].sort((left, right) => left.id.localeCompare(right.id));
		const knownTools = new Set(tools.map((tool) => tool.id));
		const skills = await Promise.all(
			options.skills.map(async (skill): Promise<LockedSkill> => {
				const content = await readFile(skill.filePath, "utf8");
				const declaredTools = frontmatterToolList(content, "allowed-tools");
				const requiredTools = frontmatterToolList(content, "required-tools");
				const missing = [...new Set([...declaredTools, ...requiredTools])].filter((name) => !knownTools.has(name));
				if (missing.length > 0)
					throw new Error(`Skill ${skill.name} declares unavailable tools: ${missing.join(", ")}`);
				if (declaredTools.length > 0) {
					const notAllowed = requiredTools.filter((name) => !declaredTools.includes(name));
					if (notAllowed.length > 0)
						throw new Error(
							`Skill ${skill.name} requires tools outside allowed-tools: ${notAllowed.join(", ")}`,
						);
				}
				return {
					id: skill.name,
					hash: await hashSkillPackage(skill.baseDir),
					source: skill.sourceInfo.source,
					filePath: skill.filePath,
					baseDir: skill.baseDir,
					description: skill.description,
					allowedTools: declaredTools,
					requiredTools,
				};
			}),
		);
		const cards: CompiledAgentCard[] = [];
		const unavailableAgentCards: AssembledAssets["unavailableAgentCards"] = [];
		for (const path of await assetFiles(options.agentCardDirectories)) {
			const result = compileAgentCard(parseDocument(await readFile(path, "utf8"), path), path, {
				skillNames: new Set(skills.map((skill) => skill.id)),
				toolNames: knownTools,
				hasModel: options.hasModel,
			});
			const card = result.value;
			if (!card) {
				const environmentOnly = result.diagnostics.every((item) =>
					["unknown_model", "unknown_skill", "unknown_tool"].includes(item.code),
				);
				if (!environmentOnly)
					throw new Error(
						result.diagnostics.map((item) => `${item.source}${item.path}: ${item.message}`).join("\n"),
					);
				unavailableAgentCards.push({
					source: path,
					reasons: result.diagnostics.map((item) => item.message),
				});
				continue;
			}
			if (cards.some((existing) => existing.id === card.id && existing.version === card.version))
				throw new Error(`Duplicate AgentCard ${card.id}@${card.version}`);
			cards.push(card);
		}
		const processSpecs: ProcessSpec[] = [];
		for (const path of await assetFiles(options.processSpecDirectories)) {
			const parsed = validateSchema<ProcessSpec>(
				ProcessSpecSchema,
				parseDocument(await readFile(path, "utf8"), path),
				path,
			);
			if (!parsed.ok)
				throw new Error(parsed.diagnostics.map((item) => `${path}${item.path}: ${item.message}`).join("\n"));
			const semanticDiagnostics = validateProcessSpecSemantics(parsed.value);
			if (semanticDiagnostics.length > 0)
				throw new Error(semanticDiagnostics.map((item) => `${path}${item.path}: ${item.message}`).join("\n"));
			if (
				processSpecs.some(
					(spec) => spec.process_spec_id === parsed.value.process_spec_id && spec.version === parsed.value.version,
				)
			)
				throw new Error(`Duplicate ProcessSpec ${parsed.value.process_spec_id}@${parsed.value.version}`);
			processSpecs.push(parsed.value);
		}
		return {
			agentCards: cards,
			processSpecs,
			skills,
			tools,
			skillTools: Object.fromEntries(skills.map((skill) => [skill.id, skill.allowedTools])),
			unavailableAgentCards,
		};
	}
}

export function toCompilerAssetCatalog(
	assets: AssembledAssets,
	checks: CheckRegistry,
	knowledgeBases: readonly LockedAssetRef[] = [],
): CompilerAssetCatalog {
	return {
		agentCards: assets.agentCards,
		skills: assets.skills,
		tools: assets.tools,
		knowledgeBases,
		checks,
	};
}
