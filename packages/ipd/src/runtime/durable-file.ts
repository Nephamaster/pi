// Provide file and directory sync boundaries for atomically published Runtime objects.
import { type FileHandle, open, readdir } from "node:fs/promises";
import { join } from "node:path";

export async function syncDirectory(path: string): Promise<void> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, "r");
		await handle.sync();
	} catch (error) {
		if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
	} finally {
		await handle?.close().catch(() => {});
	}
}

export async function syncFile(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function syncTree(path: string): Promise<void> {
	for (const entry of await readdir(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) await syncTree(child);
		else if (entry.isFile()) await syncFile(child);
	}
	await syncDirectory(path);
}
