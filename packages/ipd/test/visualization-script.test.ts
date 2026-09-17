import { describe, expect, it } from "vitest";
import { buildDashboardSnapshot, renderDashboardPage } from "../src/index.ts";
import { renderMarkdown } from "../src/visualization/dashboard-markdown.ts";
import { createCompilerFixture } from "./fixtures.ts";

function inlineScript(page: string): string {
	const match = /<script>([\s\S]*?)<\/script>/.exec(page);
	if (!match?.[1]) throw new Error("Dashboard page has no inline script");
	return match[1];
}

describe("IPD visualization generated script", () => {
	function pageScript(): string {
		const fixture = createCompilerFixture();
		const snapshot = buildDashboardSnapshot(
			{
				runId: fixture.runId,
				revision: 3,
				phase: "compile",
				status: "running",
				taskInput: fixture.taskInput,
				processSelection: fixture.processSelection,
				selectedProcessSpec: fixture.processSpec,
				workflowCandidate: fixture.workflow,
				nodes: [],
				rounds: [],
				submissions: [],
				reviews: [],
				approvals: [],
				mechanicalChecks: [],
				events: [],
				operations: {},
			},
			[fixture.processSpec],
		);
		return inlineScript(
			renderDashboardPage({
				runId: fixture.runId,
				liveEndpoint: `/api/runs/${fixture.runId}`,
				snapshotUrl: `/runs/${fixture.runId}/snapshot.html`,
				initialSnapshot: snapshot,
			}),
		);
	}

	it("emits syntactically valid JavaScript for the live dashboard", () => {
		expect(() => new Function(pageScript())).not.toThrow();
	});

	it("renders common Markdown blocks without trusting embedded HTML", () => {
		const rendered = renderMarkdown("# 标题\n\n**重点**\n\n1. 第一项\n2. 第二项\n\n<script>alert(1)</script>");

		expect(rendered).toContain("<h1>标题</h1>");
		expect(rendered).toContain("<strong>重点</strong>");
		expect(rendered).toContain("<ol><li>第一项</li><li>第二项</li></ol>");
		expect(rendered).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(rendered).not.toContain("<script>alert(1)</script>");
	});
});
