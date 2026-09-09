// 计算完整 Skill 包内容哈希并拒绝符号链接。
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { hashJson } from "../ir/hash.ts";

async function filesUnder(root: string, directory: string): Promise<Array<{ path: string; hash: string }>> {
	const files: Array<{ path: string; hash: string }> = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.name === "__pycache__" || (entry.isFile() && entry.name.endsWith(".pyc"))) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await filesUnder(root, path)));
		else if (entry.isFile()) {
			const content = await readFile(path);
			files.push({
				path: relative(root, path).replaceAll("\\", "/"),
				hash: createHash("sha256").update(content).digest("hex"),
			});
		} else if ((await lstat(path)).isSymbolicLink())
			throw new Error(`Skill packages cannot contain symlinks: ${path}`);
	}
	return files;
}

export async function hashSkillPackage(baseDir: string): Promise<string> {
	const files = await filesUnder(baseDir, baseDir);
	if (files.length === 0) throw new Error(`Skill package contains no files: ${baseDir}`);
	files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	return hashJson(files);
}
