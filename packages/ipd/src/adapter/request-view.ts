// Bound repeated tool evidence in the request projection; retain originals in the native Session.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, ExtensionFactory, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import type { ProviderRequestObservation, RequestViewLimits } from "./provider-request-admission.ts";

export const CONTEXT_EVIDENCE_TOOL = "ipd_read_context";
const MAX_VIEW_REPAIRS = 2;
const TEXT_PAGE_CHARS = 8000;

interface EvidenceEntry {
	id: string;
	message: ToolResultMessage;
}

function evidenceEntries(ctx: ExtensionContext): Map<string, EvidenceEntry> {
	return new Map(
		ctx.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "toolResult"
					? [[entry.message.toolCallId, { id: entry.id, message: entry.message }] as const]
					: [],
			),
	);
}

function reference(entry: EvidenceEntry, block: number): TextContent {
	const part = entry.message.content[block];
	return {
		type: "text",
		text: `[IPD request-view reference: ${JSON.stringify({
			entry_id: entry.id,
			block,
			tool: entry.message.toolName,
			type: part.type,
			...(part.type === "text" ? { characters: part.text.length } : { mime_type: part.mimeType }),
		})}. Original evidence is retained, not summarized or verified. Read this block with ${CONTEXT_EVIDENCE_TOOL}; text supports offset/limit, images are read one at a time.]`,
	};
}

/** Only tool content is replaceable. Instructions, tool calls, roles and result identities remain intact. */
export function projectRequestView(
	messages: AgentMessage[],
	entries: ReadonlyMap<string, EvidenceEntry>,
	limits: RequestViewLimits,
	byteTarget: number,
): AgentMessage[] {
	let bytes = Buffer.byteLength(JSON.stringify(messages));
	let images = messages.reduce(
		(total, message) =>
			total +
			("content" in message && Array.isArray(message.content)
				? message.content.filter((part) => part.type === "image").length
				: 0),
		0,
	);
	const newestResult = messages.filter((message) => message.role === "toolResult").at(-1);
	// Oldest evidence is reduced first. The newest result is paged only if it cannot fit intact.
	return messages.map((message) => {
		if (message.role !== "toolResult") return message;
		// A requested page must reach the model once, or fail admission; never turn it into another unread reference.
		if (message === newestResult && message.toolName === CONTEXT_EVIDENCE_TOOL) return message;
		const entry = entries.get(message.toolCallId);
		if (!entry || entry.message.toolName !== message.toolName) return message;
		let messageImages = message.content.filter((part) => part.type === "image").length;
		let changed = false;
		const content = message.content.map((part, index) => {
			const original = entry.message.content[index];
			// Do not expose content hidden or transformed by another extension/context edit.
			if (!original || original.type !== part.type) return part;
			if (original.type === "text" && part.type === "text" && original.text !== part.text) return part;
			if (
				original.type === "image" &&
				part.type === "image" &&
				(original.data !== part.data || original.mimeType !== part.mimeType)
			)
				return part;
			const imagePressure =
				part.type === "image" &&
				(images > limits.maxImagesPerRequest || messageImages > limits.maxImagesPerMessage);
			if (!imagePressure && bytes <= byteTarget) return part;
			const replacement = reference(entry, index);
			const saved = Buffer.byteLength(JSON.stringify(part)) - Buffer.byteLength(JSON.stringify(replacement));
			if (!imagePressure && saved <= 0) return part;
			bytes -= saved;
			if (part.type === "image") {
				images--;
				messageImages--;
			}
			changed = true;
			return replacement;
		});
		return changed ? { ...message, content } : message;
	});
}

