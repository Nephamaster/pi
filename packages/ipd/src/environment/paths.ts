// 校验虚拟路径并安全物化精确输入，拒绝符号链接和目录越界。
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, copyFile, lstat, mkdir, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { hashJson } from "../ir/hash.ts";
import type {
	EnvironmentBinding,
	EnvironmentInputBinding,
	EnvironmentLayout,
	EnvironmentPaths,
	EnvironmentStaticAsset,
} from "./contracts.ts";
import { EnvironmentError, throwIfAborted } from "./contracts.ts";

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEFAULT_MAX_INPUT_FILES = 10_000;
const DEFAULT_MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024;

function virtualContains(root: string, target: string): boolean {
	return target === root || target.startsWith(`${root}/`);
}

export function normalizeVirtualPath(path: string): string {
	if (!path.startsWith("/")) throw new EnvironmentError("policy_denied", `Virtual path must be absolute: ${path}`);
	if (path.includes("\0")) throw new EnvironmentError("policy_denied", "Virtual path contains a null byte");
	const normalized = posix.normalize(path);
	if (normalized !== path || path.split("/").includes(".."))
		throw new EnvironmentError("policy_denied", `Virtual path is not normalized: ${path}`);
	return normalized;
}

function workspaceRoot(scope: string, workspace: string): string {
	if (isAbsolute(scope) || scope.split(/[\\/]/).includes(".."))
		throw new EnvironmentError("policy_denied", `Invalid logical workspace scope: ${scope}`);
	const normalized = posix.normalize(scope.replaceAll("\\", "/"));
	return normalized === "." ? workspace : `${workspace}/${normalized}`;
}

export function resolveEnvironmentLayout(paths: EnvironmentPaths): EnvironmentLayout {
	return {
		defaultCwd: paths.workspace,
		readOnlyRoots: [paths.context, paths.skills, paths.inputs],
		writableRoots: [paths.workspace, paths.scratch, paths.cache, paths.home, paths.temporary],
		exportRoot: `${paths.workspace}/outputs`,
	};
}

export function assertVirtualPathAllowed(
	path: string,
	binding: EnvironmentBinding,
	operation: "read" | "write",
): string {
	const normalized = normalizeVirtualPath(path);
	const layout = resolveEnvironmentLayout(binding.paths);
	const roots = operation === "read" ? [...layout.readOnlyRoots, ...layout.writableRoots] : layout.writableRoots;
	if (!roots.some((root) => virtualContains(root, normalized)))
		throw new EnvironmentError("policy_denied", `Path is outside the environment ${operation} scope: ${path}`);
	return normalized;
}

export function assertVirtualWorkingDirectoryAllowed(path: string, binding: EnvironmentBinding): string {
	const normalized = normalizeVirtualPath(path);
	const layout = resolveEnvironmentLayout(binding.paths);
	if (![...layout.readOnlyRoots, ...layout.writableRoots].some((root) => virtualContains(root, normalized)))
		throw new EnvironmentError("policy_denied", `Path is outside the environment cwd scope: ${path}`);
	return normalized;
}

export function assertVirtualExportAllowed(path: string, outputRoot: string, binding: EnvironmentBinding): string {
	const normalized = normalizeVirtualPath(path);
	const layout = resolveEnvironmentLayout(binding.paths);
	const declaredRoot = workspaceRoot(outputRoot, binding.paths.workspace);
	if (!virtualContains(layout.exportRoot, declaredRoot))
		throw new EnvironmentError(
			"policy_denied",
			`Declared output root is outside the environment export root: ${outputRoot}`,
		);
	if (!virtualContains(declaredRoot, normalized))
		throw new EnvironmentError("policy_denied", `Path is outside declared output ${outputRoot}: ${path}`);
	return normalized;
}

function safeMaterializationTarget(root: string, binding: EnvironmentInputBinding): string {
	if (!SAFE_SEGMENT.test(binding.bindingId))
		throw new EnvironmentError("policy_denied", `Invalid input binding ID: ${binding.bindingId}`);
	const destination = resolve(root, binding.bindingId);
	if (relative(resolve(root), destination).startsWith(".."))
		throw new EnvironmentError(
			"policy_denied",
			`Input binding escapes its materialization root: ${binding.bindingId}`,
		);
	return destination;
}

interface CopyBudget {
	files: number;
	bytes: number;
}

async function copyTree(source: string, destination: string, budget: CopyBudget, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const stat = await lstat(source);
	if (stat.isSymbolicLink())
		throw new EnvironmentError("policy_denied", `Input materialization rejects symbolic links: ${source}`);
	if (stat.isFile()) {
		budget.files++;
		budget.bytes += stat.size;
		if (budget.files > DEFAULT_MAX_INPUT_FILES || budget.bytes > DEFAULT_MAX_INPUT_BYTES)
			throw new EnvironmentError("policy_denied", "Input materialization exceeds the configured size limit");
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(source, destination, constants.COPYFILE_EXCL);
		return;
	}
	if (!stat.isDirectory()) throw new EnvironmentError("policy_denied", `Unsupported input file type: ${source}`);
	await mkdir(destination, { recursive: true });
	for (const entry of await readdir(source))
		await copyTree(join(source, entry), join(destination, entry), budget, signal);
}

