import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Type from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	CheckExecutorRegistry,
	createArtifactIntegrityCheckExecutor,
	createArtifactManifest,
	defineCheckExecutor,
	MechanicalCheckError,
	MechanicalChecker,
} from "../src/index.ts";
import { createValidWorkflow } from "./fixtures.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixture() {
	const workspace = await mkdtemp(join(tmpdir(), "pi-ipd-check-"));
	roots.push(workspace);
	await mkdir(join(workspace, "outputs"));
	await writeFile(join(workspace, "outputs", "primary.txt"), "primary");
	await writeFile(join(workspace, "outputs", "review.txt"), "review");
	const contract = createValidWorkflow().nodes[0].output;
	const manifest = await createArtifactManifest({
		workspace,
		contract,
		submission: {
			id: "artifact-1",
			runId: "run-1",
			nodeId: "produce",
			attemptId: "attempt-1",
			contractId: contract.id,
			createdAt: 1,
			inputs: [],
			files: [
				{ path: "outputs/primary.txt", mimeType: "text/plain" },
				{ path: "outputs/review.txt", mimeType: "text/plain" },
			],
			metadata: {},
		},
	});
	return { workspace, contract, manifest, artifacts: [{ contract, manifest }] };
}

describe("MechanicalChecker", () => {
	it("returns criterion evidence and an aggregate PASS", async () => {
		const fixture = await createFixture();
		const registry = new CheckExecutorRegistry();
		registry.add(createArtifactIntegrityCheckExecutor());
		registry.add(
			defineCheckExecutor({
				id: "metadata-check",
				parameters: Type.Object({ expected: Type.String() }, { additionalProperties: false }),
				async execute(parameters) {
					return {
						result: parameters.expected === "ok" ? "PASS" : "FAIL",
						evidence: { expected: parameters.expected },
						message: "Metadata checked",
					};
				},
			}),
		);
		let now = 0;
		const checker = new MechanicalChecker(registry, () => now++);
		const result = await checker.evaluate(
			[
				{
					id: "integrity",
					description: "Validate file integrity",
					checkId: "artifact-integrity",
					parameters: {},
					requiredEvidence: ["Manifest"],
				},
				{
					id: "metadata",
					description: "Validate metadata",
					checkId: "metadata-check",
					parameters: { expected: "ok" },
					requiredEvidence: ["Check output"],
				},
			],
			fixture,
		);
		expect(result.result).toBe("PASS");
		expect(result.criteria).toHaveLength(2);
		expect(result.criteria.every((criterion) => criterion.durationMs >= 0)).toBe(true);
	});

	it("fails integrity after Artifact content changes", async () => {
		const fixture = await createFixture();
		await writeFile(join(fixture.workspace, "outputs", "primary.txt"), "changed");
		const registry = new CheckExecutorRegistry();
		registry.add(createArtifactIntegrityCheckExecutor());
		const checker = new MechanicalChecker(registry);
		const result = await checker.evaluate(
			[
				{
					id: "integrity",
					description: "Validate file integrity",
					checkId: "artifact-integrity",
					parameters: {},
					requiredEvidence: ["Manifest"],
				},
			],
			fixture,
		);
		expect(result.result).toBe("FAIL");
	});

	it("rejects an unregistered Check before execution", async () => {
		const fixture = await createFixture();
		const checker = new MechanicalChecker(new CheckExecutorRegistry());
		await expect(
			checker.evaluate(
				[
					{
						id: "missing",
						description: "Missing Check",
						checkId: "missing",
						parameters: {},
						requiredEvidence: ["Evidence"],
					},
				],
				fixture,
			),
		).rejects.toBeInstanceOf(MechanicalCheckError);
	});
});
