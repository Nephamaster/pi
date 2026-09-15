// 复用 Pi 的 sandbox-runtime 策略，为 IPD 节点的 Bash 提供 OS 级文件系统与网络隔离。
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	type BashOperations,
	createBashToolDefinition,
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import type { NodePermissionsSchema } from "../contracts/workflow.ts";

const require = createRequire(import.meta.url);

function unique(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => resolve(value)))];
}

function contains(root: string, target: string): boolean {
	const value = relative(root, target);
	return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function resolveSandboxCli(): string {
	try {
		const entry = require.resolve("@anthropic-ai/sandbox-runtime");
		return join(dirname(entry), "cli.js");
	} catch (error) {
		throw new Error(
			`IPD Bash sandbox requires @anthropic-ai/sandbox-runtime: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function enclosingNodeModules(path: string): string | undefined {
	let current = dirname(resolve(path));
	while (dirname(current) !== current) {
		if (basename(current) === "node_modules") return current;
		current = dirname(current);
	}
	return undefined;
}

function executableRuntimeRoot(path: string): string {
	const directory = dirname(path);
	return basename(directory) === "bin" ? dirname(directory) : directory;
}

async function resolveExecutable(command: string, pathValue: string | undefined): Promise<string | undefined> {
	const candidates = command.includes(sep)
		? [resolve(command)]
		: (pathValue ?? "")
				.split(delimiter)
				.filter(Boolean)
				.map((directory) => resolve(directory, command));
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Try the next PATH entry.
		}
	}
	return undefined;
}

async function runtimeReadRoots(
	cliPath: string,
	requiredCommands: readonly string[],
	pathValue: string | undefined,
): Promise<string[]> {
	const roots = [executableRuntimeRoot(process.execPath)];
	const nodeModules = enclosingNodeModules(cliPath);
	if (nodeModules) roots.push(nodeModules);
	for (const command of new Set(["socat", ...requiredCommands])) {
		const executable = await resolveExecutable(command, pathValue);
		if (!executable) continue;
		roots.push(executableRuntimeRoot(executable));
		try {
			roots.push(executableRuntimeRoot(await realpath(executable)));
		} catch {
			// The executable passed access() but disappeared; command execution will report the race.
		}
	}
	return unique(roots);
}

export async function denyReadExcept(root: string, allowedRoots: readonly string[]): Promise<string[]> {
	const protectedRoot = resolve(root);
	const allowed = unique(allowedRoots).filter((candidate) => contains(protectedRoot, candidate));
	if (allowed.length === 0) return [protectedRoot];
	if (allowed.includes(protectedRoot)) return [];
	const denied: string[] = [];
	const visit = async (directory: string, candidates: readonly string[]): Promise<void> => {
		let entries: string[];
		try {
			entries = await readdir(directory);
		} catch (error) {
			if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
			throw error;
		}
		const allowedChildren = new Map<string, string[]>();
		for (const candidate of candidates) {
			const child = relative(directory, candidate).split(sep)[0];
			if (!child) continue;
			const values = allowedChildren.get(child) ?? [];
			values.push(candidate);
			allowedChildren.set(child, values);
		}
		for (const entry of entries) {
			if (!allowedChildren.has(entry)) denied.push(join(directory, entry));
		}
		for (const [child, childCandidates] of allowedChildren) {
			const childPath = join(directory, child);
			if (!childCandidates.includes(childPath)) await visit(childPath, childCandidates);
		}
	};
	await visit(protectedRoot, allowed);
	return unique(denied);
}

export interface NodeSandboxOptions {
	workspace: string;
	sessionDirectory: string;
	participantId: string;
	permissions: Static<typeof NodePermissionsSchema>;
	additionalReadRoots?: () => readonly string[];
	deniedReadRoots?: () => readonly string[];
	allowReadOwnWritePaths?: boolean;
	requiredCommands?: readonly string[];
	beforeExec?: () => Promise<void>;
}

function nodeSandboxOperations(options: NodeSandboxOptions): BashOperations {
	const workspace = resolve(options.workspace);
	const sandboxRoot = join(options.sessionDirectory, "sandbox", options.participantId);
	const sandboxHome = join(sandboxRoot, "home");
	const cliPath = resolveSandboxCli();

	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			await options.beforeExec?.();
			const configuredReadRoots = options.permissions.read_paths.map((path) => resolve(workspace, path));
			const writeRoots = options.permissions.write_paths.map((path) => resolve(workspace, path));
			const additionalReadRoots = options.additionalReadRoots?.() ?? [];
			const deniedMutableRoots = (options.deniedReadRoots?.() ?? []).map((path) => resolve(workspace, path));
			await Promise.all([
				mkdir(sandboxHome, { recursive: true }),
				...writeRoots.map((path) => mkdir(path, { recursive: true })),
			]);
			const runtimeRoots = await runtimeReadRoots(
				cliPath,
				options.requiredCommands ?? [],
				env?.PATH ?? process.env.PATH,
			);
			const effectiveReadRoots = unique([
				...configuredReadRoots,
				...(options.allowReadOwnWritePaths ? writeRoots : []),
				...additionalReadRoots,
				...runtimeRoots,
				sandboxHome,
			]);
			const protectedReadDenies = await denyReadExcept(homedir(), effectiveReadRoots);
			const configDirectory = await mkdtemp(join(tmpdir(), "pi-ipd-srt-"));
			const settings = {
				network: {
					allowedDomains: options.permissions.external_actions ? ["*"] : [],
					deniedDomains: [],
				},
				filesystem: {
					// sandbox-runtime exposes denyRead but no allowRead. Hide siblings along each authorized Home path
					// instead of hiding an ancestor that contains the workspace, Skills, or sandbox helper binaries.
					denyRead: unique([...protectedReadDenies, ...deniedMutableRoots]),
					// Writes are allow-only. Runtime-private HOME/TMP are writable but isolated from the host profile.
					allowWrite: unique([...writeRoots, sandboxHome, configDirectory]),
					denyWrite: [],
				},
			};
			const settingsFile = join(configDirectory, "settings.json");
			try {
				await writeFile(settingsFile, JSON.stringify(settings), "utf8");
			} catch (error) {
				await rm(configDirectory, { recursive: true, force: true });
				throw error;
			}
			const childEnv: NodeJS.ProcessEnv = {
				...env,
				HOME: sandboxHome,
				TMPDIR: configDirectory,
				TMP: configDirectory,
				TEMP: configDirectory,
				XDG_CONFIG_HOME: join(sandboxHome, ".config"),
				XDG_CACHE_HOME: join(sandboxHome, ".cache"),
			};
			return new Promise((resolvePromise, reject) => {
				const child = spawn(process.execPath, [cliPath, "--settings", settingsFile, command], {
					cwd,
					detached: process.platform !== "win32",
					env: childEnv,
					stdio: ["ignore", "pipe", "pipe"],
				});
				let timedOut = false;
				let timer: NodeJS.Timeout | undefined;
				const kill = () => {
					if (!child.pid) return;
					try {
						if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
						else child.kill("SIGKILL");
					} catch {
						child.kill("SIGKILL");
					}
				};
				const cleanup = async () => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", kill);
					await rm(configDirectory, { recursive: true, force: true });
				};
				if (timeout && timeout > 0)
					timer = setTimeout(() => {
						timedOut = true;
						kill();
					}, timeout * 1000);
				signal?.addEventListener("abort", kill, { once: true });
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				child.on("error", (error) => {
					void cleanup().finally(() => reject(error));
				});
				child.on("close", (code) => {
					void cleanup().then(() => {
						if (signal?.aborted) reject(new Error("aborted"));
						else if (timedOut) reject(new Error(`timeout:${timeout}`));
						else resolvePromise({ exitCode: code });
					});
				});
			});
		},
	};
}

export function createNodeSandboxedBashTool(options: NodeSandboxOptions): ToolDefinition {
	return defineTool(
		createBashToolDefinition(options.workspace, {
			operations: nodeSandboxOperations(options),
			exposeSessionEnvironment: false,
		}),
	);
}
