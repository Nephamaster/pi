// 规范化相对路径并判断文件作用域包含或重叠关系。
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
	return normalized === "." ? "." : normalized.replace(/\/+$/, "");
}

export function scopeContains(parent: string, child: string): boolean {
	if (parent === ".") return true;
	return child === parent || child.startsWith(`${parent}/`);
}

export function scopesOverlap(left: string, right: string): boolean {
	return scopeContains(left, right) || scopeContains(right, left);
}
