import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import {
	compileWorkflow,
	DockerCli,
	DockerEnvironmentProvider,
	EnvironmentManager,
	loadRegisteredDockerProfile,
	type NodeRoundWork,
	PiNodeWorker,
	prepareRunDirectory,
	SubmissionStore,
} from "../src/index.ts";
import { validateReviewEvidence } from "../src/runtime/evidence-validation.ts";
import { sealReviewEvidence } from "../src/runtime/review-evidence-store.ts";
import { createCompilerFixture, createExecutionStamp } from "./fixtures.ts";
import { passReport } from "./governance-fixtures.ts";

it.runIf(process.env.PI_IPD_DOCKER_INTEGRATION === "1")(
	"exports real Docker Reviewer verification without mutating its sealed subjects",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "ipd-p1-docker-"));
		const faux = registerFauxProvider();
		let worker: PiNodeWorker | undefined;
		let manager: EnvironmentManager | undefined;
		try {
			const docker = new DockerCli({ dockerConfigDirectory: join(root, "docker-config") });
			const profile = await loadRegisteredDockerProfile(
				fileURLToPath(new URL("../environments/code-node24/profile.template.json", import.meta.url)),
				docker,
			);
			manager = new EnvironmentManager([
				new DockerEnvironmentProvider({ docker, storageRoot: join(root, "leases") }),
			]);
			const fixture = createCompilerFixture();
			const compiled = compileWorkflow({
				...fixture,
				assets: {
					...fixture.assets,
					environmentProfiles: [profile],
					environmentPolicy: { allowedProfiles: [profile.ref], defaultProfile: profile.ref },
				},
			});
			if (!compiled.ok) throw new Error(JSON.stringify(compiled.report.diagnostics));
			const directory = await prepareRunDirectory(root, fixture.runId);
			await mkdir(join(directory.workspace, "outputs/produce"), { recursive: true });
			await writeFile(join(directory.workspace, "outputs/produce/result.txt"), "sealed subject");
			const producer = compiled.baseline.nodes[0].definition;
			if (producer.kind !== "execution") throw new Error("Invalid fixture");
			const submission = await new SubmissionStore().seal({
				run: directory,
				runId: fixture.runId,
				node: producer,
				roundId: "produce:1",
				attemptId: "produce:1",
				submissionId: "candidate",
				inputSubmissionIds: [],
				submission: {
					summary: "Subject",
					outputs: [
						{
							output_id: "content-output",
							files: [{ path: "outputs/produce/result.txt", media_type: "text/plain" }],
						},
					],
					evidence: [],
					metadata: {},
				},
			});
			const model = faux.getModel();
			const modelRuntime = await ModelRuntime.create({
				authPath: join(root, "auth.json"),
				modelsPath: null,
				refreshOnCreate: false,
			});
			modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
			await modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
			worker = new PiNodeWorker({
				agentDir: root,
				workspace: directory.workspace,
				sessionDirectory: directory.sessions,
				modelRuntime,
				model,
				thinkingLevel: "off",
				environmentManager: manager,
			});
			const node = compiled.baseline.nodes.find((item) => item.definition.kind === "review")!;
			const work: NodeRoundWork = {
				stamp: createExecutionStamp("review:1"),
				runId: fixture.runId,
				roundId: "review:1",
				node,
				inputSubmissions: [submission],
				inputBindings: [
					{
						inputId: "candidate",
						submissionId: submission.submissionId,
						outputId: "content-output",
						approvalReviewNodeIds: [],
					},
				],
				taskContext: { materials: [], unresolvedFacts: [] },
				forbiddenMutableReadPaths: [],
				feedback: [],
				environmentBinding: compiled.baseline.environmentBindings.find(
					(item) => item.nodeId === node.definition.node_id,
				),
			};
			await worker.prepareRound(work);
			const lease = manager.inspectRun(fixture.runId)[0];
			const context = manager.context(lease.leaseId, work.roundId);
			await context.provider.makeDirectory(context.lease, context.round, "/workspace/outputs/review-evidence");
			await context.provider.writeFile(
				context.lease,
				context.round,
				"/workspace/outputs/review-evidence/check.txt",
				Buffer.from("reviewer verified exact subject"),
			);
			const report = passReport(work);
			report.criteria[0].evidence[0].verification_path = "outputs/review-evidence/check.txt";
			const receipts = await sealReviewEvidence(directory, worker, work, report);
			const evidence = await validateReviewEvidence(work, report, receipts);
			expect(await readFile(join(directory.root, evidence[0].rawRef), "utf8")).toBe(
				"reviewer verified exact subject",
			);
			expect(await readFile(join(submission.outputs[0].sealedRoot, "outputs/produce/result.txt"), "utf8")).toBe(
				"sealed subject",
			);
			expect(evidence[0].rawDigest).toMatch(/^[a-f0-9]{64}$/);
		} finally {
			await worker?.releaseRun("run-1");
			await manager?.releaseRun("run-1");
			faux.unregister();
			await rm(root, { recursive: true, force: true });
		}
	},
	120_000,
);
