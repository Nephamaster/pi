import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	assertInstalledWorkspacePlan,
	assertIpdDependencyDeclarations,
	assertIpdPackedFiles,
	createIpdInstallPlan,
	readWorkspacePackages,
} from "./ipd-install-plan.mjs";

const IPD = "@earendil-works/pi-ipd";
const AI = "@earendil-works/pi-ai";
const VERSION = "0.87.1";

function writeJson(path, value) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}

function fixture(t, options = {}) {
	const root = mkdtempSync(join(tmpdir(), "ipd-install-plan-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeJson(join(root, "package.json"), { workspaces: options.workspaces ?? ["packages/*", "packages/session-backends/*"] });
	mkdirSync(join(root, "packages"), { recursive: true });
	const add = (path, name, fields = {}) => {
		writeJson(join(root, "packages", path, "package.json"), { name, version: VERSION, ...fields });
	};
	add("ipd", IPD, options.ipd ?? {});
	return { root, add };
}

function installedFixture(root, plan) {
	const consumer = join(root, "consumer");
	mkdirSync(consumer, { recursive: true });
	for (const pkg of plan.packages) {
		writeJson(join(consumer, "node_modules", pkg.manifest.name, "package.json"), pkg.manifest);
	}
	return consumer;
}

test("runtime closure follows transitive internal dependencies, not a six-package allowlist", (t) => {
	const { root, add } = fixture(t, { ipd: { dependencies: { [AI]: `^${VERSION}` } } });
	add("ai", AI, { dependencies: { "@example/nested": `^${VERSION}` } });
	add("session-backends/nested", "@example/nested");
	add("unrelated", "@example/unrelated");
	const plan = createIpdInstallPlan(root);
	assert.deepEqual(plan.packages.map((pkg) => pkg.manifest.name), [AI, IPD, "@example/nested"].sort());
	assert.equal(plan.edges.length, 2);
});

test("runtime closure includes internal optional and peer dependencies", (t) => {
	const { root, add } = fixture(t, { ipd: {
		optionalDependencies: { "@example/optional": `^${VERSION}` },
		peerDependencies: { "@example/peer": `^${VERSION}`, "external-peer": "1.0.0" },
		peerDependenciesMeta: { "@example/peer": { optional: true } },
	} });
	add("optional", "@example/optional");
	add("peer", "@example/peer");
	assert.equal(createIpdInstallPlan(root).packages.length, 3);
});

test("development dependencies and npm aliases are not replaced with workspace tarballs", (t) => {
	const { root, add } = fixture(t, { ipd: {
		dependencies: { [AI]: "npm:published-fixture@1.0.0", external: "1.0.0" },
		devDependencies: { "@example/test-only": `^${VERSION}` },
	} });
	add("ai", AI);
	add("test-only", "@example/test-only");
	assert.deepEqual(createIpdInstallPlan(root).packages.map((pkg) => pkg.manifest.name), [IPD]);
});

test("workspace dependency cycles terminate and pack each workspace once", (t) => {
	const { root, add } = fixture(t, { ipd: { dependencies: { [AI]: `^${VERSION}` } } });
	add("ai", AI, { dependencies: { [IPD]: `^${VERSION}` } });
	const plan = createIpdInstallPlan(root);
	assert.equal(plan.packages.length, 2);
	assert.equal(plan.edges.length, 2);
});

test("generated and fixture package.json files outside declared workspaces are ignored", (t) => {
	const { root, add } = fixture(t);
	add("coding-agent/install-lock", IPD);
	add("ipd/test/fixtures/sample", IPD);
	assert.equal(readWorkspacePackages(root).size, 1);
});

test("literal example workspaces are discovered", (t) => {
	const { root, add } = fixture(t, {
		workspaces: ["packages/*", "packages/coding-agent/examples/extension"],
		ipd: { dependencies: { "@example/extension": `^${VERSION}` } },
	});
	add("coding-agent/examples/extension", "@example/extension");
	assert.equal(createIpdInstallPlan(root).packages.length, 2);
});

test("duplicate declared workspace names fail instead of silently overriding", (t) => {
	const { root, add } = fixture(t);
	add("duplicate", IPD);
	assert.throws(() => readWorkspacePackages(root), /Duplicate workspace/);
});

test("unsupported workspace glob syntax fails explicitly", (t) => {
	const { root } = fixture(t, { workspaces: ["packages/**"] });
	assert.throws(() => readWorkspacePackages(root), /Unsupported workspace pattern/);
});

test("malformed runtime dependency specifications fail", (t) => {
	const { root, add } = fixture(t, { ipd: { dependencies: { [AI]: 42 } } });
	add("ai", AI);
	assert.throws(() => createIpdInstallPlan(root), /Invalid dependencies entry/);
});

test("IPD dependency declarations follow the existing sync-versions convention", (t) => {
	const { root, add } = fixture(t, { ipd: { dependencies: { [AI]: `^${VERSION}` } } });
	add("ai", AI);
	assert.doesNotThrow(() => assertIpdDependencyDeclarations(root));
});

test("stale IPD dependency ranges are rejected before package installation", (t) => {
	const { root, add } = fixture(t, { ipd: { dependencies: { [AI]: "^0.85.1" } } });
	add("ai", AI);
	assert.throws(() => assertIpdDependencyDeclarations(root), /must match the workspace declaration \^0.87.1/);
});

const packedManifest = {
	exports: {
		".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
		"./legacy": { import: "./dist/legacy.js", types: "./dist/legacy.d.ts" },
		"./workspace": { import: "./dist/workspace.js", types: "./dist/workspace.d.ts" },
	},
};
const requiredFiles = [
	"package.json",
	"dist/index.js", "dist/index.d.ts",
	"dist/legacy.js", "dist/legacy.d.ts",
	"dist/workspace.js", "dist/workspace.d.ts",
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
];

test("complete packed entries and runtime resources pass the file-set check", () => {
	assert.doesNotThrow(() => assertIpdPackedFiles(packedManifest, requiredFiles));
});

for (const missing of ["dist/index.js", "dist/workspace.d.ts", "assets/skills/workflow-design/SKILL.md", "environments/common/fs-bridge.mjs"]) {
	test(`packed smoke rejects a missing ${missing}`, () => {
		assert.throws(() => assertIpdPackedFiles(packedManifest, requiredFiles.filter((file) => file !== missing)), /missing/);
	});
}

test("an archive containing source files cannot disguise a missing compiled entry", () => {
	assert.throws(() => assertIpdPackedFiles(packedManifest, [...requiredFiles, "src/index.ts"]), /source tree/);
});

test("exports must have compiled declaration and runtime targets", () => {
	assert.throws(() => assertIpdPackedFiles({ exports: { ...packedManifest.exports, ".": { source: "./src/index.ts" } } }, requiredFiles), /dist import target/);
});

test("exports cannot escape the dist directory", () => {
	assert.throws(() => assertIpdPackedFiles({ exports: { ...packedManifest.exports, ".": { import: "./dist/../outside.js", types: "./dist/index.d.ts" } } }, requiredFiles), /escapes dist/);
});

test("installed runtime workspace closure passes without source links", (t) => {
	const { root, add } = fixture(t, { ipd: { dependencies: { [AI]: `^${VERSION}` } } });
	add("ai", AI);
	const plan = createIpdInstallPlan(root);
	const installed = assertInstalledWorkspacePlan(installedFixture(root, plan), plan);
	assert.equal(installed.size, 2);
});

test("missing installed runtime workspaces are rejected", (t) => {
	const { root, add } = fixture(t, { ipd: { dependencies: { [AI]: `^${VERSION}` } } });
	add("ai", AI);
	const plan = createIpdInstallPlan(root);
	const consumer = installedFixture(root, plan);
	rmSync(join(consumer, "node_modules", AI), { recursive: true });
	assert.throws(() => assertInstalledWorkspacePlan(consumer, plan), /ENOENT/);
});

test("wrong installed root version is rejected", (t) => {
	const { root } = fixture(t);
	const plan = createIpdInstallPlan(root);
	const consumer = installedFixture(root, plan);
	writeJson(join(consumer, "node_modules", IPD, "package.json"), { name: IPD, version: "0.85.1" });
	assert.throws(() => assertInstalledWorkspacePlan(consumer, plan), /version mismatch/);
});

test("a nested old registry copy is rejected even if the root version is correct", (t) => {
	const { root, add } = fixture(t, { ipd: { dependencies: { [AI]: `^${VERSION}` } } });
	add("ai", AI);
	const plan = createIpdInstallPlan(root);
	const consumer = installedFixture(root, plan);
	writeJson(join(consumer, "node_modules", IPD, "node_modules", AI, "package.json"), { name: AI, version: "0.85.1" });
	assert.throws(() => assertInstalledWorkspacePlan(consumer, plan), /did not resolve to its packed copy/);
});

test("even an identical-version duplicate must resolve to the supplied packed location", (t) => {
	const { root, add } = fixture(t, { ipd: { dependencies: { [AI]: `^${VERSION}` } } });
	add("ai", AI);
	const plan = createIpdInstallPlan(root);
	const consumer = installedFixture(root, plan);
	writeJson(join(consumer, "node_modules", IPD, "node_modules", AI, "package.json"), { name: AI, version: VERSION });
	assert.throws(() => assertInstalledWorkspacePlan(consumer, plan), /did not resolve to its packed copy/);
});

test("a source-workspace symlink does not count as a clean installation", (t) => {
	const { root } = fixture(t);
	const plan = createIpdInstallPlan(root);
	const consumer = installedFixture(root, plan);
	rmSync(join(consumer, "node_modules", IPD), { recursive: true });
	symlinkSync(join(root, "packages/ipd"), join(consumer, "node_modules", IPD), "dir");
	assert.throws(() => assertInstalledWorkspacePlan(consumer, plan), /escapes consumer/);
});

test("installed identity is checked separately from its path and version", (t) => {
	const { root } = fixture(t);
	const plan = createIpdInstallPlan(root);
	const consumer = installedFixture(root, plan);
	writeJson(join(consumer, "node_modules", IPD, "package.json"), { name: "wrong-package", version: VERSION });
	assert.throws(() => assertInstalledWorkspacePlan(consumer, plan), /identity mismatch/);
});

test("removing an existing package export is not treated as a successful smoke check", () => {
	assert.throws(() => assertIpdPackedFiles({ exports: { ".": packedManifest.exports["."] } }, requiredFiles), /Required IPD export is missing/);
});
