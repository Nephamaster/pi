import { describe, expect, it } from "vitest";
import { canonicalJson, hashJson } from "../src/index.ts";

describe("canonical JSON", () => {
	it("sorts object keys without changing array order", () => {
		expect(canonicalJson({ z: 1, a: { d: 2, c: [3, 1] } })).toBe('{"a":{"c":[3,1],"d":2},"z":1}');
	});

	it("produces stable SHA-256 hashes", () => {
		expect(hashJson({ b: 2, a: 1 })).toBe(hashJson({ a: 1, b: 2 }));
		expect(hashJson({ a: 1 })).toMatch(/^[a-f0-9]{64}$/);
	});
});
