import { isAbsolute, posix } from "node:path";

export function normalizeScope(scope: string): string | undefined {
	const portable = scope.replaceAll("\\", "/").trim();
	if (!portable || isAbsolute(portable) || /^[A-Za-z]:\//.test(portable)) {
		return undefined;
	}
	const normalized = posix.normalize(portable);
	if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
		return undefined;
	}
	return normalized === "" ? "." : normalized;
}

export function scopeContains(parent: string, child: string): boolean {
	if (parent === ".") return true;
	return child === parent || child.startsWith(`${parent}/`);
}
