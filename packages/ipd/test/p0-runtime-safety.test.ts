import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CheckExecutorRegistry,
	createArtifactFileSetCheckExecutor,
	effectiveNodeReadRoots,
	MechanicalChecker,
} from "../src/index.ts";
import { missingRuntimeCommands } from "../src/adapter/node-runtime-environment.ts";

describe("IPD P0 runtime safety", () => {
	it("lets execution read its owned write root without widening review reads", () => {
		const workspace = "/tmp/ipd-workspace";
		const permissions = {
			read_paths: ["outputs/upstream"],
			write_paths: ["outputs/current"],
			external_actions: false,
		};
		const executionRoots = effectiveNodeReadRoots({
			workspace,
			permissions,
			allowReadOwnWritePaths: true,
		});
		const reviewRoots = effectiveNodeReadRoots({
			workspace,
			permissions,
			allowReadOwnWritePaths: false,
		});
		expect(executionRoots).toContain(resolve(workspace, "outputs/current"));
		expect(reviewRoots).not.toContain(resolve(workspace, "outputs/current"));
	});

	it("fails runtime preflight for a missing Skill command before Session work", async () => {
		const participant = {
			participantId: "producer",
			agentCard: { tools: [] },
			lockedSkills: [
				{
					id: "test-skill",
					hash: "a".repeat(64),
					source: "test",
					filePath: "/tmp/SKILL.md",
					baseDir: "/tmp",
					description: "Test",
					allowedTools: [],
					requiredCommands: ["definitely-not-an-ipd-runtime-command"],
				},
			],
			lockedTools: [],
			lockedKnowledgeBases: [],
		} as never;
		expect(await missingRuntimeCommands(participant)).toContain("definitely-not-an-ipd-runtime-command");
	});

	it("enforces exact user-facing artifact file sets", async () => {
		const registry = new CheckExecutorRegistry();
		registry.add(createArtifactFileSetCheckExecutor());
		const checker = new MechanicalChecker(registry);
		const base = {
			workspace: "/tmp",
			contract: { id: "delivery", artifactType: "presentation", description: "Deck", businessPurpose: "Deliver" },
			manifest: {
				artifactId: "a",
				runId: "r",
				nodeId: "n",
				attemptId: "x",
				contractId: "delivery",
				createdAt: 1,
				inputs: [],
				files: [{ path: "deck.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", size: 1, sha256: "a".repeat(64) }],
				metadata: {},
			},
		};
		const criterion = {
			kind: "mechanical" as const,
			criterion_id: "delivery-files",
			description: "Only one PPTX is delivered",
			check_id: "artifact-file-set",
			parameters: { exact_count: 1, extensions: [".pptx"] },
			evidence_requirements: [],
		};
		const pass = await checker.evaluate([criterion], { ...base, artifacts: [base] } as never);
		expect(pass.result).toBe("PASS");
		const failBase = {
			...base,
			manifest: {
				...base.manifest,
				files: [...base.manifest.files, { path: "qa.pdf", mimeType: "application/pdf", size: 1, sha256: "b".repeat(64) }],
			},
		};
		const fail = await checker.evaluate([criterion], { ...failBase, artifacts: [failBase] } as never);
		expect(fail.result).toBe("FAIL");
	});
});
