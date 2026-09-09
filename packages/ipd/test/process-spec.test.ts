import { describe, expect, it } from "vitest";
import { validateProcessSpecSemantics } from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

describe("ProcessSpec semantic validation", () => {
	it("rejects duplicate stable IDs and dangling cross-references", () => {
		const spec = structuredClone(createCompilerFixture().processSpec);
		spec.required_deliverables[0].activity_id = "missing-activity";
		spec.required_reviews[0].deliverable_id = "missing-deliverable";
		spec.required_reviews[0].criteria.push({
			...spec.required_reviews[0].criteria[0],
		});
		const codes = validateProcessSpecSemantics(spec).map((diagnostic) => diagnostic.code);
		expect(codes).toContain("process_spec_activity_unknown");
		expect(codes).toContain("process_spec_deliverable_unknown");
		expect(codes).toContain("process_spec_id_duplicate");
	});
});
