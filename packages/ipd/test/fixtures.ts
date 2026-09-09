import {
	CheckExecutorRegistry,
	compileAgentCard,
	createArtifactIntegrityCheckExecutor,
	hashJson,
	type ProcessSelection,
	type ProcessSpec,
	type TaskInput,
	type WorkflowDefinition,
} from "../src/index.ts";

const hash = "a".repeat(64);

export function createValidWorkflow(): WorkflowDefinition {
	return {
		schema_version: 2,
		workflow_id: "example-workflow",
		workflow_version: "1.0.0",
		name: "Example Workflow",
		task_input_ref: { id: "task-1", hash },
		process_selection_ref: { id: "selection-1", hash },
		nodes: [
			{
				kind: "execution",
				node_id: "produce",
				name: "Produce",
				agents: [
					{
						participant_id: "producer",
						agent_ref: { id: "producer", version: "1.0.0" },
						required_capabilities: ["production"],
						skills: [],
						tools: [],
						knowledge_bases: [],
						permissions: {
							read_paths: ["."],
							write_paths: ["outputs/produce"],
							external_actions: false,
						},
					},
				],
				contract: {
					objective: "Produce the requested result",
					responsibilities: ["Create the result"],
					non_responsibilities: ["Approve the result"],
					work_requirements: ["Use the supplied material"],
					constraints: [],
				},
				inputs: [{ kind: "task_material", input_id: "source", material_id: "brief", required: true }],
				outputs: [
					{
						output_id: "content-output",
						artifact_type: "text-bundle",
						description: "Produced content",
						business_purpose: "Satisfy the task",
						path_prefix: "outputs/produce",
						evidence_requirements: ["Source references"],
						process_evidence_requirement_refs: ["content.evidence.1"],
						criterion_refs: ["integrity", "quality"],
					},
				],
			},
			{
				kind: "review",
				node_id: "review-produce",
				name: "Review Produce",
				agents: [
					{
						participant_id: "reviewer",
						agent_ref: { id: "reviewer", version: "1.0.0" },
						required_capabilities: ["review"],
						skills: [],
						tools: [],
						knowledge_bases: [],
						permissions: {
							read_paths: ["outputs/produce"],
							write_paths: [],
							external_actions: false,
						},
					},
				],
				contract: {
					objective: "Independently review the result",
					responsibilities: ["Evaluate the quality criterion"],
					non_responsibilities: ["Modify the produced files"],
					work_requirements: ["Cite evidence for the conclusion"],
					constraints: ["Do not modify the reviewed submission"],
				},
				inputs: [
					{
						kind: "node_output",
						input_id: "candidate",
						source: { node_id: "produce", output_id: "content-output" },
						required: true,
						availability: "submitted",
						approval_review_node_ids: [],
					},
				],
				targets: [{ node_id: "produce", output_id: "content-output", criterion_refs: ["quality"] }],
				allowed_rework_node_ids: ["produce"],
			},
		],
		criteria: [
			{
				kind: "mechanical",
				criterion_id: "integrity",
				description: "Files match their manifest",
				check_id: "artifact-integrity",
				parameters: {},
				evidence_requirements: [],
			},
			{
				kind: "semantic",
				criterion_id: "quality",
				description: "The result satisfies the task",
				evidence_requirements: ["Specific findings"],
				process_criterion_refs: ["content-review.criterion.1"],
			},
		],
		requirement_coverage: [
			{
				source: "task_requirement",
				requirement_id: "deliver-result",
				responsible_node_ids: ["produce", "review-produce"],
				output_refs: [{ node_id: "produce", output_id: "content-output" }],
				criterion_refs: ["quality"],
			},
			{
				source: "process_activity",
				requirement_id: "produce",
				responsible_node_ids: ["produce"],
				output_refs: [{ node_id: "produce", output_id: "content-output" }],
				criterion_refs: [],
			},
			{
				source: "process_deliverable",
				requirement_id: "content",
				responsible_node_ids: ["produce"],
				output_refs: [{ node_id: "produce", output_id: "content-output" }],
				criterion_refs: ["integrity", "quality"],
			},
			{
				source: "process_review",
				requirement_id: "content-review",
				responsible_node_ids: ["review-produce"],
				output_refs: [{ node_id: "produce", output_id: "content-output" }],
				criterion_refs: ["quality"],
			},
		],
		completion: {
			required_node_ids: ["produce", "review-produce"],
			final_outputs: [{ node_id: "produce", output_id: "content-output" }],
			delivery_outputs: [{ node_id: "produce", output_id: "content-output" }],
			required_review_node_ids: ["review-produce"],
		},
	};
}