export function createRequestView(limits: RequestViewLimits): {
	extension: ExtensionFactory;
	onRejected(observation: ProviderRequestObservation): void;
} {
	let byteTarget = Math.floor(limits.maxRequestBytes * 0.7);
	let viewLimits = { ...limits };
	let repairs = 0;
	let continueRepairedRequest = false;
	let rejected: ProviderRequestObservation | undefined;
	let lastView: AgentMessage[] = [];
	return {
		onRejected: (observation) => {
			rejected = observation;
		},
		extension: (pi) => {
			pi.on("before_agent_start", () => {
				byteTarget = Math.floor(limits.maxRequestBytes * 0.7);
				viewLimits = { ...limits };
				repairs = 0;
				continueRepairedRequest = false;
				rejected = undefined;
			});
			pi.on("context", (event, ctx) => {
				continueRepairedRequest = false;
				lastView = projectRequestView(event.messages, evidenceEntries(ctx), viewLimits, byteTarget);
				return { messages: lastView };
			});
			pi.on("turn_end", (event, ctx) => {
				const failure = rejected;
				rejected = undefined;
				if (ctx.signal?.aborted || event.outcome === "aborted") return;
				const evidence = evidenceEntries(ctx);
				if (event.outcome === "completed") repairs = 0;
				let retry = false;
				if (failure && event.outcome === "error" && repairs < MAX_VIEW_REPAIRS) {
					const nextTarget =
						failure.reasonCode === "request_bytes_exceeded" ? Math.floor(byteTarget / 2) : byteTarget;
					// Some providers merge several tool results into one user message on the wire.
					const nextLimits =
						failure.reasonCode === "message_images_exceeded"
							? {
									...viewLimits,
									maxImagesPerRequest: Math.min(viewLimits.maxImagesPerRequest, limits.maxImagesPerMessage),
								}
							: viewLimits;
					const nextView = projectRequestView(lastView, evidence, nextLimits, nextTarget);
					if (JSON.stringify(nextView) !== JSON.stringify(lastView)) {
						byteTarget = nextTarget;
						viewLimits = nextLimits;
						repairs++;
						retry = true;
					}
				}
				const entries: SessionBoundaryDraft[] = [...event.entries];
				const view = projectRequestView(event.context.contextMessages, evidence, viewLimits, byteTarget);
				const toolViews = new Map(
					view.flatMap((message) =>
						message.role === "toolResult" ? [[message.toolCallId, message] as const] : [],
					),
				);
				for (const projected of event.context.contextEntries) {
					const message = projected.messages[0];
					if (message?.role !== "toolResult") continue;
					const replacement = toolViews.get(message.toolCallId);
					if (replacement && JSON.stringify(replacement.content) !== JSON.stringify(message.content))
						entries.push({
							type: "context_edit",
							targetId: projected.sourceEntry.id,
							replacement: { content: replacement.content },
						});
				}
				if (retry && failure) {
					continueRepairedRequest = true;
					// Native boundary continuation retries only the rejected request, never its dispatch/tools.
					entries.push(
						{ type: "context_edit", targetId: event.messageEntryId, replacement: null },
						{
							type: "custom",
							customType: "ipd_request_view_repair",
							data: { requestId: failure.requestId, repair: repairs, byteTarget },
						},
					);
				}
				return { entries };
			});
			// The low-level loop always ends on errors; Pi's settlement boundary owns error continuation.
			pi.on("agent_before_settle", (_event, ctx) => {
				if (!continueRepairedRequest || ctx.signal?.aborted) return;
				continueRepairedRequest = false;
				return { continue: true };
			});
			pi.registerTool({
				name: CONTEXT_EVIDENCE_TOOL,
				label: "Read retained context evidence",
				description:
					"Read an exact tool-result block from this Session using an IPD request-view reference. Text is paged; request one image at a time. This does not execute the original tool again or read other Sessions/files.",
				parameters: Type.Object({
					entry_id: Type.String(),
					block: Type.Integer({ minimum: 0 }),
					offset: Type.Optional(Type.Integer({ minimum: 0 })),
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: TEXT_PAGE_CHARS })),
				}),
				async execute(_id, args, signal, _update, ctx) {
					signal?.throwIfAborted();
					const entry = [...evidenceEntries(ctx).values()].find((candidate) => candidate.id === args.entry_id);
					const part = entry?.message.content[args.block];
					if (!part) throw new Error("Evidence block is not a tool result in this Session branch");
					if (part.type === "image") {
						if (
							limits.maxImagesPerMessage === 0 ||
							limits.maxImagesPerRequest === 0 ||
							Buffer.byteLength(JSON.stringify(part)) > limits.maxRequestBytes * 0.35
						)
							throw new Error(
								"This image cannot fit the current request budget. Read a smaller image/crop from the authorized workspace instead.",
							);
						return { content: [part], details: { entry_id: entry.id, block: args.block } };
					}
					const offset = args.offset ?? 0;
					const limit = Math.min(
						args.limit ?? TEXT_PAGE_CHARS,
						Math.max(1, Math.floor(limits.maxRequestBytes / 16)),
					);
					const end = Math.min(part.text.length, offset + limit);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									entry_id: entry.id,
									block: args.block,
									offset,
									next_offset: end < part.text.length ? end : null,
									total_characters: part.text.length,
								}),
							},
							{ type: "text", text: part.text.slice(offset, end) },
						],
						details: {},
					};
				},
			});
		},
	};
}
