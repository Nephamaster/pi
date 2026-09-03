import { open, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { Static } from "typebox";
import { toJsonValue } from "../ir/hash.ts";
import type { IpdDiagnostic, JsonValue } from "../ir/types.ts";
import { type ArtifactViewProvider, ArtifactViewRegistry } from "../registry/artifact-view-registry.ts";
import {
	type ArtifactContract,
	type ArtifactManifest,
	type ArtifactManifestFileSchema,
	validateArtifactManifest,
} from "./manifest.ts";

export type ArtifactManifestFile = Static<typeof ArtifactManifestFileSchema>;

export interface ReviewViewOptions {
	maxTextBytes: number;
	maxImageBytes: number;
}

interface ReviewMaterialBase {
	providerId: string;
	path: string;
	mimeType: string;
	sha256: string;
}

export type ReviewMaterial =
	| (ReviewMaterialBase & { kind: "text"; text: string; truncated: boolean })
	| (ReviewMaterialBase & { kind: "json"; value: JsonValue })
	| (ReviewMaterialBase & { kind: "image"; data: string })
	| (ReviewMaterialBase & { kind: "reference"; reason: string });

export interface ReviewBundle {
	artifactId: string;
	generatedAt: number;
	materials: ReviewMaterial[];
}

export type BuildReviewBundleResult =
	| { ok: true; bundle: ReviewBundle; diagnostics: [] }
	| { ok: false; diagnostics: IpdDiagnostic[] };

async function readPrefix(path: string, maxBytes: number): Promise<{ data: Buffer; truncated: boolean }> {
	const file = await open(path, "r");
	try {
		const buffer = Buffer.alloc(maxBytes + 1);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		return { data: buffer.subarray(0, Math.min(bytesRead, maxBytes)), truncated: bytesRead > maxBytes };
	} finally {
		await file.close();
	}
}

export function createTextViewProvider(): ArtifactViewProvider {
	return {
		id: "builtin-text",
		mimeTypes: ["text/*"],
		async create(file, absolutePath, options) {
			const content = await readPrefix(absolutePath, options.maxTextBytes);
			return {
				kind: "text",
				providerId: "builtin-text",
				path: file.path,
				mimeType: file.mimeType,
				sha256: file.sha256,
				text: content.data.toString("utf8"),
				truncated: content.truncated,
			};
		},
	};
}

export function createJsonViewProvider(): ArtifactViewProvider {
	return {
		id: "builtin-json",
		mimeTypes: ["application/json"],
		async create(file, absolutePath, options) {
			if (file.size > options.maxTextBytes) {
				throw new Error(`JSON review file exceeds ${options.maxTextBytes} bytes: ${file.path}`);
			}
			const value: unknown = JSON.parse(await readFile(absolutePath, "utf8"));
			return {
				kind: "json",
				providerId: "builtin-json",
				path: file.path,
				mimeType: file.mimeType,
				sha256: file.sha256,
				value: toJsonValue(value),
			};
		},
	};
}

export function createImageViewProvider(): ArtifactViewProvider {
	return {
		id: "builtin-image",
		mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
		async create(file, absolutePath, options) {
			if (file.size > options.maxImageBytes) {
				throw new Error(`Image review file exceeds ${options.maxImageBytes} bytes: ${file.path}`);
			}
			return {
				kind: "image",
				providerId: "builtin-image",
				path: file.path,
				mimeType: file.mimeType,
				sha256: file.sha256,
				data: (await readFile(absolutePath)).toString("base64"),
			};
		},
	};
}

export function createDefaultArtifactViewRegistry(): ArtifactViewRegistry {
	const registry = new ArtifactViewRegistry();
	for (const provider of [createJsonViewProvider(), createTextViewProvider(), createImageViewProvider()]) {
		const collision = registry.add(provider);
		if (collision) throw new Error(collision.message);
	}
	return registry;
}

export async function buildReviewBundle(options: {
	workspace: string;
	contract: ArtifactContract;
	manifest: ArtifactManifest;
	registry: ArtifactViewRegistry;
	viewOptions?: Partial<ReviewViewOptions>;
	now?: () => number;
}): Promise<BuildReviewBundleResult> {
	const validation = await validateArtifactManifest({
		workspace: options.workspace,
		contract: options.contract,
		manifest: options.manifest,
	});
	if (!validation.ok) return { ok: false, diagnostics: validation.diagnostics };
	const diagnostics: IpdDiagnostic[] = [];
	const materials: ReviewMaterial[] = [];
	const viewOptions: ReviewViewOptions = {
		maxTextBytes: options.viewOptions?.maxTextBytes ?? 1_000_000,
		maxImageBytes: options.viewOptions?.maxImageBytes ?? 10_000_000,
	};
	for (const [index, file] of options.manifest.files.entries()) {
		const provider = options.registry.resolve(file.mimeType);
		if (!provider) {
			materials.push({
				kind: "reference",
				providerId: "none",
				path: file.path,
				mimeType: file.mimeType,
				sha256: file.sha256,
				reason: "No registered Artifact View Provider can render this file",
			});
			continue;
		}
		try {
			const absolutePath = await realpath(resolve(options.workspace, file.path));
			const material = await provider.create(file, absolutePath, viewOptions);
			materials.push(material);
		} catch (error) {
			diagnostics.push({
				code: "artifact_view_failed",
				path: `/files/${index}`,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (diagnostics.length > 0) return { ok: false, diagnostics };
	return {
		ok: true,
		bundle: {
			artifactId: options.manifest.id,
			generatedAt: (options.now ?? Date.now)(),
			materials,
		},
		diagnostics: [],
	};
}
