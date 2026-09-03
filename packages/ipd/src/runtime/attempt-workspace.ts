import { copyFile, cp, lstat, mkdir, readdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ArtifactManifest } from "../artifact/manifest.ts";
import { normalizeScope, scopeContains } from "../ir/scopes.ts";

const MARKER_FILE = ".ipd-attempt-workspace.json";
const RUN_MARKER_FILE = "run.json";

export interface RunWorkspace {
	root: string;
	workspace: string;
	accepted: string;
	final: string;
	sessions: string;
	checkpoints: string;
}

export interface AttemptWorkspace {
	root: string;
	checkpoint: string;
	promote(manifest: ArtifactManifest): Promise<void>;
}

export interface PrepareAttemptWorkspaceInput {
	workspace: string;
	runRoot: string;
	runId: string;
	nodeId: string;
	attemptNumber: number;
	attemptId: string;
	writeScopes: readonly string[];
	previousAttemptNumber?: number;
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
			const destination = join(target, entry.name);
			if (!(await exists(destination))) {
				await symlink(join(source, entry.name), destination, entry.isDirectory() ? "dir" : "file");
			}
			continue;
		}
		const sourceIpd = join(source, entry.name);
		const targetIpd = join(target, entry.name);
		await mkdir(targetIpd, { recursive: true });
		for (const ipdEntry of await readdir(sourceIpd, { withFileTypes: true })) {
			if (["attempts", "runs"].includes(ipdEntry.name)) continue;
			const destination = join(targetIpd, ipdEntry.name);
			if (!(await exists(destination))) {
				await symlink(join(sourceIpd, ipdEntry.name), destination, ipdEntry.isDirectory() ? "dir" : "file");
			}
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
	async prepareRun(projectWorkspace: string, runId: string): Promise<RunWorkspace> {
		const project = resolve(projectWorkspace);
		const root = join(project, ".pi", "ipd", "runs", runId);
		const workspace = join(root, "workspace");
		const runWorkspace = {
			root,
			workspace,
			accepted: join(root, "accepted"),
			final: join(root, "final"),
			sessions: join(root, "sessions"),
			checkpoints: join(root, "checkpoints"),
		};
		await Promise.all(Object.values(runWorkspace).map((path) => mkdir(path, { recursive: true })));
		const marker = join(root, RUN_MARKER_FILE);
		if (!(await exists(marker))) {
			for (const entry of await readdir(project, { withFileTypes: true })) {
				if (entry.name === "outputs") continue;
				if (entry.name === ".pi") {
					await createPiOverlay(join(project, entry.name), join(workspace, entry.name));
					continue;
				}
				const destination = join(workspace, entry.name);
				if (!(await exists(destination))) {
					await symlink(join(project, entry.name), destination, entry.isDirectory() ? "dir" : "file");
				}
			}
			await writeFile(marker, `${JSON.stringify({ runId, projectWorkspace: project }, null, 2)}\n`);
		}
		return runWorkspace;
	}

	async prepare(input: PrepareAttemptWorkspaceInput): Promise<AttemptWorkspace> {
		const workspace = resolve(input.workspace);
		const runRoot = resolve(input.runRoot);
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
		const attemptBase = join(runRoot, "work", input.nodeId, `attempt-${input.attemptNumber}`);
		const root = join(attemptBase, "workspace");
		const checkpoint = join(runRoot, "checkpoints", input.nodeId, `attempt-${input.attemptNumber}.json`);
		if (!(await exists(join(root, MARKER_FILE)))) {
			await mkdir(root, { recursive: true });
			await mkdir(dirname(checkpoint), { recursive: true });
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
			const previousRoot = input.previousAttemptNumber
				? join(runRoot, "work", input.nodeId, `attempt-${input.previousAttemptNumber}`, "workspace")
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
				const acceptedRoot = join(runRoot, "accepted", manifest.nodeId, manifest.id);
				for (const file of manifest.files) {
					if (!writeScopes.some((scope) => scopeContains(scope, file.path))) {
						throw new Error(`Artifact path is outside the Attempt write scopes: ${file.path}`);
					}
					const source = resolve(root, file.path);
					const destination = resolve(workspace, file.path);
					const acceptedDestination = resolve(acceptedRoot, file.path);
					assertInside(root, source);
					assertInside(workspace, destination);
					assertInside(acceptedRoot, acceptedDestination);
					await mkdir(dirname(destination), { recursive: true });
					await mkdir(dirname(acceptedDestination), { recursive: true });
					const temporary = join(dirname(destination), `.${basename(destination)}.${input.attemptId}.tmp`);
					await copyFile(source, temporary);
					await rename(temporary, destination);
					await copyFile(source, acceptedDestination);
				}
				const published = manifest.files.map((file) => ({ path: file.path, sha256: file.sha256 }));
				const current = JSON.parse(await readFile(checkpoint, "utf8")) as Record<string, unknown>;
				await writeFile(checkpoint, `${JSON.stringify({ ...current, published }, null, 2)}\n`);
			},
		};
	}

	async publishFinal(runWorkspace: RunWorkspace, manifests: readonly ArtifactManifest[]): Promise<string[]> {
		const published: string[] = [];
		for (const manifest of manifests) {
			for (const file of manifest.files) {
				const source = resolve(runWorkspace.workspace, file.path);
				const destination = resolve(runWorkspace.final, manifest.nodeId, file.path);
				assertInside(runWorkspace.workspace, source);
				assertInside(runWorkspace.final, destination);
				await mkdir(dirname(destination), { recursive: true });
				await copyFile(source, destination);
				published.push(destination);
			}
		}
		return published;
	}
}
