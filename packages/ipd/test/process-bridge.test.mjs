// Native subprocess regressions for IPD PR1.5; no Docker, model, or extra test dependency.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const source = fileURLToPath(new URL("../environments/common/process-bridge.mjs", import.meta.url));
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "ipd-process-"));
	const cwd = join(root, "work with spaces");
	const scratch = join(root, "private scratch");
	const bridge = join(root, "bridge with spaces.mjs");
	const ids = new Set();
	await mkdir(cwd);
	await mkdir(scratch);
	await copyFile(source, bridge);
	t.after(async () => {
		for (const id of ids) {
			try {
				const state = JSON.parse(await readFile(join(scratch, ".ipd-processes", `${id}.json`), "utf8"));
				if (state.pid) process.kill(-state.pid, "SIGKILL");
			} catch (error) {
				if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
			}
		}
		await rm(root, { recursive: true, force: true });
	});
	const call = async (operation, id, extra = [], environment = {}, maxLogBytes = 1048576) => {
		ids.add(id);
		const launch = operation === "start" ? { argv: ["/bin/bash", "--noprofile", "--norc", "-c", extra[1]], cwd: extra[0], environment: { PATH: process.env.PATH, HOME: root, ...environment, NODE_OPTIONS: "" }, maxLogBytes } : undefined;
		return exec(process.execPath, [bridge, JSON.stringify({ version: 1, operation, scratch, processId: id, launch })], {
			timeout: 15_000,
			env: { ...process.env, NODE_OPTIONS: "", ...environment },
		});
	};
	return {
		root,
		cwd,
		call,
		log: (id) => readFile(join(scratch, ".ipd-processes", `${id}.log`), "utf8"),
		state: async (id) => JSON.parse((await call("status", id)).stdout),
		metadata: async (id) => JSON.parse(await readFile(join(scratch, ".ipd-processes", `${id}.json`), "utf8")),
	};
}

async function eventually(check, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return await check();
		} catch (error) {
			if (Date.now() >= deadline) throw error;
			await delay(25);
		}
	}
}

const command = (script) => `${quote(process.execPath)} -e ${quote(script)}`;

test("forwards scratch, cwd and quoted commands; logs and metadata exist when start acknowledges", async (t) => {
	const f = await fixture(t);
	const id = randomUUID();
	const output = "quoted ' text\nand another line";
	const started = JSON.parse(
		(await f.call("start", id, [f.cwd, command(`console.log(process.cwd()); console.log(${JSON.stringify(output)})`)])).stdout,
	);
	assert.ok(Number.isInteger(started.pid));
	await f.log(id); // Must be readable immediately, without a sleep or ENOENT fallback.
	await eventually(async () => assert.equal((await f.state(id)).state, "exited"));
	assert.equal((await f.state(id)).exitCode, 0);
	assert.equal(await f.log(id), `${f.cwd}\n${output}\n`);
});

test("acknowledgement means command spawned, not application readiness; a silent service has a readable log", async (t) => {
	const f = await fixture(t);
	const id = randomUUID();
	await f.call("start", id, [
		f.cwd,
		command('const fs=require("node:fs"); const timer=setInterval(()=>{if(fs.existsSync("release")){console.log("managed-ready"); clearInterval(timer); setInterval(()=>{},1000)}},20)'),
	]);
	assert.equal((await f.state(id)).state, "running");
	assert.equal(await f.log(id), "");
	await writeFile(join(f.cwd, "release"), "go");
	await eventually(async () => assert.match(await f.log(id), /managed-ready/));
	assert.equal(JSON.parse((await f.call("stop", id)).stdout).state, "stopped");
	assert.equal((await f.state(id)).state, "stopped");
});

