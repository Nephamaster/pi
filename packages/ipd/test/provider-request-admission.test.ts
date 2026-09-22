import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { BeforeProviderRequestEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRequestViewLimits } from "../src/adapter/provider-request-admission.ts";
import {
	createProviderRequestAdmissionExtension,
	inspectProviderRequest,
	type ProviderRequestObservation,
} from "../src/index.ts";

const registrations: Array<ReturnType<typeof registerFauxProvider>> = [];

function limitedModel() {
	const registration = registerFauxProvider();
	registrations.push(registration);
	return {
		...registration.getModel(),
		inputLimits: {
			maxRequestBytes: 256,
			images: { maxPerMessage: 1, maxPerRequest: 1 },
		},
	};
}

describe("provider request admission", () => {
	afterEach(() => {
		for (const registration of registrations.splice(0)) registration.unregister();
	});
	it("uses explicit local budgets without provider metadata and never exceeds declared API limits", () => {
		const model = limitedModel();
		expect(resolveRequestViewLimits({ ...model, inputLimits: undefined })).toEqual({
			maxRequestBytes: 4 * 1024 * 1024,
			maxImagesPerRequest: 8,
			maxImagesPerMessage: 4,
		});
		expect(resolveRequestViewLimits(model, { maxRequestBytes: 2048, maxImagesPerRequest: 20 })).toEqual({
			maxRequestBytes: 256,
			maxImagesPerRequest: 1,
			maxImagesPerMessage: 1,
		});
		expect(() => resolveRequestViewLimits(model, { maxRequestBytes: 0 })).toThrow("Invalid IPD");
	});

	it("counts provider image wrappers once and detects a merged message limit", () => {
		const model = { ...limitedModel(), inputLimits: { images: { maxPerRequest: 8, maxPerMessage: 1 } } };
		const result = inspectProviderRequest(
			{
				messages: [
					{
						role: "user",
						content: [
							{ type: "image_url", image_url: { type: "image", url: "data:image/png;base64,AA==" } },
							{ type: "image", source: { type: "base64", data: "AA==" } },
						],
					},
				],
			},
			model,
		);
		expect(result).toMatchObject({ imageCount: 2, maxImagesInMessage: 2, reasonCode: "message_images_exceeded" });
	});

	it("counts repeated image object references as separate wire occurrences", () => {
		const image = { type: "image", source: { type: "base64", data: "AA==" } };
		expect(
			inspectProviderRequest({ messages: [{ role: "user", content: [image, image] }] }, limitedModel()),
		).toMatchObject({ imageCount: 2, maxImagesInMessage: 2 });
	});
	it("measures the serialized provider body and image totals", () => {
		const payload = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "inspect" },
						{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
					],
				},
			],
		};
		const result = inspectProviderRequest(payload, limitedModel());
		expect(result).toMatchObject({
			serializedBytes: Buffer.byteLength(JSON.stringify(payload)),
			imageCount: 1,
			maxImagesInMessage: 1,
			status: "admitted",
		});
	});

	it("records and rejects an oversized request before provider I/O", async () => {
		let handler: ((event: BeforeProviderRequestEvent) => Promise<unknown>) | undefined;
		const observations: ProviderRequestObservation[] = [];
		const recorder = vi.fn(async (observation: ProviderRequestObservation) => {
			observations.push(observation);
			return true;
		});
		await createProviderRequestAdmissionExtension(
			limitedModel(),
			() => recorder,
		)({
			on(name: string, callback: (event: BeforeProviderRequestEvent) => Promise<unknown>) {
				expect(name).toBe("before_provider_request");
				handler = callback;
			},
		} as unknown as ExtensionAPI);
		const payload = { messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(512) }] }] };

		await expect(handler?.({ type: "before_provider_request", payload })).rejects.toMatchObject({
			name: "ProviderRequestAdmissionError",
			code: "ipd_request_bytes_exceeded",
		});
		expect(recorder).toHaveBeenCalledOnce();
		expect(observations[0]).toMatchObject({ status: "rejected", reasonCode: "request_bytes_exceeded" });
	});
});
