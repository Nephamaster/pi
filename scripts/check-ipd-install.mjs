#!/usr/bin/env node
// Consume npm's actual packed file set without source aliases or an IPD source tree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
	const pkg = join(temporary, "package");
	await symlink(join(root, "node_modules"), join(pkg, "node_modules"), "dir");
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
