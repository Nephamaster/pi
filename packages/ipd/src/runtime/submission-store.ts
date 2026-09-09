import { copyFile, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SubmitArtifact } from "../adapter/structured-submissions.ts";
import { createArtifactManifest, validateArtifactManifest } from "../artifact/manifest.ts";
import type { SubmissionRecord } from "../contracts/runtime.ts";
import type { ExecutionNode } from "../contracts/workflow.ts";
import { hashJson, toJsonValue } from "../ir/hash.ts";
import { normalizeScope, scopeContains } from "../ir/scopes.ts";
import type { RunDirectory } from "./run-directory.ts";

export interface SealSubmissionInput {
	run: RunDirectory;
	runId: string;
	node: ExecutionNode;
	roundId: string;
	submissionId: string;
	inputSubmissionIds: string[];
	submission: SubmitArtifact;
}

export class SubmissionValidationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SubmissionValidationError";
	}
}

export class SubmissionStore {
	async seal(input: SealSubmissionInput): Promise<SubmissionRecord> {
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input.submissionId))
			throw new SubmissionValidationError("Invalid Submission ID");
		const contentHash = hashJson({
			runId: input.runId,
			nodeId: input.node.node_id,
			roundId: input.roundId,
			inputSubmissionIds: input.inputSubmissionIds,
			submission: input.submission,
		});
		const target = join(input.run.submissions, input.submissionId);
		try {
			const existing = JSON.parse(await readFile(join(target, "submission.json"), "utf8")) as SubmissionRecord;
			if (existing.contentHash !== contentHash) throw new Error(`Submission ID conflict: ${input.submissionId}`);
			return existing;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const definitions = new Map(input.node.outputs.map((output) => [output.output_id, output]));
		if (input.submission.outputs.length !== definitions.size)
			throw new SubmissionValidationError("Submission must provide every declared output exactly once");
		const staging = join(input.run.submissions, `.${input.submissionId}.${process.pid}.${Date.now()}.tmp`);
		await mkdir(staging, { recursive: false });
		try {
			const outputs: SubmissionRecord["outputs"] = [];
			const seenOutputs = new Set<string>();
			for (const submitted of input.submission.outputs) {
				const definition = definitions.get(submitted.output_id);
				if (!definition || seenOutputs.has(submitted.output_id))
					throw new SubmissionValidationError(`Invalid output submission: ${submitted.output_id}`);
				seenOutputs.add(submitted.output_id);
				const outputRoot = normalizeScope(definition.path_prefix);
				if (!outputRoot) throw new SubmissionValidationError(`Invalid output path: ${definition.path_prefix}`);
				const realOutputRoot = await realpath(resolve(input.run.workspace, outputRoot));
				for (const file of submitted.files) {
					const path = normalizeScope(file.path);
					if (!path || !scopeContains(outputRoot, path))
						throw new SubmissionValidationError(`File ${file.path} is outside output ${definition.output_id}`);
					const realFile = await realpath(resolve(input.run.workspace, path));
					const relativeFile = relative(realOutputRoot, realFile);
					if (relativeFile.startsWith("..") || isAbsolute(relativeFile))
						throw new SubmissionValidationError(
							`File ${file.path} resolves outside output ${definition.output_id}`,
						);
				}
				const manifest = await createArtifactManifest({
					workspace: input.run.workspace,
					contract: {
						id: definition.output_id,
						artifactType: definition.artifact_type,
						description: definition.description,
						businessPurpose: definition.business_purpose,
					},
					submission: {
						id: `${input.submissionId}:${definition.output_id}`,
						runId: input.runId,
						nodeId: input.node.node_id,
						attemptId: input.roundId,
						contractId: definition.output_id,
						createdAt: Date.now(),
						inputs: input.inputSubmissionIds,
						files: submitted.files.map((file) => ({ path: file.path, mimeType: file.media_type })),
						metadata: { summary: input.submission.summary },
					},
				});
				for (const file of manifest.files) {
					const destination = resolve(staging, file.path);
					await mkdir(dirname(destination), { recursive: true });
					await copyFile(resolve(input.run.workspace, file.path), destination);
				}
				const validation = await validateArtifactManifest({
					workspace: staging,
					contract: {
						id: definition.output_id,
						artifactType: definition.artifact_type,
						description: definition.description,
						businessPurpose: definition.business_purpose,
					},
					manifest,
				});
				if (!validation.ok) throw new Error(`Submission changed while being sealed: ${definition.output_id}`);
				outputs.push({ outputId: definition.output_id, sealedRoot: target, manifest });
			}
			const record: SubmissionRecord = {
				submissionId: input.submissionId,
				contentHash,
				nodeId: input.node.node_id,
				roundId: input.roundId,
				status: "candidate",
				inputSubmissionIds: [...input.inputSubmissionIds],
				outputs,
				evidence: toJsonValue(input.submission.evidence),
				createdAt: Date.now(),
			};
			await writeFile(join(staging, "submission.json"), `${JSON.stringify(record, null, "\t")}\n`, "utf8");
			await rename(staging, target);
			return record;
		} catch (error) {
			await rm(staging, { recursive: true, force: true });
			throw error;
		}
	}
}