test("fast commands keep their final exit codes instead of being overwritten by the starter", async (t) => {
	const f = await fixture(t);
	await Promise.all(
		[0, 7, 0, 7, 0, 7].map(async (exitCode) => {
			const id = randomUUID();
			await f.call("start", id, [f.cwd, `printf 'exit-${exitCode}'; exit ${exitCode}`]);
			await eventually(async () => assert.equal((await f.state(id)).state, "exited"));
			assert.equal((await f.state(id)).exitCode, exitCode);
			assert.equal(await f.log(id), `exit-${exitCode}`);
		}),
	);
});

test("a command spawn failure is returned to the caller, not a successful handle", async (t) => {
	const f = await fixture(t);
	const id = randomUUID();
	await assert.rejects(f.call("start", id, [join(f.cwd, "missing"), "echo must-not-run"]), (error) => {
		assert.equal(error.stdout, "");
		assert.match(error.stderr, /failed to start.*ENOENT/);
		return true;
	});
	assert.equal((await f.metadata(id)).state, "exited");
	assert.equal((await f.metadata(id)).exitCode, -1);
	assert.match(await f.log(id), /ENOENT/);
});

test("runner bootstrap errors fail before readiness and remain in the log", async (t) => {
	const f = await fixture(t);
	const id = randomUUID();
	const preload = join(f.root, "bootstrap.mjs");
	await writeFile(preload, 'if(JSON.parse(process.argv[2]).operation==="run"){console.error("synthetic-bootstrap-error");process.exit(23)}');
	await assert.rejects(
		f.call("start", id, [f.cwd, "echo must-not-run"], { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }),
		(error) => {
			assert.equal(error.stdout, "");
			assert.match(error.stderr, /failed to start/);
			return true;
		},
	);
	assert.match(await f.log(id), /synthetic-bootstrap-error/);
	assert.equal((await f.metadata(id)).state, "exited");
});

