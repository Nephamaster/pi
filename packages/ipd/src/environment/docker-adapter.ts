// 通过受限 argv 调用集中管理 Docker CLI，并提供有界输出、超时和取消。
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { EnvironmentError, throwIfAborted } from "./contracts.ts";

export interface DockerCliOptions {
	executable?: string;
	dockerConfigDirectory: string;
	path?: string;
	managementTimeoutMs?: number;
	maxOutputBytes?: number;
}

export interface DockerRunOptions {
	streamOutput?: boolean;
	input?: Buffer;
	signal?: AbortSignal;
	/** Zero leaves the command deadline to its caller; omission uses the management deadline. */
	timeoutMs?: number;
	onStdout?: (data: Buffer) => void;
	onStderr?: (data: Buffer) => void;
	acceptedExitCodes?: readonly number[];
}

export interface DockerRunResult {
	exitCode: number;
	stdout: Buffer;
	stderr: Buffer;
}

export interface DockerCommandRunner {
	run(args: readonly string[], options?: DockerRunOptions): Promise<DockerRunResult>;
}

export class DockerCli implements DockerCommandRunner {
	private readonly executable: string;
	private readonly dockerConfigDirectory: string;
	private readonly path: string;
	private readonly managementTimeoutMs: number;
	private readonly maxOutputBytes: number;

	constructor(options: DockerCliOptions) {
		this.executable = options.executable ?? "docker";
		this.dockerConfigDirectory = options.dockerConfigDirectory;
		this.path = options.path ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
		this.managementTimeoutMs = options.managementTimeoutMs ?? 60_000;
		this.maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
	}

	async run(args: readonly string[], options: DockerRunOptions = {}): Promise<DockerRunResult> {
		throwIfAborted(options.signal);
		await mkdir(this.dockerConfigDirectory, { recursive: true, mode: 0o700 });
		throwIfAborted(options.signal);
		const timeoutMs = options.timeoutMs ?? this.managementTimeoutMs;
		return new Promise((resolve, reject) => {
			const child = spawn(this.executable, [...args], {
				env: { PATH: this.path, DOCKER_CONFIG: this.dockerConfigDirectory },
				stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let outputBytes = 0;
			let timedOut = false;
			let settled = false;
			const finish = (operation: () => void) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
				operation();
			};
			const kill = () => {
				try {
					child.kill("SIGKILL");
				} catch {
					// The process already exited.
				}
			};
			const abort = () => kill();
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							timedOut = true;
							kill();
						}, timeoutMs)
					: undefined;
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.signal?.aborted) abort();
			const collect = (target: Buffer[], callback: ((data: Buffer) => void) | undefined, data: Buffer) => {
				if (options.streamOutput) {
					const available = Math.max(0, this.maxOutputBytes - outputBytes);
					if (available) target.push(data.subarray(0, available));
					outputBytes += data.length;
					callback?.(data);
					return;
				}
				outputBytes += data.length;
				if (outputBytes > this.maxOutputBytes) {
					kill();
					return;
				}
				target.push(data);
				callback?.(data);
			};
			child.stdout?.on("data", (data: Buffer) => collect(stdout, options.onStdout, data));
			child.stderr?.on("data", (data: Buffer) => collect(stderr, options.onStderr, data));
			child.on("error", (error) =>
				finish(() => {
					const code = (error as NodeJS.ErrnoException).code;
					reject(
						new EnvironmentError(
							"environment_unavailable",
							code === "ENOENT"
								? `Docker CLI is unavailable: ${this.executable}`
								: `Docker CLI failed to start: ${error.message}`,
							{ cause: error },
						),
					);
				}),
			);
			child.on("close", (code) =>
				finish(() => {
					if (options.signal?.aborted) {
						reject(new EnvironmentError("cancelled", "Docker operation was cancelled"));
						return;
					}
					if (timedOut) {
						reject(new EnvironmentError("process_timeout", `Docker operation timed out after ${timeoutMs}ms`));
						return;
					}
					if (!options.streamOutput && outputBytes > this.maxOutputBytes) {
						reject(new EnvironmentError("environment_unavailable", "Docker output exceeded the trusted limit"));
						return;
					}
					const exitCode = code ?? -1;
					const result = { exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
					if (!(options.acceptedExitCodes ?? [0]).includes(exitCode)) {
						const detail = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim();
						reject(
							new EnvironmentError(
								"environment_unavailable",
								`Docker command failed with exit ${exitCode}${detail ? `: ${detail}` : ""}`,
							),
						);
						return;
					}
					resolve(result);
				}),
			);
			child.stdin?.on("error", () => {});
			if (options.input) child.stdin?.end(options.input);
		});
	}
}
