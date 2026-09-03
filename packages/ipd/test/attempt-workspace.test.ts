import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ArtifactManifest, AttemptWorkspaceManager } from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function manifest(path: string): ArtifactManifest {
	return {
		id: "artifact-1",
		runId: "run-1",
		nodeId: "produce",
		attemptId: "attempt-1",
		contractId: "output",
		createdAt: 1,
		inputs: [],
		files: [
			{
				path,
				mimeType: "text/plain",
				sha256: "0".repeat(64),
				size: 7,
			},
		],
		metadata: {},
	};
}

describe("AttemptWorkspaceManager", () => {
	it("isolates writes, promotes accepted files, and seeds rework from the previous Attempt", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-attempt-workspace-"));
		roots.push(root);
		await mkdir(join(root, "outputs"), { recursive: true });
		await mkdir(join(root, ".pi", "skills", "test"), { recursive: true });
		await writeFile(join(root, "source.txt"), "source");
		await writeFile(join(root, ".pi", "skills", "test", "SKILL.md"), "skill");
		await writeFile(join(root, "outputs", "result.txt"), "original");

		const manager = new AttemptWorkspaceManager();
		const runWorkspace = await manager.prepareRun(root, "run-1");
		const first = await manager.prepare({
			workspace: runWorkspace.workspace,
			runRoot: runWorkspace.root,
			runId: "run-1",
			nodeId: "produce",
			attemptNumber: 1,
			attemptId: "attempt-1",
			writeScopes: ["outputs"],
		});
		expect(await readFile(join(first.root, "source.txt"), "utf8")).toBe("source");
		expect(await readFile(join(first.root, ".pi", "skills", "test", "SKILL.md"), "utf8")).toBe("skill");
		await writeFile(join(first.root, "outputs", "result.txt"), "staged-1");
		expect(await readFile(join(root, "outputs", "result.txt"), "utf8")).toBe("original");

		const second = await manager.prepare({
			workspace: runWorkspace.workspace,
			runRoot: runWorkspace.root,
			runId: "run-1",
			nodeId: "produce",
			attemptNumber: 2,
			attemptId: "attempt-2",
			previousAttemptNumber: 1,
			writeScopes: ["outputs"],
		});
		expect(await readFile(join(second.root, "outputs", "result.txt"), "utf8")).toBe("staged-1");
		await writeFile(join(second.root, "outputs", "result.txt"), "accepted");
		await second.promote(manifest("outputs/result.txt"));
		expect(await readFile(join(runWorkspace.workspace, "outputs", "result.txt"), "utf8")).toBe("accepted");
		expect(
			await readFile(join(runWorkspace.accepted, "produce", "artifact-1", "outputs", "result.txt"), "utf8"),
		).toBe("accepted");
		expect(await readFile(join(root, "outputs", "result.txt"), "utf8")).toBe("original");
		await manager.publishFinal(runWorkspace, [manifest("outputs/result.txt")]);
		expect(await readFile(join(runWorkspace.final, "produce", "outputs", "result.txt"), "utf8")).toBe("accepted");
	});

	it("rejects workspace-wide writes instead of pretending they are isolated", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-attempt-workspace-"));
		roots.push(root);
		const manager = new AttemptWorkspaceManager();
		const runWorkspace = await manager.prepareRun(root, "run-1");
		await expect(
			manager.prepare({
				workspace: runWorkspace.workspace,
				runRoot: runWorkspace.root,
				runId: "run-1",
				nodeId: "produce",
				attemptNumber: 1,
				attemptId: "attempt-1",
				writeScopes: ["."],
			}),
		).rejects.toThrow("bounded write scopes");
	});
});
