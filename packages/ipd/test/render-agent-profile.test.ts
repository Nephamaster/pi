import { describe, expect, it } from "vitest";
import { compileAgentCard, renderAgentRuntimeProfile, renderAgentSelectionProfile } from "../src/index.ts";

describe("AgentCard prompt projections", () => {
	it("keeps the runtime profile focused on professional identity and method", () => {
		const card = compileAgentCard(
			{
				id: "project-shepherd",
				name: "Project Shepherd",
				description: "Coordinates reviewed delivery",
				responsibilities: ["Coordinate delivery"],
				nonResponsibilities: ["Approve own work"],
				capabilities: ["workflow-design"],
				applicableScenarios: ["Complex delivery"],
				principles: ["Keep evidence traceable"],
				deliverables: ["Decision package"],
				promptProfile: {
					approach: ["Decompose by deliverable"],
					communication: ["State risks directly"],
					verification: ["Verify source lineage"],
				},
			},
			"project-shepherd.yaml",
			{
				skillNames: new Set(),
				toolNames: new Set(["read"]),
				hasModel: () => true,
			},
		).value!;
		const rendered = renderAgentRuntimeProfile(card);
		expect(rendered).toContain("Decompose by deliverable");
		expect(rendered).toContain("Coordinate delivery");
		expect(rendered).toContain("Approve own work");
		expect(rendered).not.toContain("Complex delivery");
		expect(rendered).not.toContain("Decision package");
		expect(rendered).not.toContain("Verify source lineage");
		expect(rendered).not.toContain("State risks directly");

		const selection = renderAgentSelectionProfile(card);
		expect(selection).toContain("Complex delivery");
		expect(selection).toContain("Decision package");
		expect(selection).toContain("Verify source lineage");
	});
});
