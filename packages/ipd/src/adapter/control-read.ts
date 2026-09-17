// Control roles may read their locked Skill assets, never the execution workspace.
import { access, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { createReadToolDefinition, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export function createControlReadTool(
	workspace: string,
	roots: readonly string[],
	verify: () => Promise<void>,
): ToolDefinition {
	const authorize = async (path: string) => {
		await verify();
		const target = await realpath(path);
		for (const root of roots) {
			const child = relative(await realpath(root), target);
			if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) return;
		}
		throw new Error("Control-role read is outside its locked Skill assets");
	};
	return defineTool(
		createReadToolDefinition(workspace, {
			operations: {
				async access(path) {
					await authorize(path);
					await access(path);
				},
				async accessWithSignal(path, signal) {
					signal?.throwIfAborted();
					await authorize(path);
					await access(path);
				},
				async readFile(path) {
					await authorize(path);
					return readFile(path);
				},
				async readFileWithSignal(path, signal) {
					await authorize(path);
					return readFile(path, { signal });
				},
			},
		}),
	);
}
