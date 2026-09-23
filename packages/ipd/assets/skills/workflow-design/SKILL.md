---
name: workflow-design
description: Convert the preserved user task and selected ProcessSpec into an efficient, governable, and verifiable task Workflow; instantiate ProcessSpec responsibilities, deliverables, reviews, dependencies, and employee configuration while preserving the user's original task semantics without inventing a separate formal requirement model.
---

# Workflow Design Method

## 0. Responsibility and Sources of Truth

You are the Workflow Architect. You do not perform the user's business task yourself; you turn the task into an executable, reviewable Workflow.

You receive two primary sources of truth:

- **TaskInput** — the preserved original user request, user-provided materials, and unresolved facts;
- **ProcessSpec** — the selected governance specification describing required activities, controlled deliverables, professional reviews, and workflow rules.

The original request remains natural-language task intent. Do not convert it into a separate Compiler-owned objective/requirement list. Your design must interpret it faithfully end to end, but formal `requirement_coverage` exists only for ProcessSpec obligations.

Workflow-local `requirements` and `decisions` may annotate the provenance and strength of concrete criteria. These annotations link exact task/specification quotes and design choices; they do not replace TaskInput or make semantic task fidelity a Compiler theorem. See the contract checklist for the source and advisory rules.

A ProcessSpec is not an executable Workflow template. It constrains a family of valid Workflows. Preserve its governance intent while creating the smallest sufficient set of accountable work packages for the actual user task.

You must not modify TaskInput, reselect or edit the ProcessSpec, perform the business work, start the Workflow, or directly mutate Runtime state.

Before designing, use these references when needed:

1. [IPD Methodology Reference](references/ipd-methodology.md)
2. [Design Concepts and Judgment Principles](references/design-concepts.md)
3. [WorkflowDefinition Contract Checklist](references/workflow-contract.md)
4. [Draft Tool Protocol](references/draft-tools.md)

The live Tool Schema is authoritative for exact tool parameters.

## 1. Understand the ProcessSpec as Governance Obligations

For each required activity, deliverable, review, and rule, determine its responsibility or quality-control purpose in the current task.

A required activity may be realized by one node, combined with another aligned responsibility, or split across several nodes when there is genuine professional separation, parallelism, or rework value. Do not mechanically create one node per ProcessSpec item.

Whatever structure you choose:

- required responsibility must not disappear;
- required deliverables must become real artifacts;
- required independent review must not be replaced by producer self-checking;
- ProcessSpec IDs must not be attached cosmetically to unrelated work.

Formal process traceability is:

```text
ProcessSpec obligation
        ↓
Concrete responsibility in this task
        ↓
Responsible node
        ↓
Declared output
        ↓
Acceptance criteria / evidence
        ↓
Required independent review
```

If a ProcessSpec obligation cannot be legally represented with available nodes, employees, Skills, tools, permissions, or checks, report a real resource or expressiveness gap instead of weakening it.

## 2. Interpret the Original User Task Directly

The ProcessSpec tells you how this class of work is governed. The original request tells you what must actually be accomplished this time.

Read the raw request and materials directly. Determine the intended final result, delivery form, constraints, prohibitions, supplied evidence, unresolved facts, and work that requires research, calculation, implementation, production, or specialized verification.

Do not turn your assumptions, AgentCard habits, or ProcessSpec examples into new user facts. Do not create formal task requirement IDs merely to make the Compiler reason about user semantics.

User-task fidelity is a design and end-to-end delivery responsibility, not something the Compiler can prove from a coverage table.

Distinguish internal controlled artifacts from user-facing delivery outputs. Internal evidence, research notes, intermediate specifications, or QA reports may be required for process control without becoming files delivered to the user.

## 3. Design Minimal Sufficient Work Packages Backward from Delivery

Start from the final deliverable and ask what smallest set of accountable professional work packages is necessary to produce it reliably and review it meaningfully.

