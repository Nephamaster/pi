import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { RunState } from "../src/contracts/runtime.ts";
import { newAuthoringDraft } from "../src/control/workflow-draft-import.ts";
import { applyDraftCommand } from "../src/control/workflow-draft-operations.ts";
import { buildDashboardSnapshot } from "../src/visualization/dashboard-model.ts";

const state = {
	runId: "run-1",
	phase: "design",
	status: "running",
	revision: 0,
	nodes: [],
	rounds: [],
	events: [],
} as unknown as RunState;
const references = {
	task_input_ref: { id: "task", hash: "a".repeat(64) },
	process_selection_ref: { id: "selection", hash: "b".repeat(64) },
};

describe("incomplete authoring dashboard", () => {
	it("renders identity-only nodes without inventing contracts or employees", () => {
		const draft = applyDraftCommand(newAuthoringDraft("run-1", references), {
			domain: "topology",
			data: {
				nodes: [
					{ node_id: "A", kind: "execution", name: "Analyze", output_ids: ["data"] },
					{ node_id: "R", kind: "review", name: "Review" },
				],
				connections: [
					{
						consumer_node_id: "R",
						input_id: "candidate",
						source: { kind: "node_output", node_id: "A", output_id: "data" },
					},
				],
			},
		}).draft;
		const before = structuredClone(draft);
		const snapshot = buildDashboardSnapshot(state, [], draft);
		assert.equal(snapshot.workflow.source, "draft");
		assert.equal(snapshot.workflow.nodes[0].agent, "Unassigned");
		assert.equal(snapshot.workflow.nodes[0].objective, "");
		assert.ok(snapshot.workflow.edges.some((edge) => edge.from === "A" && edge.to === "R"));
		assert.deepEqual(draft, before);
	});
	it("displays an empty authoring draft as draft rather than compiled work", () => {
		const snapshot = buildDashboardSnapshot(state, [], newAuthoringDraft("run-1", references));
		assert.equal(snapshot.workflow.source, "draft");
		assert.deepEqual(snapshot.workflow.nodes, []);
		assert.equal(snapshot.workflow.completionDefined, false);
	});
});
