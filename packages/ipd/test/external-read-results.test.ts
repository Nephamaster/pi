import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createExternalReadResultAdapter } from "../src/adapter/external-read-results.ts";
import type { EnvironmentToolContext } from "../src/environment/tool-backend.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "ipd-external-result-"));
	roots.push(root);
	const bytes = Buffer.from(
		"# Source\n\n> Source: https://example.com/report.pdf\n> Pages: 1\n\n---\n\nactual PDF body needle\n",
	);
	const path = join(root, "report.md");
	await writeFile(path, bytes);
	const files = new Map<string, Buffer>();
	const write = vi.fn(async (_lease, _round, destination: string, content: Buffer) => {
		files.set(destination, content);
	});
	// Only the materialization boundary is mocked here; the Docker suite covers the native read/grep/Bash path.
	const current = {
		lease: { leaseId: "node-a" },
		round: { generation: 1 },
		binding: { paths: { workspace: "/workspace" } },
		provider: { writeFile: write },
	} as unknown as EnvironmentToolContext;
	const result = {
		content: [
			{
				type: "text" as const,
				text: `PDF extracted and saved to: ${path}\n\nPages: 1\nCharacters: ${bytes.toString().length}`,
			},
		],
		details: { responseId: "response-a", urls: ["https://example.com/report.pdf"] },
	};
	const execute = vi.fn(async () => result);
	const tool: ToolDefinition = {
		name: "fetch_content",
		label: "Fetch",
		description: "original provider",
		parameters: Type.Object({ url: Type.String() }),
		execute,
	};
	const adapt = createExternalReadResultAdapter(() => current, root);
	return { root, path, bytes, files, current, result, execute, tool, adapt, write };
}

it("keeps the registered schema and execution, copying the full PDF body to a node path", async () => {
	const f = await fixture();
	const wrapped = f.adapt(f.tool);
	expect(wrapped.parameters).toBe(f.tool.parameters);
	const result = await wrapped.execute(
		"call",
		{ url: "https://example.com/report.pdf" },
		undefined,
		undefined,
		{} as never,
	);
	expect(f.execute).toHaveBeenCalledOnce();
	const [path, content] = [...f.files][0];
	expect(path).toMatch(/^\/workspace\/\.external-content\/[a-f0-9]{64}\.md$/);
	expect(content).toEqual(f.bytes);
	expect(result.content[0]).toMatchObject({ text: expect.stringContaining(path) });
	expect(JSON.stringify(result.content)).not.toContain(f.root);
	expect(f.result.content[0].text).toContain(f.path);
});

it.each(["outside", "symlink", "source-mismatch", "length-mismatch"])(
	"rejects %s rather than granting general host access",
	async (mode) => {
		const f = await fixture();
		if (mode === "outside") f.result.content[0].text = f.result.content[0].text.replace(f.path, "/etc/passwd");
		if (mode === "symlink") {
			await rm(f.path);
			await symlink("/etc/passwd", f.path);
		}
		if (mode === "source-mismatch") f.result.details.urls = ["https://example.com/another.pdf"];
		if (mode === "length-mismatch") f.result.content[0].text += "0";
		await expect(f.adapt(f.tool).execute("call", {}, undefined, undefined, {} as never)).rejects.toThrow();
		expect(f.write).not.toHaveBeenCalled();
	},
);

it("preserves imported content across host cache replacement, and rejects another Session's response ID", async () => {
	const f = await fixture();
	await f.adapt(f.tool).execute("fetch", {}, undefined, undefined, {} as never);
	await writeFile(f.path, "cache overwritten by another request");
	const get = f.adapt({
		...f.tool,
		name: "get_search_content",
		execute: async () => ({ ...f.result, details: { url: "https://example.com/report.pdf" } }),
	});
	const result = await get.execute("get", { responseId: "response-a" }, undefined, undefined, {} as never);
	expect(JSON.stringify(result.content)).toContain("/workspace/.external-content/");
	expect(f.write).toHaveBeenCalledOnce();
	const other = createExternalReadResultAdapter(() => f.current, f.root)({ ...f.tool, name: "get_search_content" });
	await expect(other.execute("get", { responseId: "response-a" }, undefined, undefined, {} as never)).rejects.toThrow(
		"not issued",
	);
});

it("does not import a late or cancelled response", async () => {
	const f = await fixture();
	f.tool.execute = async () => {
		f.current.round = { ...f.current.round, generation: 2 };
		return f.result;
	};
	await expect(f.adapt(f.tool).execute("late", {}, undefined, undefined, {} as never)).rejects.toMatchObject({
		code: "cancelled",
	});
	expect(f.write).not.toHaveBeenCalled();
	const controller = new AbortController();
	controller.abort();
	await expect(f.adapt(f.tool).execute("cancel", {}, controller.signal, undefined, {} as never)).rejects.toMatchObject(
		{ code: "cancelled" },
	);
	expect(f.write).not.toHaveBeenCalled();
});
