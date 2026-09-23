// Bounded read-only views. Both tool text and details contain only the selected page.
import type { JsonValue } from "../contracts/primitives.ts";
import { type ProcessSpec, ProcessSpecSchema } from "../contracts/process-spec.ts";
import { hashJson, toJsonValue } from "../ir/hash.ts";
import { processSources } from "../ir/process-sources.ts";
import { validateSchema } from "../ir/validation.ts";
import { draftCompleteness } from "./workflow-draft-completeness.ts";
import { draftReferences, draftTopology } from "./workflow-draft-links.ts";
import { reviewProjection } from "./workflow-draft-materialize.ts";
import { type AuthoringDraft, DraftError, type DraftExternalViews } from "./workflow-draft-model.ts";

export const DRAFT_VIEW_NAMES = [
	"summary",
	"topology",
	"nodes",
	"criteria",
	"stages",
	"governance",
	"coverage",
	"completion",
	"incomplete",
	"validation",
	"catalog",
	"process",
	"operation",
] as const;
export interface DraftReadRequest {
	view?: (typeof DRAFT_VIEW_NAMES)[number];
	node_ids?: string[];
	criterion_ids?: string[];
	ids?: string[];
	sections?: ("identity" | "contract" | "agent" | "outputs" | "inputs" | "review")[];
	kind?: string;
	source?: string;
	query?: string;
	category?: string;
	operation_id?: string;
	limit?: number;
	cursor?: string;
}
export function draftSummary(draft: AuthoringDraft) {
	const missing = draftCompleteness(draft);
	return {
		draft_id: draft.draftId,
		current_revision: draft.revision,
		protocol_version: 2,
		editing: draft.editing,
		metadata: draft.metadata,
		counts: {
			nodes: draft.nodes.length,
			criteria: draft.criteria.length,
			stages: draft.stage_plans.length,
			incomplete: missing.length,
			compiler_errors:
				draft.lastValidation?.revision === draft.revision && draft.lastValidation.mode === "compile"
					? draft.lastValidation.diagnostics.filter((item) => item.category !== "incomplete").length
					: null,
		},
		last_validation: draft.lastValidation
			? {
					revision: draft.lastValidation.revision,
					mode: draft.lastValidation.mode,
					valid: draft.lastValidation.valid,
				}
			: null,
		diagnostics_scope: "global-completeness; compiler-not-run-unless-marked",
		diagnostics: missing.slice(0, 8),
		truncated: missing.length > 8,
		more: missing.length > 8 ? { tool: "workflow_draft_read", view: "incomplete" } : null,
	};
}
const identifier = (item: unknown): string => {
	if (!item || typeof item !== "object") return "";
	const record = item as Record<string, unknown>;
	return (
		[
			"id",
			"criterion_id",
			"stage_id",
			"requirement_id",
			"activity_id",
			"deliverable_id",
			"review_id",
			"rule_id",
			"name",
		]
			.map((key) => record[key])
			.find((value): value is string => typeof value === "string") ?? ""
	);
};
function selectView(draft: AuthoringDraft, request: DraftReadRequest, context: DraftExternalViews): unknown[] {
	const view = request.view ?? "summary";
	const filter = <T>(items: T[], id: (item: T) => string, ids?: string[]) =>
		items.filter((item) => !ids || ids.includes(id(item)));
	switch (view) {
		case "summary":
			return [draftSummary(draft)];
		case "topology": {
			const graph = draftTopology(draft);
			return [
				...graph.nodes.map((node) => ({ record_type: "node", ...node })),
				...graph.edges.map((edge) => ({ record_type: "edge", ...edge })),
			];
		}
		case "nodes": {
			if (!request.node_ids?.length)
				throw new DraftError("node_ids_required", "/node_ids", "Select node IDs; use topology for the node index.");
			for (const id of request.node_ids)
				if (!draft.nodes.some((node) => node.node_id === id))
					throw new DraftError("node_unknown", id, `Unknown node ${id}`);
			return filter(draft.nodes, (node) => node.node_id, request.node_ids).map((node) => {
				const sections = request.sections ?? ["identity", "contract", "agent", "outputs", "inputs", "review"];
				const result: Record<string, unknown> = { node_id: node.node_id };
				for (const section of sections) {
					if (section === "identity")
						Object.assign(result, { name: node.name, kind: node.kind, environment_ref: node.environment_ref });
					else if (section === "review")
						result.review =
							node.kind === "review" ? { ...node.review_plan, derived: reviewProjection(node) } : null;
					else result[section] = node[section];
				}
				return result;
			});
		}
		case "criteria":
			return filter(draft.criteria, (item) => item.criterion_id, request.criterion_ids ?? request.ids).map(
				(criterion) => ({
					...criterion,
					used_by: draftReferences(draft)
						.filter((ref) => ref.target === `criterion:${criterion.criterion_id}`)
						.map((ref) => ref.path),
				}),
			);
		case "stages":
			return filter(draft.stage_plans, (item) => item.stage_id, request.ids);
		case "governance":
			return [
				...(!request.ids ? [{ metadata: draft.metadata, prerequisites: draft.prerequisites }] : []),
				...filter(draft.requirements, (item) => item.requirement_id, request.ids).map((item) => ({
					record_type: "requirement",
					...item,
				})),
				...filter(draft.decisions, (item) => item.decision_id, request.ids).map((item) => ({
					record_type: "decision",
					...item,
				})),
			];
		case "coverage":
			return filter(draft.process_coverage, (item) => item.requirement_id, request.ids).filter(
				(item) => !request.source || item.source === request.source,
			);
		case "completion":
			return [draft.completion ?? { incomplete: true }];
		case "incomplete":
			return draftCompleteness(draft).filter(
				(item) => !request.node_ids || request.node_ids.some((id) => item.path.startsWith(`node:${id}.`)),
			);
		case "validation":
			return draft.lastValidation
				? [
						{
							revision: draft.lastValidation.revision,
							valid: draft.lastValidation.valid,
							mode: draft.lastValidation.mode,
						},
						...draft.lastValidation.diagnostics.filter(
							(item) => !request.category || item.category === request.category,
						),
					]
				: [{ message: "No current validation record." }];
		case "operation": {
			if (!request.operation_id)
				throw new DraftError(
					"operation_id_required",
					"/operation_id",
					"Select the operation whose receipt was lost.",
				);
			if (Object.hasOwn(draft.operations, request.operation_id)) return [draft.operations[request.operation_id]];
			if (draft.legacyOperations && Object.hasOwn(draft.legacyOperations, request.operation_id))
				return [{ protocol: "legacy-v1", ...draft.legacyOperations[request.operation_id] }];
			return [{ found: false }];
		}
		case "catalog": {
			const catalog = context.catalog;
			if (!catalog || typeof catalog !== "object")
				return [{ available: false, message: "No catalog view was provided by trusted control." }];
			const records = Array.isArray(catalog)
				? catalog
				: request.kind
					? (catalog as Record<string, JsonValue>)[request.kind]
					: Object.keys(catalog).map((kind) => ({ kind }));
			const items = Array.isArray(records) ? records : records ? [records] : [];
			return filter(items, identifier, request.ids).filter(
				(item) => !request.query || JSON.stringify(item).toLowerCase().includes(request.query.toLowerCase()),
			);
		}
		case "process": {
			if (request.kind === "sources") {
				const parsed = validateSchema<ProcessSpec>(ProcessSpecSchema, context.process);
				if (!parsed.ok) return [{ available: false, message: "No validated selected ProcessSpec." }];
				return processSources(parsed.value)
					.filter((item) => !request.ids || request.ids.includes(item.source_ref))
					.filter(
						(item) => !request.query || JSON.stringify(item).toLowerCase().includes(request.query.toLowerCase()),
					);
			}
			if (!context.process || typeof context.process !== "object" || Array.isArray(context.process))
				return [{ available: false }];
			const process = context.process as Record<string, JsonValue>;
			const keys = request.source
				? [request.source]
				: ["required_activities", "required_deliverables", "required_reviews", "workflow_rules"];
			return keys
				.flatMap((key) => {
					const value = process[key];
					return Array.isArray(value) ? value.map((item) => ({ source: key, value: item })) : [];
				})
				.filter((item) => !request.ids || request.ids.includes(identifier(item.value)));
		}
	}
}
export function readDraftView(draft: AuthoringDraft, request: DraftReadRequest, context: DraftExternalViews = {}) {
	const { cursor, ...selection } = request;
	const limit = request.limit ?? 12;
	if (!Number.isInteger(limit) || limit < 1 || limit > 50)
		throw new DraftError("invalid_page_limit", "/limit", "Page limit must be 1..50.");
	const records = selectView(draft, request, context).map(toJsonValue);
	const signature = hashJson({ revision: draft.revision, selection, viewContent: records });
	let index = 0;
	let offset = 0;
	if (cursor) {
		try {
			const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
				signature: string;
				index: number;
				offset: number;
			};
			if (
				decoded.signature !== signature ||
				!Number.isInteger(decoded.index) ||
				decoded.index < 0 ||
				!Number.isInteger(decoded.offset) ||
				decoded.offset < 0
			)
				throw new Error("invalid");
			index = decoded.index;
			offset = decoded.offset;
		} catch {
			throw new DraftError(
				"stale_or_invalid_cursor",
				"/cursor",
				"The page cursor does not match this revision, view, or catalog. Restart the read.",
			);
		}
	}
	if (index > records.length || (index === records.length && offset !== 0))
		throw new DraftError("invalid_cursor_offset", "/cursor", "Cursor is outside the selected view.");
	const items: JsonValue[] = [];
	let chars = 0;
	let fragment: { item_index: number; text: string; offset: number; encoding: "json-text" } | undefined;
	for (; index < records.length && items.length < limit; index++) {
		const encoded = JSON.stringify(records[index]);
		if (offset > encoded.length)
			throw new DraftError("invalid_cursor_offset", "/cursor", "Fragment offset is outside the selected item.");
		if (encoded.length > 12000 || offset) {
			if (items.length) break;
			let end = Math.min(encoded.length, offset + 12000);
			if (end < encoded.length && /[\uD800-\uDBFF]/.test(encoded[end - 1])) end--;
			fragment = { item_index: index, text: encoded.slice(offset, end), offset, encoding: "json-text" };
			offset = end;
			if (offset === encoded.length) {
				offset = 0;
				index++;
			}
			break;
		}
		if (chars + encoded.length > 12000 && items.length) break;
		items.push(records[index]);
		chars += encoded.length;
	}
	const truncated = index < records.length;
	return {
		draft_id: draft.draftId,
		current_revision: draft.revision,
		view: request.view ?? "summary",
		items,
		...(fragment ? { fragment } : {}),
		total_items: records.length,
		truncated,
		next_cursor: truncated ? Buffer.from(JSON.stringify({ signature, index, offset })).toString("base64url") : null,
	};
}
