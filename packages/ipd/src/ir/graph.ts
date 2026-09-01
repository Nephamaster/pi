import type { ExecutionNodeDefinition } from "./schemas.ts";

export interface TopologicalSortResult {
	order: string[];
	cycle: string[];
}

export function topologicalSort(nodes: readonly ExecutionNodeDefinition[]): TopologicalSortResult {
	const nodeIds = new Set(nodes.map((node) => node.id));
	const indegree = new Map(nodes.map((node) => [node.id, 0]));
	const dependents = new Map<string, string[]>();

	for (const node of nodes) {
		for (const dependency of node.dependsOn) {
			if (!nodeIds.has(dependency)) continue;
			indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
			const current = dependents.get(dependency) ?? [];
			current.push(node.id);
			dependents.set(dependency, current);
		}
	}

	const ready = Array.from(indegree.entries())
		.filter(([, count]) => count === 0)
		.map(([id]) => id)
		.sort();
	const order: string[] = [];
	while (ready.length > 0) {
		const id = ready.shift();
		if (id === undefined) break;
		order.push(id);
		for (const dependent of (dependents.get(id) ?? []).sort()) {
			const next = (indegree.get(dependent) ?? 0) - 1;
			indegree.set(dependent, next);
			if (next === 0) {
				ready.push(dependent);
				ready.sort();
			}
		}
	}

	const cycle = Array.from(indegree.entries())
		.filter(([, count]) => count > 0)
		.map(([id]) => id)
		.sort();
	return { order, cycle };
}
