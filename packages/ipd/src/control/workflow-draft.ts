// 持久化并校验带修订号和幂等操作的工作流草稿。
import { open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Static } from "typebox";
import type { JsonValue } from "../contracts/primitives.ts";
import type {
	CriterionDefinition,
	RequirementCoverageSchema,
	WorkflowCompletionSchema,
	WorkflowDefinition,
	WorkflowNode,
} from "../contracts/workflow.ts";
import { WorkflowDefinitionSchema } from "../contracts/workflow.ts";
import { hashJson, toJsonValue } from "../ir/hash.ts";
import { validateSchema } from "../ir/validation.ts";

export interface WorkflowDraftHeader {
	schema_version: 2;
	workflow_id: string;
	workflow_version: string;
	name: string;
}

export interface WorkflowDraftTrustedReferences {
	task_input_ref: WorkflowDefinition["task_input_ref"];
	process_selection_ref: WorkflowDefinition["process_selection_ref"];
}

export type WorkflowDraftOperation =
	| { kind: "set_header"; header: WorkflowDraftHeader }
	| { kind: "upsert_node"; node: WorkflowNode }
	| { kind: "remove_node"; node_id: string }
	| { kind: "upsert_criterion"; criterion: CriterionDefinition }
	| { kind: "set_requirement_coverage"; coverage: Static<typeof RequirementCoverageSchema>[] }
	| { kind: "set_completion"; completion: Static<typeof WorkflowCompletionSchema> };

export interface WorkflowDraftState {
	draftId: string;
	runId: string;
	revision: number;
	trustedReferences: WorkflowDraftTrustedReferences;
	header?: WorkflowDraftHeader;
	nodes: WorkflowNode[];
	criteria: CriterionDefinition[];
	requirementCoverage: Static<typeof RequirementCoverageSchema>[];
	completion?: Static<typeof WorkflowCompletionSchema>;
	operations: Record<string, { requestHash: string; revision: number }>;
}

export interface WorkflowDraftValidation {
	valid: boolean;
	diagnostics: Array<{ path: string; message: string }>;
	workflow?: WorkflowDefinition;
}

export type WorkflowDraftValidator = (workflow: WorkflowDefinition) => Array<{ path: string; message: string }>;

export interface WorkflowDraftManagerOptions {
	file: string;
	trustedReferences: WorkflowDraftTrustedReferences;
	validator?: WorkflowDraftValidator;
}

export class WorkflowDraftManager {
	private readonly file: string;
	private readonly trustedReferences: WorkflowDraftTrustedReferences;
	private readonly validator?: WorkflowDraftValidator;
	private queue: Promise<void> = Promise.resolve();

	constructor(options: WorkflowDraftManagerOptions) {
		this.file = options.file;
		this.trustedReferences = structuredClone(options.trustedReferences);
		this.validator = options.validator;
	}

