import { appendFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	type AgentSessionEvent,
	defineTool,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { PiNodeSessionFactory } from "../src/adapter/pi-node-session-factory.ts";
import { createSubmissionTool, SubmissionCapture } from "../src/adapter/structured-submissions.ts";
import { compileWorkflow } from "../src/compiler/compiler.ts";
import { createCompilerFixture } from "./fixtures.ts";

// Refactor baseline: real Pi sessions and IPD submission tools, with only the
// provider replaced by faux responses. Do not mock retry, persistence or the loop.
describe("IPD native session contract", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function createFixture() {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-native-contract-"));
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const faux = registerFauxProvider();
		cleanups.push(async () => {
			faux.unregister();
		});
		const modelRuntime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});
		await modelRuntime.setRuntimeApiKey(model.provider, "faux-key");

		const compiled = compileWorkflow(createCompilerFixture());
		if (!compiled.ok) throw new Error("Baseline fixture did not compile");
		const participant = compiled.baseline.nodes.find((node) => node.definition.node_id === "produce")?.agents[0];
		if (!participant) throw new Error("Missing production participant");
		const capture = new SubmissionCapture<{ result: string }>();
		const submission = createSubmissionTool({
			name: "submit_contract",
			label: "Submit contract",
			description: "Submit the synthetic baseline result.",
			parameters: Type.Object({ result: Type.String() }),
			capture,
			validate: (value) => (value.result === "accepted" ? [] : ["result must be accepted"]),
		});
		const markerPath = join(root, "work.txt");
		const recordWork = defineTool({
			name: "record_work",
			label: "Record work",
			description: "Record one synthetic side effect.",
			parameters: Type.Object({}),
			async execute() {
				await appendFile(markerPath, "done\n");
				return { content: [{ type: "text", text: "Work recorded" }], details: {} };
			},
		});
		const unboundTool = defineTool({
			name: "unbound_tool",
			label: "Unbound tool",
			description: "Must not be exposed to this participant.",
			parameters: Type.Object({}),
			async execute() {
				throw new Error("Unbound tool executed");
			},
		});
		const sessionDirectory = join(root, "sessions");
		const session = await new PiNodeSessionFactory({
			agentDir: root,
			modelRuntime,
			customTools: [unboundTool],
		}).create({
			nodeId: "produce",
			workspace: root,
			sessionDirectory,
			systemPrompt: "Complete the synthetic task and submit its result.",
			participant,
			runDefaultModel: model,
			runDefaultThinkingLevel: "off",
			controlTools: [recordWork, submission],
		});
		const events: AgentSessionEvent[] = [];
		const unsubscribe = session.subscribe((event) => events.push(event));
		cleanups.push(async () => {
			try {
				await session.abort();
			} finally {
				unsubscribe();
				session.dispose();
			}
		});
		return { root, faux, session, capture, events, markerPath, sessionDirectory };
	}

	it("keeps native retry and compaction enabled in isolated default settings", () => {
		const settings = SettingsManager.inMemory({}, { projectTrusted: false });
		expect(settings.getRetrySettings().enabled).toBe(true);
		expect(settings.getCompactionSettings().enabled).toBe(true);
	});

	it("retries the model inside one prompt without replaying completed work, then terminates on capture", async () => {
		const fixture = await createFixture();
		const task = "Record work once, then submit the result.";
		fixture.faux.setResponses([
			(context) => {
				expect(context.tools?.map((tool) => tool.name).sort()).toEqual(["record_work", "submit_contract"]);
				return fauxAssistantMessage([fauxToolCall("record_work", {})], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage([fauxToolCall("submit_contract", { result: "accepted" })], { stopReason: "toolUse" }),
		]);

		await fixture.session.prompt(task);

		expect(fixture.faux.state.callCount).toBe(3);
		expect(await readFile(fixture.markerPath, "utf8")).toBe("done\n");
		expect(fixture.capture.value).toEqual({ result: "accepted" });
		expect(fixture.events.filter((event) => event.type === "auto_retry_start")).toHaveLength(1);
		expect(fixture.events.filter((event) => event.type === "auto_retry_end")).toEqual([
			expect.objectContaining({ success: true, attempt: 1 }),
		]);
		expect(fixture.session.isIdle).toBe(true);

		const files = (await readdir(fixture.sessionDirectory)).filter((file) => file.endsWith(".jsonl"));
		expect(files).toHaveLength(1);
		const entries = SessionManager.open(join(fixture.sessionDirectory, files[0])).getEntries();
		const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(messages.filter((message) => message.role === "assistant" && message.stopReason === "error")).toHaveLength(
			1,
		);
	}, 15_000);

	it("corrects rejected structured output without treating it as a model retry", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("submit_contract", { result: "invalid" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("submit_contract", { result: "accepted" })], { stopReason: "toolUse" }),
		]);

		await fixture.session.prompt("Submit the result, correcting invalid fields when necessary.");

		expect(fixture.faux.state.callCount).toBe(2);
		expect(fixture.capture.value).toEqual({ result: "accepted" });
		expect(fixture.events.filter((event) => event.type === "auto_retry_start")).toHaveLength(0);
		const submissionErrors = fixture.events.flatMap((event) =>
			event.type === "tool_execution_end" && event.toolName === "submit_contract" ? [event.isError] : [],
		);
		expect(submissionErrors).toEqual([true, false]);
	});

	it("starts a later quality round on the same session while retaining the earlier tool result", async () => {
		const fixture = await createFixture();
		const sessionId = fixture.session.sessionId;
		fixture.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("submit_contract", { result: "accepted" })], { stopReason: "toolUse" }),
			(context) => {
				expect(
					context.messages.some(
						(message) => message.role === "toolResult" && message.toolName === "submit_contract",
					),
				).toBe(true);
				return fauxAssistantMessage([fauxToolCall("submit_contract", { result: "accepted" })], {
					stopReason: "toolUse",
				});
			},
		]);

		await fixture.session.prompt("Produce the first candidate.");
		expect(fixture.capture.value).toEqual({ result: "accepted" });
		fixture.capture.beginRound();
		expect(fixture.capture.value).toBeUndefined();
		await fixture.session.prompt("Apply the supplied review feedback and submit a new candidate.");

		expect(fixture.capture.value).toEqual({ result: "accepted" });
		expect(fixture.session.sessionId).toBe(sessionId);
		expect(fixture.faux.state.callCount).toBe(2);
		expect(fixture.session.isIdle).toBe(true);
	});

	it("reports a final non-retryable model error without manufacturing a submission", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" })]);

		await expect(fixture.session.prompt("Produce the result.")).rejects.toThrow("invalid_api_key");

		expect(fixture.capture.value).toBeUndefined();
		expect(fixture.faux.state.callCount).toBe(1);
		expect(fixture.events.filter((event) => event.type === "auto_retry_start")).toHaveLength(0);
		expect(fixture.session.isIdle).toBe(true);
	});
});