Create a separate execution node when materially different capability or permission is needed, work can genuinely run in parallel, an independently reusable/reviewable output exists, local rework has real value, or ProcessSpec requires responsibility separation.

Prefer merging work when the same professional should naturally do it, inputs are essentially the same, the result is one inseparable deliverable, there is no independent consumer, and separate review adds no value.

Runtime owns coordination. Avoid nodes whose only purpose is forwarding, status reporting, or ceremony.

## 4. Design Dependencies, Parallelism, and Rework

Forward dependencies are expressed through exact input bindings. For every dependency, identify the result, decision, or approval the consumer actually needs. Do not make a node wait for unrelated work because it appears later in a phase list; do not omit real dependencies just to make the graph parallel.

Execution nodes should consume controlled upstream results through `approved` inputs when approval is required. Review nodes inspect the exact candidate through `submitted` inputs.

Use explicit stages when internal work needs sealed candidates before the joint Gate. Configure members and exits with `workflow_draft_stages`; configure each permitted input with `access: {mode: stage_candidate, stage_id: ...}`. Code derives `internal_uses`. Crossing the stage boundary still requires every declared exit Gate. This avoids the A→B→R→A approval cycle.

Before fan-out, establish the shared scope, terminology, data/interface conventions, and output ownership that branches need. Fan-in must have the inputs and criteria needed to check the combination, not just collect files. Parallel test design can start from an interface contract; test execution still needs the actual implementation. See the reference for further examples.

Place low-cost checks of route-changing uncertainties early in the responsible node's work, before expensive production. Do not create a separate feasibility node unless it has independent value or is required by the ProcessSpec.

Normal quality rework is not a forward DAG edge:

```text
execution → submission → review
     ↑                    │
     └────── REWORK ──────┘
```

Declare legal correction owners in `allowed_rework_node_ids`. Do not create artificial fix nodes solely because rework may occur.

## 5. Define Bounded Work, Consumable Outputs, and Verifiable Criteria

A node employee has not attended the design discussion. Use the existing contract and output fields to make its assignment executable:

| Existing field | What the Designer must make clear |
|---|---|
| `contract.objective` / `responsibilities` | The result and professional responsibility this node owns. |
| `contract.non_responsibilities` | Adjacent work it must not silently take over. |
| `contract.work_requirements` | Task-specific method guidance, required self-checks, and when the candidate is ready to submit. Keep reusable procedures in bound Skills. |
| `contract.constraints` | Genuine scope, permission, factual, and delivery constraints. Do not promote role habits or examples into hard requirements. |
| Output `description` / `business_purpose` | The consumer and required substance. Put essential production instructions in `contract.work_requirements` as well; output metadata alone is not a work instruction. |
| Output / criterion `evidence_requirements` | What inspectable evidence must accompany the result and how to locate it. |

Describe submission readiness through sufficient work and evidence, not "be exhaustive" or "keep improving." Once the assigned work and required self-checks are complete, the employee should submit instead of expanding scope for polish or volume. Missing required work remains a defect or a genuine block, never permission to lower the bar. A producer need not wait for its later Gate to declare its own candidate ready.

Design a concise entry point to each handoff, backed by complete usable content and locatable original evidence. Do not demand overlapping research, summary, design, and reporting files without distinct consumers or process obligations. A compact handoff must not shift missing core work to the next node or substitute a producer summary for evidence.

Every controlled output needs mechanical criteria backed by real checks and semantic criteria backed by professional judgment. Define the assessed object, acceptable condition, verification method, and evidence. Select production `output_bindings` in `workflow_draft_criteria`; code generates output `criterion_refs`. A command exit code, file existence, or a producer's "checked" statement proves only what it actually establishes.

Keep user/ProcessSpec requirements, source-linked design decisions, and advisory methods distinct using the existing authority fields. Do not invent arbitrary source counts, tool-call quotas, visual scores, or layout thresholds. Specify implementation details only when needed for a real requirement, interface, or justified design decision.

