// Materialize pi-web-access PDF results in the lease; never turn returned text into arbitrary host read authority.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { EnvironmentError, throwIfAborted } from "../environment/contracts.ts";
import type { EnvironmentToolContext } from "../environment/tool-backend.ts";

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function createExternalReadResultAdapter(
	getContext: () => EnvironmentToolContext,
	pdfDirectory = join(tmpdir(), "pi-web-pdf"),
): (tool: ToolDefinition) => ToolDefinition {
	const responses = new Set<string>();
	const imported = new Map<string, string>();
	return (tool) => {
		if (!["web_search", "source_check", "fetch_content", "get_search_content"].includes(tool.name)) return tool;
		return {
			...tool,
			async execute(id, input, signal, onUpdate, ctx) {
				throwIfAborted(signal);
				const requestedId = object(input)?.responseId;
				if (tool.name === "get_search_content" && (typeof requestedId !== "string" || !responses.has(requestedId)))
					throw new EnvironmentError("policy_denied", "Content responseId was not issued to this node Session");
				const current = getContext();
				const leaseId = current.lease.leaseId;
				const generation = current.round.generation;
				const result = await tool.execute(id, input, signal, onUpdate, ctx);
				throwIfAborted(signal);
				const details = object(result.details);
				const responseId = typeof details?.responseId === "string" ? details.responseId : requestedId;
				if (typeof responseId === "string") responses.add(responseId);
				if (tool.name !== "fetch_content" && tool.name !== "get_search_content") return result;
				const urls = Array.isArray(details?.urls) ? details.urls : [details?.url];
				const content = [];
				for (const block of result.content) {
					if (block.type !== "text") {
						content.push(block);
						continue;
					}
					const match = /^PDF extracted and saved to: ([^\r\n]+)\n\nPages: (\d+)\nCharacters: (\d+)$/m.exec(
						block.text,
					);
					if (!match) {
						content.push(block);
						continue;
					}
					const source = match[1];
					const key = `${responseId ?? id}:${source}`;
					let destination = imported.get(key);
					if (!destination) {
						const root = resolve(pdfDirectory);
						if (
							dirname(source) !== root ||
							resolve(source) !== source ||
							!/\/[a-z0-9-]+\.md$/.test(source) ||
							(await realpath(root)) !== root
						)
							throw new EnvironmentError(
								"policy_denied",
								"External PDF result is outside the extraction directory",
							);
						const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
						let bytes: Buffer;
						try {
							const stat = await file.stat();
							if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024)
								throw new EnvironmentError(
									"policy_denied",
									"External PDF result is not a bounded regular file",
								);
							bytes = await file.readFile();
							const text = bytes.toString("utf8");
							if (
								bytes.length > 64 * 1024 * 1024 ||
								text.length !== Number(match[3]) ||
								!urls.some(
									(url) =>
										typeof url === "string" &&
										/^https?:\/\//.test(url) &&
										text.split("\n").includes(`> Source: ${url}`),
								)
							)
								throw new EnvironmentError(
									"policy_denied",
									"External PDF provenance or length does not match the tool result",
								);
						} finally {
							await file.close();
						}
						throwIfAborted(signal);
						const latest = getContext();
						if (latest.lease.leaseId !== leaseId || latest.round.generation !== generation)
							throw new EnvironmentError("cancelled", "External result belongs to a previous environment round");
						destination = `${current.binding.paths.workspace}/.external-content/${createHash("sha256").update(bytes).digest("hex")}.md`;
						await current.provider.writeFile(current.lease, current.round, destination, bytes, signal);
						imported.set(key, destination);
					}
					content.push({ ...block, text: block.text.replace(source, destination) });
				}
				return { ...result, content };
			},
		};
	};
}
