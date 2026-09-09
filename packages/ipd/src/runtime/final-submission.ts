import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { hashFile } from "../artifact/hash-file.ts";
import type { FinalSubmissionFileRecord, FinalSubmissionRecord, RunState } from "../contracts/runtime.ts";
import { normalizeScope } from "../ir/scopes.ts";
import type { RunDirectory } from "./run-directory.ts";
import { approvedSubmissionForOutput, requireBaseline } from "./runtime-state.ts";

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
): Promise<FinalSubmissionRecord> {
	const baseline = requireBaseline(state);
	const staging = `${directory.finalSubmission}.${process.pid}.${Date.now()}.tmp`;
	const files: FinalSubmissionFileRecord[] = [];
	const destinations = new Set<string>();
	await mkdir(staging, { recursive: false });
	try {
		for (const ref of baseline.workflow.completion.delivery_outputs) {
			const submission = approvedSubmissionForOutput(
				state,
				ref,
				baseline.workflow.completion.required_review_node_ids,
			);
			if (!submission) throw new Error(`Delivery output is not approved: ${ref.node_id}:${ref.output_id}`);
			const output = submission.outputs.find((item) => item.outputId === ref.output_id);
			const node = baseline.workflow.nodes.find((item) => item.node_id === ref.node_id);
			const definition =
				node?.kind === "execution" ? node.outputs.find((item) => item.output_id === ref.output_id) : undefined;
			if (!output || !definition) throw new Error(`Delivery output is missing: ${ref.node_id}:${ref.output_id}`);
			for (const file of output.manifest.files) {
				const path = deliveryPath(definition.path_prefix, file.path);
				if (destinations.has(path)) throw new Error(`Final delivery path collision: ${path}`);
				destinations.add(path);
				const source = resolve(output.sealedRoot, file.path);
				const destination = resolve(staging, path);
				await mkdir(dirname(destination), { recursive: true });
				await copyFile(source, destination);
				if ((await hashFile(destination)) !== file.sha256)
					throw new Error(`Final delivery file failed integrity validation: ${file.path}`);
				files.push({
					path,
					mimeType: file.mimeType,
					sha256: file.sha256,
					size: file.size,
					submissionId: submission.submissionId,
					nodeId: ref.node_id,
					outputId: ref.output_id,
					sourcePath: file.path,
				});
			}
		}
		await rm(directory.finalSubmission, { recursive: true, force: true });
		await rename(staging, directory.finalSubmission);
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
	return { directory: directory.finalSubmission, files, createdAt: Date.now() };
}
