import type { IpdDiagnostic, WorkflowAssetRecord } from "../ir/types.ts";

export interface WorkflowAssetRegistry {
	list(): readonly WorkflowAssetRecord[];
	get(id: string, version: string): WorkflowAssetRecord | undefined;
}

export class InMemoryWorkflowAssetRegistry implements WorkflowAssetRegistry {
	private readonly workflows = new Map<string, WorkflowAssetRecord>();

	add(record: WorkflowAssetRecord): IpdDiagnostic | undefined {
		const key = `${record.workflow.id}@${record.workflow.version}`;
		const existing = this.workflows.get(key);
		if (existing) {
			return {
				code: "asset_collision",
				path: "/id",
				message: `Workflow ${key} is defined by both ${existing.source} and ${record.source}`,
				source: record.source,
			};
		}
		this.workflows.set(key, record);
		return undefined;
	}

	list(): readonly WorkflowAssetRecord[] {
		return Array.from(this.workflows.values()).sort(
			(left, right) =>
				left.workflow.id.localeCompare(right.workflow.id) ||
				left.workflow.version.localeCompare(right.workflow.version),
		);
	}

	get(id: string, version: string): WorkflowAssetRecord | undefined {
		return this.workflows.get(`${id}@${version}`);
	}
}
