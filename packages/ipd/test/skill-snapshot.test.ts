import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashSkillPackage, snapshotSkillPackage } from "../src/index.ts";

async function makeDirectoriesWritable(directory: string): Promise<void> {
	await chmod(directory, 0o700).catch(() => {});
	for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
		if (entry.isDirectory()) await makeDirectoriesWritable(join(directory, entry.name));
	}
}

describe("Skill snapshots", () => {
	const roots: string[] = [];

	afterEach(async () => {
		for (const root of roots.splice(0)) {
			await makeDirectoriesWritable(root);
			await rm(root, { recursive: true, force: true });
		}
	});

	it("creates a content-addressed readonly copy that is unaffected by later source changes", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-skill-snapshot-"));
		roots.push(root);
		const source = join(root, "source");
		await mkdir(source);
		await writeFile(join(source, "SKILL.md"), "---\nname: example\ndescription: example\n---\noriginal\n");
		const hash = await hashSkillPackage(source);
		const snapshot = await snapshotSkillPackage(source, join(root, "snapshots"), hash);
		await writeFile(join(source, "SKILL.md"), "changed\n");

		expect(await hashSkillPackage(snapshot)).toBe(hash);
		expect(await readFile(join(snapshot, "SKILL.md"), "utf8")).toContain("original");
		expect((await stat(join(snapshot, "SKILL.md"))).mode & 0o222).toBe(0);
		expect(await snapshotSkillPackage(source, join(root, "snapshots"), hash)).toBe(snapshot);
	});

	it("publishes one snapshot when the same Skill is initialized concurrently", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-skill-snapshot-race-"));
		roots.push(root);
		const source = join(root, "source");
		await mkdir(join(source, "nested"), { recursive: true });
		await writeFile(join(source, "SKILL.md"), "---\nname: example\ndescription: example\n---\n");
		await writeFile(join(source, "nested", "asset.txt"), "asset\n");
		const hash = await hashSkillPackage(source);
		const now = vi.spyOn(Date, "now").mockReturnValue(1789521328023);
		try {
			const snapshots = await Promise.all(
				Array.from({ length: 8 }, () => snapshotSkillPackage(source, join(root, "snapshots"), hash)),
			);
			expect(new Set(snapshots)).toEqual(new Set([join(root, "snapshots", hash)]));
			expect(await readdir(join(root, "snapshots"))).toEqual([hash]);
		} finally {
			now.mockRestore();
		}
	});
});
