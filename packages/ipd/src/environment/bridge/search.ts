// Container ripgrep backend for Pi grep/find, bounded before transport; not a web-search tool.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { BridgeRequest } from "./protocol.ts";

export async function searchFiles(request: Extract<BridgeRequest, { operation: "search" | "find" }>) {
	const args =
		request.operation === "find"
			? [
					"--files",
					"--hidden",
					"--glob",
					request.pattern,
					"--glob",
					"!**/node_modules/**",
					"--glob",
					"!**/.git/**",
					"--",
					request.path,
				]
			: [
					"--json",
					"--line-number",
					"--max-columns",
					"4096",
					...(request.ignoreCase ? ["--ignore-case"] : []),
					...(request.literal ? ["--fixed-strings"] : []),
					...(request.glob ? ["--glob", request.glob] : []),
					"--",
					request.pattern,
					request.path,
				];
	const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
	const result: Array<string | { path: string; line?: number; text?: string }> = [];
	let error = "";
	child.stderr.on("data", (chunk: Buffer) => {
		error = (error + chunk.toString()).slice(0, 8192);
	});
	const exited = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	void exited.catch(() => {});
	let limited = false;
	let readComplete = false;
	try {
		for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
			if (request.operation === "find") result.push(line);
			else {
				const event = JSON.parse(line) as {
					type: string;
					data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
				};
				if (event.type === "match" && event.data?.path?.text)
					result.push({ path: event.data.path.text, line: event.data.line_number, text: event.data.lines?.text });
			}
			if (result.length >= (request.maxResults ?? 1000)) {
				limited = true;
				break;
			}
		}
		readComplete = true;
	} finally {
		if ((limited || !readComplete) && child.exitCode === null) child.kill("SIGKILL");
	}
	const code = await exited;
	if (!limited && code !== 0 && code !== 1) throw new Error(`Search failed: ${error}`);
	return result;
}
