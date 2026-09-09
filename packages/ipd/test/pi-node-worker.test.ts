import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { compileWorkflow, PiNodeWorker } from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

describe("PiNodeWorker", () => {
	const roots: string[] = [];
	afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

	it("captures two execution rounds from the same persistent Pi Session", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-worker-"));
		roots.push(root);
		const faux = registerFauxProvider();
		const contexts: string[] = [];
		const response = (summary: string) => (context: Context) => {
			contexts.push(JSON.stringify(context));
			return fauxAssistantMessage(
				fauxToolCall("submit_artifact", {
					summary,
					outputs: [
						{
							output_id: "content-output",
							files: [{ path: "outputs/produce/result.txt", media_type: "text/plain" }],
						},
					],
					evidence: [],
					metadata: {},
				}),
				{ stopReason: "toolUse" },
			);
		};
		faux.setResponses([response("first"), response("revised")]);
		try {
			const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
			const model = faux.getModel();
			modelRuntime.registerProvider(model.provider, {
				baseUrl: model.baseUrl,
				api: model.api,
				models: [{ ...model, id: model.id, name: model.name }],
			});
			await modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
			const compiled = compileWorkflow(createCompilerFixture());
			if (!compiled.ok) throw new Error("Fixture did not compile");
			const node = compiled.baseline.nodes.find((item) => item.definition.node_id === "produce")!;
			const worker = new PiNodeWorker({
				agentDir: root,
				workspace: root,
				sessionDirectory: join(root, "sessions"),
				modelRuntime,
				model,
				thinkingLevel: "off",
			});
			const first = await worker.runExecution({
				runId: "run-1",
				roundId: "round-1",
				node,
				inputSubmissions: [],
				inputBindings: [],
				taskContext: { objectives: [], requirements: [], materials: [], unresolvedFacts: [] },
				forbiddenMutableReadPaths: [],
				feedback: [],
			});
			const second = await worker.runExecution({
				runId: "run-1",
				roundId: "round-2",
				node,
				inputSubmissions: [],
				inputBindings: [],
				taskContext: { objectives: [], requirements: [], materials: [], unresolvedFacts: [] },
				forbiddenMutableReadPaths: [],
				feedback: ["revise"],
			});
			expect([first.summary, second.summary]).toEqual(["first", "revised"]);
			expect(faux.state.callCount).toBe(2);
			expect(contexts[0]).toContain("IPD Node Contract");
			expect(contexts[0]).toContain("ipd_current_round");
			expect(contexts[0]).toContain("round-1");
			expect(contexts[1]).toContain("round-2");
			expect(contexts[1]).toContain("revise");
		} finally {
			faux.unregister();
		}
	});
});
