// Measure the exact provider payload and reject configured byte or image overflows before network I/O.
import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type ExtensionFactory, ProviderRequestRejection } from "@earendil-works/pi-coding-agent";
import type { ProviderRequestRecord } from "../contracts/runtime.ts";

export type ProviderRequestObservation = Omit<
	ProviderRequestRecord,
	"attemptId" | "commandId" | "nodeId" | "createdAt"
>;

const IMAGE_TYPES = new Set(["image", "image_url", "input_image", "inline_data", "inlineData"]);

type ModelWithInputLimits = Model<Api> & {
	inputLimits?: {
		maxRequestBytes?: number;
		images?: { maxPerMessage?: number; maxPerRequest?: number };
	};
};

export interface RequestViewLimits {
	maxRequestBytes: number;
	maxImagesPerRequest: number;
	maxImagesPerMessage: number;
}

// Local working budgets, not a claim about an unconfigured provider's API limits.
export function resolveRequestViewLimits(
	model: ModelWithInputLimits,
	policy: Partial<RequestViewLimits> = {},
): RequestViewLimits {
	const limits = {
		maxRequestBytes: Math.min(
			policy.maxRequestBytes ?? 4 * 1024 * 1024,
			model.inputLimits?.maxRequestBytes ?? Infinity,
		),
		maxImagesPerRequest: Math.min(
			policy.maxImagesPerRequest ?? 8,
			model.inputLimits?.images?.maxPerRequest ?? Infinity,
		),
		maxImagesPerMessage: Math.min(
			policy.maxImagesPerMessage ?? 4,
			model.inputLimits?.images?.maxPerMessage ?? Infinity,
		),
	};
	for (const [key, value] of Object.entries(limits))
		if (!Number.isSafeInteger(value) || value < (key === "maxRequestBytes" ? 1 : 0))
			throw new Error(`Invalid IPD request-view limit: ${key}`);
	return limits;
}

class ProviderRequestAdmissionError extends ProviderRequestRejection {
	readonly code: string;
	readonly observed: number;
	readonly limit: number;

	constructor(code: string, message: string, observed: number, limit: number) {
		super(message);
		this.name = "ProviderRequestAdmissionError";
		this.code = code;
		this.observed = observed;
		this.limit = limit;
	}
}

function imageCount(value: unknown, seen = new Set<object>()): number {
	if (typeof value !== "object" || value === null) return 0;
	if (seen.has(value)) return 0;
	seen.add(value);
	const record = value as Record<string, unknown>;
	const own =
		(typeof record.type === "string" && IMAGE_TYPES.has(record.type)) ||
		"image_url" in record ||
		("inlineData" in record && typeof record.inlineData === "object") ||
		("inline_data" in record && typeof record.inline_data === "object")
			? 1
			: 0;
	const count = own || Object.values(record).reduce<number>((total, item) => total + imageCount(item, seen), 0);
	// Shared objects serialize once per occurrence; only cycles, not repeated references, are excluded.
	seen.delete(value);
	return count;
}

function messageCollections(payload: unknown): unknown[][] {
	if (typeof payload !== "object" || payload === null) return [];
	const record = payload as Record<string, unknown>;
	return [record.messages, record.contents, record.input].filter((value): value is unknown[] => Array.isArray(value));
}

export function inspectProviderRequest(payload: unknown, model: ModelWithInputLimits): ProviderRequestObservation {
	let serialized: string;
	try {
		serialized = JSON.stringify(payload);
	} catch (error) {
		throw new ProviderRequestAdmissionError(
			"request_payload_unserializable",
			`Provider request payload cannot be serialized: ${error instanceof Error ? error.message : String(error)}`,
			0,
			0,
		);
	}
	const serializedBytes = Buffer.byteLength(serialized);
	const images = imageCount(payload);
	const maxImagesInMessage = Math.max(
		0,
		...messageCollections(payload).flatMap((messages) => messages.map((message) => imageCount(message))),
	);
	const maxRequestBytes = model.inputLimits?.maxRequestBytes;
	const maxImagesPerRequest = model.inputLimits?.images?.maxPerRequest;
	const maxImagesPerMessage = model.inputLimits?.images?.maxPerMessage;
	let reasonCode: ProviderRequestObservation["reasonCode"];
	if (maxRequestBytes !== undefined && serializedBytes > maxRequestBytes) reasonCode = "request_bytes_exceeded";
	else if (maxImagesPerRequest !== undefined && images > maxImagesPerRequest) reasonCode = "request_images_exceeded";
	else if (maxImagesPerMessage !== undefined && maxImagesInMessage > maxImagesPerMessage)
		reasonCode = "message_images_exceeded";
	return {
		requestId: randomUUID(),
		provider: model.provider,
		modelId: model.id,
		serializedBytes,
		imageCount: images,
		maxImagesInMessage,
		...(maxRequestBytes === undefined ? {} : { maxRequestBytes }),
		...(maxImagesPerRequest === undefined ? {} : { maxImagesPerRequest }),
		...(maxImagesPerMessage === undefined ? {} : { maxImagesPerMessage }),
		status: reasonCode ? "rejected" : "admitted",
		...(reasonCode ? { reasonCode } : {}),
	};
}

export function createProviderRequestAdmissionExtension(
	model: Model<Api>,
	getRecorder: () => ((observation: ProviderRequestObservation) => Promise<boolean>) | undefined,
	options: { limits?: RequestViewLimits; onRejected?: (observation: ProviderRequestObservation) => void } = {},
): ExtensionFactory {
	const limits = resolveRequestViewLimits(model, options.limits);
	return (pi) => {
		pi.on("before_provider_request", async (event) => {
			const observation = inspectProviderRequest(event.payload, {
				...model,
				inputLimits: {
					maxRequestBytes: limits.maxRequestBytes,
					images: { maxPerRequest: limits.maxImagesPerRequest, maxPerMessage: limits.maxImagesPerMessage },
				},
			});
			const recorder = getRecorder();
			if (recorder && !(await recorder(observation)))
				throw new ProviderRequestAdmissionError(
					"ipd_stale_dispatch",
					"IPD rejected a provider request from a stale execution Attempt.",
					1,
					0,
				);
			if (observation.status === "rejected") {
				options.onRejected?.(observation);
				const byteDescription = `${observation.serializedBytes}${observation.maxRequestBytes ? `/${observation.maxRequestBytes}` : ""} bytes`;
				const imageDescription = `${observation.imageCount}/${limits.maxImagesPerRequest} images`;
				throw new ProviderRequestAdmissionError(
					`ipd_${observation.reasonCode}`,
					`request_too_large: IPD provider request admission rejected the request (${byteDescription}, ${imageDescription}, ${observation.maxImagesInMessage}/${limits.maxImagesPerMessage} images in one message). Compact or otherwise repair the current request view before retrying; unchanged replay is forbidden.`,
					observation.reasonCode === "request_bytes_exceeded"
						? observation.serializedBytes
						: observation.reasonCode === "message_images_exceeded"
							? observation.maxImagesInMessage
							: observation.imageCount,
					observation.reasonCode === "request_bytes_exceeded"
						? (observation.maxRequestBytes ?? 0)
						: observation.reasonCode === "message_images_exceeded"
							? limits.maxImagesPerMessage
							: limits.maxImagesPerRequest,
				);
			}
			return undefined;
		});
	};
}
