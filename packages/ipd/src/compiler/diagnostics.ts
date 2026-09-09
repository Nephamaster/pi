import type { CompilerDiagnostic } from "../contracts/baseline.ts";
import type { NodeOutputRef } from "../contracts/workflow.ts";

export const outputKey = (ref: NodeOutputRef) => `${ref.node_id}/${ref.output_id}`;
export const assetKey = (ref: { id: string; version: string }) => `${ref.id}@${ref.version}`;

export function addDiagnostic(
	diagnostics: CompilerDiagnostic[],
	code: string,
	path: string,
	message: string,
	nodeId?: string,
): void {
	diagnostics.push({ code, severity: "error", path, message, nodeId });
}

export function duplicateIds(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const repeated = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) repeated.add(value);
		seen.add(value);
	}
	return [...repeated];
}
