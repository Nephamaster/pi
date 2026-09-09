import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPathWithinRoots } from "../src/index.ts";

describe("node file scope", () => {
	const roots: string[] = [];
	afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

	it("allows owned files and rejects sibling or symlink escapes", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-file-scope-"));
		roots.push(root);
		const workspace = join(root, "workspace");
		const owned = join(workspace, "outputs", "owned");
		const sibling = join(workspace, "outputs", "sibling");
		const outside = join(root, "outside");
		await Promise.all([mkdir(owned, { recursive: true }), mkdir(sibling, { recursive: true }), mkdir(outside)]);
		await writeFile(join(owned, "result.txt"), "owned");
		await writeFile(join(sibling, "result.txt"), "sibling");
		await writeFile(join(outside, "secret.txt"), "secret");
		await symlink(outside, join(owned, "escape"));

		expect(await isPathWithinRoots(join(owned, "result.txt"), [owned])).toBe(true);
		expect(await isPathWithinRoots(join(sibling, "result.txt"), [owned])).toBe(false);
		expect(await isPathWithinRoots(join(owned, "escape", "secret.txt"), [owned])).toBe(false);
	});
});
