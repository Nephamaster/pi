#!/usr/bin/env node
// Test actual tarball contents. --clean additionally rejects workspace links and
// nested registry copies; it does not publish packages or run a model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packReleasePackages } from "./coding-agent-consumer.mjs";
import {
	assertInstalledWorkspacePlan,
	assertIpdDependencyDeclarations,
	assertIpdPackedFiles,
	createIpdInstallPlan,
} from "./ipd-install-plan.mjs";

assert(Number(process.versions.node.split(".")[0]) >= 24, "IPD package verification requires Node.js 24 or newer.");
assert(process.argv.slice(2).every((arg) => arg === "--clean"), "Supported option: --clean");
const root = fileURLToPath(new URL("../", import.meta.url));
assertIpdDependencyDeclarations(root);
const temporary = await mkdtemp(join(tmpdir(), "pi-ipd-install-"));

try {
	const manifest = JSON.parse(await readFile(join(root, "packages/ipd/package.json"), "utf8"));
	const clean = process.argv.includes("--clean");
	const plan = clean ? createIpdInstallPlan(root) : {
		packages: [{ manifest, directory: join(root, "packages/ipd") }],
		edges: [],
	};
	// Reuse the existing pack helper, including its npm-version-specific JSON handling.
	const tarballs = packReleasePackages(
		plan.packages.map((pkg) => ({ name: pkg.manifest.name, directory: pkg.directory })),
		temporary,
	);
	const archive = tarballs.get(manifest.name);
	assert(archive, "IPD tarball was not produced.");
	const packedFiles = execFileSync("tar", ["-tf", archive], { encoding: "utf8" })
		.trim().split("\n").map((path) => path.replace(/^package\//, ""));
	execFileSync("tar", ["-xf", archive, "-C", temporary]);
	let pkg = join(temporary, "package");
	const packedManifest = JSON.parse(await readFile(join(pkg, "package.json"), "utf8"));
	assert.equal(packedManifest.name, manifest.name);
	assert.equal(packedManifest.version, manifest.version);
	assertIpdPackedFiles(packedManifest, packedFiles);
	if (clean) {
		const consumer = join(temporary, "clean-consumer");
		await mkdir(consumer);
		const dependencies = Object.fromEntries([...tarballs].map(([name, path]) => [name, `file:${path}`]));
		await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", dependencies }));
		execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"], {
			cwd: consumer,
			stdio: "inherit",
		});
		const installed = assertInstalledWorkspacePlan(consumer, plan);
		pkg = installed.get(manifest.name);
		console.log(`Verified packed workspace closure: ${[...installed.keys()].join(", ")}`);
	} else {
		// Fast file-set smoke only. Never describe this path as a clean installation.
		await symlink(join(root, "node_modules"), join(pkg, "node_modules"), "dir");
	}
	const smoke = join(pkg, "consumer.mjs");
	await writeFile(smoke, `
import assert from "node:assert/strict";
import { renderDashboardPage, FileRunStore } from "@earendil-works/pi-ipd";
import { DockerCli } from "@earendil-works/pi-ipd/workspace";
const html = renderDashboardPage({ runId: "packed-consumer" });
assert(html.includes("IpdDashboard.startDashboard"));
assert(!/<script\\s+src=/.test(html));
assert.equal(typeof FileRunStore, "function");
assert.equal(typeof DockerCli, "function");
console.log("Packed IPD default and workspace entries passed.");
`, "utf8");
	const home = join(temporary, "smoke-home");
	await mkdir(home);
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: home,
		XDG_CACHE_HOME: home,
		PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
		PI_SKIP_VERSION_CHECK: "1",
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
	};
	for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
		if (process.env[name]) env[name] = process.env[name];
	}
	execFileSync(process.execPath, [smoke], { cwd: pkg, env, stdio: "inherit", timeout: 30_000 });
} finally {
	await rm(temporary, { recursive: true, force: true });
}
