// Starts and controls long-running commands by opaque handles inside one lease.
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const ROOT = "/scratch/.ipd-processes";
const ID = /^[a-f0-9-]{36}$/;
const [operation, processId, cwd, command] = process.argv.slice(2);
if (!operation || !processId || !ID.test(processId)) throw new Error("Invalid managed process request");

const metadataPath = `${ROOT}/${processId}.json`;
const logPath = `${ROOT}/${processId}.log`;
await mkdir(ROOT, { recursive: true });

async function metadata() {
	return JSON.parse(await readFile(metadataPath, "utf8"));
}

if (operation === "start") {
	if (!cwd || command === undefined) throw new Error("Managed process start requires cwd and command");
	const runner = spawn(process.execPath, [new URL(import.meta.url).pathname, "run", processId, cwd, command], {
		detached: true,
		stdio: "ignore",
	});
	if (!runner.pid) throw new Error("Managed process runner did not start");
	await writeFile(metadataPath, JSON.stringify({ pid: runner.pid, state: "running" }), { mode: 0o600 });
	runner.unref();
	process.stdout.write(JSON.stringify({ pid: runner.pid }));
} else if (operation === "run") {
	if (!cwd || command === undefined) process.exit(2);
	const log = openSync(logPath, "a", 0o600);
	await writeFile(metadataPath, JSON.stringify({ pid: process.pid, state: "running" }), { mode: 0o600 });
	const child = spawn("/bin/bash", ["-lc", command], { cwd, env: process.env, stdio: ["ignore", log, log] });
	const exitCode = await new Promise((resolve) => child.once("close", (code) => resolve(code ?? -1)));
	await writeFile(metadataPath, JSON.stringify({ pid: process.pid, state: "exited", exitCode }), { mode: 0o600 });
} else if (operation === "status") {
	const current = await metadata();
	if (current.state === "running") {
		try {
			process.kill(current.pid, 0);
		} catch {
			current.state = "exited";
			await writeFile(metadataPath, JSON.stringify(current), { mode: 0o600 });
		}
	}
	process.stdout.write(JSON.stringify(current));
} else if (operation === "stop") {
	const current = await metadata();
	let killed = false;
	if (current.state === "running") {
		try {
			process.kill(-current.pid, "SIGTERM");
			killed = true;
		} catch {
			// The process already exited.
		}
		current.state = "stopped";
		await writeFile(metadataPath, JSON.stringify(current), { mode: 0o600 });
	}
	process.stdout.write(JSON.stringify({ ...current, killed }));
} else {
	throw new Error(`Unknown managed process operation: ${operation}`);
}
