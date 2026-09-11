import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AssetAssembler, hashSkillPackage, validateProcessSpecStaffing } from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

describe("AssetAssembler", () => {
	const roots: string[] = [];
	afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

	it("associates Skill allowed-tools and required-tools with the Pi Tool Registry", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-assets-"));
		roots.push(root);
		const skillDir = join(root, "skills", "analysis");
		const cardDir = join(root, "cards");
		const specDir = join(root, "specs");
		await Promise.all([skillDir, cardDir, specDir].map((path) => mkdir(path, { recursive: true })));
		await writeFile(
			join(skillDir, "SKILL.md"),
			"---\nname: analysis\ndescription: Analyze inputs.\nallowed-tools: read custom_search\nrequired-tools: custom_search\n---\n\nUse the available evidence.\n",
		);
		await writeFile(
			join(cardDir, "analyst.json"),
			JSON.stringify({
				id: "analyst",
				name: "Analyst",
				description: "Analyzes inputs",
				responsibilities: ["Analyze"],
				nonResponsibilities: [],
				capabilities: ["analysis"],
				skills: ["analysis"],
				tools: ["read", "custom_search"],
			}),
		);
		await writeFile(join(specDir, "spec.json"), JSON.stringify(createCompilerFixture().processSpec));
		const custom = defineTool({
			name: "custom_search",
			label: "Search",
			description: "Search a test corpus",
			parameters: Type.Object({ query: Type.String() }),
			async execute() {
				return { content: [{ type: "text", text: "result" }], details: {} };
			},
		});
		const loaded = loadSkillsFromDir({ dir: join(root, "skills"), source: "test" });
		const result = await new AssetAssembler().assemble({
			agentCardDirectories: [cardDir],
			processSpecDirectories: [specDir],
			skills: loaded.skills,
			tools: [custom],
			builtinToolNames: ["read"],
			hasModel: () => true,
		});
		expect(result.skillTools.analysis).toEqual(["read", "custom_search"]);
		expect(result.skills[0]).toMatchObject({
			id: "analysis",
			filePath: join(skillDir, "SKILL.md"),
			requiredTools: ["custom_search"],
		});
		expect(result.skills[0].hash).not.toBe("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
		const lockedHash = result.skills[0].hash;
		await mkdir(join(skillDir, "__pycache__"));
		await writeFile(join(skillDir, "__pycache__", "helper.cpython-314.pyc"), "derived cache");
		expect(await hashSkillPackage(skillDir)).toBe(lockedHash);
		expect(result.agentCards).toHaveLength(1);
		expect(result.processSpecs).toHaveLength(1);
	});

	it("compiles the packaged professional role library", async () => {
		const result = await new AssetAssembler().assemble({
			agentCardDirectories: [fileURLToPath(new URL("../assets/agency-role-library/agent-cards", import.meta.url))],
			processSpecDirectories: [fileURLToPath(new URL("../assets/process-specs", import.meta.url))],
			skills: [],
			tools: [],
			builtinToolNames: [
				"read",
				"write",
				"edit",
				"bash",
				"grep",
				"find",
				"ls",
				"web_search",
				"get_search_content",
				"fetch_content",
				"source_check",
			],
			hasModel: () => true,
		});
		expect(result.unavailableAgentCards).toEqual([]);
		expect(result.agentCards).toHaveLength(46);
		expect(result.agentCards).toContainEqual(
			expect.objectContaining({ id: "agency-project-management-project-shepherd" }),
		);
		expect(result.agentCards).toContainEqual(expect.objectContaining({ id: "ipd-process-selector" }));
		expect(result.agentCards).toContainEqual(
			expect.objectContaining({
				id: "agency-research-synthesist",
				tools: expect.arrayContaining(["web_search", "get_search_content", "source_check"]),
			}),
		);
		expect(result.agentCards).toContainEqual(
			expect.objectContaining({
				id: "agency-design-visual-storyteller",
				capabilities: expect.arrayContaining(["narrative-design", "presentation-production"]),
			}),
		);
		expect(result.agentCards).toContainEqual(
			expect.objectContaining({
				id: "agency-product-trend-researcher",
				capabilities: expect.arrayContaining(["evidence-review"]),
			}),
		);
		expect(result.agentCards).toContainEqual(
			expect.objectContaining({
				id: "agency-testing-evidence-collector",
				capabilities: expect.arrayContaining(["presentation-review"]),
			}),
		);
		const spec = result.processSpecs.find(
			(candidate) => candidate.process_spec_id === "project-reviewed-content-delivery",
		);
		expect(spec).toBeDefined();
		if (!spec) return;
		const cardsFor = (capabilities: readonly string[]) =>
			result.agentCards.filter((card) => capabilities.every((capability) => card.capabilities.includes(capability)));
		for (const activity of spec.required_activities)
			expect(cardsFor(activity.required_capabilities)).not.toHaveLength(0);
		for (const review of spec.required_reviews) {
			const deliverable = spec.required_deliverables.find((item) => item.deliverable_id === review.deliverable_id);
			const activity = spec.required_activities.find((item) => item.activity_id === deliverable?.activity_id);
			const producers = cardsFor(activity?.required_capabilities ?? []);
			const reviewers = cardsFor(review.reviewer_capabilities);
			expect(reviewers.some((reviewer) => producers.some((producer) => producer.id !== reviewer.id))).toBe(true);
		}
	});

	it("can staff every ProcessSpec marked executable with the default employee pool", async () => {
		const result = await new AssetAssembler().assemble({
			agentCardDirectories: [
				fileURLToPath(new URL("../assets/agent-cards", import.meta.url)),
				fileURLToPath(new URL("../assets/agency-role-library/agent-cards", import.meta.url)),
			],
			processSpecDirectories: [fileURLToPath(new URL("../assets/process-specs", import.meta.url))],
			skills: [],
			tools: [],
			builtinToolNames: [
				"read",
				"write",
				"edit",
				"bash",
				"grep",
				"find",
				"ls",
				"web_search",
				"get_search_content",
				"fetch_content",
				"source_check",
			],
			hasModel: () => true,
		});
		expect(result.agentCards).toContainEqual(expect.objectContaining({ id: "ipd-general-artifact-producer" }));
		expect(result.agentCards).toContainEqual(expect.objectContaining({ id: "ipd-general-artifact-reviewer" }));
		for (const spec of result.processSpecs.filter((candidate) => candidate.default_executable))
			expect(validateProcessSpecStaffing(spec, result.agentCards)).toEqual([]);
	});

	it("does not manufacture builtin Tool assets that are absent from Pi's registry", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-default-assets-"));
		roots.push(root);
		const result = await new AssetAssembler().assembleDefault({
			agentDir: root,
			projectRoot: root,
			projectTrusted: false,
			skills: [],
			tools: [],
			hasModel: () => true,
		});
		expect(result.tools).toEqual([]);
		expect(result.skills).toContainEqual(expect.objectContaining({ id: "process-selection" }));
		expect(result.unavailableAgentCards.length).toBeGreaterThan(0);
	});
});
