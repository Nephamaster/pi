// 从共享工作区校验并封存不可混淆的提交版本。
import { copyFile, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SubmitArtifact } from "../adapter/structured-submissions.ts";
import { createArtifactManifest, validateArtifactManifest } from "../artifact/manifest.ts";
import type { SubmissionOutputRecord, SubmissionRecord } from "../contracts/runtime.ts";
import type { ExecutionNode } from "../contracts/workflow.ts";
import { hashJson, toJsonValue } from "../ir/hash.ts";
import { normalizeScope, scopeContains } from "../ir/scopes.ts";
import { syncDirectory, syncTree } from "./durable-file.ts";
import type { RunDirectory } from "./run-directory.ts";

export interface SealSubmissionInput {
	run: RunDirectory;
	runId: string;
	node: ExecutionNode;
	roundId: string;
	attemptId: string;
	submissionId: string;
	inputSubmissionIds: string[];
	submission: SubmitArtifact;
	sourceWorkspace?: string;
	signal?: AbortSignal;
	preservedOutputs?: SubmissionOutputRecord[];
}

export class SubmissionValidationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SubmissionValidationError";
	}
}

export class SubmissionStore {
	async seal(input: SealSubmissionInput): Promise<SubmissionRecord> {
		input.signal?.throwIfAborted();
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input.submissionId))
			throw new SubmissionValidationError("Invalid Submission ID");
		const contentHash = hashJson({
			runId: input.runId,
			nodeId: input.node.node_id,
			roundId: input.roundId,
			attemptId: input.attemptId,
			inputSubmissionIds: input.inputSubmissionIds,
			submission: input.submission,
		});
		const target = join(input.run.submissions, input.submissionId);
		let existing: SubmissionRecord | undefined;
		try {
			existing = JSON.parse(await readFile(join(target, "submission.json"), "utf8")) as SubmissionRecord;
			if (existing.contentHash !== contentHash) throw new Error(`Submission ID conflict: ${input.submissionId}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const sourceWorkspace = input.sourceWorkspace ?? input.run.workspace;
		const definitions = new Map(input.node.outputs.map((output) => [output.output_id, output]));
		if (input.submission.outputs.length + (input.submission.preserved_outputs?.length ?? 0) !== definitions.size)
			throw new SubmissionValidationError("Submission must provide every declared output exactly once");
		const staging = join(input.run.submissions, `.${input.submissionId}.${process.pid}.${Date.now()}.tmp`);
		await mkdir(staging, { recursive: false });
		try {
			const outputs: SubmissionRecord["outputs"] = [];
			const seenOutputs = new Set<string>();
			for (const submitted of input.submission.outputs) {
				input.signal?.throwIfAborted();
				const definition = definitions.get(submitted.output_id);
				if (!definition || seenOutputs.has(submitted.output_id))
					throw new SubmissionValidationError(`Invalid output submission: ${submitted.output_id}`);
				seenOutputs.add(submitted.output_id);
				const outputSummary =
					submitted.summary ?? (definitions.size === 1 ? input.submission.summary : definition.description);
				const outputRoot = normalizeScope(definition.path_prefix);
				if (!outputRoot) throw new SubmissionValidationError(`Invalid output path: ${definition.path_prefix}`);
				const realOutputRoot = await realpath(resolve(sourceWorkspace, outputRoot));
				const sealedOutputStaging = join(staging, definition.output_id);
				await mkdir(sealedOutputStaging, { recursive: false });
				for (const file of submitted.files) {
					const path = normalizeScope(file.path);
					if (!path || !scopeContains(outputRoot, path))
						throw new SubmissionValidationError(`File ${file.path} is outside output ${definition.output_id}`);
					const realFile = await realpath(resolve(sourceWorkspace, path));
					const relativeFile = relative(realOutputRoot, realFile);
					if (relativeFile.startsWith("..") || isAbsolute(relativeFile))
						throw new SubmissionValidationError(
							`File ${file.path} resolves outside output ${definition.output_id}`,
						);
				}
				const manifest = await createArtifactManifest({
					workspace: sourceWorkspace,
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
						attemptId: input.attemptId,
						contractId: definition.output_id,
						createdAt: Date.now(),
						inputs: input.inputSubmissionIds,
						files: submitted.files.map((file) => ({ path: file.path, mimeType: file.media_type })),
						metadata: { summary: outputSummary },
					},
				});
				for (const file of manifest.files) {
					input.signal?.throwIfAborted();
					const destination = resolve(sealedOutputStaging, file.path);
					await mkdir(dirname(destination), { recursive: true });
					await copyFile(resolve(sourceWorkspace, file.path), destination);
					input.signal?.throwIfAborted();
				}
				const validation = await validateArtifactManifest({
					workspace: sealedOutputStaging,
					contract: {
						id: definition.output_id,
						artifactType: definition.artifact_type,
						description: definition.description,
						businessPurpose: definition.business_purpose,
					},
					manifest,
				});
				if (!validation.ok) throw new Error(`Submission changed while being sealed: ${definition.output_id}`);
				outputs.push({
					outputId: definition.output_id,
					sealedRoot: join(target, definition.output_id),
					manifest,
					revisionId: `${input.submissionId}:output:${definition.output_id}`,
					manifestHash: hashJson(manifest),
					contractHash: hashJson(definition),
					handoff: {
						outputId: definition.output_id,
						purpose: definition.business_purpose,
						keyResult: outputSummary,
						requirementRefs: [...(input.node.contract.requirement_refs ?? [])],
						decisionRefs: [...(input.node.contract.decision_refs ?? [])],
						limitations: [
							...(submitted.limitations ?? (definitions.size === 1 ? (input.submission.limitations ?? []) : [])),
						],
						navigation: manifest.files.map((file) => file.path),
						provenance: "producer_authored_summary",
					},
				});
			}
			for (const output of outputs) {
				const definition = definitions.get(output.outputId)!;
				const sourceValidation = await validateArtifactManifest({
					workspace: sourceWorkspace,
					contract: {
						id: definition.output_id,
						artifactType: definition.artifact_type,
						description: definition.description,
						businessPurpose: definition.business_purpose,
					},
					manifest: output.manifest,
				});
				if (!sourceValidation.ok)
					throw new SubmissionValidationError(
						`Submission source changed before the complete candidate was frozen: ${output.outputId}`,
					);
			}
			for (const preserved of input.preservedOutputs ?? []) {
				if (!definitions.has(preserved.outputId) || seenOutputs.has(preserved.outputId) || !preserved.preservedFrom)
					throw new SubmissionValidationError(`Invalid preserved output: ${preserved.outputId}`);
				seenOutputs.add(preserved.outputId);
				const destinationRoot = join(staging, preserved.outputId);
				for (const file of preserved.manifest.files) {
					const destination = resolve(destinationRoot, file.path);
					await mkdir(dirname(destination), { recursive: true });
					await copyFile(resolve(preserved.sealedRoot, file.path), destination);
				}
				const definition = definitions.get(preserved.outputId)!;
				const verified = await validateArtifactManifest({
					workspace: destinationRoot,
					contract: {
						id: definition.output_id,
						artifactType: definition.artifact_type,
						description: definition.description,
						businessPurpose: definition.business_purpose,
					},
					manifest: preserved.manifest,
				});
				if (!verified.ok) throw new SubmissionValidationError(`Preserved output changed: ${preserved.outputId}`);
				outputs.push({ ...structuredClone(preserved), sealedRoot: join(target, preserved.outputId) });
			}
			if (seenOutputs.size !== definitions.size)
				throw new SubmissionValidationError(
					"Every declared output must be changed or validly preserved exactly once",
				);
			const record: SubmissionRecord = {
				submissionId: input.submissionId,
				contentHash,
				nodeId: input.node.node_id,
				roundId: input.roundId,
				attemptId: input.attemptId,
				status: "candidate",
				inputSubmissionIds: [...input.inputSubmissionIds],
				outputs,
				evidence: toJsonValue(input.submission.evidence),
				createdAt: Date.now(),
				resolutionClaims: input.submission.resolution_claims?.map((claim) => ({
					findingId: claim.finding_id,
					outputId: claim.output_id,
					explanation: claim.explanation,
					evidence: [...claim.evidence],
				})),
			};
			await writeFile(join(staging, "submission.json"), `${JSON.stringify(record, null, "\t")}\n`, "utf8");
			for (const output of record.outputs) {
				const scopedRecord: SubmissionRecord = {
					...record,
					outputs: [output],
					resolutionClaims: record.resolutionClaims?.filter((claim) => claim.outputId === output.outputId),
					evidence: toJsonValue(
						input.submission.evidence.filter(
							(item) =>
								item.output_id === output.outputId ||
								(record.outputs.length === 1 && item.output_id === undefined),
						),
					),
				};
				await writeFile(
					join(staging, output.outputId, "submission.json"),
					`${JSON.stringify(scopedRecord, null, "\t")}\n`,
					"utf8",
				);
			}
			input.signal?.throwIfAborted();
			if (existing) {
				const fileIdentity = (value: SubmissionRecord) =>
					value.outputs.map((output) => ({ outputId: output.outputId, files: output.manifest.files }));
				if (hashJson(fileIdentity(existing)) !== hashJson(fileIdentity(record)))
					throw new SubmissionValidationError(
						`Submission ID conflict: ${input.submissionId} has different file bytes`,
					);
				await rm(staging, { recursive: true, force: true });
				return existing;
			}
			await syncTree(staging);
			await rename(staging, target);
			await syncDirectory(input.run.submissions);
			return record;
		} catch (error) {
			await rm(staging, { recursive: true, force: true });
			throw error;
		}
	}
}
