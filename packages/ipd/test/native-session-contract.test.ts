import { appendFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
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
import type { ProviderRequestObservation, RequestViewLimits } from "../src/adapter/provider-request-admission.ts";
import { CONTEXT_EVIDENCE_TOOL } from "../src/adapter/request-view.ts";
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
			requestViewLimits?: Partial<RequestViewLimits>;
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
			requestViewLimits: options.requestViewLimits,
		});
		const requests: ProviderRequestObservation[] = [];
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
			getProviderRequestRecorder: () => async (request: ProviderRequestObservation) => {
				requests.push(request);
				return true;
			},
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
		return {
			root,
			faux,
			session,
			prompt,
			capture,
			events,
			markerPath,
			sessionDirectory,
			requests,
			factory,
			input,
			adapter,
		};
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
				expect(
					context.messages
						.filter((message) => message.role === "system")
						.flatMap((message) => message.toolsAdded ?? [])
						.map((tool) => tool.name)
						.sort(),
				).toEqual([CONTEXT_EVIDENCE_TOOL, "record_work", "submit_contract"]);
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

	it("retains images and stable system state through tool turns, updating only on a new dispatch", async () => {
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
				expect(request.messages.at(-1)?.role).toBe("toolResult");
				expect(JSON.stringify(request.messages.filter((message) => message.role === "system"))).toContain(
					"runtime-current-first",
				);
				expect(JSON.stringify(request.messages)).not.toContain("runtime-current-latest");
				return fauxAssistantMessage(fauxToolCall("submit_contract", { result: "accepted" }), {
					stopReason: "toolUse",
				});
			},
		]);
		await fixture.prompt("Inspect the picture, record work and submit.");
		const files = (await readdir(fixture.sessionDirectory)).filter((file) => file.endsWith(".jsonl"));
		const persisted = await readFile(join(fixture.sessionDirectory, files[0]), "utf8");
		expect(persisted).toContain(image.data);
		expect(persisted).toContain("runtime-current-first");
		expect(fixture.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		fixture.faux.setResponses([
			(request) => {
				expect(JSON.stringify(request.messages.filter((message) => message.role === "system"))).toContain(
					"runtime-current-latest",
				);
				return fauxAssistantMessage("continued");
			},
		]);
		await fixture.prompt("Continue retained work");
		expect(fixture.session.messages.filter((message) => message.role === "user")).toHaveLength(2);
		expect(
			fixture.session.messages.filter(
				(message) => message.role === "system" && message.sections?.ipd_current_round !== undefined,
			),
		).toHaveLength(2);
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
			expect(JSON.stringify(request.messages.filter((message) => message.role === "system"))).toContain(
				"current-contract-after-compaction",
			);
			expect(request.messages.at(-1)?.role).toBe("toolResult");
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

	it("pages large evidence without losing originals, the contract or executing its tool again", async () => {
		let executions = 0;
		const source = `large-source:${"x".repeat(100_000)}:exact-ending`;
		const largeResult = defineTool({
			name: "large_result",
			label: "Large result",
			description: "Return retained text",
			parameters: Type.Object({}),
			async execute() {
				executions++;
				return { content: [{ type: "text", text: source }], details: {} };
			},
		});
		const fixture = await createFixture({
			extraTools: [largeResult],
			requestViewLimits: { maxRequestBytes: 32_000 },
			sessionSettings: { compaction: { enabled: false } },
			getCurrentContext: () => "frozen-input-and-unresolved-finding",
		});
		const identity = fixture.session.sessionId;
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			(request) => {
				expect(JSON.stringify(request.messages)).toContain("IPD request-view reference");
				expect(JSON.stringify(request.messages)).not.toContain(source);
				const entry = fixture.session.sessionManager
					.getBranch()
					.find(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.toolName === "large_result",
					)!;
				return fauxAssistantMessage(
					fauxToolCall(CONTEXT_EVIDENCE_TOOL, {
						entry_id: entry.id,
						block: 0,
						offset: source.length - 13,
						limit: 13,
					}),
					{ stopReason: "toolUse" },
				);
			},
			(request) => {
				const text = JSON.stringify(request.messages);
				expect(text).toContain(":exact-ending");
				expect(text).toContain("frozen-input-and-unresolved-finding");
				return fauxAssistantMessage(fauxToolCall("submit_contract", { result: "accepted" }), {
					stopReason: "toolUse",
				});
			},
		]);
		await fixture.prompt("Read the evidence and submit.");
		expect(executions).toBe(1);
		expect(fixture.session.sessionId).toBe(identity);
		expect(fixture.capture.value).toEqual({ result: "accepted" });
		const raw = SessionManager.open(fixture.session.sessionFile!).getEntries();
		expect(JSON.stringify(raw)).toContain(source);
		expect(raw.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
		expect(raw.some((entry) => entry.type === "context_edit")).toBe(true);
	});

	it("bounds image batches and can retrieve an omitted original from the same Session", async () => {
		const image = {
			type: "image" as const,
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=",
		};
		const images = defineTool({
			name: "pictures",
			label: "Pictures",
			description: "Return a batch",
			parameters: Type.Object({}),
			async execute() {
				return { content: [image, image, image], details: {} };
			},
		});
		const fixture = await createFixture({
			extraTools: [images],
			requestViewLimits: { maxImagesPerMessage: 1, maxImagesPerRequest: 1 },
		});
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("pictures", {}), { stopReason: "toolUse" }),
			(request) => {
				const result = request.messages.find(
					(message) => message.role === "toolResult" && message.toolName === "pictures",
				);
				if (result?.role !== "toolResult") throw new Error("Image tool result is missing");
				expect(result.content.filter((block) => block.type === "image")).toHaveLength(1);
				const entry = fixture.session.sessionManager
					.getBranch()
					.find(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.toolName === "pictures",
					)!;
				return fauxAssistantMessage(fauxToolCall(CONTEXT_EVIDENCE_TOOL, { entry_id: entry.id, block: 0 }), {
					stopReason: "toolUse",
				});
			},
			(request) => {
				const results = request.messages.filter((message) => message.role === "toolResult");
				expect(
					results.flatMap((message) => message.content.filter((block) => block.type === "image")),
				).toHaveLength(1);
				expect(results.at(-1)).toMatchObject({ toolName: CONTEXT_EVIDENCE_TOOL, content: [image] });
				return fauxAssistantMessage("Done");
			},
		]);
		await fixture.prompt("Inspect these images in batches.");
		const raw = fixture.session.sessionManager
			.getBranch()
			.find(
				(entry) =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "pictures",
			);
		expect(raw).toMatchObject({ message: { content: [image, image, image] } });
	});

	it("repairs an exact wire-byte rejection inside one native run without replaying side effects", async () => {
		let executions = 0;
		const largeResult = defineTool({
			name: "large_result",
			label: "Large result",
			description: "Return text once",
			parameters: Type.Object({}),
			async execute() {
				executions++;
				return { content: [{ type: "text", text: "x".repeat(16_000) }], details: {} };
			},
		});
		const fixture = await createFixture({
			extraTools: [largeResult],
			requestViewLimits: { maxRequestBytes: 32_000 },
			sessionSettings: { compaction: { enabled: false } },
		});
		// Faux has no HTTP serializer. This shim invokes the real Pi payload hook with measured wire overhead.
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			...Array.from({ length: 3 }, () => async (context: Context, options: SimpleStreamOptions | undefined) => {
				await options?.onPayload?.(
					{ messages: context.messages, transport_padding: "p".repeat(16_000) },
					fixture.session.model!,
				);
				return fauxAssistantMessage(fauxToolCall("submit_contract", { result: "accepted" }), {
					stopReason: "toolUse",
				});
			}),
		]);
		await fixture.prompt("Read once and finish.");
		expect(executions).toBe(1);
		expect(fixture.capture.value).toEqual({ result: "accepted" });
		expect(fixture.requests.map((request) => request.status)).toEqual(["rejected", "admitted"]);
		expect(
			fixture.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "ipd_request_view_repair"),
		).toHaveLength(1);
		expect(fixture.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
	});

	it.each([false, true])(
		"reports irreducible instructions as request_capacity (native compaction=%s)",
		async (enabled) => {
			const fixture = await createFixture({
				requestViewLimits: { maxRequestBytes: 12_000 },
				sessionSettings: { compaction: { enabled } },
				getCurrentContext: () => `immutable-contract:${"x".repeat(16_000)}`,
			});
			let admitted = 0;
			fixture.faux.setResponses([
				async (context, options) => {
					await options?.onPayload?.({ messages: context.messages }, fixture.session.model!);
					admitted++;
					return fauxAssistantMessage("Must not be reached");
				},
			]);
			await expect(fixture.prompt(`immutable-task:${"x".repeat(16_000)}`)).rejects.toMatchObject({
				kind: "request_capacity",
				retryable: false,
			});
			expect(admitted).toBe(0);
			expect(fixture.faux.state.callCount).toBe(1);
			expect(fixture.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		},
	);

	it("continues using retained evidence references after reopening the original Session", async () => {
		const evidence = `saved-evidence:${"x".repeat(16_000)}`;
		const source = defineTool({
			name: "source",
			label: "Source",
			description: "Read evidence",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: evidence }], details: {} };
			},
		});
		const fixture = await createFixture({ extraTools: [source], requestViewLimits: { maxRequestBytes: 12_000 } });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("source", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Retained"),
		]);
		await fixture.prompt("Read once.");
		const reopened = SessionManager.open(fixture.session.sessionFile!);
		const entry = reopened
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "toolResult")!;
		expect(entry).toBeDefined();
		fixture.session.dispose();
		const restored = await fixture.factory.create({
			...fixture.input,
			restoreSession: {
				sessionId: fixture.session.sessionId,
				sessionFile: fixture.session.sessionFile!,
				entryId: reopened.getLeafId()!,
			},
		});
		cleanups.push(async () => {
			await restored.abort();
			restored.dispose();
		});
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall(CONTEXT_EVIDENCE_TOOL, { entry_id: entry.id, block: 0, limit: 15 }), {
				stopReason: "toolUse",
			}),
			(request) => {
				expect(JSON.stringify(request.messages.at(-1))).toContain("saved-evidence:");
				return fauxAssistantMessage("Done");
			},
		]);
		await restored.prompt("Read the saved reference.");
		expect(restored.sessionId).toBe(fixture.session.sessionId);
	});

	it("repairs provider-side merging of image results without replaying either read", async () => {
		let executions = 0;
		const image = {
			type: "image" as const,
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=",
		};
		const picture = defineTool({
			name: "picture",
			label: "Picture",
			description: "Read image",
			parameters: Type.Object({}),
			async execute() {
				executions++;
				return { content: [image], details: {} };
			},
		});
		const fixture = await createFixture({
			extraTools: [picture],
			requestViewLimits: { maxImagesPerMessage: 1, maxImagesPerRequest: 8 },
			sessionSettings: { compaction: { enabled: false } },
		});
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("picture", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("picture", {}), { stopReason: "toolUse" }),
			...Array.from({ length: 2 }, () => async (context: Context, options: SimpleStreamOptions | undefined) => {
				const content = context.messages.flatMap((message) =>
					message.role === "toolResult" ? message.content : [],
				);
				await options?.onPayload?.({ messages: [{ role: "user", content }] }, fixture.session.model!);
				return fauxAssistantMessage("Finished");
			}),
		]);
		await fixture.prompt("Inspect two pictures");
		expect(executions).toBe(2);
		expect(fixture.requests.map((request) => request.status)).toEqual(["rejected", "admitted"]);
		expect(fixture.requests[0].reasonCode).toBe("message_images_exceeded");
	});

	it("does not continue a capacity repair after the dispatch is cancelled", async () => {
		const result = defineTool({
			name: "large_result",
			label: "Result",
			description: "Text",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: "x".repeat(16_000) }], details: {} };
			},
		});
		const fixture = await createFixture({
			extraTools: [result],
			requestViewLimits: { maxRequestBytes: 32_000 },
			sessionSettings: { compaction: { enabled: false } },
		});
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			async (context, options) => {
				try {
					await options?.onPayload?.(
						{ messages: context.messages, padding: "p".repeat(16_000) },
						fixture.session.model!,
					);
				} catch (error) {
					void fixture.adapter.stop("run", "produce", fixture.input.participant.participantId, "round");
					throw error;
				}
				return fauxAssistantMessage("Must not be sent");
			},
		]);
		await expect(fixture.prompt("Read once")).rejects.toMatchObject({ kind: "cancelled" });
		expect(fixture.faux.state.callCount).toBe(2);
		expect(
			fixture.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "ipd_request_view_repair"),
		).toHaveLength(0);
	});
});
