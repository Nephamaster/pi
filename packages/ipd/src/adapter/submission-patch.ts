// Payload-only corrections. Never reads/writes files or modifies Runtime state.
import type { JsonValue } from "../contracts/primitives.ts";

export type SubmissionPatch = { op: "set"; path: string; value: JsonValue } | { op: "remove"; path: string };

function segments(path: string): string[] {
	if (!path.startsWith("/") || path.length > 1024 || path === "/")
		throw new Error("Use a non-root JSON Pointer to a submission field.");
	const parts = path.slice(1).split("/");
	if (parts.length > 16 || parts.some((part) => /~(?![01])/u.test(part)))
		throw new Error("Invalid or excessively deep submission pointer.");
	return parts.map((part) => {
		const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
		if (!key || ["__proto__", "prototype", "constructor"].includes(key))
			throw new Error("Unsafe submission pointer.");
		return key;
	});
}
function objectAt(value: unknown, path: string): Record<string, unknown> | unknown[] {
	if (value === null || typeof value !== "object")
		throw new Error(`Submission pointer does not address an object: ${path}`);
	return value as Record<string, unknown> | unknown[];
}
function arrayIndex(key: string, array: unknown[]): number {
	if (!/^(0|[1-9]\d*)$/u.test(key) || !Number.isSafeInteger(Number(key)) || Number(key) >= array.length)
		throw new Error("Array corrections must address an existing index; replace the array to append.");
	return Number(key);
}
export function readSubmissionField(value: unknown, path: string): unknown {
	let current = value;
	for (const key of segments(path)) {
		const object = objectAt(current, path);
		if (Array.isArray(object)) current = object[arrayIndex(key, object)];
		else {
			if (!Object.hasOwn(object, key)) throw new Error(`Submission field is absent: ${path}`);
			current = object[key];
		}
	}
	return structuredClone(current);
}
export function patchSubmission(value: unknown, patches: readonly SubmissionPatch[]): unknown {
	if (!patches.length || patches.length > 32) throw new Error("Provide 1..32 submission field corrections.");
	const candidate: unknown = structuredClone(value);
	for (const patch of patches) {
		const keys = segments(patch.path);
		const key = keys.pop()!;
		let parent = candidate;
		for (const token of keys) {
			const object = objectAt(parent, patch.path);
			if (Array.isArray(object)) parent = object[arrayIndex(token, object)];
			else {
				if (!Object.hasOwn(object, token)) throw new Error(`Submission parent is absent: ${patch.path}`);
				parent = object[token];
			}
		}
		const object = objectAt(parent, patch.path);
		if (Array.isArray(object)) {
			const index = arrayIndex(key, object);
			if (patch.op === "remove") object.splice(index, 1);
			else object[index] = structuredClone(patch.value);
		} else if (patch.op === "remove") {
			if (!Object.hasOwn(object, key)) throw new Error(`Submission field is absent: ${patch.path}`);
			delete object[key];
		} else {
			Object.defineProperty(object, key, {
				value: structuredClone(patch.value),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
	}
	return candidate;
}
