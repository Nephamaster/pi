import { describe, expect, it } from "vitest";
import { topologicalSort } from "../src/index.ts";

describe("topologicalSort", () => {
	it("reports unknown dependencies without treating them as graph edges", () => {
		const result = topologicalSort([
			{ id: "a", dependsOn: ["missing"] },
			{ id: "b", dependsOn: ["a"] },
		]);
		expect(result.order).toEqual(["a", "b"]);
		expect(result.unknownDependencies).toEqual([{ nodeId: "a", dependencyId: "missing" }]);
	});

	it("distinguishes cycle members from downstream blocked nodes", () => {
		const result = topologicalSort([
			{ id: "a", dependsOn: ["b"] },
			{ id: "b", dependsOn: ["a"] },
			{ id: "downstream", dependsOn: ["a"] },
		]);
		expect(result.cycle).toEqual(["a", "b"]);
		expect(result.cycle).not.toContain("downstream");
	});
});
