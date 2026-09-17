#!/usr/bin/env node
// Consume npm's actual packed file set without source aliases or an IPD source tree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "pi-ipd-install-"));
try {
	const result = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], {
		cwd: join(root, "packages/ipd"), encoding: "utf8",
	}));
	const files = result[0].files.map(file => file.path);
	assert(files.includes("dist/visualization/dashboard-assets.generated.js"));
	assert(!files.some(file => file.startsWith("src/")));
	execFileSync("tar", ["-xf", join(temporary, result[0].filename), "-C", temporary]);
	let pkg = join(temporary, "package");
	if (process.argv.includes("--clean")) {
		// Private workspace packages are supplied as real tarballs; external dependencies come from npm.
		const consumer = join(temporary, "clean-consumer");
		await mkdir(consumer);
		const dependencies = {};
		for (const directory of ["ai", "agent", "tui", "telemetry", "coding-agent", "ipd"]) {
			const archive = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], { cwd: join(root, "packages", directory), encoding: "utf8" }))[0];
			dependencies[archive.name] = `file:${join(temporary, archive.filename)}`;
		}
		await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", dependencies }));
		execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"], { cwd: consumer, stdio: "inherit" });
		const installed = join(consumer, "node_modules/@earendil-works/pi-ipd");
		assert((await realpath(installed)).startsWith(consumer));
		assert.equal(JSON.parse(await readFile(join(installed, "package.json"), "utf8")).name, "@earendil-works/pi-ipd");
		pkg = installed;
	} else await symlink(join(root, "node_modules"), join(pkg, "node_modules"), "dir");
	await writeFile(join(pkg, "consumer.mjs"), `
import assert from 'node:assert/strict';
import { renderDashboardPage, FileRunStore } from '@earendil-works/pi-ipd';
import { DockerCli } from '@earendil-works/pi-ipd/workspace';
const html = renderDashboardPage({runId:'packed-consumer'});
assert(html.includes('IpdDashboard.startDashboard'));
assert(!/<script\\s+src=/.test(html));
assert.equal(typeof FileRunStore, 'function');
assert.equal(typeof DockerCli, 'function');
console.log('Packed IPD default and workspace entries passed.');
`, "utf8");
	execFileSync(process.execPath, [join(pkg, "consumer.mjs")], { cwd: pkg, stdio: "inherit" });
} finally { await rm(temporary, { recursive: true, force: true }); }
