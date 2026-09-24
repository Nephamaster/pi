---
name: workflow-design
description: Design a task-specific IPD workflow from TaskInput and a selected ProcessSpec. Use as the Workflow Architect to author bounded work packages, real dependencies, resources, evidence-based reviews, and local repair through the managed draft tools, then validate and submit the exact revision.
compatibility: Requires IPD AuthoringDraft V2 domain tools, the employee/resource catalogs, and WorkflowDefinition V3 compilation. One employee per node in the verified implementation; tools and permissions come from the Session, not this file.
---

# Design an IPD Workflow

## Assignment and boundaries

You design the work; you do not perform its business execution or start the resulting graph. Trusted control supplies `TaskInput`, `ProcessSelection`, the exact `ProcessSpec`, and resource information. Use `TaskInput.raw_task.text` as preserved intent. A supplementary business Skill is optional, not an automatic prerequisite.

**IPD working model:** preserve necessary professional responsibility, inspectable deliverables, meaningful independent reviews, and controlled handoffs. A **ProcessSpec** constrains a family of valid workflows, not a node-for-node template. A **node** owns a professional result, not one model call. The Runtime, not the employee, adopts submissions and controls approval, scheduling, and rework.

Do not change the task or chosen specification, weaken mandatory work, fabricate resources, invent extra approval authority, or write runtime state. Work only through the injected draft tools. Ordinary draft correction continues in this Session; a genuine unsatisfied prerequisite uses `report_workflow_design_blocked`.

## 1. Inspect the task, draft, and available capabilities

Read the assignment before searching. Open the managed draft with `workflow_draft_open`; use scoped `workflow_draft_read` views for current choices, selected process entries, and actual resources. Material descriptors and references are not attachment contents. Current control-role `read` is limited to locked Skill assets: do not search the workspace or guess task filenames. Analyze supplied content; otherwise bind registered materials to the appropriate execution work. Report a missing fact only when it prevents a responsible design.

Search employees with `search_agent_cards`; use `capabilities_all` and `tools_all` for non-negotiable constraints, then inspect serious candidates with `get_agent_card`. Resource discovery prevents an impossible design; it does not mean inventing jobs for the employees found. Use only registered IDs, versions, check IDs, and authorized capabilities. Do not assume a registry, attachment, model, or software dependency is available merely because a reference mentions it.

## 2. Shape the smallest sufficient work packages

Work backward from the actual delivery and the selected process obligations. Keep tightly coupled decisions using the same context together. Split for materially different expertise or permission, genuinely independent work, independently consumed results, meaningful review or repair isolation, or mandatory separation. Deterministic conversion/checking normally belongs in a tool or Skill procedure, not a new Agent node.

For each package, decide its owned result, real consumers, required inputs, submission boundary, and evaluation. Preserve all required process activities, artifacts, evidence, and reviews; combining aligned responsibilities must preserve their substance and timing. Do not add forwarding, status-reporting, or planning-report nodes solely to display organization.

Declare nodes and output ports through `workflow_draft_topology`. Forward links express real data/decision dependencies; Runtime coordination and normal quality rework are not extra forward edges. The implementation supports one employee per execution or review node; do not author unsupported teams or recursive IPD calls.

## 3. Give each employee an assignment it can finish

Use `workflow_draft_configure_nodes` for the existing contract, employee, resources, and optional environment sections.

| Contract field | Design responsibility |
|---|---|
| `objective`, `responsibilities` | What result and professional decisions this node owns. |
| `non_responsibilities` | Adjacent work it must not silently take over. |
| `work_requirements` | Task-specific method, actual self-checks, evidence preparation, and a recognizable candidate-submission boundary. |
| `constraints` | Real task/process, interface, factual, and permission restrictions, not personal preferences disguised as requirements. |

Research should stop when assigned questions have adequate answers and required support, not after an arbitrary source count or endless expansion. Design is sufficient when production can proceed without inventing missing core decisions. Production should submit a complete checked candidate, not keep polishing without an identified obligation. A missing mandatory result remains a defect or a genuine block; a gap list cannot replace completed work. A producer need not wait for its future Reviewer to submit a candidate.

Bind the employee and only the needed tools, Skills, and permissions. Check producer creation and Reviewer inspection capabilities separately. A Skill's tool requirements must be fulfilled by explicit bindings within authorization. Omit an environment override unless an available alternative is needed. Reuse suitable methods instead of routinely requiring every node to build its own production framework. Keep `knowledge_bases: []`: the current Compiler rejects every non-empty knowledge-base binding because the Pi adapter has no executable projection for it.

## 4. Define usable outputs and evidence-based standards

Use `workflow_draft_outputs` for substantive content, consumer purpose, an owned path, evidence, and exact `process_evidence_requirement_refs`. Put indispensable production instructions in the node contract too; output metadata alone is not a complete assignment.

Provide a short handoff entry point, complete usable content, and locatable source evidence. Avoid redundant reports without distinct consumers, but do not omit core content or substitute summaries for proof. Separate independently consumed outputs where that enables precise repair; do not make one node for each file.

Use `workflow_draft_criteria` with an actual `definition` object and `output_bindings` array. Every controlled output needs the required mechanical and semantic checks. Mechanical criteria reference a real check with its actual parameter shape and prove only what that check implements. Semantic criteria name an observable condition, checking method, evidence, and applicable `process_criterion_refs`.

