// 判断 Compiler 当前是否为每个节点分配独立的 Docker 私有工作区。
import type { CompilerAssetCatalog } from "./types.ts";

export function usesPrivateNodeWorkspaces(catalog: CompilerAssetCatalog): boolean {
	if (!catalog.environmentProfiles || !catalog.environmentPolicy) return false;
	const allowed = catalog.environmentProfiles.filter((candidate) =>
		catalog.environmentPolicy?.allowedProfiles.some(
			(ref) => ref.id === candidate.profile.id && ref.version === candidate.profile.version,
		),
	);
	return allowed.length > 0 && allowed.every((candidate) => candidate.profile.provider === "docker");
}
