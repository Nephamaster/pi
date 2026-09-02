import { describe, expect, it } from "vitest";
import { IpdRuntimeError, selectFixedStaffCore } from "../src/index.ts";
import { compileCard } from "./fixtures.ts";

function staffCard(id: string, capabilities: string[]) {
	return compileCard({
		id,
		name: id,
		description: `Fixed Staff Core member ${id}`,
		responsibilities: ["Govern the IPD Run"],
		nonResponsibilities: ["Produce business Artifacts"],
		capabilities: ["staff", "staff-core", ...capabilities],
	});
}

describe("selectFixedStaffCore", () => {
	it("selects the planning specialist first and preserves every fixed Core member", () => {
		const delivery = staffCard("a-delivery", ["delivery-governance"]);
		const planner = staffCard("z-planner", ["workflow-planning"]);
		const worker = compileCard({
			id: "worker",
			name: "Worker",
			description: "Business employee",
			responsibilities: ["Produce an Artifact"],
			nonResponsibilities: [],
			capabilities: ["implementation"],
		});

		const selected = selectFixedStaffCore([delivery, worker, planner]);
		expect(selected.plannerCard.id).toBe("z-planner");
		expect(selected.staffCoreCards.map((card) => card.id)).toEqual(["z-planner", "a-delivery"]);
	});

	it("rejects a Pool without a fixed Core or workflow-planning member", () => {
		expect(() => selectFixedStaffCore([])).toThrow(IpdRuntimeError);
		expect(() => selectFixedStaffCore([staffCard("delivery", ["delivery-governance"])])).toThrow("workflow-planning");
	});
});