	async open(runId: string): Promise<WorkflowDraftState> {
		try {
			return await this.read();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const state: WorkflowDraftState = {
			draftId: `${runId}:workflow-draft`,
			runId,
			revision: 0,
			trustedReferences: structuredClone(this.trustedReferences),
			nodes: [],
			criteria: [],
			requirementCoverage: [],
			operations: {},
		};
		try {
			await this.writeExclusive(state);
			return state;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const existing = await this.read();
			if (existing.runId !== runId) throw new Error(`Workflow Draft belongs to another Run: ${existing.runId}`);
			return existing;
		}
	}

	async read(): Promise<WorkflowDraftState> {
		const state = JSON.parse(await readFile(this.file, "utf8")) as WorkflowDraftState;
		if (hashJson(state.trustedReferences) !== hashJson(this.trustedReferences))
			throw new Error("Workflow Draft trusted references do not match this Run");
		return state;
	}

	async apply(
		draftId: string,
		expectedRevision: number,
		operationId: string,
		operations: readonly WorkflowDraftOperation[],
	): Promise<WorkflowDraftState> {
		let result: WorkflowDraftState | undefined;
		await this.enqueue(async () => {
			const state = await this.read();
			if (state.draftId !== draftId) throw new Error(`Unknown Workflow Draft: ${draftId}`);
			const requestHash = hashJson(operations);
			const previous = state.operations[operationId];
			if (previous) {
				if (previous.requestHash !== requestHash) throw new Error(`Draft operation ID conflict: ${operationId}`);
				result = state;
				return;
			}
			if (state.revision !== expectedRevision)
				throw new Error(`Draft revision conflict: expected ${expectedRevision}, current ${state.revision}`);
			for (const operation of operations) this.applyOperation(state, operation);
			state.revision++;
			state.operations[operationId] = { requestHash, revision: state.revision };
			await this.write(state);
			result = state;
		});
		if (!result) throw new Error("Draft operation produced no result");
		return result;
	}

	async validate(expectedRevision: number): Promise<WorkflowDraftValidation> {
		const state = await this.read();
		if (state.revision !== expectedRevision)
			throw new Error(`Draft revision conflict: expected ${expectedRevision}, current ${state.revision}`);
		const candidate = this.materialize(state);
		const parsed = validateSchema<WorkflowDefinition>(WorkflowDefinitionSchema, candidate, this.file);
		if (!parsed.ok)
			return {
				valid: false,
				diagnostics: parsed.diagnostics.map((item) => ({ path: item.path, message: item.message })),
			};
		const diagnostics = this.validator?.(parsed.value) ?? [];
		return { valid: diagnostics.length === 0, diagnostics, workflow: parsed.value };
	}

	async submit(expectedRevision: number): Promise<WorkflowDefinition> {
		const validation = await this.validate(expectedRevision);
		if (!validation.valid || !validation.workflow)
			throw new Error(
				`Workflow Draft is invalid: ${validation.diagnostics.map((item) => `${item.path}: ${item.message}`).join("; ")}`,
			);
		return validation.workflow;
	}

	private materialize(state: WorkflowDraftState): JsonValue {
		return toJsonValue({
			...(state.header ?? {}),
			...state.trustedReferences,
			nodes: state.nodes,
			criteria: state.criteria,
			requirement_coverage: state.requirementCoverage,
			...(state.completion ? { completion: state.completion } : {}),
		});
	}

	private applyOperation(state: WorkflowDraftState, operation: WorkflowDraftOperation): void {
		if (operation.kind === "set_header") state.header = structuredClone(operation.header);
		else if (operation.kind === "upsert_node") this.upsert(state.nodes, operation.node, (item) => item.node_id);
		else if (operation.kind === "remove_node")
			state.nodes = state.nodes.filter((item) => item.node_id !== operation.node_id);
		else if (operation.kind === "upsert_criterion")
			this.upsert(state.criteria, operation.criterion, (item) => item.criterion_id);
		else if (operation.kind === "set_requirement_coverage")
			state.requirementCoverage = structuredClone(operation.coverage);
		else state.completion = structuredClone(operation.completion);
	}

	private upsert<T>(items: T[], value: T, key: (item: T) => string): void {
		const index = items.findIndex((item) => key(item) === key(value));
		if (index < 0) items.push(structuredClone(value));
		else items[index] = structuredClone(value);
	}

	private async writeExclusive(state: WorkflowDraftState): Promise<void> {
		const file = await open(this.file, "wx");
		try {
			await file.writeFile(`${JSON.stringify(state, null, "\t")}\n`, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
	}

	private async write(state: WorkflowDraftState): Promise<void> {
		const temporary = join(dirname(this.file), `.workflow-draft.${process.pid}.${Date.now()}.tmp`);
		const file = await open(temporary, "wx");
		try {
			await file.writeFile(`${JSON.stringify(state, null, "\t")}\n`, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, this.file);
	}

	private async enqueue(operation: () => Promise<void>): Promise<void> {
		const current = this.queue.catch(() => {}).then(operation);
		this.queue = current.catch(() => {});
		await current;
	}
}
