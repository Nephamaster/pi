// Starts and controls long-running commands by opaque handles inside one lease.
import { fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const ID = /^[a-f0-9-]{36}$/;
const START_TIMEOUT_MS = 10_000;
const args = process.argv.slice(2);
const [operation, scratchRoot, processId, cwd, command] = args;
if (
	!operation ||
	!scratchRoot?.startsWith("/") ||
	posix.normalize(scratchRoot) !== scratchRoot ||
	!processId ||
	!ID.test(processId)
)
	throw new Error("Invalid managed process request");

const ROOT = `${scratchRoot}/.ipd-processes`;
const metadataPath = `${ROOT}/${processId}.json`;
const logPath = `${ROOT}/${processId}.log`;
await mkdir(ROOT, { recursive: true });

async function metadata() {
	return JSON.parse(await readFile(metadataPath, "utf8"));
}

async function saveMetadata(value) {
	const temporary = `${metadataPath}.${randomUUID()}.tmp`;
	await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
	await rename(temporary, metadataPath);
}

function signalGroup(pid, signal) {
	if (!pid) return false;
	try {
		process.kill(-pid, signal);
		return true;
	} catch (error) {
		if (error.code !== "ESRCH") throw error;
		return false;
	}
}

if (operation === "start") {
	if (!cwd || command === undefined) throw new Error("Managed process start requires cwd and command");
	// Create the log before forking so even bootstrap failures have a diagnostic path.
	const log = openSync(logPath, "a", 0o600);
	let runner;
	try {
		// Forward the same request; do not maintain a second positional argument list.
		runner = fork(fileURLToPath(import.meta.url), ["run", ...args.slice(1)], {
			detached: true,
			execArgv: [],
			stdio: ["ignore", log, log, "ipc"],
		});
	} finally {
		closeSync(log);
	}
	try {
		await new Promise((resolve, reject) => {
			let finished = false;
			const finish = (error) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				runner.off("error", onError);
				runner.off("exit", onExit);
				runner.off("disconnect", onDisconnect);
				runner.off("message", onMessage);
				if (error) reject(error);
				else resolve();
			};
			const onError = (error) => finish(error);
			const onExit = (code, signal) => finish(new Error(`Runner exited before acknowledgement (${code ?? signal})`));
			const onDisconnect = () => finish(new Error("Runner disconnected before acknowledgement"));
			const onMessage = (message) => {
				if (message?.type === "failed") return finish(new Error(message.message));
				if (message?.type !== "ready" || message.processId !== processId || message.pid !== runner.pid)
					return finish(new Error("Invalid managed process acknowledgement"));
				runner.send({ type: "accepted", processId }, (error) => finish(error));
			};
			const timer = setTimeout(() => finish(new Error("Managed process startup timed out")), START_TIMEOUT_MS);
			runner.once("error", onError);
			runner.once("exit", onExit);
			runner.once("disconnect", onDisconnect);
			runner.once("message", onMessage);
		});
		if (runner.connected) runner.disconnect();
		runner.unref();
		process.stdout.write(JSON.stringify({ pid: runner.pid }));
	} catch (error) {
		// A failed handshake must not leave an unowned runner or user command behind.
		signalGroup(runner.pid, "SIGKILL");
		if (runner.connected) runner.disconnect();
		await saveMetadata({ pid: runner.pid, state: "exited", exitCode: -1, error: error.message });
		throw new Error(`Managed process ${processId} failed to start: ${error.message}; log: ${logPath}`, { cause: error });
	}
} else if (operation === "run") {
	if (!cwd || command === undefined || !process.connected) throw new Error("Managed runner requires a start handshake");
	// Until the caller accepts ownership, a disconnected caller cancels this process group.
	const orphaned = () => signalGroup(process.pid, "SIGKILL");
	process.once("disconnect", orphaned);
	const accepted = new Promise((resolve) => {
		process.once("message", (message) => {
			if (message?.type !== "accepted" || message.processId !== processId) return orphaned();
			process.off("disconnect", orphaned);
			resolve();
		});
	});
	try {
		const child = spawn("/bin/bash", ["-lc", command], { cwd, env: process.env, stdio: ["ignore", 1, 2] });
		// Install both listeners before waiting: a short command can exit during metadata I/O.
		const exited = new Promise((resolve) => child.once("close", (code) => resolve(code ?? -1)));
		await new Promise((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
		await saveMetadata({ pid: process.pid, state: "running" });
		await new Promise((resolve, reject) => {
			process.send({ type: "ready", processId, pid: process.pid }, (error) => (error ? reject(error) : resolve()));
		});
		await accepted;
		const exitCode = await exited;
		await saveMetadata({ pid: process.pid, state: "exited", exitCode });
	} catch (error) {
		console.error(error);
		if (process.connected) {
			// Keep the channel alive until the caller receives the error and terminates us.
			process.send({ type: "failed", message: error.message }, (sendError) => {
				if (sendError) orphaned();
			});
		} else {
			orphaned();
		}
	}
} else if (operation === "status") {
	const current = await metadata();
	if (current.state === "running") {
		try {
			process.kill(current.pid, 0);
		} catch (error) {
			if (error.code !== "ESRCH") throw error;
			current.state = "exited";
			await saveMetadata(current);
		}
	}
	process.stdout.write(JSON.stringify(current));
} else if (operation === "stop") {
	const current = await metadata();
	let killed = false;
	if (current.state === "running") {
		killed = signalGroup(current.pid, "SIGTERM");
		current.state = "stopped";
		await saveMetadata(current);
	}
	process.stdout.write(JSON.stringify({ ...current, killed }));
} else {
	throw new Error(`Unknown managed process operation: ${operation}`);
}
