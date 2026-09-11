// 在 Pi 工具调用边界检查节点的文件读写范围。
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { type ExtensionFactory, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import type { NodePermissionsSchema } from "../contracts/workflow.ts";

async function nearestExistingRealPath(path: string): Promise<string> {
	let current = path;
	while (true) {
		try {
			return await realpath(current);
		} catch (error) {
			if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			const parent = dirname(current);
			if (parent === current) throw error;
			current = parent;
		}
	}
}

function contains(root: string, path: string): boolean {
	const value = relative(root, path);
	return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

export async function isPathWithinRoots(path: string, roots: readonly string[]): Promise<boolean> {
	for (const root of roots) {
		if (!contains(root, path)) continue;
		const [realRoot, realTarget] = await Promise.all([nearestExistingRealPath(root), nearestExistingRealPath(path)]);
		if (contains(realRoot, realTarget)) return true;
	}
	return false;
}

export function effectiveNodeReadRoots(options: {
	workspace: string;
	permissions: Static<typeof NodePermissionsSchema>;
	additionalReadRoots?: readonly string[];
	allowReadOwnWritePaths?: boolean;
}): string[] {
	const workspace = resolve(options.workspace);
	return [
		...new Set([
			...options.permissions.read_paths.map((scope) => resolve(workspace, scope)),
			...(options.allowReadOwnWritePaths
				? options.permissions.write_paths.map((scope) => resolve(workspace, scope))
				: []),
			...(options.additionalReadRoots ?? []).map((root) => resolve(root)),
		]),
	];
}

export function createNodeFileScopeExtension(options: {
	workspace: string;
	permissions: Static<typeof NodePermissionsSchema>;
	additionalReadRoots?: () => readonly string[];
	deniedReadRoots?: () => readonly string[];
	allowReadOwnWritePaths?: boolean;
}): ExtensionFactory {
	const workspace = resolve(options.workspace);
	return (pi) => {
		pi.on("tool_call", async (event) => {
			let requested: string;
			if (isToolCallEventType("read", event)) requested = event.input.path;
			else if (isToolCallEventType("write", event)) requested = event.input.path;
			else if (isToolCallEventType("edit", event)) requested = event.input.path;
			else return undefined;
			const target = isAbsolute(requested) ? resolve(requested) : resolve(workspace, requested);
			if (
				event.toolName === "read" &&
				(options.deniedReadRoots?.() ?? []).some((root) => contains(resolve(workspace, root), target))
			)
				return { block: true, reason: `Read must use the sealed Submission instead of mutable path: ${requested}` };
			const roots =
				event.toolName === "read"
					? effectiveNodeReadRoots({
							workspace,
							permissions: options.permissions,
							additionalReadRoots: options.additionalReadRoots?.(),
							allowReadOwnWritePaths: options.allowReadOwnWritePaths,
						})
					: options.permissions.write_paths.map((scope) => resolve(workspace, scope));
			if (await isPathWithinRoots(target, roots)) return undefined;
			return { block: true, reason: `Path is outside the node's ${event.toolName} scope: ${requested}` };
		});
	};
}
