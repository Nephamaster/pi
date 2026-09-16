// 计算完整 Skill 包内容哈希并拒绝符号链接。
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
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

async function copySkillTree(source: string, destination: string, destinationExists = false): Promise<void> {
	if (!destinationExists) await mkdir(destination, { recursive: false, mode: 0o700 });
	for (const entry of await readdir(source, { withFileTypes: true })) {
		if (entry.name === "__pycache__" || (entry.isFile() && entry.name.endsWith(".pyc"))) continue;
		const sourcePath = join(source, entry.name);
		const destinationPath = join(destination, entry.name);
		if (entry.isDirectory()) await copySkillTree(sourcePath, destinationPath);
		else if (entry.isFile()) await copyFile(sourcePath, destinationPath);
		else if ((await lstat(sourcePath)).isSymbolicLink())
			throw new Error(`Skill packages cannot contain symlinks: ${sourcePath}`);
	}
}

async function makeSkillTreeReadonly(directory: string): Promise<void> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) await makeSkillTreeReadonly(path);
		else await chmod(path, 0o444);
	}
	await chmod(directory, 0o555);
}

async function removeSkillStaging(directory: string): Promise<void> {
	const makeDirectoriesWritable = async (current: string): Promise<void> => {
		await chmod(current, 0o700).catch(() => {});
		for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
			if (entry.isDirectory()) await makeDirectoriesWritable(join(current, entry.name));
		}
	};
	await makeDirectoriesWritable(directory);
	await rm(directory, { recursive: true, force: true });
}

export async function snapshotSkillPackage(
	baseDir: string,
	snapshotRoot: string,
	expectedHash: string,
): Promise<string> {
	const target = join(snapshotRoot, expectedHash);
	try {
		if ((await hashSkillPackage(target)) !== expectedHash)
			throw new Error(`Stored Skill snapshot is corrupt: ${target}`);
		return target;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
	const staging = await mkdtemp(join(snapshotRoot, `.${expectedHash}.`));
	try {
		await copySkillTree(baseDir, staging, true);
		if ((await hashSkillPackage(staging)) !== expectedHash)
			throw new Error(`Skill changed while its snapshot was being created: ${baseDir}`);
		await makeSkillTreeReadonly(staging);
		try {
			await rename(staging, target);
		} catch (error) {
			if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			await removeSkillStaging(staging);
			if ((await hashSkillPackage(target)) !== expectedHash)
				throw new Error(`Stored Skill snapshot is corrupt: ${target}`);
		}
		return target;
	} catch (error) {
		await removeSkillStaging(staging);
		throw error;
	}
}
