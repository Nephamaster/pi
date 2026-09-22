// Seal Reviewer-owned verification files separately from the immutable subjects under review.
import { copyFile, mkdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SubmitReview } from "../adapter/structured-submissions.ts";
import { hashFile } from "../artifact/hash-file.ts";
import { hashJson } from "../ir/hash.ts";
import { normalizeScope, scopeContains } from "../ir/scopes.ts";
import { syncDirectory, syncTree } from "./durable-file.ts";
import type { NodeRoundWork, NodeWorker } from "./node-worker.ts";
import type { RunDirectory } from "./run-directory.ts";
import { SubmissionValidationError } from "./submission-store.ts";

export async function sealReviewEvidence(
	directory: RunDirectory,
	worker: NodeWorker,
	work: NodeRoundWork,
	report: SubmitReview,
): Promise<Map<string, { rawRef: string; rawDigest: string }>> {
	const paths = [
		...new Set(
			report.criteria.flatMap((criterion) =>
				criterion.evidence.flatMap((evidence) => (evidence.verification_path ? [evidence.verification_path] : [])),
			),
		),
	];
	const records = new Map<string, { rawRef: string; rawDigest: string }>();
	if (!paths.length) return records;
	for (const path of paths)
		if (normalizeScope(path) !== path || !scopeContains("outputs/review-evidence", path))
			throw new SubmissionValidationError(`Reviewer evidence path is outside its export boundary: ${path}`);
	if (!worker.exportReviewEvidence)
		throw new SubmissionValidationError("The execution adapter does not support Reviewer evidence export");
	const source = await worker.exportReviewEvidence(work, paths, work.signal);
	const parent = join(directory.root, "evidence");
	const target = join(parent, `${work.stamp.attemptId}-${hashJson(report).slice(0, 16)}`);
	const staging = `${target}.tmp`;
	try {
		await mkdir(staging, { recursive: true });
		const sourceRoot = await realpath(source);
		for (const path of paths) {
			work.signal?.throwIfAborted();
			const origin = await realpath(resolve(sourceRoot, path));
			const child = relative(sourceRoot, origin);
			if (child.startsWith("..") || isAbsolute(child))
				throw new SubmissionValidationError("Reviewer evidence escapes its exported snapshot");
			const destination = resolve(staging, path);
			await mkdir(dirname(destination), { recursive: true });
			const digest = await hashFile(origin);
			await copyFile(origin, destination);
			if ((await hashFile(destination)) !== digest)
				throw new SubmissionValidationError("Reviewer evidence changed during sealing");
			records.set(path, { rawRef: relative(directory.root, join(target, path)), rawDigest: digest });
		}
		await syncTree(staging);
		try {
			await rename(staging, target);
		} catch (error) {
			if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			for (const [path, record] of records)
				if ((await hashFile(join(target, path))) !== record.rawDigest)
					throw new Error("Immutable Reviewer evidence identity conflict");
			await rm(staging, { recursive: true, force: true });
		}
		await syncDirectory(parent);
		return records;
	} finally {
		await rm(source, { recursive: true, force: true });
		await rm(staging, { recursive: true, force: true });
	}
}
