import { appendFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	type AgentSessionEvent,
	defineTool,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { NodeSessionAdapter } from "../src/adapter/node-session-adapter.ts";
import { PiNodeSessionFactory } from "../src/adapter/pi-node-session-factory.ts";
import type { IpdSessionSettings } from "../src/adapter/session-policy.ts";
import { createSubmissionTool, SubmissionCapture } from "../src/adapter/structured-submissions.ts";
import { compileWorkflow } from "../src/compiler/compiler.ts";
import { createCompilerFixture } from "./fixtures.ts";

// Real Pi sessions and IPD tools. Only model responses are synthetic; do not
// mock native retries, compaction, persistence or the agent loop.
describe("IPD native session contract", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function createFixture(
		options: {
			sessionSettings?: IpdSessionSettings;
			getCurrentContext?: () => string | undefined;
			extraTools?: readonly ToolDefinition[];
			contextWindow?: number;
			lockedIoTools?: string[];
			environmentTools?: readonly ToolDefinition[];
		} = {},
	) {
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
		const model = {
			...faux.getModel(),
			...(options.contextWindow ? { contextWindow: options.contextWindow, maxTokens: 100 } : {}),
		};
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
		const factory = new PiNodeSessionFactory({
			agentDir: root,
			modelRuntime,
			customTools: [unboundTool],
			sessionSettings: options.sessionSettings,
		});
		const input = {
			nodeId: "produce",
			workspace: root,
			sessionDirectory,
			systemPrompt: "Complete the synthetic task and submit its result.",
			participant: {
				...participant,
				lockedTools:
					options.lockedIoTools?.map((id) => ({ id, hash: "a".repeat(64), source: "test" })) ??
					participant.lockedTools,
			},
			environmentTools: options.environmentTools,
			runDefaultModel: model,
			runDefaultThinkingLevel: "off" as const,
			controlTools: [recordWork, submission, ...(options.extraTools ?? [])],
			getCurrentContext: options.getCurrentContext,
		};
		const session = await factory.create(input);
		const adapter = new NodeSessionAdapter({ create: async () => session, validate: () => factory.validate(input) });
		await adapter.create({
			runId: "run",
			nodeId: "produce",
			participantId: participant.participantId,
			createInput: input,
		});
		const prompt = (text: string) => adapter.dispatch("run", "produce", participant.participantId, "round", text);
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
		return { root, faux, session, prompt, capture, events, markerPath, sessionDirectory };
	}

	it("keeps native retry and compaction enabled in isolated default settings", () => {
		const settings = SettingsManager.inMemory({}, { projectTrusted: false });
		expect(settings.getRetrySettings().enabled).toBe(true);
		expect(settings.getCompactionSettings().enabled).toBe(true);
	});

	it.each(["read", "write", "edit", "bash", "grep", "find", "ls", "powershell"])(
		"never falls back to the host for an unbound %s backend",
		async (tool) => {
			await expect(createFixture({ lockedIoTools: [tool] })).rejects.toThrow(
				"requires an explicit execution backend",
			);
		},
	);

	it("rejects an incomplete environment tool set instead of filling it with host tools", async () => {
		await expect(createFixture({ lockedIoTools: ["read"], environmentTools: [] })).rejects.toThrow(
			"host fallback is disabled",
		);
		const read = defineTool({
			name: "read",
			label: "Host read",
			description: "Must not bypass backend selection",
			parameters: Type.Object({}),
			async execute() {
				throw new Error("must not execute");
			},
		});
		await expect(createFixture({ extraTools: [read] })).rejects.toThrow("host fallback is disabled");
	});

	it("exposes the actual Pi session and persisted identity without another session facade", async () => {
		const { session, prompt, faux } = await createFixture();
		faux.setResponses([fauxAssistantMessage("Saved.")]);
		expect(typeof session.compact).toBe("function");
		expect(typeof session.steer).toBe("function");
		expect(session.sessionManager.getSessionId()).toBe(session.sessionId);
		await prompt("Save this synthetic session.");
		expect(session.sessionFile).toBeDefined();
		expect(SessionManager.open(session.sessionFile!).getSessionId()).toBe(session.sessionId);
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

		await fixture.prompt(task);

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

	it("corrects rejected structured output as a native tool error without a model retry", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("submit_contract", { result: "invalid" })], { stopReason: "toolUse" }),
			(context) => {
				expect(fixture.capture.value).toBeUndefined();
				const feedback = context.messages.at(-1);
				expect(feedback?.role).toBe("toolResult");
				if (feedback?.role !== "toolResult") throw new Error("Missing rejection feedback");
				expect(feedback.toolName).toBe("submit_contract");
				expect(feedback.isError).toBe(true);
				const text = feedback.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
				expect(text).toContain("Submission rejected");
				expect(text).toContain("result must be accepted");
				return fauxAssistantMessage([fauxToolCall("submit_contract", { result: "accepted" })], {
					stopReason: "toolUse",
				});
			},
		]);

		await fixture.prompt("Submit the result, correcting invalid fields when necessary.");

		expect(fixture.faux.state.callCount).toBe(2);
		expect(fixture.capture.value).toEqual({ result: "accepted" });
		expect(fixture.events.filter((event) => event.type === "auto_retry_start")).toHaveLength(0);
		const executions = fixture.events.filter(
			(event) => event.type === "tool_execution_end" && event.toolName === "submit_contract",
		);
		expect(executions).toEqual([
			expect.objectContaining({
				isError: true,
				result: expect.objectContaining({ details: { captured: false, diagnostics: ["result must be accepted"] } }),
			}),
			expect.objectContaining({
				isError: false,
				result: expect.objectContaining({ details: expect.objectContaining({ captured: true }), terminate: true }),
			}),
		]);
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

		await fixture.prompt("Produce the first candidate.");
		expect(fixture.capture.value).toEqual({ result: "accepted" });
		fixture.capture.beginRound();
		expect(fixture.capture.value).toBeUndefined();
		await fixture.prompt("Apply the supplied review feedback and submit a new candidate.");

		expect(fixture.capture.value).toEqual({ result: "accepted" });
		expect(fixture.session.sessionId).toBe(sessionId);
		expect(fixture.faux.state.callCount).toBe(2);
		expect(fixture.session.isIdle).toBe(true);
	});

	it("reports a final non-retryable model error without manufacturing a submission", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" })]);

		await expect(fixture.prompt("Produce the result.")).rejects.toMatchObject({
			message: "invalid_api_key",
			retryable: false,
		});
		expect(fixture.capture.value).toBeUndefined();
		expect(fixture.faux.state.callCount).toBe(1);
		expect(fixture.events.filter((event) => event.type === "auto_retry_start")).toHaveLength(0);
		expect(fixture.session.isIdle).toBe(true);
	});

	it.each([false, true])(
		"honors the frozen native retry policy (enabled=%s) without a second retry loop",
		async (enabled) => {
			const sessionSettings = { retry: { enabled, maxRetries: 1, baseDelayMs: 1 } };
			const fixture = await createFixture({ sessionSettings });
			// A caller mutating its options cannot change an existing session.
			sessionSettings.retry.enabled = !enabled;
			sessionSettings.retry.maxRetries = 5;
			fixture.faux.setResponses(
				Array.from({ length: 8 }, () =>
					fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
				),
			);
			await expect(fixture.prompt("Try once under the selected policy.")).rejects.toMatchObject({
				retryable: false,
			});
			expect(fixture.faux.state.callCount).toBe(enabled ? 2 : 1);
			expect(fixture.events.filter((event) => event.type === "auto_retry_start")).toHaveLength(enabled ? 1 : 0);
			expect(fixture.capture.value).toBeUndefined();
		},
	);

	it("reports a model abort as cancellation, not a missing submission that should be corrected", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "aborted" })]);
		await expect(fixture.prompt("Cancelled work.")).rejects.toMatchObject({
			kind: "cancelled",
			retryable: false,
		});
		expect(fixture.faux.state.callCount).toBe(1);
		expect(fixture.capture.value).toBeUndefined();
	});

	it("retains earlier images after a successful tool turn without persisting the injected current context", async () => {
		const image = {
			type: "image" as const,
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=",
		};
		const picture = defineTool({
			name: "read_picture",
			label: "Picture",
			description: "Return a synthetic image.",
			parameters: Type.Object({}),
			async execute() {
				return { content: [image], details: {} };
			},
		});
		let context = "runtime-current-first";
		const fixture = await createFixture({ getCurrentContext: () => context, extraTools: [picture] });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read_picture", {}), { stopReason: "toolUse" }),
			() => {
				context = "runtime-current-latest";
				return fauxAssistantMessage(fauxToolCall("record_work", {}), { stopReason: "toolUse" });
			},
			(request) => {
				const result = request.messages.find(
					(message) => message.role === "toolResult" && message.toolName === "read_picture",
				);
				expect(result).toMatchObject({ content: [image] });
				expect(JSON.stringify(request.messages.at(-1))).toContain("runtime-current-latest");
				return fauxAssistantMessage(fauxToolCall("submit_contract", { result: "accepted" }), {
					stopReason: "toolUse",
				});
			},
		]);
		await fixture.prompt("Inspect the picture, record work and submit.");
		const files = (await readdir(fixture.sessionDirectory)).filter((file) => file.endsWith(".jsonl"));
		const persisted = await readFile(join(fixture.sessionDirectory, files[0]), "utf8");
		expect(persisted).toContain(image.data);
		expect(persisted).not.toContain("runtime-current-");
		expect(fixture.capture.value).toEqual({ result: "accepted" });
	});

	it("uses native automatic compaction and re-injects the current contract before continuing", async () => {
		const largeTool = defineTool({
			name: "large_result",
			label: "Large result",
			description: "Synthetic output crossing the context threshold.",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text" as const, text: `large-tool-result:${"x".repeat(6800)}` }], details: {} };
			},
		});
		const fixture = await createFixture({
			contextWindow: 2600,
			sessionSettings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
			getCurrentContext: () => "current-contract-after-compaction",
			extraTools: [largeTool],
		});
		let resumed = false;
		const finishOrSummarize = (request: Context) => {
			if (!request.messages.some((message) => message.role === "toolResult" && message.toolName === "large_result"))
				return fauxAssistantMessage("saved-summary");
			resumed = true;
			expect(JSON.stringify(request.messages)).toContain("saved-summary");
			expect(JSON.stringify(request.messages.at(-1))).toContain("current-contract-after-compaction");
			return fauxAssistantMessage(fauxToolCall("submit_contract", { result: "accepted" }), {
				stopReason: "toolUse",
			});
		};
		fixture.faux.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			...Array.from({ length: 4 }, () => finishOrSummarize),
		]);
		await fixture.prompt("seed old history");
		await fixture.prompt("seed recent history");
		await fixture.prompt("run the large tool");
		expect(resumed).toBe(true);
		expect(fixture.capture.value).toEqual({ result: "accepted" });
		expect(
			fixture.events.some(
				(event) => event.type === "compaction_end" && event.result !== undefined && !event.aborted,
			),
		).toBe(true);
		const files = (await readdir(fixture.sessionDirectory)).filter((file) => file.endsWith(".jsonl"));
		const entries = SessionManager.open(join(fixture.sessionDirectory, files[0])).getEntries();
		expect(entries.some((entry) => entry.type === "compaction")).toBe(true);
	});
});