test("startup acknowledgement has a deadline and a stalled runner cannot execute later", { timeout: 20_000 }, async (t) => {
	const f = await fixture(t);
	const id = randomUUID();
	const preload = join(f.root, "stall.mjs");
	await writeFile(preload, 'if(JSON.parse(process.argv[2]).operation==="run"){await new Promise(resolve=>setTimeout(resolve,60000))}');
	await assert.rejects(
		f.call("start", id, [f.cwd, "echo must-not-run"], { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }),
		(error) => {
			assert.equal(error.stdout, "");
			assert.match(error.stderr, /startup timed out/);
			return true;
		},
	);
	const state = await f.metadata(id);
	assert.equal(state.state, "exited");
	assert.equal(state.exitCode, -1);
	assert.equal(await f.log(id), "");
	// A dead process can remain as a zombie briefly in minimal containers; it cannot execute.
	if (process.platform === "linux") {
		await eventually(async () => {
			try {
				const status = await readFile(`/proc/${state.pid}/status`, "utf8");
				assert.match(status, /State:\s+Z/);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		});
	}
});

test("normal, full-log and managed commands share cwd and explicit environment without login startup", async (t) => {
	const f = await fixture(t);
	const executable = fileURLToPath(new URL("../environments/common/command-bridge.mjs", import.meta.url));
	await writeFile(join(f.root, ".bash_profile"), "export IPD_PROFILE_VALUE=wrong; export PATH=/wrong\n");
	const environment = { PATH: "/profile-only", HOME: f.root, IPD_PROFILE_VALUE: "profile" };
	const script = command('console.log(JSON.stringify({cwd:process.cwd(),path:process.env.PATH,value:process.env.IPD_PROFILE_VALUE,secret:process.env.IPD_HOST_SECRET}))');
	const launch = { argv: ["/bin/bash", "--noprofile", "--norc", "-c", script], cwd: f.cwd, environment, maxLogBytes: 1024 };
	const expected = `${JSON.stringify({cwd:f.cwd,path:"/profile-only",value:"profile"})}\n`;
	const options = { timeout: 15000, env: { ...process.env, NODE_OPTIONS: "", IPD_HOST_SECRET: "must-not-reach-command" } };
	assert.equal((await exec(process.execPath, [executable, JSON.stringify({version:1,operation:"exec",launch})], options)).stdout, expected);
	const logPath = join(f.root, "full output.log");
	assert.equal((await exec(process.execPath, [executable, JSON.stringify({version:1,operation:"exec",launch:{...launch,logPath}})], options)).stdout, expected);
	assert.equal(await readFile(logPath,"utf8"), expected);
	const id = randomUUID();
	await f.call("start", id, [f.cwd, script], environment);
	await eventually(async()=>assert.equal((await f.state(id)).state,"exited"));
	assert.equal(await f.log(id), expected);
});

test("managed logs stay bounded and say when output is truncated", async (t) => {
	const f = await fixture(t); const id = randomUUID();
	await f.call("start", id, [f.cwd, command('process.stdout.write("x".repeat(65536))')], {}, 1024);
	await eventually(async()=>assert.equal((await f.state(id)).state,"exited"));
	const log = await f.log(id);
	assert.ok(Buffer.byteLength(log) <= 1024);
	assert.match(log, /Output truncated at the environment log limit/);
});

test("rejects incompatible bridge versions before executing a command", async (t) => {
	const f = await fixture(t);
	const executable = fileURLToPath(new URL("../environments/common/command-bridge.mjs", import.meta.url));
	await assert.rejects(exec(process.execPath,[executable,JSON.stringify({version:99,operation:"exec"})],{cwd:f.cwd,env:{...process.env,NODE_OPTIONS:""}}),error=>{
		assert.match(error.stderr,/Unsupported bridge protocol version/); return true;
	});
});

test("cancels a foreground command tree without stopping an unrelated managed service", async (t) => {
	const f = await fixture(t);
	const service = randomUUID();
	await f.call("start", service, [f.cwd, command('setInterval(()=>{},1000)')]);
	const executable = fileURLToPath(new URL("../environments/common/command-bridge.mjs", import.meta.url));
	const scratch = join(f.root, "command scratch");
	const processId = randomUUID();
	const identity = { version: 1, scratch, processId };
	const launch = { argv: ["/bin/bash", "--noprofile", "--norc", "-c", "echo started > command-ready; sleep 120 & wait"], cwd: f.cwd, environment: { PATH: process.env.PATH }, maxLogBytes: 1024 };
	const running = exec(process.execPath, [executable, JSON.stringify({ ...identity, operation: "exec", launch })]);
	const outcome = running.catch(error => error);
	await eventually(async () => {
		await readFile(join(f.cwd, "command-ready"));
		assert.equal((await f.state(service)).state, "running");
	});
	assert.deepEqual(JSON.parse((await exec(process.execPath, [executable, JSON.stringify({ ...identity, operation: "cancel_command" })])).stdout), { stopped: true });
	await outcome;
	assert.equal((await f.state(service)).state, "running");
	assert.equal(JSON.parse((await f.call("stop", service)).stdout).state, "stopped");
});

test("normal command completion preserves background work; an explicit cancellation still stops its group", async (t) => {
	const f = await fixture(t);
	const executable = fileURLToPath(new URL("../environments/common/command-bridge.mjs", import.meta.url));
	const identity = { version: 1, scratch: join(f.root, "commands"), processId: randomUUID() };
	const launch = { argv: ["/bin/bash", "--noprofile", "--norc", "-c", "sleep 60 >/dev/null 2>&1 & echo $! > background.pid"], cwd: f.cwd, environment: { PATH: process.env.PATH }, maxLogBytes: 1024 };
	await exec(process.execPath, [executable, JSON.stringify({ ...identity, operation: "exec", launch })]);
	const pid = Number(await readFile(join(f.cwd, "background.pid"), "utf8"));
	t.after(() => { try { process.kill(pid, "SIGKILL"); } catch(error) { if(error.code !== "ESRCH") throw error; } });
	assert.doesNotThrow(() => process.kill(pid, 0));
	assert.deepEqual(JSON.parse((await exec(process.execPath, [executable, JSON.stringify({ ...identity, operation: "cancel_command" })])).stdout), { stopped: true });
});
