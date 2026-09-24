import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function traceBuild(t, name, failAt = "") {
	const directory = mkdtempSync(join(tmpdir(), "ipd-build-contract-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	for (const pkg of ["chord", "tui", "telemetry", "ai", "durable", "agent", "session-backends/sqlite-node", "protocol", "client", "server", "coding-agent", "ipd"]) {
		mkdirSync(join(directory, "packages", pkg), { recursive: true });
	}
	mkdirSync(join(directory, "bin"));
	const log = join(directory, "calls.jsonl");
	// The real root shell command runs against an inert npm stand-in. This test
	// proves orchestration/order, not compilation or package installation.
	const fakeNpm = join(directory, "bin/npm");
	writeFileSync(fakeNpm, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const pkg = path.basename(process.cwd());
fs.appendFileSync(process.env.IPD_TEST_LOG, JSON.stringify({ pkg, args: process.argv.slice(2) }) + "\\n");
if (pkg === process.env.IPD_TEST_FAIL) process.exit(23);
`);
	chmodSync(fakeNpm, 0o755);
	let status = 0;
	try {
		execFileSync("/bin/sh", ["-c", manifest.scripts[name]], {
			cwd: directory,
			env: { ...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH}`, IPD_TEST_LOG: log, IPD_TEST_FAIL: failAt },
			stdio: "pipe",
		});
	} catch (error) {
		status = error.status;
	}
	const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	return { status, calls };
}

for (const name of ["build", "build:offline"]) {
	test(`${name} includes IPD exactly once after coding-agent`, { skip: process.platform === "win32" }, (t) => {
		const { status, calls } = traceBuild(t, name);
		assert.equal(status, 0);
		assert.deepEqual(calls.slice(-2).map((call) => call.pkg), ["coding-agent", "ipd"]);
		assert.equal(calls.filter((call) => call.pkg === "ipd").length, 1);
		assert.deepEqual(calls.at(-1).args, ["run", "build"]);
		assert.deepEqual(calls.find((call) => call.pkg === "ai").args, ["run", name === "build:offline" ? "build:offline" : "build"]);
	});
}

test("upstream build failure prevents IPD packing against partial output", { skip: process.platform === "win32" }, (t) => {
	const { status, calls } = traceBuild(t, "build:offline", "coding-agent");
	assert.equal(status, 23);
	assert.equal(calls.at(-1).pkg, "coding-agent");
	assert(!calls.some((call) => call.pkg === "ipd"));
});

test("normal repository checks run the IPD internal-version guard", () => {
	assert.equal(manifest.scripts["check:ipd-build-contract"], "node scripts/check-ipd-build-contract.mjs");
	assert(manifest.scripts.check.includes("npm run check:ipd-build-contract"));
});
