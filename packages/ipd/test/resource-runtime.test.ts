import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	compileWorkflow,
	FileRunStore,
	hashJson,
	MechanicalChecker,
	type NodeWorker,
	prepareRunDirectory,
	ResourceAdmission,
	SubmissionStore,
	WorkflowRuntime,
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";
import { passReport } from "./governance-fixtures.ts";

it("queues a second Run durably and wakes it without another model request or an early Attempt claim", async () => {
	const root = await mkdtemp(join(tmpdir(), "ipd-p1-admission-runtime-"));
	const admission = new ResourceAdmission({ active: 1, activePerRoot: 1 });
	let releaseFirst = () => {};
	const firstMayFinish = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let firstStarted = () => {};
	const started = new Promise<void>((resolve) => {
		firstStarted = resolve;
	});
	let active = 0;
	let maximum = 0;
	const runtimes: WorkflowRuntime[] = [];
	try {
		const create = async (runId: string) => {
			const fixture = createCompilerFixture();
			fixture.runId = runId;
			fixture.processSelection.run_id = runId;
			fixture.workflow.process_selection_ref.hash = hashJson(fixture.processSelection);
			const compiled = compileWorkflow(fixture);
			if (!compiled.ok) throw new Error(JSON.stringify(compiled.report.diagnostics));
			const directory = await prepareRunDirectory(root, runId);
			const worker: NodeWorker = {
				async runExecution() {
					active++;
					maximum = Math.max(active, maximum);
					try {
						if (runId === "first") {
							firstStarted();
							await firstMayFinish;
						}
						await mkdir(join(directory.workspace, "outputs/produce"), { recursive: true });
						await writeFile(join(directory.workspace, "outputs/produce/result.txt"), runId);
						return {
							summary: runId,
							outputs: [
								{
									output_id: "content-output",
									files: [{ path: "outputs/produce/result.txt", media_type: "text/plain" }],
								},
							],
							evidence: [],
							metadata: {},
						};
					} finally {
						active--;
					}
				},
				async runReview(work) {
					return passReport(work);
				},
			};
			const store = new FileRunStore();
			store.bind(runId, directory.stateFile);
			const runtime = new WorkflowRuntime(
				store,
				directory,
				worker,
				new SubmissionStore(),
				new MechanicalChecker(fixture.assets.checks),
				{ admission },
			);
			runtimes.push(runtime);
			await runtime.activate(compiled.baseline, fixture.taskInput);
			return { runtime, store };
		};
		const first = await create("first");
		const second = await create("second");
		const runningFirst = first.runtime.run();
		await started;
		const runningSecond = second.runtime.run();
		await expect
			.poll(async () =>
				(await second.store.read("second")).waits.some(
					(wait) => wait.kind === "resource" && wait.state === "waiting",
				),
			)
			.toBe(true);
		expect((await second.store.read("second")).attempts).toHaveLength(0);
		releaseFirst();
		const results = await Promise.all([runningFirst, runningSecond]);
		expect(results.map((state) => state.status)).toEqual(["succeeded", "succeeded"]);
		expect(maximum).toBe(1);
		expect(results[1].waits.find((wait) => wait.kind === "resource")?.state).toBe("satisfied");
	} finally {
		releaseFirst();
		await Promise.all(runtimes.map((runtime) => runtime.release()));
		await rm(root, { recursive: true, force: true });
	}
});