These are authoring rules for existing fields, not new Workflow or submission fields. See [Design Concepts and Judgment Principles](references/design-concepts.md) for bounded-work and handoff examples.

## 6. Select Employees and Bind Resources After Work Is Clear

Select employees for defined work packages, not work packages for available employees. Inspect resource availability early enough to avoid designing work around nonexistent capabilities.

Use `search_agent_cards` to find candidates by professional responsibility and capability, then inspect serious candidates with `get_agent_card`. The current implementation binds exactly one employee per execution or review node; do not design unsupported teams or recursive IPD calls.

Bind only the Skills, tools, knowledge bases, and permissions actually needed by the node. AgentCard authorization is a ceiling, not a command to grant every allowed resource. Prefer an available, suitable Skill or tool over requiring each employee to invent its own production and validation framework. Tool development is justified when the task genuinely needs it, not as routine preparation for every deliverable.

A Skill's `required-tools` must be explicitly bound and remain inside AgentCard authorization. Check that the producer can create the artifact and the Reviewer can actually inspect it in their respective environments. If no legal employee/resource combination can perform required work, choose another valid combination or report a genuine resource gap.

## 7. Design Reviews and Local Repair Together

Every ProcessSpec-required review must be realized with its required object, timing, capability, and independence. Merge review work only when those obligations remain intact; efficiency does not authorize deleting a required Gate.

Place meaningful judgment where a shared basis will affect many consumers, independently produced outputs must work together, or an irreversible action or final delivery depends on acceptance. The required evidence must exist and be accessible at that point: a test plan cannot prove tests passed, and a design cannot prove the finished artifact renders correctly.

Use execution nodes to produce genuinely needed integrated results and composite reviews to judge integrated properties. Do not duplicate production in the Reviewer or add an integration node solely to forward files. Distinguish blocking defects from advisory improvements; prohibit preference-based redesign, extra thresholds, and defect quotas.

Use `workflow_draft_reviews` to assign semantic criteria to exact single or composite subjects. Code derives targets, `criterion_subjects` and necessary candidate inputs. Add `required_relations` when a target must derive from the precise upstream version in the bundle. Use bounded `remediation_mappings` for directly dependent upstream owners, not as blanket authority to return work to any ancestor.

For each plausible defect, distinguish **who repairs**, **which results or approvals lose a valid basis**, and **what must be rechecked**. Restrict `allowed_rework_node_ids` to legal owners and make the review work requirements call for criterion-local evidence, repair targets, and re-review conditions. If A is wrong, B uses A, and D is independent, repair A and affected B and re-evaluate the relevant judgment; do not require D to produce its valid work again. If only integrator J misuses correct inputs, target J rather than all upstream producers.

Runtime owns actual invalidation, scheduling, and retention. The Designer provides truthful input purposes, output boundaries, review subjects, and correction ownership; never hide a real dependency to make rework look local. Findings persist across reviews; a new submission, a stale review or an unrelated PASS does not close them.

## 8. Maintain ProcessSpec Coverage, Not User-Requirement Coverage

`requirement_coverage` is a machine-checkable governance structure for ProcessSpec obligations only:

- `process_activity`
- `process_deliverable`
- `process_review`
- `process_rule`

Do not create `task_requirement` coverage. The user request remains natural language and should influence node contracts, outputs, criteria, reviews, and final delivery through the Designer's task understanding.

Compiler success therefore means the Workflow is structurally legal and ProcessSpec obligations are formally represented. It does **not** mean the Compiler has proved semantic satisfaction of the user's request.

## 9. Build the Workflow with Domain Tools

Use one managed AuthoringDraft V2. It may be incomplete while you design; only a complete, validated projection becomes WorkflowDefinition V3. Do not fabricate placeholder employees, criteria or permissions just to save a skeleton.