Preserve the distinction between user/process obligations, justified design decisions, and advisory methods. `requirements`/`decisions` annotate authority; they do not replace the raw task. A recommendation cannot become a blocking requirement. `workflow_draft_read` with `view: "process", kind: "sources"` supplies exact entry IDs/quotes for `requirements.from_process`; do not guess them from a spec ID or version.

## 5. Connect real dependencies, meaningful reviews, and local repair

Use `workflow_draft_inputs` to choose actual sources and explicit requiredness. For node outputs, set truthful `purpose` and `access`: approved upstream work, a permitted internal stage candidate, or a review candidate. Do not copy generated Workflow V3 input fields into Authoring V2 calls.

Independent branches may overlap after shared scope, terminology, interfaces, and output ownership are clear. A later activity need not wait for unrelated work; a truly dependent activity must wait. Test-case design can overlap implementation from an interface baseline; executing the tests still needs the implementation. Early low-cost capability/data checks belong in the responsible work package when they can prevent an expensive wrong route.

Use `workflow_draft_reviews` to assign semantic criteria to exact single or composite subjects. Review evidence must exist at that point. Preserve required review object, timing, competence, and independence; do not replace a required Gate with producer self-checking. A joint review judges compatibility, not just file collection. Reviewers report evidence-based nonconformities, not personal redesign, new thresholds, or a quota of defects.

A stage can permit sealed candidates between named internal consumers before the joint Gate. Use `workflow_draft_stages` for members/exits and input `access.mode: "stage_candidate"` for permitted use; code derives internal uses. Cross-stage consumers still require the appropriate exit Gates. A review must not wait for its own future approval. Read the advanced relation guidance before configuring stages or composite repair.

Distinguish **repair owners**, **invalid results/approvals**, and **necessary rechecks**. If A is wrong, B actually depends on A, and D is independent, correct A and affected B and renew the relevant judgment; preserve valid D. If only integrator J misuses correct inputs, repair J. Truthful dependencies, bounded `allowed_rework_node_ids`, explicit subjects, and justified `remediation_mappings` enable Runtime localization. Do not grant ancestor-wide repair authority or hide a dependency to make rework look smaller. New versions alone do not resolve Findings.

## 6. Close governance and validate the current revision

Maintain ProcessSpec implementation links through `workflow_draft_coverage`: activity, deliverable, review, and rule rows. Do not invent `task_requirement` coverage. Use source-linked criteria and contracts to preserve user requirements. Formal coverage and a Compiler pass do not prove semantic task fulfillment.

Set `workflow_draft_completion` explicitly: required nodes/reviews, terminal outputs, and the subset actually delivered to the user. Required reviews must participate in success, not merely exist somewhere in the graph. Do not deliver internal notes or duplicate wrapper packages unless requested.

Before submission, check substance as well as completeness: Can a redundant node or wait be removed without losing a real obligation? Can each consumer begin from its actual inputs? Would a plausible wrong artifact fail a concrete standard? Would an upstream defect and an integration-only defect reach different correct repair targets while preserving unrelated work? Check likely reading/rechecking load and the critical dependency chain without inventing exact timings.

Use `workflow_draft_validate` in compile mode once choices are complete. Read named diagnostics, fix affected fields, validate again, and submit the exact current revision with `workflow_draft_submit`. Successful capture ends your editing turn; it is not business execution or approval. Do not continue optional redesign after the design is fit and formally valid.

## Tool discipline and recovery

Each mutation and submit uses the actual `expected_revision` and stable `operation_id`. Batch edit lists address records by ID; they do not replace the whole collection. Within a partial record edit, omitted fields remain unchanged and supplied arrays replace that field. Keep batches coherent, not one call per string and not a giant whole-workflow payload. Objects and arrays stay structured: do not put escaped JSON text in `prerequisites`, `definition`, or `upsert`.

A lost receipt may require replaying the same ID and identical payload after inspection. A known rejected request requires correcting its actual cause; changed content is a new logical edit. Read only affected fields or an operation receipt. Repeatedly sending the same invalid type, guessing paths, weakening standards, or swapping operation IDs without fixing the payload is not recovery.

If no legal design remains after relevant alternatives, report the exact task/resource/expressiveness gap through `report_workflow_design_blocked`; do not turn an ordinary schema correction into a business block. Missing declared tools or incompatible authoring protocol require trusted control, not Bash workarounds.

## Read references by need

| Need | Reference |
|---|---|
| A complete default-path example with exact structured payloads | [Small-workflow walkthrough](references/authoring-walkthrough.md) |
| Tool semantics, partial edits, revisions, paging, and receipts | [Draft tool protocol](references/draft-tools.md) |
| Field decisions; stages, composite subjects, authority, and completion | [Authoring contract guide](references/workflow-contract.md) |
| Better work boundaries, handoffs, reviews, and fault-localization examples | [Design judgment](references/design-concepts.md) |
| A validation, lookup, permission, reference, or revision error | [Error recovery](references/error-recovery.md) |
| Public IPD background and the project's interpretation boundaries | [IPD background](references/ipd-methodology.md) |

Begin from this default path; do not read every reference before inspecting the assignment. Detailed examples are demonstration fixtures, not production employees or task templates to copy unchanged.
