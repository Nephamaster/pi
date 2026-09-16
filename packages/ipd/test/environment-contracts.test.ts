import { describe, expect, it } from "vitest";
import { classifyWorkerError } from "../src/adapter/pi-node-worker.ts";
import { DEFAULT_ENVIRONMENT_PATHS } from "../src/environment/profiles.ts";
import {
	assertVirtualExportAllowed,
	assertVirtualPathAllowed,
	assertVirtualWorkingDirectoryAllowed,
	buildIsolatedEnvironment,
	compileWorkflow,
	createEnvironmentBinding,
	EnvironmentError,
	legacySrtProfile,
	matchesVersion,
	parseSkillEnvironmentRequirements,
	registerExecutionProfiles,
	resolveExecutionProfile,
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

function profile(id: string, commands: string[] = []) {
	return legacySrtProfile({
		schemaVersion: 1,
		id,
		version: "1.0.0",
		provider: "legacy-srt",
		capabilities: [{ id: "node", version: "24.19.0" }],
		commands,
		supportedTools: [],
		environment: { PATH: "/usr/bin", LANG: "C.UTF-8" },
		network: { mode: "none" },
		resources: { memoryBytes: 512 * 1024 * 1024, cpus: 1, pids: 128, logBytes: 1024 * 1024 },
		probes: [{ id: "node", version: "1.0.0", command: ["node", "--version"], timeoutSeconds: 10 }],
		paths: DEFAULT_ENVIRONMENT_PATHS,
	});
}

describe("environment contracts", () => {
	it("parses and validates structured Skill environment requirements", () => {
		const parsed = parseSkillEnvironmentRequirements(
			`---
name: example
environment-requirements:
  schema-version: 1
  capabilities:
    - id: node
      version: ">=24.0.0 <25.0.0"
  commands: [node, rg]
  network: none
---
`,
			"example",
		);
		expect(parsed).toEqual({
			schemaVersion: 1,
			capabilities: [{ id: "node", version: ">=24.0.0 <25.0.0" }],
			commands: ["node", "rg"],
			network: "none",
		});
		expect(() =>
			parseSkillEnvironmentRequirements(
				`---
environment-requirements:
  schema-version: 2
---
`,
				"invalid",
			),
		).toThrow(/invalid environment-requirements/);
	});

	it("uses deterministic version constraints and rejects ambiguous Profile selection", () => {
		expect(matchesVersion("24.19.0", ">=24.0.0 <25.0.0")).toBe(true);
		expect(matchesVersion("25.0.0", "^24.0.0")).toBe(false);
		const profiles = registerExecutionProfiles([profile("first", ["node"]), profile("second", ["node"])]);
		expect(() =>
			resolveExecutionProfile({
				profiles,
				policy: {
					allowedProfiles: profiles.map(({ profile: item }) => ({ id: item.id, version: item.version })),
				},
				requirements: {
					schemaVersion: 1,
					capabilities: [{ id: "node", version: "^24.0.0" }],
					commands: ["node"],
					network: "none",
				},
				requiredTools: [],
			}),
		).toThrow(/ambiguous/);
	});

	it("freezes resolved Profile bindings into the Compiler baseline", () => {
		const fixture = createCompilerFixture();
		const profiles = registerExecutionProfiles([profile("legacy")]);
		const result = compileWorkflow({
			...fixture,
			assets: {
				...fixture.assets,
				environmentProfiles: profiles,
				environmentPolicy: {
					allowedProfiles: [{ id: "legacy", version: "1.0.0" }],
					defaultProfile: { id: "legacy", version: "1.0.0" },
				},
			},
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.baseline.environmentBindings).toHaveLength(2);
		expect(result.baseline.environmentBindings[0].profileRef).toEqual(profiles[0].ref);
		expect(Object.isFrozen(result.baseline.environmentBindings)).toBe(true);
	});

	it("rejects an unregistered explicit Profile without running a Provider", () => {
		const fixture = createCompilerFixture();
		fixture.workflow.nodes[0].environment_ref = { id: "missing", version: "1.0.0" };
		const result = compileWorkflow(fixture);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.report.diagnostics.map((item) => item.code)).toContain("environment_unavailable");
	});

	it("builds command environments without inheriting host variables", () => {
		const environment = buildIsolatedEnvironment({ PATH: "/profile/bin" }, { LANG: "C.UTF-8" });
		expect(environment).toEqual({ PATH: "/profile/bin", LANG: "C.UTF-8" });
		expect(environment).not.toHaveProperty("HOME");
		expect(() => buildIsolatedEnvironment({ NODE_OPTIONS: "--require=/tmp/hook.js" })).toThrow(EnvironmentError);
	});

	it("separates private workspace access, command cwd, and declared export scope", () => {
		const registered = registerExecutionProfiles([profile("private-workspace")])[0];
		const binding = createEnvironmentBinding({
			nodeId: "produce",
			participantId: "worker",
			profile: registered,
			readPaths: [],
			writePaths: ["outputs/deck"],
			skillHashes: [],
			policy: { allowedProfiles: [{ id: "private-workspace", version: "1.0.0" }] },
		});

		expect(assertVirtualWorkingDirectoryAllowed("/workspace", binding)).toBe("/workspace");
		expect(assertVirtualPathAllowed("/workspace/work/generate.mjs", binding, "write")).toBe(
			"/workspace/work/generate.mjs",
		);
		expect(assertVirtualPathAllowed("/ipd/inputs/source/file.md", binding, "read")).toBe(
			"/ipd/inputs/source/file.md",
		);
		expect(() => assertVirtualPathAllowed("/ipd/inputs/source/file.md", binding, "write")).toThrow(
			/outside the environment write scope/,
		);
		expect(assertVirtualExportAllowed("/workspace/outputs/deck/final.pptx", "outputs/deck", binding)).toBe(
			"/workspace/outputs/deck/final.pptx",
		);
		expect(() => assertVirtualExportAllowed("/workspace/work/generate.mjs", "outputs/deck", binding)).toThrow(
			/outside declared output/,
		);
		expect(() => assertVirtualWorkingDirectoryAllowed("/etc", binding)).toThrow(/outside the environment cwd scope/);
	});

	it("preserves typed environment failures and never retries them by default", () => {
		const error = classifyWorkerError(new EnvironmentError("environment_unavailable", "Docker is unavailable"));
		expect(error.kind).toBe("environment_unavailable");
		expect(error.retryable).toBe(false);
	});
});
