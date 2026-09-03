import { describe, expect, it } from "vitest";
import { hashJson, selectWorkflowTemplate } from "../src/index.ts";
import { createValidWorkflow } from "./fixtures.ts";

function asset(version: string) {
	const workflow = createValidWorkflow();
	workflow.version = version;
	const hash = hashJson(workflow);
	return { workflow, hash, source: `${version}.json` };
}

describe("Workflow template selection", () => {
	it("selects the latest semantic version when only an id is supplied", () => {
		const assets = [asset("2.0.0-beta.1"), asset("1.9.0"), asset("2.0.0")];
		expect(selectWorkflowTemplate(assets, "test-workflow")?.workflow.version).toBe("2.0.0");
	});

	it("honors exact version and hash constraints", () => {
		const first = asset("1.0.0");
		const second = asset("2.0.0");
		const assets = [first, second];
		expect(selectWorkflowTemplate(assets, "test-workflow", "1.0.0", first.hash)).toBe(first);
		expect(selectWorkflowTemplate(assets, "test-workflow", "1.0.0", second.hash)).toBeUndefined();
	});
});
