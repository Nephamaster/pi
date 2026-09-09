import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface RunDirectory {
	runId: string;
	root: string;
	workspace: string;
	submissions: string;
	sessions: string;
	finalSubmission: string;
	stateFile: string;
}

export async function prepareRunDirectory(projectRoot: string, runId: string): Promise<RunDirectory> {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(runId)) throw new Error(`Invalid Run ID: ${runId}`);
	const root = resolve(projectRoot, ".pi", "ipd", "runs", runId);
	const directory = {
		runId,
		root,
		workspace: join(root, "workspace"),
		submissions: join(root, "submissions"),
		sessions: join(root, "sessions"),
		finalSubmission: join(root, "final_submission"),
		stateFile: join(root, "state.json"),
	};
	await Promise.all(
		[directory.workspace, directory.submissions, directory.sessions].map((path) => mkdir(path, { recursive: true })),
	);
	return directory;
}
