import { lstat, mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decodeBridgeRequest } from "./protocol.ts";

try {
	const request = decodeBridgeRequest(process.argv[2] ?? "");
	if (!("path" in request)) throw new Error("File bridge requires a file operation");
	const { operation, path } = request;
	if (operation === "read") {
		if (request.length === undefined) process.stdout.write(await readFile(path));
		else {
			const file = await open(path, "r");
			try {
				const buffer = Buffer.alloc(request.length);
				const { bytesRead } = await file.read(buffer, 0, buffer.length, request.offset ?? 0);
				process.stdout.write(buffer.subarray(0, bytesRead));
			} finally {
				await file.close();
			}
		}
	} else if (operation === "write") {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, Buffer.concat(chunks), { mode: 0o600 });
	} else if (operation === "mkdir") await mkdir(path, { recursive: true });
	else if (operation === "stat") {
		const stat = await lstat(path);
		process.stdout.write(
			JSON.stringify({
				type: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
				size: stat.size,
			}),
		);
	} else {
		const entries = await Promise.all(
			(await readdir(path, { withFileTypes: true })).map(async (entry) => ({
				name: entry.name,
				type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
				size: (await lstat(`${path}/${entry.name}`)).size,
			})),
		);
		process.stdout.write(JSON.stringify(entries));
	}
} catch (error) {
	process.stderr.write(
		JSON.stringify({
			bridgeError: {
				code: (error as NodeJS.ErrnoException).code ?? "BRIDGE_ERROR",
				message: error instanceof Error ? error.message : String(error),
			},
		}),
	);
	process.exitCode = 1;
}
