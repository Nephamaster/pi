import { open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import Type, { type Static } from "typebox";
import {
	type ArtifactContractSchema,
	IdentifierSchema,
	JsonValueSchema,
	NonEmptyStringSchema,
	OpaqueIdSchema,
} from "../ir/schemas.ts";
import { normalizeScope } from "../ir/scopes.ts";
import type { IpdDiagnostic, JsonValue } from "../ir/types.ts";
import { validateSchema } from "../ir/validation.ts";
import { hashFile } from "./hash-file.ts";

const ArtifactSubmissionFileSchema = Type.Object(
	{
		path: NonEmptyStringSchema,
		mimeType: NonEmptyStringSchema,
	},
	{ additionalProperties: false },
);

export const ArtifactSubmissionSchema = Type.Object(
	{
		id: OpaqueIdSchema,
		runId: OpaqueIdSchema,
		nodeId: IdentifierSchema,
		attemptId: OpaqueIdSchema,
		contractId: IdentifierSchema,
		createdAt: Type.Integer({ minimum: 0 }),
		inputs: Type.Array(OpaqueIdSchema, { uniqueItems: true }),
		files: Type.Array(ArtifactSubmissionFileSchema, { minItems: 1 }),
		metadata: JsonValueSchema,
	},
	{ additionalProperties: false },
);

export type ArtifactSubmission = Static<typeof ArtifactSubmissionSchema>;

export const ArtifactManifestFileSchema = Type.Object(
	{
		path: NonEmptyStringSchema,
		mimeType: NonEmptyStringSchema,
		sha256: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
		size: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

export const ArtifactManifestSchema = Type.Object(
	{
		id: OpaqueIdSchema,
		runId: OpaqueIdSchema,
		nodeId: IdentifierSchema,
		attemptId: OpaqueIdSchema,
		contractId: IdentifierSchema,
		createdAt: Type.Integer({ minimum: 0 }),
		inputs: Type.Array(OpaqueIdSchema, { uniqueItems: true }),
		files: Type.Array(ArtifactManifestFileSchema, { minItems: 1 }),
		metadata: JsonValueSchema,
	},
	{ additionalProperties: false },
);

export type ArtifactManifest = Static<typeof ArtifactManifestSchema>;
export type ArtifactContract = Static<typeof ArtifactContractSchema>;

export interface ArtifactValidationResult {
	ok: boolean;
	diagnostics: IpdDiagnostic[];
}

export class ArtifactValidationError extends Error {
	readonly diagnostics: IpdDiagnostic[];

	constructor(message: string, diagnostics: IpdDiagnostic[]) {
		super(message);
		this.name = "ArtifactValidationError";
		this.diagnostics = diagnostics;
	}
}

interface ResolvedArtifactPath {
	normalizedPath: string;
	absolutePath: string;
}

async function validateFileContent(path: string, mimeType: string, diagnosticPath: string): Promise<IpdDiagnostic[]> {
	if (mimeType === "application/json" || mimeType.endsWith("+json")) {
		try {
			JSON.parse(await readFile(path, "utf8"));
			return [];
		} catch (error) {
			return [
				{
					code: "artifact_content_invalid",
					path: diagnosticPath,
					message: `File declared as ${mimeType} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
				},
			];
		}
	}
	if (mimeType.startsWith("text/")) {
		const file = await open(path, "r");
		try {
			const buffer = Buffer.alloc(65_536);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			const content = buffer.subarray(0, bytesRead);
			if (content.includes(0)) {
				return [
					{
						code: "artifact_content_invalid",
						path: diagnosticPath,
						message: `File declared as ${mimeType} contains binary NUL bytes`,
					},
				];
			}
			try {
				new TextDecoder("utf-8", { fatal: true }).decode(content);
				return [];
			} catch {
				return [
					{
						code: "artifact_content_invalid",
						path: diagnosticPath,
						message: `File declared as ${mimeType} is not valid UTF-8 text`,
					},
				];
			}
		} finally {
			await file.close();
		}
	}
	if (mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
		const file = await open(path, "r");
		try {
			const header = Buffer.alloc(4);
			const { bytesRead } = await file.read(header, 0, header.length, 0);
			return bytesRead === 4 && header[0] === 0x50 && header[1] === 0x4b
				? []
				: [
						{
							code: "artifact_content_invalid",
							path: diagnosticPath,
							message: "File declared as PPTX is not an OOXML ZIP package",
						},
					];
		} finally {
			await file.close();
		}
	}
	return [];
}

async function resolveArtifactPath(
	workspace: string,
	path: string,
	diagnosticPath: string,
): Promise<{ value?: ResolvedArtifactPath; diagnostics: IpdDiagnostic[] }> {
	const normalizedPath = normalizeScope(path);
	if (normalizedPath === undefined || normalizedPath === "." || isAbsolute(path)) {
		return {
			diagnostics: [
				{
					code: "artifact_path_invalid",
					path: diagnosticPath,
					message: `Artifact path must be a relative file path: ${path}`,
				},
			],
		};
	}
	let workspaceRealPath: string;
	let fileRealPath: string;
	try {
		workspaceRealPath = await realpath(workspace);
		fileRealPath = await realpath(resolve(workspaceRealPath, normalizedPath));
	} catch (error) {
		return {
			diagnostics: [
				{
					code: "artifact_missing",
					path: diagnosticPath,
					message: error instanceof Error ? error.message : String(error),
				},
			],
		};
	}
	const relativePath = relative(workspaceRealPath, fileRealPath);
	if (
		relativePath === ".." ||
		relativePath.startsWith("../") ||
		relativePath.startsWith("..\\") ||
		isAbsolute(relativePath)
	) {
		return {
			diagnostics: [
				{
					code: "artifact_path_invalid",
					path: diagnosticPath,
					message: `Artifact resolves outside the workspace: ${path}`,
				},
			],
		};
	}
	return { value: { normalizedPath, absolutePath: fileRealPath }, diagnostics: [] };
}

export async function createArtifactManifest(options: {
	workspace: string;
	contract: ArtifactContract;
	submission: ArtifactSubmission;
}): Promise<ArtifactManifest> {
	const parsed = validateSchema<ArtifactSubmission>(ArtifactSubmissionSchema, options.submission);
	if (!parsed.ok) throw new ArtifactValidationError("Invalid Artifact submission", parsed.diagnostics);
	const diagnostics: IpdDiagnostic[] = [];
	if (parsed.value.contractId !== options.contract.id) {
		diagnostics.push({
			code: "artifact_type_invalid",
			path: "/contractId",
			message: `Artifact Contract mismatch: expected ${options.contract.id}, received ${parsed.value.contractId}`,
		});
	}
	const seenPaths = new Set<string>();
	const files: ArtifactManifest["files"] = [];
	for (const [index, file] of parsed.value.files.entries()) {
		const resolved = await resolveArtifactPath(options.workspace, file.path, `/files/${index}/path`);
		diagnostics.push(...resolved.diagnostics);
		if (!resolved.value) continue;
		if (seenPaths.has(resolved.value.normalizedPath)) {
			diagnostics.push({
				code: "duplicate_id",
				path: `/files/${index}/path`,
				message: `Artifact file path is duplicated: ${resolved.value.normalizedPath}`,
			});
			continue;
		}
		seenPaths.add(resolved.value.normalizedPath);
		const fileStat = await stat(resolved.value.absolutePath);
		if (!fileStat.isFile()) {
			diagnostics.push({
				code: "artifact_type_invalid",
				path: `/files/${index}/path`,
				message: `Artifact path is not a regular file: ${file.path}`,
			});
			continue;
		}
		diagnostics.push(
			...(await validateFileContent(resolved.value.absolutePath, file.mimeType, `/files/${index}/mimeType`)),
		);
		files.push({
			path: resolved.value.normalizedPath,
			mimeType: file.mimeType,
			sha256: await hashFile(resolved.value.absolutePath),
			size: fileStat.size,
		});
	}
	if (diagnostics.length > 0) throw new ArtifactValidationError("Artifact submission failed validation", diagnostics);
	return { ...parsed.value, files };
}

export async function validateArtifactManifest(options: {
	workspace: string;
	contract: ArtifactContract;
	manifest: unknown;
}): Promise<ArtifactValidationResult> {
	const parsed = validateSchema<ArtifactManifest>(ArtifactManifestSchema, options.manifest);
	if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
	const diagnostics: IpdDiagnostic[] = [];
	if (parsed.value.contractId !== options.contract.id) {
		diagnostics.push({
			code: "artifact_type_invalid",
			path: "/contractId",
			message: `Artifact Contract mismatch: expected ${options.contract.id}, received ${parsed.value.contractId}`,
		});
	}
	const seenPaths = new Set<string>();
	for (const [index, file] of parsed.value.files.entries()) {
		const resolved = await resolveArtifactPath(options.workspace, file.path, `/files/${index}/path`);
		diagnostics.push(...resolved.diagnostics);
		if (!resolved.value) continue;
		if (resolved.value.normalizedPath !== file.path) {
			diagnostics.push({
				code: "artifact_path_invalid",
				path: `/files/${index}/path`,
				message: `Artifact Manifest path is not normalized: ${file.path}`,
			});
		}
		if (seenPaths.has(resolved.value.normalizedPath)) {
			diagnostics.push({
				code: "duplicate_id",
				path: `/files/${index}/path`,
				message: `Artifact file path is duplicated: ${file.path}`,
			});
			continue;
		}
		seenPaths.add(resolved.value.normalizedPath);
		const fileStat = await stat(resolved.value.absolutePath);
		if (!fileStat.isFile()) {
			diagnostics.push({
				code: "artifact_type_invalid",
				path: `/files/${index}/path`,
				message: `Artifact path is not a regular file: ${file.path}`,
			});
			continue;
		}
		diagnostics.push(
			...(await validateFileContent(resolved.value.absolutePath, file.mimeType, `/files/${index}/mimeType`)),
		);
		if (fileStat.size !== file.size) {
			diagnostics.push({
				code: "artifact_size_mismatch",
				path: `/files/${index}/size`,
				message: `Artifact size changed from ${file.size} to ${fileStat.size}: ${file.path}`,
			});
		}
		const currentHash = await hashFile(resolved.value.absolutePath);
		if (currentHash !== file.sha256) {
			diagnostics.push({
				code: "artifact_hash_mismatch",
				path: `/files/${index}/sha256`,
				message: `Artifact content Hash changed: ${file.path}`,
			});
		}
	}
	return { ok: diagnostics.length === 0, diagnostics };
}

export function artifactManifestToJson(manifest: ArtifactManifest): JsonValue {
	return JSON.parse(JSON.stringify(manifest)) as JsonValue;
}