export function createCompilerFixture() {
	const taskInput: TaskInput = {
		schema_version: 1,
		task_input_id: "task-1",
		raw_task: { text: "Create a reviewed deliverable", source: "user-message:1" },
		objectives: [],
		requirements: [
			{
				requirement_id: "deliver-result",
				statement: { text: "Deliver a reviewed result", source: "user-message:1" },
			},
		],
		materials: [{ material_id: "brief", description: "Task brief", reference: "user-message:1" }],
		unresolved_facts: [],
	};
	const processSpec: ProcessSpec = {
		schema_version: 2,
		process_spec_id: "delivery-process",
		version: "1.0.0",
		name: "Delivery Process",
		description: "Produce and independently review a deliverable",
		source: "project-defined",
		default_executable: true,
		applicable_when: ["The task requires a reviewed deliverable"],
		not_applicable_when: [],
		required_activities: [
			{ activity_id: "produce", description: "Produce the deliverable", required_capabilities: ["production"] },
		],
		required_deliverables: [
			{
				deliverable_id: "content",
				activity_id: "produce",
				artifact_type: "text-bundle",
				description: "Reviewed content",
				evidence_requirements: [
					{
						evidence_requirement_id: "content.evidence.1",
						description: "Source references",
					},
				],
			},
		],
		required_reviews: [
			{
				review_id: "content-review",
				deliverable_id: "content",
				description: "Independent content review",
				reviewer_capabilities: ["review"],
				independent_agent: true,
				criteria: [
					{
						process_criterion_id: "content-review.criterion.1",
						description: "The content satisfies the task",
					},
				],
			},
		],
		workflow_rules: [],
	};
	const processSelection: ProcessSelection = {
		schema_version: 1,
		process_selection_id: "selection-1",
		run_id: "run-1",
		task_input_ref: { id: taskInput.task_input_id, hash: hashJson(taskInput) },
		process_spec_ref: {
			id: processSpec.process_spec_id,
			version: processSpec.version,
			hash: hashJson(processSpec),
		},
		rationale: "The selected process requires production and independent review",
		task_requirement_refs: ["deliver-result"],
		process_requirement_refs: ["produce", "content", "content-review"],
		unresolved_fact_refs: [],
	};
	const workflow = createValidWorkflow();
	workflow.task_input_ref = { id: taskInput.task_input_id, hash: hashJson(taskInput) };
	workflow.process_selection_ref = { id: processSelection.process_selection_id, hash: hashJson(processSelection) };
	const cardContext = {
		skillNames: new Set<string>(),
		toolNames: new Set(["read"]),
		hasModel: () => true,
	};
	const producer = compileAgentCard(
		{
			id: "producer",
			name: "Producer",
			description: "Produces task deliverables",
			responsibilities: ["Produce content"],
			nonResponsibilities: ["Approve own content"],
			capabilities: ["production", "review"],
			permissions: { workspace: "write", readScopes: ["."], writeScopes: ["outputs/produce"] },
		},
		"producer.yaml",
		cardContext,
	).value!;
	const reviewer = compileAgentCard(
		{
			id: "reviewer",
			name: "Reviewer",
			description: "Reviews task deliverables",
			responsibilities: ["Review content"],
			nonResponsibilities: ["Modify reviewed content"],
			capabilities: ["review"],
			permissions: { workspace: "read", readScopes: ["outputs/produce"], writeScopes: [] },
		},
		"reviewer.yaml",
		cardContext,
	).value!;
	const checks = new CheckExecutorRegistry();
	checks.add(createArtifactIntegrityCheckExecutor());
	return {
		runId: "run-1",
		taskInput,
		processSelection,
		processSpec,
		workflow,
		assets: { agentCards: [producer, reviewer], skills: [], tools: [], knowledgeBases: [], checks },
	};
}