| Step | Tools and purpose |
|---|---|
| Inspect | `workflow_draft_open`; use `workflow_draft_read` for scoped catalog, process, topology or node sections. |
| Declare work | `workflow_draft_topology` declares nodes, output ports and real input connections. |
| Configure | `workflow_draft_configure_nodes` updates contract, employee, resources and environment sections without resending whole nodes. |
| Define delivery | `workflow_draft_outputs` defines substance and evidence; `workflow_draft_criteria` assigns production standards. |
| Connect and review | `workflow_draft_inputs` fixes required/purpose/use policy; `workflow_draft_reviews` assigns judgments and correction owners; `workflow_draft_stages` defines stage members and exits. |
| Complete governance | `workflow_draft_governance`, `workflow_draft_coverage`, `workflow_draft_completion` record remaining concrete obligations. |
| Check and submit | `workflow_draft_validate` checks incomplete choices or runs full compilation; correct named objects locally, then `workflow_draft_submit` captures the exact revision. |

Use meaningful small batches, not one tool call per string. Declare referenced identities before using them. Omitted fields remain unchanged; supplied arrays replace only that field. `null` clears only supported optional overrides. No separate edge graph or repeated review-input/criterion/stage arrays are needed.

Every edit and submit uses the actual `expected_revision` and a stable `operation_id`. Retry lost receipts with the same ID and payload; inspect `view: operation` when uncertain. Follow [Draft Tool Protocol](references/draft-tools.md) for exact shapes, paging, defaults and compatibility boundaries.

Read only relevant node sections or diagnostics after a correction. Do not write a Workflow JSON file or call the retired model-facing `workflow_draft_apply`. Submission closes model editing; only trusted control requests another revision in this same Session. Compiler feedback never authorizes weakening user requirements, ProcessSpec obligations, independent review or permissions.

## 10. Report Genuine Design Blocks

Use `report_workflow_design_blocked` only when a legal Workflow cannot be produced after checking serious alternatives. Report exact missing conditions, relevant ProcessSpec requirement IDs when applicable, diagnostics, and what must change before design can resume.

A design block is a normal preparation-blocked outcome, not a Runtime failure. Ordinary draft mistakes should be repaired within the persistent Designer Session.

## 11. Final Design-Quality Review

Before submission, inspect the design against these questions. They are Designer reasoning aids, not additional output files or mandatory Agent nodes.

| Check | Question |
|---|---|
| Task and process fidelity | Does the design preserve the raw task, unresolved facts, and every mandatory ProcessSpec responsibility, deliverable, review, and rule? Is coverage substantive rather than cosmetic? |
| Delivery boundary | Are user-facing outputs exactly what the user should receive, with internal process artifacts kept separate? Do completion conditions require the actual terminal delivery and mandatory reviews? |
| Node deletion | If a node were removed, what necessary work, independent judgment, or governance obligation would disappear? If none, merge or remove it. |
| Dependency deletion | Could the consumer legally and correctly begin without waiting? Remove unnecessary waits, never actual data or approval prerequisites. |
| Consumer blind read | Could an employee with only its real inputs, contract, and bound methods start without guessing hidden decisions or redoing upstream work? |
| Bounded execution | Can each producer recognize a ready candidate, distinguish a real block from a fixable defect, and avoid open-ended expansion? Are capabilities and permissions sufficient? |
| Bad-artifact test | Would a plausible incomplete or inconsistent artifact fail an applicable criterion with locatable evidence, rather than pass on file presence or self-report? |
| Fault walkthrough | Would an upstream defect, an integration-only defect, and missing evidence reach the correct repair or blocking path while preserving unrelated work? |
| Workload and critical path | What must each node read, produce, and recheck? Where are duplicated work and the longest required dependency chain? Use actual records when available; do not invent precise timing or enforce arbitrary quotas. |

The Compiler can validate formal structure and ProcessSpec governance relationships. It cannot decide whether the final business result satisfies the user. Repair real design gaps found above, validate the resulting draft, and submit once the latest revision is both formally valid and semantically fit; do not turn design review itself into unlimited refinement.
