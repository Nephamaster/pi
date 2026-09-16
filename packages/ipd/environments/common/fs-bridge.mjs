// Provides binary-safe file operations inside an IPD execution container.
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const [operation, path] = process.argv.slice(2);
if (!operation || !path) throw new Error("Usage: fs-bridge.mjs <read|write|list|stat|mkdir> <path>");

if (operation === "read") {
	process.stdout.write(await readFile(path));
} else if (operation === "write") {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, Buffer.concat(chunks), { mode: 0o600 });
} else if (operation === "list") {
	const entries = await Promise.all(
		(await readdir(path, { withFileTypes: true })).map(async (entry) => {
			const details = await lstat(`${path}/${entry.name}`);
			return {
				name: entry.name,
				type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
				size: details.size,
			};
		}),
	);
	process.stdout.write(JSON.stringify(entries));
} else if (operation === "stat") {
	const details = await lstat(path);
	process.stdout.write(
		JSON.stringify({
			type: details.isDirectory() ? "directory" : details.isSymbolicLink() ? "symlink" : "file",
			size: details.size,
		}),
	);
} else if (operation === "mkdir") {
	await mkdir(path, { recursive: true });
} else {
	throw new Error(`Unknown file operation: ${operation}`);
}
