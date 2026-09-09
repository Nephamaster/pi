export interface DirectedNode {
	id: string;
	dependsOn: readonly string[];
}

export interface TopologicalSortResult {
	order: string[];
	cycle: string[];
	unknownDependencies: Array<{ nodeId: string; dependencyId: string }>;
}

export function topologicalSort(nodes: readonly DirectedNode[]): TopologicalSortResult {
	const nodeIds = new Set(nodes.map((node) => node.id));
	const unknownDependencies = nodes.flatMap((node) =>
		node.dependsOn
			.filter((dependencyId) => !nodeIds.has(dependencyId))
			.map((dependencyId) => ({ nodeId: node.id, dependencyId })),
	);
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

	const byId = new Map(nodes.map((node) => [node.id, node]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const stack: string[] = [];
	const cycle = new Set<string>();
	const visit = (id: string) => {
		if (visited.has(id)) return;
		if (visiting.has(id)) {
			for (const member of stack.slice(stack.indexOf(id))) cycle.add(member);
			return;
		}
		visiting.add(id);
		stack.push(id);
		for (const dependency of byId.get(id)?.dependsOn ?? []) {
			if (byId.has(dependency)) visit(dependency);
		}
		stack.pop();
		visiting.delete(id);
		visited.add(id);
	};
	for (const node of nodes) visit(node.id);
	return { order, cycle: [...cycle].sort(), unknownDependencies };
}
