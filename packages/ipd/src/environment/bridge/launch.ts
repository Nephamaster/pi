import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { CommandLaunch } from "./protocol.ts";

/** One argv/cwd/environment contract for Bash, full logs, managed commands and probes. */
export async function launchCommand(launch: CommandLaunch, emit: boolean) {
	if (launch.logPath) await mkdir(dirname(launch.logPath), { recursive: true });
	const log = launch.logPath ? await open(launch.logPath, "w", 0o600) : undefined;
	const marker = Buffer.from("\n[Output truncated at the environment log limit]\n").subarray(0, launch.maxLogBytes);
	let remaining = log ? Math.max(0, launch.maxLogBytes - marker.length) : 0;
	let truncated = false;
	const child = spawn(launch.argv[0], launch.argv.slice(1), {
		cwd: launch.cwd,
		env: launch.environment,
		stdio: ["inherit", "pipe", "pipe"],
	});
	let writes = Promise.resolve();
	const collect = (data: Buffer, stream: NodeJS.WriteStream) => {
		if (emit && !stream.write(data)) {
			const input = stream === process.stdout ? child.stdout : child.stderr;
			input.pause();
			stream.once("drain", () => input.resume());
		}
		if (log) {
			const chunk = data.subarray(0, remaining);
			remaining -= chunk.length;
			if (chunk.length)
				writes = writes.then(async () => {
					await log.write(chunk);
				});
			if (data.length > chunk.length && !truncated) {
				truncated = true;
				writes = writes.then(async () => {
					await log.write(marker);
				});
			}
			void writes.catch(() => child.kill("SIGKILL"));
		}
	};
	child.stdout.on("data", (data: Buffer) => collect(data, process.stdout));
	child.stderr.on("data", (data: Buffer) => collect(data, process.stderr));
	// Install exit/error handlers before awaiting spawn so fast exits cannot be lost.
	const exited = new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 1));
	}).finally(async () => {
		try {
			await writes;
		} finally {
			await log?.close();
		}
	});
	void exited.catch(() => {});
	await new Promise<void>((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", reject);
	});
	return { child, exited };
}
