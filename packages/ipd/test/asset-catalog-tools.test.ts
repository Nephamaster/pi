import { describe, expect, it } from "vitest";
import {
	createAgentCardCatalogTools,
	createProcessSpecCatalogTools,
	renderAgentSelectionProfile,
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

describe("control-role asset catalog tools", () => {
	it("searches ProcessSpec summaries and reads exact versions on demand", async () => {
		const fixture = createCompilerFixture();
		const tools = createProcessSpecCatalogTools([fixture.processSpec]);
		const search = tools.find((tool) => tool.name === "search_process_specs");
		const read = tools.find((tool) => tool.name === "get_process_spec");
		if (!search || !read) throw new Error("ProcessSpec catalog tools are missing");
		const searched = await search.execute(
			"search-1",
			{ query: "reviewed deliverable", limit: 5 },
			undefined,
			undefined,
			{} as never,
		);
		expect(searched.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("delivery-process") });
		expect(searched.content[0]).toMatchObject({
			type: "text",
			text: expect.stringMatching(/^<process_spec_search_results>[\s\S]*<\/process_spec_search_results>$/),
		});
		const loaded = await read.execute(
			"read-1",
			{ id: "delivery-process", version: "1.0.0" },
			undefined,
			undefined,
			{} as never,
		);
		expect(loaded.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("required_activities") });
		expect(loaded.content[0]).toMatchObject({
			type: "text",
			text: expect.stringMatching(/^<process_spec>[\s\S]*<\/process_spec>$/),
		});
	});

	it("returns compact AgentCard search results and a rich selection profile only on read", async () => {
		const fixture = createCompilerFixture();
		const producer = fixture.assets.agentCards.find((card) => card.id === "producer");
		if (!producer) throw new Error("Producer card is missing");
		const tools = createAgentCardCatalogTools(fixture.assets.agentCards);
		const search = tools.find((tool) => tool.name === "search_agent_cards");
		const read = tools.find((tool) => tool.name === "get_agent_card");
		if (!search || !read) throw new Error("AgentCard catalog tools are missing");
		const searched = await search.execute(
			"search-1",
			{ query: "production", limit: 5 },
			undefined,
			undefined,
			{} as never,
		);
		const searchText = searched.content[0]?.type === "text" ? searched.content[0].text : "";
		expect(searchText).toContain("producer");
		expect(searchText).toMatch(/^<agent_card_search_results>[\s\S]*<\/agent_card_search_results>$/);
		expect(searchText).not.toContain("# Agent Selection Profile");
		const loaded = await read.execute(
			"read-1",
			{ id: producer.id, version: producer.version },
			undefined,
			undefined,
			{} as never,
		);
		expect(loaded.content[0]).toMatchObject({ type: "text", text: renderAgentSelectionProfile(producer) });
	});

	it("filters employees by exact capability and tool intersection before ranking", async () => {
		const fixture = createCompilerFixture();
		const producer = fixture.assets.agentCards.find((card) => card.id === "producer");
		const reviewer = fixture.assets.agentCards.find((card) => card.id === "reviewer");
		if (!producer || !reviewer) throw new Error("Fixture cards are missing");
		producer.tools.push("bash");
		const tools = createAgentCardCatalogTools([producer, reviewer]);
		const search = tools.find((tool) => tool.name === "search_agent_cards");
		if (!search) throw new Error("AgentCard search tool is missing");
		const matched = await search.execute(
			"search-filtered",
			{ query: "*", capabilities_all: ["production"], tools_all: ["bash"] },
			undefined,
			undefined,
			{} as never,
		);
		const matchedText = matched.content[0]?.type === "text" ? matched.content[0].text : "";
		expect(matchedText).toContain("producer");
		expect(matchedText).not.toContain('"id":"reviewer"');
		const none = await search.execute(
			"search-none",
			{ query: "*", capabilities_all: ["review"], tools_all: ["bash"] },
			undefined,
			undefined,
			{} as never,
		);
		const noneText = none.content[0]?.type === "text" ? none.content[0].text : "";
		expect(noneText).toContain("producer");
	});
});
