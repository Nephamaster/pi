import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { launchCommand } from "./launch.ts";
import { BRIDGE_VERSION, decodeBridgeRequest, encodeBridgeRequest } from "./protocol.ts";

interface ProcessMetadata {
	pid: number;
	state: "running" | "exited" | "stopped";
	exitCode?: number;
	error?: string;
}
interface Acknowledgement {
	version: number;
	type: "ready" | "accepted" | "failed";
	processId: string;
	pid?: number;
	message?: string;
}
const START_TIMEOUT_MS = 10_000;
const request = decodeBridgeRequest(process.argv[2] ?? "");
if (!("scratch" in request)) throw new Error("Process bridge requires a managed process request");
const { scratch, processId } = request;
const root = `${scratch}/.ipd-processes`;
const metadataPath = `${root}/${processId}.json`;
const logPath = `${root}/${processId}.log`;
await mkdir(root, { recursive: true });
const metadata = async (): Promise<ProcessMetadata> =>
	JSON.parse(await readFile(metadataPath, "utf8")) as ProcessMetadata;
async function saveMetadata(value: ProcessMetadata): Promise<void> {
	const temporary = `${metadataPath}.${randomUUID()}.tmp`;
	await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
	await rename(temporary, metadataPath);
}
function signalGroup(pid: number | undefined, signal: NodeJS.Signals | 0): boolean {
	if (!pid) return false;
	try {
		process.kill(-pid, signal);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		return false;
	}
}

if (request.operation === "start") {
	const log = openSync(logPath, "a", 0o600);
	const runner = fork(
		fileURLToPath(import.meta.url),
		[encodeBridgeRequest({ ...request, operation: "run", launch: { ...request.launch, logPath } })],
		{
			detached: true,
			execArgv: [],
			stdio: ["ignore", log, log, "ipc"],
		},
	);
	closeSync(log);
	try {
		await new Promise<void>((resolve, reject) => {
			let finished = false;
			const finish = (error?: Error | null) => {
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
			const onError = (error: Error) => finish(error);
			const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
				finish(new Error(`Runner exited before acknowledgement (${code ?? signal})`));
			const onDisconnect = () => finish(new Error("Runner disconnected before acknowledgement"));
			const onMessage = (message: Acknowledgement) => {
				if (message?.version !== BRIDGE_VERSION || message.processId !== processId)
					return finish(new Error("Invalid managed process acknowledgement"));
				if (message.type === "failed") return finish(new Error(message.message));
				if (message.type !== "ready" || message.pid !== runner.pid)
					return finish(new Error("Invalid managed process acknowledgement"));
				runner.send({ version: BRIDGE_VERSION, type: "accepted", processId }, (error) => finish(error));
			};
			const timer = setTimeout(() => finish(new Error("Managed process startup timed out")), START_TIMEOUT_MS);
			runner.once("error", onError);
			runner.once("exit", onExit);
			runner.once("disconnect", onDisconnect);
			runner.once("message", onMessage);
		});
		if (runner.connected) runner.disconnect();
		runner.unref();
		process.stdout.write(JSON.stringify({ version: BRIDGE_VERSION, pid: runner.pid }));
	} catch (error) {
		signalGroup(runner.pid, "SIGKILL");
		if (runner.connected) runner.disconnect();
		const message = error instanceof Error ? error.message : String(error);
		await saveMetadata({ pid: runner.pid ?? 0, state: "exited", exitCode: -1, error: message });
		throw new Error(`Managed process ${processId} failed to start: ${message}; log: ${logPath}`, { cause: error });
	}
} else if (request.operation === "run") {
	if (!process.connected) throw new Error("Managed runner requires a start handshake");
	const orphaned = () => {
		signalGroup(process.pid, "SIGKILL");
	};
	process.once("disconnect", orphaned);
	const accepted = new Promise<void>((resolve) => {
		process.once("message", (message: Acknowledgement) => {
			if (message?.version !== BRIDGE_VERSION || message.type !== "accepted" || message.processId !== processId)
				return orphaned();
			process.off("disconnect", orphaned);
			resolve();
		});
	});
	try {
		const launched = await launchCommand(request.launch, false);
		await saveMetadata({ pid: process.pid, state: "running" });
		await new Promise<void>((resolve, reject) => {
			process.send!(
				{ version: BRIDGE_VERSION, type: "ready", processId, pid: process.pid },
				(error: Error | null) => (error ? reject(error) : resolve()),
			);
		});
		await accepted;
		await saveMetadata({ pid: process.pid, state: "exited", exitCode: await launched.exited });
	} catch (error) {
		console.error(error);
		if (process.connected)
			process.send!(
				{
					version: BRIDGE_VERSION,
					type: "failed",
					processId,
					message: error instanceof Error ? error.message : String(error),
				},
				(sendError: Error | null) => {
					if (sendError) orphaned();
				},
			);
		else orphaned();
	}
} else if (request.operation === "status") {
	const current = await metadata();
	if (current.state === "running" && !signalGroup(current.pid, 0)) {
		current.state = "exited";
		await saveMetadata(current);
	}
	process.stdout.write(JSON.stringify(current));
} else if (request.operation === "stop") {
	const current = await metadata();
	let killed = false;
	if (current.state === "running") {
		signalGroup(current.pid, "SIGTERM");
		await delay(250);
		killed = signalGroup(current.pid, "SIGKILL");
		current.state = "stopped";
		await saveMetadata(current);
	}
	process.stdout.write(JSON.stringify({ ...current, killed }));
}
