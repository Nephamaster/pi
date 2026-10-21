import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { API } from "typescript/unstable/sync";

const root = fileURLToPath(new URL("../", import.meta.url));
const client = resolve(root, "packages/ipd/src/visualization/dashboard-client.ts");

function config(path) {
	const api = new API({ cwd: root });
	try {
		return api.parseConfigFile(resolve(root, path));
	} finally {
		api.close();
	}
}

// These inspect real project configurations. The following small compiler probes
// exercise their standard-library boundary, not the complete monorepo build.
const hostConfig = config("tsconfig.json");
const browserConfig = config("packages/ipd/tsconfig.browser.json");
const buildConfig = config("packages/ipd/tsconfig.build.json");

function probe(configPath, source) {
	const file = resolve(root, "__ipd_type_boundary_probe__.ts");
	const probeConfig = resolve(root, "__ipd_type_boundary_probe__.json");
	const files = new Map([
		[file, source],
		[probeConfig, JSON.stringify({
			extends: resolve(root, configPath),
			compilerOptions: { types: [], noEmit: true, skipLibCheck: true },
			files: [file],
			include: [],
			exclude: [],
		})],
	]);
	const api = new API({ cwd: root, fs: {
		fileExists: (name) => files.has(resolve(name)) ? true : undefined,
		readFile: (name) => files.get(resolve(name)),
	} });
	try {
		const project = api.updateSnapshot({ openProjects: [probeConfig] }).getProject(probeConfig);
		assert(project);
		return [
			...project.program.getConfigFileParsingDiagnostics(),
			...project.program.getProgramDiagnostics(),
			...project.program.getSyntacticDiagnostics(),
			...project.program.getSemanticDiagnostics(),
		];
	} finally {
		api.close();
	}
}

const domProbe = `export {};
const element: HTMLElement = document.body;
const request: RequestInit = { cache: "no-store" };
void element; void request;
`;

test("the host check excludes only the separately checked browser entry", () => {
	assert(!hostConfig.fileNames.includes(client));
	assert(hostConfig.fileNames.includes(resolve(root, "packages/ipd/src/runtime/workflow-runtime.ts")));
	assert(hostConfig.fileNames.includes(resolve(root, "packages/ipd/test/compiler.test.ts")));
	assert(hostConfig.fileNames.includes(resolve(root, "packages/ipd/src/visualization/dashboard-model.ts")));
});

test("browser entry remains type-checked with DOM libraries", () => {
	assert(browserConfig.fileNames.includes(client));
	assert(browserConfig.options.lib.includes("lib.dom.d.ts"));
	assert(browserConfig.options.lib.includes("lib.dom.iterable.d.ts"));
	assert(!hostConfig.options.lib.some((name) => name.startsWith("lib.dom")));
	assert(!buildConfig.fileNames.includes(client));
});

test("browser check is still part of the normal repository gate", () => {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert(manifest.scripts.check.includes("npm run check:ipd-dashboard"));
	assert(manifest.scripts.check.includes("tsc --noEmit"));
	assert(manifest.scripts["check:ipd-dashboard"].includes("tsc -p packages/ipd/tsconfig.browser.json"));
});

test("the old host-wide inclusion reproduces missing DOM names", () => {
	const errors = probe("tsconfig.json", domProbe);
	assert(errors.some((item) => item.code === 2304));
	assert(errors.some((item) => item.text.includes("document")));
});

test("the same DOM and fetch-cache probe passes the browser configuration", () => {
	assert.deepEqual(probe("packages/ipd/tsconfig.browser.json", domProbe), []);
});

test("the browser check still rejects an invalid DOM assignment", () => {
	const errors = probe("packages/ipd/tsconfig.browser.json", "export {}; const element: HTMLElement = 1; void element;");
	assert(errors.some((item) => item.code === 2322));
});

test("excluding the browser entry does not silently enable DOM in host code", () => {
	const errors = probe("tsconfig.json", "export {}; document.body.append('host');");
	assert(errors.some((item) => item.text.includes("document")));
});
