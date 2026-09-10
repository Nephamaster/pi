# WorkflowDefinition Contract Checklist

This reference explains **how to fill the concrete Workflow configuration**.

For the meaning of IPD, ProcessSpec, nodes, dependencies, parallelism, and rework, first read [Design Concepts and Judgment Principles](design-concepts.md).

The current Schema exposed by the draft tools is the final authority for actual fields.

Do not copy this entire document into node prompts.

## 1. Header, Identity, and Resources

The header contains only:

- `schema_version`;
- `workflow_id`;
- `workflow_version`;
- `name`.

Trusted `task_input_ref` and `process_selection_ref` are filled by the draft manager.

The Workflow Designer does not calculate their trusted hashes.

Custom node, criterion, output, and participant IDs should be stable and begin with a letter, using only:

- letters;
- digits;
- `.`;
- `_`;
- `-`.

When referencing existing IDs from TaskInput, ProcessSpec, AgentCard, etc., copy them exactly.

The current implementation binds one employee per node.

A participant definition contains:

- `participant_id`;
- `agent_ref(id/version)`;
- `required_capabilities`;
- `skills`;
- `tools`;
- `knowledge_bases`;
- `permissions`.

Skill and Tool references must use real registered IDs.

AgentCard and Knowledge Base references use exact versions.

Do not add Schema fields such as:

- ad-hoc `model`;
- custom hashes;
- free-text prompt bypass fields.

Model selection is resolved from the employee asset and Run configuration.

AgentCard professional Skills do not mean every node automatically loads all Skills.

Bind only the methods the node actually needs.

Tools and Knowledge Bases must also exist and remain within the employee asset's authorization boundary.

## 2. Node Work Contract

| Field | Meaning |
|---|---|
| `objective` | The concrete result this work package must achieve; should be possible to judge completion. |
| `responsibilities` | Specific responsibilities this node must own. |
| `non_responsibilities` | Adjacent work that this node explicitly does not own, preventing responsibility drift. |
| `work_requirements` | Task-specific requirements for input handling, work method, delivery, and self-checking. |
| `constraints` | Hard constraints derived from TaskInput and ProcessSpec, including scope, factual, permission, and evidence constraints. |

Node-specific stable instructions belong in `contract.work_requirements` or `contract.constraints`.

Do not create a free-text prompt side channel.

Generic professional principles from AgentCard also do not automatically become node acceptance criteria.

## 3. Inputs, Outputs, and Paths

### Task Material Input

Use `kind=task_material`.

Provide:

- `input_id`;
- `material_id`;
- `required`.

`material_id` must exist in `TaskInput.materials`.

A required material whose ID exists but whose content cannot actually be read is not satisfied.

### Node Output Input

Use `kind=node_output`.

Provide:

- `input_id`;
- `source.node_id`;
- `source.output_id`;
- `required`;
- `availability`;
- `approval_review_node_ids`.

Execution nodes consuming controlled upstream work should use `approved` and list the exact review nodes responsible for approval of that output.

A review node reading the candidate it reviews should use `submitted`.

A review must not require its own approval before it can start.

Do not mark a genuinely required input as `required=false` merely to avoid blocking.

### Execution Outputs

Each output includes:

- `output_id`;
- `artifact_type`;
- `description`;
- `business_purpose`;
- `path_prefix`;
- `evidence_requirements`;
- `criterion_refs`.

`path_prefix` is a relative path under the shared Run workspace, not the sealed Submission directory.

Use normalized relative paths:

- no `..`;
- no trailing `/`.

A good default is one owned root such as:

```text
outputs/<node_id>
```

Different execution-node write roots must not be equal or parent/child of one another.

Review nodes must use:

```text
write_paths = []
external_actions = false
```

If tests, renders, caches, or review-support derivatives require writing files, assign that work to a writable execution node instead of widening Reviewer permissions.

## 4. Criteria, Review, and Rework

### Mechanical Criterion

Fields include:

- `criterion_id`;
- `description`;
- `check_id`;
- `parameters`;
- `evidence_requirements`.

`check_id` and its parameter Schema must come from the real mechanical-check catalog.

Mechanical checks may claim only what they actually validate.

For example, `artifact-integrity` must not be described as proving business correctness, factual correctness, or visual quality if it does not implement those checks.

### Semantic Criterion

Fields include:

- `criterion_id`;
- `description`;
- non-empty `evidence_requirements`.

A semantic criterion should state:

- the judgment object;
- the acceptable condition;
- required verification;
- required evidence.

Define each standard once, then reference it from outputs, reviews, and coverage.

Do not create slightly different versions of the same criterion in multiple places.

### Review

`review.targets` precisely identifies:

- `node_id`;
- `output_id`;
- semantic criteria to evaluate.

Every semantic criterion must have real Reviewer coverage.

`allowed_rework_node_ids` should contain only execution nodes actually responsible for correcting potential defects.

Do not add:

- voting;
- dynamic Reviewer replacement;
- budget thresholds;
- arbitrary script-based routing

as first-version workflow control.

## 5. Requirement Coverage

`requirement_coverage.source` must be one of:

- `task_requirement`;
- `process_activity`;
- `process_deliverable`;
- `process_review`;
- `process_rule`.

Each coverage record should truthfully include:

- `requirement_id`;
- `responsible_node_ids`;
- `output_refs`;
- `criterion_refs`.

A ProcessSpec required activity should be owned by an execution node with appropriate capability.

A required deliverable should map to a real output.

A required review should map to a review node with the required professional capability and independence.

Natural-language quality requirements must be instantiated as actual criteria.

Merely placing the ProcessSpec ID in coverage is not sufficient.

## 6. Completion and User Delivery

`completion` contains four non-empty groups:

- `required_node_ids` — nodes that must complete for Run success;
- `final_outputs` — internal terminal artifacts that must exist and satisfy requirements;
- `delivery_outputs` — outputs actually delivered to the user, and must be a subset of `final_outputs`;
- `required_review_node_ids` — reviews that must succeed for final success.

Internal evidence, source records, design specifications, and validation reports may be necessary final outputs without being user-facing delivery outputs.

Only files the user should actually receive belong in `delivery_outputs`.

If the user limits the number or type of final files, obey that constraint.

Do not deliver both:

- a final artifact; and
- another wrapper package containing a duplicate of the same artifact

unless the user actually asked for both.

Do not expand the final user-facing file set merely because internal process traceability requires more artifacts.