export async function materializeEnvironmentInputs(
	root: string,
	virtualRoot: string,
	inputs: readonly EnvironmentInputBinding[],
	signal?: AbortSignal,
): Promise<Map<string, string>> {
	throwIfAborted(signal);
	const resolvedRoot = resolve(root);
	await mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
	for (const entry of await readdir(resolvedRoot))
		await rm(join(resolvedRoot, entry), { recursive: true, force: true });
	const destinations = new Map<string, string>();
	for (const input of inputs) {
		throwIfAborted(signal);
		try {
			await access(input.sourcePath, constants.R_OK);
		} catch (error) {
			throw new EnvironmentError("environment_unavailable", `Authorized input is unavailable: ${input.bindingId}`, {
				cause: error,
			});
		}
		const destination = safeMaterializationTarget(resolvedRoot, input);
		await copyTree(input.sourcePath, destination, { files: 0, bytes: 0 }, signal);
		destinations.set(input.bindingId, destination);
		const expected = normalizeVirtualPath(input.virtualPath);
		if (!virtualContains(virtualRoot, expected))
			throw new EnvironmentError(
				"policy_denied",
				`Input virtual path is outside ${virtualRoot}: ${input.virtualPath}`,
			);
		if (basename(expected) !== input.bindingId)
			throw new EnvironmentError(
				"policy_denied",
				`Input virtual path must end with its binding ID: ${input.virtualPath}`,
			);
	}
	return destinations;
}

export async function materializeEnvironmentAssets(
	root: string,
	virtualRoot: string,
	assets: readonly EnvironmentStaticAsset[],
	signal?: AbortSignal,
): Promise<Map<string, string>> {
	const resolvedRoot = resolve(root);
	await mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
	for (const entry of await readdir(resolvedRoot))
		await rm(join(resolvedRoot, entry), { recursive: true, force: true });
	const destinations = new Map<string, string>();
	for (const asset of assets) {
		throwIfAborted(signal);
		const path = normalizeVirtualPath(asset.virtualPath);
		const relativePath = posix.relative(virtualRoot, path);
		if (!relativePath || relativePath.startsWith("../") || posix.isAbsolute(relativePath))
			throw new EnvironmentError("policy_denied", `Static asset is outside ${virtualRoot}: ${path}`);
		const destination = resolve(resolvedRoot, relativePath);
		if (!containsHostPath(resolvedRoot, destination))
			throw new EnvironmentError("policy_denied", `Static asset escapes its materialization root: ${path}`);
		if ("sourcePath" in asset) await copyTree(asset.sourcePath, destination, { files: 0, bytes: 0 }, signal);
		else {
			await mkdir(dirname(destination), { recursive: true });
			await writeFile(destination, asset.content, { mode: 0o600, flag: "wx" });
		}
		destinations.set(asset.assetId, destination);
	}
	return destinations;
}

function containsHostPath(root: string, target: string): boolean {
	const value = relative(root, target);
	return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

export async function hashEnvironmentSource(path: string): Promise<string> {
	const root = resolve(path);
	const rootStat = await lstat(root);
	if (rootStat.isSymbolicLink())
		throw new EnvironmentError("policy_denied", `Environment sources cannot contain symbolic links: ${root}`);
	if (rootStat.isFile())
		return createHash("sha256")
			.update(await readFile(root))
			.digest("hex");
	if (!rootStat.isDirectory()) throw new EnvironmentError("policy_denied", `Unsupported environment source: ${root}`);
	const files: Array<{ path: string; hash: string }> = [];
	const visit = async (current: string): Promise<void> => {
		const stat = await lstat(current);
		if (stat.isSymbolicLink())
			throw new EnvironmentError("policy_denied", `Environment sources cannot contain symbolic links: ${current}`);
		if (stat.isFile()) {
			files.push({
				path: relative(root, current).replaceAll("\\", "/"),
				hash: createHash("sha256")
					.update(await readFile(current))
					.digest("hex"),
			});
			return;
		}
		if (!stat.isDirectory())
			throw new EnvironmentError("policy_denied", `Unsupported environment source: ${current}`);
		for (const entry of await readdir(current)) await visit(join(current, entry));
	};
	await visit(root);
	files.sort((left, right) => left.path.localeCompare(right.path));
	return hashJson(files);
}

/** Checkpoint a stopped workspace without following project dependency symlinks. */
export async function hashWorkspaceState(root: string): Promise<string> {
	const hash = createHash("sha256");
	const visit = async (path: string): Promise<void> => {
		const stat = await lstat(path);
		hash.update(JSON.stringify([relative(root, path), stat.mode]));
		if (stat.isSymbolicLink()) hash.update(JSON.stringify(["link", await readlink(path)]));
		else if (stat.isFile()) {
			const fileHash = createHash("sha256");
			for await (const chunk of createReadStream(path)) fileHash.update(chunk as Buffer);
			hash.update(JSON.stringify(["file", fileHash.digest("hex")]));
		} else if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name));
		else hash.update("special-file");
	};
	await visit(root);
	return hash.digest("hex");
}
