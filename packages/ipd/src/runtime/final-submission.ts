// 把已完整批准的交付输出投影到最终交付目录。
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { hashFile } from "../artifact/hash-file.ts";
import type {
	CompletionBasis,
	FinalSubmissionFileRecord,
	FinalSubmissionRecord,
	RunState,
} from "../contracts/runtime.ts";
import { hashJson } from "../ir/hash.ts";
import { normalizeScope } from "../ir/scopes.ts";
import { syncDirectory, syncTree } from "./durable-file.ts";
import type { RunDirectory } from "./run-directory.ts";
import { approvedSubmissionForOutput, requireBaseline, runIsComplete } from "./runtime-state.ts";

function deliveryPath(outputRoot: string, sourcePath: string): string {
	const relativePath = relative(outputRoot, sourcePath).replaceAll("\\", "/");
	const normalized = normalizeScope(relativePath);
	if (!normalized || normalized === "." || isAbsolute(relativePath))
		throw new Error(`Final delivery file is outside its output root: ${sourcePath}`);
	return normalized;
}

export async function materializeFinalSubmission(
	directory: RunDirectory,
	state: RunState,
	finalizationId: string,
	basis: CompletionBasis,
	signal?: AbortSignal,
): Promise<FinalSubmissionRecord> {
	const baseline = requireBaseline(state);
	if (baseline.baselineId !== basis.baselineId) throw new Error("Final delivery Baseline changed");
	if (!completionBasisMatchesState(state, basis)) throw new Error("Final delivery basis is no longer current");
	const target = join(directory.finalSubmissions, finalizationId);
	const staging = join(directory.finalSubmissions, `.${finalizationId}.${process.pid}.${Date.now()}.tmp`);
	const files: FinalSubmissionFileRecord[] = [];
	const destinations = new Set<string>();
	await mkdir(staging, { recursive: false });
	try {
		for (const ref of basis.deliveryBindings) {
			signal?.throwIfAborted();
			const submission = state.submissions.find((item) => item.submissionId === ref.submissionId);
			if (!submission) throw new Error(`Delivery Submission is unavailable: ${ref.submissionId}`);
			const output = submission.outputs.find((item) => item.outputId === ref.outputId);
			const node = baseline.workflow.nodes.find((item) => item.node_id === ref.nodeId);
			const definition =
				node?.kind === "execution" ? node.outputs.find((item) => item.output_id === ref.outputId) : undefined;
			if (!output || !definition) throw new Error(`Delivery output is missing: ${ref.nodeId}:${ref.outputId}`);
			if (hashJson(output.manifest) !== ref.manifestHash)
				throw new Error(`Delivery output Manifest changed: ${ref.nodeId}:${ref.outputId}`);
			for (const file of output.manifest.files) {
				signal?.throwIfAborted();
				const path = deliveryPath(definition.path_prefix, file.path);
				if (destinations.has(path)) throw new Error(`Final delivery path collision: ${path}`);
				destinations.add(path);
				const source = resolve(output.sealedRoot, file.path);
				const destination = resolve(staging, path);
				await mkdir(dirname(destination), { recursive: true });
				await copyFile(source, destination);
				signal?.throwIfAborted();
				if ((await hashFile(destination)) !== file.sha256)
					throw new Error(`Final delivery file failed integrity validation: ${file.path}`);
				files.push({
					path,
					mimeType: file.mimeType,
					sha256: file.sha256,
					size: file.size,
					submissionId: submission.submissionId,
					nodeId: ref.nodeId,
					outputId: ref.outputId,
					sourcePath: file.path,
				});
			}
		}
		signal?.throwIfAborted();
		await syncTree(staging);
		try {
			await rename(staging, target);
			await syncDirectory(directory.finalSubmissions);
		} catch (error) {
			if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			await rm(staging, { recursive: true, force: true });
			for (const file of files)
				if ((await hashFile(resolve(target, file.path))) !== file.sha256)
					throw new Error(`Existing final delivery version is corrupt: ${file.path}`);
		}
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
	return {
		finalizationId,
		basisHash: hashJson(basis),
		directory: target,
		files,
		createdAt: Date.now(),
	};
}

export function completionBasisForState(state: RunState): CompletionBasis | undefined {
	if (!runIsComplete(state)) return undefined;
	const baseline = requireBaseline(state);
	const completion = baseline.workflow.completion;
	const deliveryBindings = completion.delivery_outputs.flatMap((ref) => {
		const submission = approvedSubmissionForOutput(state, ref, completion.required_review_node_ids);
		const output = submission?.outputs.find((item) => item.outputId === ref.output_id);
		if (!submission || !output) return [];
		const approvalIds = state.approvals
			.filter(
				(approval) =>
					approval.status === "active" &&
					approval.submissionId === submission.submissionId &&
					approval.outputId === ref.output_id &&
					completion.required_review_node_ids.includes(approval.reviewNodeId),
			)
			.map((approval) => approval.approvalId)
			.sort();
		return [
			{
				nodeId: ref.node_id,
				outputId: ref.output_id,
				submissionId: submission.submissionId,
				manifestHash: hashJson(output.manifest),
				approvalIds,
			},
		];
	});
	if (deliveryBindings.length !== completion.delivery_outputs.length) return undefined;
	return {
		baselineId: baseline.baselineId,
		runGeneration: state.generation ?? 0,
		deliveryBindings,
		requiredReviewIds: [...completion.required_review_node_ids].sort(),
	};
}

export function completionBasisMatchesState(state: RunState, expected: CompletionBasis): boolean {
	const current = completionBasisForState(state);
	return current !== undefined && hashJson(current) === hashJson(expected);
}
