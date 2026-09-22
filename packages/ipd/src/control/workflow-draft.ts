// One durable authoring draft. The existing Compiler remains the execution authority.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkflowDefinition } from "../contracts/workflow.ts";
import { WorkflowDefinitionSchema } from "../contracts/workflow.ts";
import { hashJson, toJsonValue } from "../ir/hash.ts";
import { validateSchema } from "../ir/validation.ts";
import { draftCompleteness } from "./workflow-draft-completeness.ts";
import { importLegacyDraft, type LegacyDraft, newAuthoringDraft } from "./workflow-draft-import.ts";
import { applyLegacyOperations, type WorkflowDraftOperation } from "./workflow-draft-legacy.ts";
import { checkDraftLinks } from "./workflow-draft-links.ts";
import { locateDiagnostic, materializeDraft } from "./workflow-draft-materialize.ts";
import {
	type AuthoringDraft, type DraftCommand, type DraftDiagnostic, type DraftExternalViews,
	type DraftReceipt, type DraftTrustedReferences, DraftError,
} from "./workflow-draft-model.ts";
import { applyDraftCommand } from "./workflow-draft-operations.ts";
import { AuthoringDraftSchema, DraftCommandSchema, LegacyDraftSchema } from "./workflow-draft-schema.ts";
import { withDraftWriter, writeDraftFile, writeImmutableDraftFile } from "./workflow-draft-storage.ts";

export type { WorkflowDraftHeader, WorkflowDraftOperation } from "./workflow-draft-legacy.ts";
/** Read-only consumers may display legacy files; writers require explicit migration. */
export type WorkflowDraftState = AuthoringDraft | LegacyDraft;
export type WorkflowDraftTrustedReferences = DraftTrustedReferences;
export type WorkflowDraftDiagnostic = DraftDiagnostic;
export interface WorkflowDraftValidation {
	revision: number;
	valid: boolean;
	mode: "draft" | "compile";
	diagnostics: DraftDiagnostic[];
	workflow?: WorkflowDefinition;
}
export type WorkflowDraftValidator = (workflow: WorkflowDefinition) => DraftDiagnostic[];
export interface WorkflowDraftManagerOptions {
	file: string;
	trustedReferences: DraftTrustedReferences;
	validator?: WorkflowDraftValidator;
	onValidation?: (validation: Omit<WorkflowDraftValidation, "workflow">) => Promise<void> | void;
}

export class WorkflowDraftManager {
	private readonly options: WorkflowDraftManagerOptions;
	private runId?: string;
	private controlClosed = false;
	private external: DraftExternalViews = {};

