// 提供稳定 JSON 规范化、哈希和深冻结能力。
import { createHash } from "node:crypto";
import type { JsonValue } from "../contracts/primitives.ts";

function canonicalizeValue(value: JsonValue): string {
	if (value === null || typeof value === "boolean" || typeof value === "number") {
		return JSON.stringify(value);
	}
	if (typeof value === "string") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalizeValue(item)).join(",")}]`;
	}
	const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeValue(item)}`).join(",")}}`;
}

export function toJsonValue(value: unknown): JsonValue {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) {
		throw new Error("Value is not JSON serializable");
	}
	return JSON.parse(serialized) as JsonValue;
}

export function canonicalJson(value: unknown): string {
	return canonicalizeValue(toJsonValue(value));
}

export function hashJson(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function freezeDeep<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
	return value;
}
