import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGrepTool, type GrepOperations } from "../src/core/tools/grep.ts";
import { ensureTool } from "../src/utils/tools-manager.ts";

vi.mock("../src/utils/tools-manager.ts", () => ({
	ensureTool: vi.fn(() => {
		throw new Error("Custom search must not resolve host ripgrep");
	}),
}));

const workspace = resolve("virtual-ipd-workspace");
const file = join(workspace, "evidence.txt");

describe("grep custom search operations", () => {
	afterEach(() => {
		expect(ensureTool).not.toHaveBeenCalled();
		vi.clearAllMocks();
	});

	it("delegates search options and the abort signal without reading host files", async () => {
		const signal = new AbortController().signal;
		const search = vi
			.fn<NonNullable<GrepOperations["search"]>>()
			.mockResolvedValue([{ filePath: file, lineNumber: 2, lineText: "a.b\r\n" }]);
		const readFile = vi.fn(() => "");
		const isDirectoryWithSignal = vi.fn(() => true);
		const tool = createGrepTool(workspace, {
			operations: { isDirectory: () => true, isDirectoryWithSignal, readFile, search },
		});
		const result = await tool.execute(
			"search",
			{ pattern: "a.b", glob: "*.txt", ignoreCase: true, literal: true, limit: 3 },
			signal,
		);
		expect(isDirectoryWithSignal).toHaveBeenCalledWith(workspace, signal);
		expect(search).toHaveBeenCalledWith(
			{ path: workspace, pattern: "a.b", glob: "*.txt", ignoreCase: true, literal: true, limit: 3 },
			signal,
		);
		expect(result.content).toEqual([{ type: "text", text: "evidence.txt:2: a.b" }]);
		expect(readFile).not.toHaveBeenCalled();
	});

	it("reads context through the backend and preserves match-limit notices", async () => {
		const signal = new AbortController().signal;
		const readFileWithSignal = vi.fn(async () => "before\r\nmatch\r\nafter");
		const tool = createGrepTool(workspace, {
			operations: {
				isDirectory: () => true,
				readFile: () => {
					throw new Error("Use the signal-aware reader");
				},
				readFileWithSignal,
				search: async () => [{ filePath: file, lineNumber: 2 }],
			},
		});
		const result = await tool.execute("search", { pattern: "match", context: 1, limit: 1 }, signal);
		expect(readFileWithSignal).toHaveBeenCalledWith(file, signal);
		expect(result.content).toEqual([
			{
				type: "text",
				text: "evidence.txt-1- before\nevidence.txt:2: match\nevidence.txt-3- after\n\n[1 matches limit reached. Use limit=2 for more, or refine pattern]",
			},
		]);
		expect(result.details).toMatchObject({ matchLimitReached: 1 });
	});

	it("returns no matches without falling back to local ripgrep", async () => {
		const tool = createGrepTool(workspace, {
			operations: { isDirectory: () => true, readFile: () => "", search: async () => [] },
		});
		expect((await tool.execute("search", { pattern: "missing" })).content).toEqual([
			{ type: "text", text: "No matches found" },
		]);
	});

	it("propagates backend errors without a host fallback", async () => {
		const failure = new Error("Backend unavailable");
		const tool = createGrepTool(workspace, {
			operations: {
				isDirectory: () => true,
				readFile: () => "",
				search: async () => {
					throw failure;
				},
			},
		});
		await expect(tool.execute("search", { pattern: "match" })).rejects.toBe(failure);
	});
});