	constructor(options: WorkflowDraftManagerOptions) {
		this.options = { ...options, trustedReferences: structuredClone(options.trustedReferences) };
	}
	setContext(context: DraftExternalViews): void {
		this.external = structuredClone(context);
	}
	getContext(): DraftExternalViews {
		return structuredClone(this.external);
	}
	async open(runId: string): Promise<AuthoringDraft> {
		if (this.runId && this.runId !== runId)
			throw new DraftError("wrong_run", "/runId", "Draft manager is already bound to another Run.");
		this.runId = runId;
		return withDraftWriter(this.options.file, async () => {
			try {
				return await this.read();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const state = newAuthoringDraft(runId, this.options.trustedReferences);
			await this.save(state);
			return state;
		});
	}
	async read(): Promise<AuthoringDraft> {
		const raw: unknown = JSON.parse(await readFile(this.options.file, "utf8"));
		if (raw && typeof raw === "object" && !("draft_schema_version" in raw))
			throw new DraftError("legacy_migration_required", "/", "Legacy draft preserved. Stop the old writer, then invoke migrateLegacy(runId, true) from trusted control code.");
		const parsed = validateSchema<AuthoringDraft>(AuthoringDraftSchema, raw, this.options.file);
		if (!parsed.ok)
			throw new DraftError("invalid_authoring_state", "/", "Stored draft failed its authoring schema.", parsed.diagnostics);
		this.checkIdentity(parsed.value);
		return parsed.value;
	}
	async beginRevision(): Promise<void> {
		if (this.controlClosed) throw new DraftError("draft_control_closed", "/", "Designer control has closed this draft.");
		await this.setEditing(true);
	}
	async close(): Promise<void> {
		this.controlClosed = true;
		await this.setEditing(false);
	}
	private async setEditing(editing: boolean): Promise<void> {
		await withDraftWriter(this.options.file, async () => {
			const state = await this.read();
			if (editing && state.closureReason === "control_closed")
				throw new DraftError("draft_control_closed", "/", "A cancelled designer cannot reopen this draft.");
			state.editing = editing;
			if (editing) delete state.closureReason;
			else state.closureReason = "control_closed";
			await this.save(state);
		});
	}
	async edit(expectedRevision: number, operationId: string, command: unknown) {
		const parsed = validateSchema<DraftCommand>(DraftCommandSchema, toJsonValue(command), "authoring-command");
		if (!parsed.ok)
			throw new DraftError("invalid_command", "/", "Invalid domain command; no edits saved.", parsed.diagnostics);
		return this.mutate(expectedRevision, operationId, parsed.value, "authoring-v2", (state) =>
			applyDraftCommand(state, parsed.value, this.external),
		);
	}
	/** Trusted compatibility entry; never exposed in a new Designer tool set. */
	async apply(draftId: string, expectedRevision: number, operationId: string, operations: readonly WorkflowDraftOperation[]): Promise<AuthoringDraft> {
		const state = await this.read();
		if (state.draftId !== draftId) throw new DraftError("wrong_draft", "/draftId", "Unknown Workflow Draft.");
		await this.mutate(expectedRevision, operationId, operations, "legacy-programmatic", (current) => ({
			draft: applyLegacyOperations(current, operations), changed: ["legacy-import"], defaults_applied: [],
		}));
		return this.read();
	}
	private async mutate(
		expectedRevision: number,
		operationId: string,
		payload: unknown,
		protocol: string,
		update: (state: AuthoringDraft) => { draft: AuthoringDraft; changed: string[]; defaults_applied: string[] },
	) {
		if (!operationId.trim()) throw new DraftError("operation_id_missing", "/operation_id", "A stable operation ID is required.");
		return withDraftWriter(this.options.file, async () => {
			const state = await this.read();
			const requestHash = hashJson({ protocol, payload });
			const previous = Object.hasOwn(state.operations, operationId) ? state.operations[operationId] : undefined;
			if (previous) {
				if (previous.requestHash !== requestHash)
					throw new DraftError("operation_id_conflict", "/operation_id", `Draft operation ID conflict: ${operationId}`);
				return { ...previous.receipt, current_revision: state.revision, replayed: true };
			}
			if (state.legacyOperations && Object.hasOwn(state.legacyOperations, operationId))
				throw new DraftError("legacy_operation_id", "/operation_id", "This ID belongs to the retained legacy operation history; inspect it before issuing a new edit.");
			this.checkRevision(state, expectedRevision);
			if (this.controlClosed || !state.editing)
				throw new DraftError("draft_not_editable", "/", "Draft editing is closed. Only trusted control may begin a compiler-requested revision.");
			const result = update(state);
			checkDraftLinks(state, result.draft, this.external);
			result.draft.revision = state.revision + 1;
			delete result.draft.lastValidation;
			const receipt: DraftReceipt = {
				operation_id: operationId, applied_revision: result.draft.revision,
				changed: result.changed, defaults_applied: result.defaults_applied,
			};
			Object.defineProperty(result.draft.operations, operationId, {
				value: { requestHash, protocol, receipt }, enumerable: true, writable: true, configurable: true,
			});
			await this.save(result.draft);
			return { ...receipt, current_revision: result.draft.revision, replayed: false };
		});
	}
	async validate(expectedRevision: number, mode: "draft" | "compile" = "compile"): Promise<WorkflowDraftValidation> {
		const result = await withDraftWriter(this.options.file, async () => {
			const state = await this.read();
			this.checkRevision(state, expectedRevision);
			const validation = this.validateCurrent(state, mode);
			const { workflow: _workflow, ...record } = validation;
			state.lastValidation = record;
			await this.save(state);
			return validation;
		});
		const { workflow: _workflow, ...record } = result;
		if (mode === "compile") await this.options.onValidation?.(record);
		return result;
	}
	private validateCurrent(state: AuthoringDraft, mode: "draft" | "compile"): WorkflowDraftValidation {
		checkDraftLinks(state, state, this.external);
		const diagnostics = draftCompleteness(state);
		if (mode === "draft" || diagnostics.length)
			return { revision: state.revision, mode, valid: mode === "draft" && diagnostics.length === 0, diagnostics };
		const materialized = materializeDraft(state);
		const parsed = validateSchema<WorkflowDefinition>(WorkflowDefinitionSchema, materialized.candidate, this.options.file);
		const errors = (parsed.ok ? this.options.validator?.(parsed.value) ?? [] : parsed.diagnostics)
			.map((error) => locateDiagnostic(error, materialized.sourceMap));
		return {
			revision: state.revision, mode, valid: parsed.ok && errors.length === 0, diagnostics: errors,
			...(parsed.ok && !errors.length ? { workflow: parsed.value } : {}),
		};
	}
	async submit(expectedRevision: number): Promise<WorkflowDefinition> {
		return (await this.submitRevision(expectedRevision, `submit:${expectedRevision}`)).workflow;
	}
	async submitRevision(expectedRevision: number, operationId: string) {
		if (!operationId.trim()) throw new DraftError("operation_id_missing", "/operation_id", "A stable submit operation ID is required.");
		const captured = await withDraftWriter(this.options.file, async () => {
			const state = await this.read();
			this.checkRevision(state, expectedRevision);
			const requestHash = hashJson({ protocol: "submit-v2", expectedRevision });
			const previous = Object.hasOwn(state.operations, operationId) ? state.operations[operationId] : undefined;
			if (previous && previous.requestHash !== requestHash)
				throw new DraftError("operation_id_conflict", "/operation_id", "Submit operation ID conflicts with another request.");
			if (state.legacyOperations && Object.hasOwn(state.legacyOperations, operationId))
				throw new DraftError("legacy_operation_id", "/operation_id", "This ID belongs to a legacy edit, not a new submission.");
			if (this.controlClosed || (!state.editing && (state.closureReason !== "captured" || !previous)))
				throw new DraftError("draft_not_editable", "/", "Draft has already been captured or closed.");
			const validation = this.validateCurrent(state, "compile");
			if (!validation.valid || !validation.workflow) {
				state.lastValidation = { revision: state.revision, valid: false, mode: "compile", diagnostics: validation.diagnostics };
				await this.save(state);
				return { kind: "invalid" as const, validation: state.lastValidation };
			}
			const hash = hashJson(validation.workflow);
			const file = join("workflow-candidates", `revision-${state.revision}-${hash}.json`);
			if (previous && previous.receipt.candidate_hash !== hash)
				throw new DraftError("candidate_changed", "/", "A replayed submit must refer to the identical candidate.");
			await writeImmutableDraftFile(join(dirname(this.options.file), file), `${JSON.stringify(validation.workflow, null, "\t")}\n`);
			const receipt: DraftReceipt = {
				operation_id: operationId, applied_revision: state.revision, changed: [], defaults_applied: [],
				candidate_hash: hash, candidate_file: file,
			};
			Object.defineProperty(state.operations, operationId, {
				value: { requestHash, protocol: "submit-v2", receipt }, enumerable: true, writable: true, configurable: true,
			});
			state.lastSubmission = receipt;
			state.lastValidation = { revision: state.revision, valid: true, mode: "compile", diagnostics: [] };
			state.editing = false;
			state.closureReason = "captured";
			await this.save(state);
			return {
				kind: "captured" as const, validation: state.lastValidation, workflow: validation.workflow,
				receipt: { ...receipt, current_revision: state.revision, replayed: Boolean(previous) },
			};
		});
		await this.options.onValidation?.(captured.validation);
		if (captured.kind === "invalid")
			throw new DraftError("draft_invalid", "/", "Workflow Draft is invalid; fix the named objects in the same draft.", captured.validation.diagnostics);
		return { workflow: captured.workflow, receipt: captured.receipt };
	}
	async migrateLegacy(runId: string, legacyWriterStopped: boolean): Promise<AuthoringDraft> {
		if (this.runId && this.runId !== runId)
			throw new DraftError("wrong_run", "/runId", "Draft manager is already bound to another Run.");
		if (!legacyWriterStopped)
			throw new DraftError("migration_writer_active", "/", "Confirm the old designer/writer has stopped before migration.");
		this.runId = runId;
		return withDraftWriter(this.options.file, async () => {
			const text = await readFile(this.options.file, "utf8");
			const raw = JSON.parse(text) as LegacyDraft & { draft_schema_version?: number };
			if (raw.draft_schema_version !== undefined) return this.read();
			this.checkIdentity(raw);
			const parsed = validateSchema<LegacyDraft>(LegacyDraftSchema, toJsonValue(raw), this.options.file);
			if (!parsed.ok)
				throw new DraftError("legacy_migration_invalid", "/", "Legacy draft contains unknown or invalid fields; migration cannot discard them.", parsed.diagnostics);
			const state = importLegacyDraft(parsed.value);
			const sourceHash = hashJson(raw);
			const backupFile = `workflow-draft.v1-${sourceHash}.json`;
			state.migration = { sourceHash, sourceRevision: raw.revision, backupFile };
			state.revision++;
			checkDraftLinks(state, state, this.external);
			await writeImmutableDraftFile(join(dirname(this.options.file), backupFile), text);
			await this.save(state);
			return state;
		});
	}
	private checkIdentity(state: { runId: string; trustedReferences: DraftTrustedReferences }): void {
		if (this.runId && state.runId !== this.runId)
			throw new DraftError("wrong_run", "/runId", `Workflow Draft belongs to another Run: ${state.runId}`);
		if (hashJson(state.trustedReferences) !== hashJson(this.options.trustedReferences))
			throw new DraftError("untrusted_references", "/trustedReferences", "Workflow Draft trusted references do not match this Run");
	}
	private checkRevision(state: AuthoringDraft, revision: number): void {
		if (state.revision !== revision)
			throw new DraftError("revision_conflict", "/revision", `Draft revision conflict: expected ${revision}, current ${state.revision}`);
	}
	private async save(state: AuthoringDraft): Promise<void> {
		const parsed = validateSchema<AuthoringDraft>(AuthoringDraftSchema, toJsonValue(state), this.options.file);
		if (!parsed.ok)
			throw new DraftError("invalid_authoring_state", "/", "Invalid authoring state; no edits saved.", parsed.diagnostics);
		await writeDraftFile(this.options.file, `${JSON.stringify(state, null, "\t")}\n`);
	}
}
