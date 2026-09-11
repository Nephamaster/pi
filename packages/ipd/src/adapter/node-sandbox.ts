// 复用 Pi 的 sandbox-runtime 策略，为 IPD 节点的 Bash 提供 OS 级文件系统与网络隔离。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
	type BashOperations,
	createBashToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import type { NodePermissionsSchema } from "../contracts/workflow.ts";

const require = createRequire(import.meta.url);

function unique(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => resolve(value)))];
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

function sandboxRunsRoot(workspace: string): string {
	// <project>/.pi/ipd/runs/<run_id>/workspace -> <project>/.pi/ipd/runs
	return dirname(dirname(resolve(workspace)));
}

export interface NodeSandboxOptions {
	workspace: string;
	sessionDirectory: string;
	participantId: string;
	permissions: Static<typeof NodePermissionsSchema>;
	additionalReadRoots?: () => readonly string[];
	deniedReadRoots?: () => readonly string[];
	allowReadOwnWritePaths?: boolean;
}

function nodeSandboxOperations(options: NodeSandboxOptions): BashOperations {
	const workspace = resolve(options.workspace);
	const runsRoot = sandboxRunsRoot(workspace);
	const sandboxRoot = join(options.sessionDirectory, "sandbox", options.participantId);
	const sandboxHome = join(sandboxRoot, "home");
	const sandboxTmp = join(sandboxRoot, "tmp");
	const cliPath = resolveSandboxCli();

	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			await Promise.all([mkdir(sandboxHome, { recursive: true }), mkdir(sandboxTmp, { recursive: true })]);
			const configuredReadRoots = options.permissions.read_paths.map((path) => resolve(workspace, path));
			const writeRoots = options.permissions.write_paths.map((path) => resolve(workspace, path));
			const effectiveReadRoots = unique([
				...configuredReadRoots,
				...(options.allowReadOwnWritePaths ? writeRoots : []),
				...(options.additionalReadRoots?.() ?? []),
				sandboxHome,
				sandboxTmp,
			]);
			const deniedMutableRoots = (options.deniedReadRoots?.() ?? []).map((path) => resolve(workspace, path));
			const settings = {
				network: {
					allowedDomains: options.permissions.external_actions ? ["*"] : [],
					deniedDomains: [],
				},
				filesystem: {
					// Reads are deny-then-allow in sandbox-runtime. Deny the host home and the complete IPD runs area,
					// then reopen only this Run workspace plus exact frozen/Skill roots. Mutable outputs owned by other
					// nodes remain explicitly denied even though the current workspace is available as the shell cwd.
					denyRead: unique([homedir(), runsRoot, join(workspace, "outputs"), ...deniedMutableRoots]),
					allowRead: unique([workspace, ...effectiveReadRoots]),
					// Writes are allow-only. Runtime-private HOME/TMP are writable but isolated from the host profile.
					allowWrite: unique([...writeRoots, sandboxHome, sandboxTmp]),
					denyWrite: [],
				},
			};
			const configDirectory = await mkdtemp(join(tmpdir(), "pi-ipd-srt-"));
			const settingsFile = join(configDirectory, "settings.json");
			await writeFile(settingsFile, JSON.stringify(settings), "utf8");
			const childEnv: NodeJS.ProcessEnv = {
				...env,
				HOME: sandboxHome,
				TMPDIR: sandboxTmp,
				TMP: sandboxTmp,
				TEMP: sandboxTmp,
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
	return createBashToolDefinition(options.workspace, {
		operations: nodeSandboxOperations(options),
		exposeSessionEnvironment: false,
	});
}
