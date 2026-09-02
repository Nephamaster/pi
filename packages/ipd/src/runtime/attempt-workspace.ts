import { copyFile, cp, lstat, mkdir, readdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ArtifactManifest } from "../artifact/manifest.ts";
import { normalizeScope, scopeContains } from "../ir/scopes.ts";

const MARKER_FILE = ".ipd-attempt-workspace.json";

export interface AttemptWorkspace {
	root: string;
	checkpoint: string;
	promote(manifest: ArtifactManifest): Promise<void>;
}

export interface PrepareAttemptWorkspaceInput {
	workspace: string;
	runId: string;
	attemptId: string;
	writeScopes: readonly string[];
	previousAttemptId?: string;
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function createPiOverlay(source: string, target: string): Promise<void> {
	if (!(await exists(source))) return;
	await mkdir(target, { recursive: true });
	for (const entry of await readdir(source, { withFileTypes: true })) {
		if (entry.name !== "ipd") {
			await symlink(join(source, entry.name), join(target, entry.name), entry.isDirectory() ? "dir" : "file");
			continue;
		}
		const sourceIpd = join(source, entry.name);
		const targetIpd = join(target, entry.name);
		await mkdir(targetIpd, { recursive: true });
		for (const ipdEntry of await readdir(sourceIpd, { withFileTypes: true })) {
			if (["attempts", "runs"].includes(ipdEntry.name)) continue;
			await symlink(
				join(sourceIpd, ipdEntry.name),
				join(targetIpd, ipdEntry.name),
				ipdEntry.isDirectory() ? "dir" : "file",
			);
		}
	}
}

function assertInside(root: string, path: string): void {
	const relation = relative(root, path);
	if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
		throw new Error(`Attempt workspace path escapes its root: ${path}`);
	}
}

export class AttemptWorkspaceManager {
	async prepare(input: PrepareAttemptWorkspaceInput): Promise<AttemptWorkspace> {
		const workspace = resolve(input.workspace);
		const scopes = input.writeScopes.map((scope) => normalizeScope(scope));
		if (scopes.some((scope) => scope === undefined)) throw new Error("Attempt write scopes must be relative paths");
		if (scopes.includes(".")) {
			throw new Error(
				"Attempt staging requires bounded write scopes; workspace-wide write scope '.' is not allowed",
			);
		}
		const writeScopes = scopes as string[];
		if (writeScopes.length === 0) {
			return {
				root: workspace,
				checkpoint: "",
				async promote() {},
			};
		}
		const attemptBase = join(workspace, ".pi", "ipd", "attempts", input.runId, input.attemptId);
		const root = join(attemptBase, "workspace");
		const checkpoint = join(attemptBase, "checkpoint.json");
		if (!(await exists(join(root, MARKER_FILE)))) {
			await mkdir(root, { recursive: true });
			const writeRoots = new Set(writeScopes.map((scope) => scope.split("/")[0]));
			for (const entry of await readdir(workspace, { withFileTypes: true })) {
				if (entry.name === ".pi") {
					if (writeRoots.has(entry.name)) throw new Error("Attempt staging does not support writes under .pi");
					await createPiOverlay(join(workspace, entry.name), join(root, entry.name));
					continue;
				}
				if (writeRoots.has(entry.name)) continue;
				await symlink(join(workspace, entry.name), join(root, entry.name), entry.isDirectory() ? "dir" : "file");
			}
			const previousRoot = input.previousAttemptId
				? join(workspace, ".pi", "ipd", "attempts", input.runId, input.previousAttemptId, "workspace")
				: undefined;
			for (const writeRoot of writeRoots) {
				const previousSource = previousRoot ? join(previousRoot, writeRoot) : undefined;
				const source =
					previousSource && (await exists(previousSource)) ? previousSource : join(workspace, writeRoot);
				const target = join(root, writeRoot);
				if (await exists(source)) await cp(source, target, { recursive: true, force: true });
				else await mkdir(target, { recursive: true });
			}
			await writeFile(
				join(root, MARKER_FILE),
				`${JSON.stringify({ runId: input.runId, attemptId: input.attemptId, writeScopes }, null, 2)}\n`,
			);
		}
		await writeFile(
			checkpoint,
			`${JSON.stringify({ runId: input.runId, attemptId: input.attemptId, workspace: root, writeScopes }, null, 2)}\n`,
		);
		return {
			root,
			checkpoint,
			promote: async (manifest) => {
				for (const file of manifest.files) {
					if (!writeScopes.some((scope) => scopeContains(scope, file.path))) {
						throw new Error(`Artifact path is outside the Attempt write scopes: ${file.path}`);
					}
					const source = resolve(root, file.path);
					const destination = resolve(workspace, file.path);
					assertInside(root, source);
					assertInside(workspace, destination);
					await mkdir(dirname(destination), { recursive: true });
					const temporary = join(dirname(destination), `.${basename(destination)}.${input.attemptId}.tmp`);
					await copyFile(source, temporary);
					await rename(temporary, destination);
				}
				const published = manifest.files.map((file) => ({ path: file.path, sha256: file.sha256 }));
				const current = JSON.parse(await readFile(checkpoint, "utf8")) as Record<string, unknown>;
				await writeFile(checkpoint, `${JSON.stringify({ ...current, published }, null, 2)}\n`);
			},
		};
	}
}
