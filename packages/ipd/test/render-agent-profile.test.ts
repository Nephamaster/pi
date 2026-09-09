import { describe, expect, it } from "vitest";
import { compileAgentCard, renderAgentProfile } from "../src/index.ts";

describe("renderAgentProfile", () => {
	it("renders the full professional profile without granting authority", () => {
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
		const rendered = renderAgentProfile(card);
		expect(rendered).toContain("Complex delivery");
		expect(rendered).toContain("Decompose by deliverable");
		expect(rendered).toContain("Decision package");
		expect(rendered).toContain("State risks directly");
		expect(rendered).toContain("Verify source lineage");
		expect(rendered).toContain("not an additional authority or permission source");
	});
});
