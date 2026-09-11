import { describe, expect, it } from "vitest";
import { buildDashboardSnapshot, renderDashboardPage } from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

function inlineScript(page: string): string {
	const match = /<script>([\s\S]*?)<\/script>/.exec(page);
	if (!match?.[1]) throw new Error("Dashboard page has no inline script");
	return match[1];
}

describe("IPD visualization generated script", () => {
	it("emits syntactically valid JavaScript for the live dashboard", () => {
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
		const page = renderDashboardPage({
			runId: fixture.runId,
			liveEndpoint: `/api/runs/${fixture.runId}`,
			snapshotUrl: `/runs/${fixture.runId}/snapshot.html`,
			initialSnapshot: snapshot,
		});

		expect(() => new Function(inlineScript(page))).not.toThrow();
	});
});
