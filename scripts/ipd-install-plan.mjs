// Build and inspect the runtime workspace closure used by the IPD package smoke test.
// No npm resolution, package installation or model calls happen in this module.
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

const IPD = "@earendil-works/pi-ipd";
const RUNTIME_SECTIONS = ["dependencies", "optionalDependencies", "peerDependencies"];

export function readWorkspacePackages(root) {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert(Array.isArray(manifest.workspaces), "The repository must declare its workspaces.");
	const patterns = manifest.workspaces.map((pattern) => {
		assert(typeof pattern === "string", "Workspace patterns must be strings.");
		assert(!/[?{}[\]!]|\*\*/.test(pattern), `Unsupported workspace pattern: ${pattern}`);
		const escaped = pattern.replace(/[.+^$()|\\]/g, "\\$&").replaceAll("*", "[^/]*");
		return new RegExp(`^${escaped}$`);
	});
	const packages = new Map();
	for (const directory of findPackageDirectories(join(root, "packages"))) {
		const path = relative(root, directory).split(sep).join("/");
		if (!patterns.some((pattern) => pattern.test(path))) continue;
		const data = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
		assert(typeof data.name === "string" && typeof data.version === "string", `Invalid package at ${path}`);
		assert(/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(data.name), `Invalid package name: ${data.name}`);
		assert(!packages.has(data.name), `Duplicate workspace package: ${data.name}`);
		packages.set(data.name, { directory, manifest: data });
	}
	return packages;
}

export function runtimeWorkspaceEdges(pkg, packages) {
	const edges = [];
	for (const section of RUNTIME_SECTIONS) {
		for (const [name, specifier] of Object.entries(pkg.manifest[section] ?? {})) {
			assert(typeof specifier === "string", `Invalid ${section} entry: ${pkg.manifest.name} -> ${name}`);
			// npm aliases intentionally target a registry package, not the same-named workspace.
			if (specifier.startsWith("npm:") || !packages.has(name)) continue;
			edges.push({ from: pkg.manifest.name, name, section, specifier });
		}
	}
	return edges;
}

export function createIpdInstallPlan(root) {
	const available = readWorkspacePackages(root);
	assert(available.has(IPD), "IPD is not a declared workspace package.");
	const selected = new Map();
	const edges = [];
	const pending = [IPD];
	while (pending.length) {
		const name = pending.pop();
		if (selected.has(name)) continue;
		const pkg = available.get(name);
		assert(pkg, `Missing runtime workspace: ${name}`);
		selected.set(name, pkg);
		for (const edge of runtimeWorkspaceEdges(pkg, available)) {
			edges.push(edge);
			pending.push(edge.name);
		}
	}
	return {
		packages: [...selected.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name)),
		edges,
	};
}

export function assertIpdDependencyDeclarations(root) {
	const packages = readWorkspacePackages(root);
	const ipd = packages.get(IPD);
	assert(ipd, "IPD is not a declared workspace package.");
	for (const edge of runtimeWorkspaceEdges(ipd, packages)) {
		const version = packages.get(edge.name).manifest.version;
		// Match sync-versions.js's canonical workspace spelling; this is not a SemVer parser.
		assert.equal(
			edge.specifier,
			`^${version}`,
			`${IPD} ${edge.section}.${edge.name} must match the workspace declaration ^${version}; run the reviewed version/lock update.`,
		);
	}
}

export function assertIpdPackedFiles(manifest, packedFiles) {
	const files = new Set(packedFiles);
	assert(files.has("package.json"), "Packed package.json is missing.");
	for (const entry of [".", "./workspace", "./legacy"]) {
		assert(manifest.exports?.[entry], `Required IPD export is missing: ${entry}`);
	}
	assert(!packedFiles.some((file) => file.startsWith("src/")), "The package must not depend on its source tree.");
	for (const [entry, conditions] of Object.entries(manifest.exports ?? {})) {
		assert(conditions && typeof conditions === "object", `Unexpected IPD export: ${entry}`);
		for (const condition of ["import", "types"]) {
			const target = conditions[condition];
			assert(typeof target === "string" && target.startsWith("./dist/"), `${entry} is missing a dist ${condition} target.`);
			assert(!target.split("/").includes(".."), `Export target escapes dist: ${target}`);
			assert(files.has(target.slice(2)), `Packed export ${entry} (${condition}) is missing: ${target}. Build IPD first.`);
		}
	}
	for (const file of [
		"dist/index.js",
		"dist/index.d.ts",
		"dist/visualization/dashboard-assets.generated.js",
		"assets/skills/process-selection/SKILL.md",
		"assets/skills/workflow-design/SKILL.md",
		"prompts/execution-node.md",
		"prompts/review-node.md",
		"environments/general-purpose/profile.template.json",
		"environments/common/command-bridge.mjs",
		"environments/common/process-bridge.mjs",
		"environments/common/fs-bridge.mjs",
		"environments/common/egress-bridge.mjs",
	]) {
		assert(files.has(file), `Required packed resource is missing: ${file}`);
	}
}

export function assertInstalledWorkspacePlan(consumer, plan) {
	const consumerRoot = realpathSync(consumer);
	const installed = new Map();
	for (const pkg of plan.packages) {
		const name = pkg.manifest.name;
		const directory = realpathSync(join(consumerRoot, "node_modules", name));
		const distance = relative(consumerRoot, directory);
		assert(
			distance && distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance),
			`Installed workspace escapes consumer: ${name}`,
		);
		const actual = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
		assert.equal(actual.name, name, `Installed package identity mismatch: ${name}`);
		assert.equal(actual.version, pkg.manifest.version, `Installed package version mismatch: ${name}`);
		installed.set(name, directory);
	}
	for (const edge of plan.edges) {
		const importer = installed.get(edge.from);
		const require = createRequire(join(importer, "package.json"));
		// Resolve from each importing package, not only the consumer root. This catches
		// nested older registry copies that root-level version checks would miss.
		const candidate = (require.resolve.paths(edge.name) ?? [])
			.map((directory) => join(directory, edge.name, "package.json"))
			.find((path) => existsSync(path) && statSync(path).isFile());
		assert(candidate, `Installed dependency is missing: ${edge.from} -> ${edge.name}`);
		assert.equal(
			realpathSync(resolve(candidate, "..")),
			installed.get(edge.name),
			`Workspace dependency did not resolve to its packed copy: ${edge.from} -> ${edge.name} (${edge.specifier})`,
		);
	}
	return installed;
}
