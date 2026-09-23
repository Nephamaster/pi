import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { PiNodeWorker } from "../src/adapter/pi-node-worker.ts";
import type { SubmitArtifact } from "../src/adapter/structured-submissions.ts";
import { compileWorkflow } from "../src/compiler/compiler.ts";
import { hashJson } from "../src/ir/hash.ts";
import type { NodeRoundWork } from "../src/runtime/node-worker.ts";
import { createCompilerFixture, createExecutionStamp } from "./fixtures.ts";

it("corrects rejected fields and Runtime correction in the SAME native Session; rejects old-round reuse", async () => {
	const root = await mkdtemp(join(tmpdir(), "ipd-local-correction-"));
	const faux = registerFauxProvider();
	let worker: PiNodeWorker | undefined;
	const contexts: string[] = [];
	const raw: SubmitArtifact = {
		summary: "existing substantive work ".repeat(200),
		outputs: [
			{ output_id: "content-output", files: [{ path: "outputs/produce/result.txt", media_type: "text/plain" }] },
		],
		evidence: [{ description: "recorded inspection", reference: "one.txt, two.txt", output_id: "content-output" }],
		metadata: { note: "retain" },
	};
	const repaired = { ...raw, evidence: [{ ...raw.evidence[0], reference: "outputs/produce/result.txt" }] };
	const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => (context: Context) => {
		contexts.push(JSON.stringify(context));
		return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
	};
	faux.setResponses([
		call("submit_artifact", raw),
		call("correct_submission", {
			base_hash: hashJson(raw),
			patches: [{ op: "set", path: "/evidence/0/reference", value: "outputs/produce/result.txt" }],
		}),
		call("submission_context", { mode: "correction", paths: ["/metadata/note"] }),
		call("correct_submission", {
			base_hash: hashJson(repaired),
			patches: [{ op: "set", path: "/metadata/note", value: "corrected metadata" }],
		}),
		call("correct_submission", {
			base_hash: hashJson(repaired),
			patches: [{ op: "set", path: "/summary", value: "invalid reuse" }],
		}),
		call("submit_artifact", { ...repaired, summary: "new work" }),
	]);
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
		if (!compiled.ok) throw new Error("fixture");
		worker = new PiNodeWorker({
			agentDir: root,
			workspace: root,
			sessionDirectory: join(root, "sessions"),
			modelRuntime,
			model,
			thinkingLevel: "off",
		});
		const work: NodeRoundWork = {
			stamp: createExecutionStamp("round-1"),
			runId: "run-1",
			roundId: "round-1",
			node: compiled.baseline.nodes.find((item) => item.definition.node_id === "produce")!,
			inputSubmissions: [],
			inputBindings: [],
			taskContext: { materials: [], unresolvedFacts: [] },
			forbiddenMutableReadPaths: [],
			feedback: [],
		};
		const first = await worker.runExecution(work);
		const session = worker.inspectRun("run-1")[0].sessionId;
		expect(first).toEqual(repaired);
		expect(contexts[1]).toContain("/evidence/0/reference");
		const second = await worker.runExecution({
			...work,
			stamp: createExecutionStamp("round-1", 2),
			feedback: [{ type: "submission_correction", issue: "Correct metadata only" }],
		});
		expect(second).toEqual({ ...repaired, metadata: { note: "corrected metadata" } });
		expect(worker.inspectRun("run-1")[0].sessionId).toBe(session);
		expect(contexts[3]).toContain("base_hash");
		const third = await worker.runExecution({
			...work,
			stamp: createExecutionStamp("round-2"),
			roundId: "round-2",
			feedback: [{ type: "quality_rework", issue: "New business revision" }],
		});
		expect(third).toEqual({ ...repaired, summary: "new work" });
		expect(contexts[5]).toContain("No matching rejected payload");
		expect(worker.inspectRun("run-1")[0].sessionId).toBe(session);
		expect(faux.state.callCount).toBe(6);
	} finally {
		await worker?.releaseRun("run-1");
		faux.unregister();
		await rm(root, { recursive: true, force: true });
	}
});
