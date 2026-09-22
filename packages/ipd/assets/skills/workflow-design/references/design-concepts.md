# Design Concepts and Judgment Principles

This reference explains common IPD and graph-execution terms used during Workflow design.

You only need a practical understanding. You do not need graph-theory knowledge or Runtime implementation details. The examples below are design aids, not mandatory artifacts, numerical quotas, or new Schema fields.

## 1. Relationship Between IPD, ProcessSpec, and Workflow

The point of IPD is not to "split a task into more steps."

Its purpose is to reduce error accumulation and late rework in long, cross-functional work through:

- explicit responsibility;
- structured deliverables;
- cross-functional collaboration;
- staged quality review.

In this system:

- **ProcessSpec** is the process governance specification for a class of tasks;
- **WorkflowDefinition** is the concrete execution design for one current TaskInput;
- **Runtime** executes the frozen Workflow, controls state, versions, approval, and rework; Agents do not directly control the global process.

A ProcessSpec is not a fixed Workflow.

It describes how this class of task should be organized so that key responsibility and quality control are not lost.

Therefore, Workflow design is neither:

```text
Turn each ProcessSpec line into a node
```

nor:

```text
Freely design a Workflow and attach coverage IDs later
```

It is:

```text
Preserve ProcessSpec responsibility / deliverable / review semantics
                             +
             Use TaskInput to define concrete work packages
                             ↓
               Produce this task's WorkflowDefinition
```

## 2. Execution Node

An execution node is a **professional work package accountable for a specific result**.

A good execution node normally has:

- a clear objective;
- exact inputs;
- one capable responsible employee;
- a concrete output;
- acceptance criteria fixed in advance;
- limited and explicit write permission.

A node is not "one model call."

The persistent Session for one node may contain:

- multiple reasoning steps;
- tool calls;
- submission correction;
- formal quality rework.

### Size Work Packages by Responsibility, Not by Actions

Keep work together when it depends on the same core context, needs tightly coupled professional decisions, and produces one inseparable result. Split it when different expertise or permissions, meaningful parallelism, independent consumption, or useful repair isolation justifies the handoff.

Searching, reading, calculating, and writing may all serve one research responsibility. A deterministic format conversion or fixed check normally belongs in an authorized tool/Skill procedure, not a new Agent node. Use explicit outputs with distinct owned paths for independently consumed results when useful; do not create a node for every file or job title.

Ask what would have to change together after a defect. Separate genuinely independent results so they can be referenced and preserved independently; do not split tightly coupled work merely to show more roles.

### Write a Contract with a Submission Boundary

Use `objective`, `responsibilities`, `non_responsibilities`, `work_requirements`, and `constraints` to answer: what is owned, what inputs are valid, what remains a professional choice, and when the candidate is ready. Reusable working methods belong in Skills. A sequence of required tool calls is justified only by actual task, interface, or safety needs.

Example of an open-ended assignment:

> Research the topic comprehensively, find many sources, and repeatedly improve a detailed report.

A bounded alternative, adapted to the actual task:

> Answer the specified decision questions using authorized sources. Deliver substantive conclusions, locatable support for material claims, and explicit conflicts or limitations. Submit when the required questions have adequate answers and evidence, with material conflicts resolved or disclosed as the frozen contract permits. Do not continue searching merely to increase the source count. If a missing prerequisite prevents a valid answer after reasonable authorized attempts, report that concrete block; a gap list is not a completed analysis.

Equivalent boundaries in other work:
- Design is ready when the producer can implement the required result without inventing missing core decisions, not when every aesthetic detail is enumerated.
- Production is ready when the complete candidate meets its assigned self-checks and evidence requirements, not when no further polish is imaginable.
- Verification is complete when assigned checks have truthful results and limitations, even when they establish that the tested product is defective. A complete test report is not a product release.

These are candidate-submission conditions, not permission for the producer to approve downstream use.

## 3. Review Node / Gate

A review node represents independent quality judgment.

It reads an exact Submission version and evidence, then evaluates frozen semantic criteria.

Review does not exist merely to "read it again" or "find some problems."

It ensures that:

- a producer cannot approve itself through a completion claim;
- downstream work satisfies its declared candidate-use or Gate-release conditions;
- defects can be mapped to a criterion, output, and responsible rework owner.

Independence is checked against actual scoped participants, Sessions and production contributions. Independent instances may share a capable AgentCard; changing a role label does not erase production involvement.

The current implementation binds one employee per review node.

Choose the review point by the risk it controls and the evidence available there. A shared factual/interface basis may need early checking; a combined property needs the relevant outputs; actual usability needs the actual artifact. Do not claim final rendering, performance, or external execution from plans alone.

Preserve mandatory ProcessSpec reviews, including timing and independence. Where the specification permits consolidation, a phase-level Gate can evaluate several results. Adding a Gate to every low-level action is not inherently safer.

Keep judgment separate from new creative work. A Reviewer locates observable nonconformities against frozen criteria, does not rewrite the producer's design to match personal taste, and does not have a defect quota. Consolidate common-root-cause findings without dropping affected locations or necessary evidence.

Missing content or evidence that the deliverable was required to supply is normally a defect (`FAIL`). Existing evidence or checking conditions that the Reviewer cannot access may make judgment `BLOCKED`. Neither means PASS, and neither licenses adding new standards.

## 4. Submission, Approved Input, and Versioning

An execution node submits an exact versioned **Submission**.

A Review evaluates that exact version.

If downstream work requires an `approved` input, it must consume the specific Submission version that has passed the required review, not the producer's mutable workspace file.

This provides traceability for:

- who produced what;
- which version passed which review;
- which version downstream actually consumed.

It also allows rework invalidation to affect only downstream work that truly consumed an older version.

### Design the Consumer's Interface

For each output, state its purpose in `business_purpose`, required substance in `description`, and traceable support in `evidence_requirements`. Put essential production instructions in `contract.work_requirements`, not only output metadata. Bind only the inputs the next responsibility needs.

Use a short entry point, complete usable content, and evidence locators. A source-backed analysis might expose decisions and unresolved issues first, then claim-to-source locations and retained originals. It need not reproduce all exploratory notes in several different handoff documents. The Reviewer still checks real sources; the summary is navigation, not proof.

A concise handoff must not omit core content and force the next node to do the producer's work. Retain all ProcessSpec-required artifacts even if a shorter operational view is useful.

**Consumer blind read:** inspect the planned assignment as though the employee has none of the Designer's discussion history. Can it identify the valid inputs, units/time range, owned outputs, unresolved conditions, and submission boundary? Fix missing contract or input information; do not solve it by broadcasting every employee's conversation.

## 5. Forward Dependency / DAG

Normal execution dependencies come from input bindings.

If B needs an output from A, then A is a forward dependency of B.

These forward dependencies form a DAG: **Directed Acyclic Graph**.

The practical meaning is simple:

> Normal execution must not contain a circular wait where A waits for B and B also waits for A.

You do not manually maintain a separate dependency graph.

Correctly configure node inputs; the Compiler derives and validates the forward graph.

## 6. Fan-out and Fan-in

**Fan-out** means one approved result enables several independent downstream work packages.

```text
        ┌→ B
A ──────┼→ C
        └→ D
```

**Fan-in** means one downstream work package requires several upstream results.

```text
B ─┐
C ─┼→ E
D ─┘
```

Parallelism is a means, not a goal.

Run work in parallel only when it is genuinely independent.

If one work package requires another result, declare the dependency rather than forcing concurrency for appearance.

Before branching, settle necessary shared scope, terminology, interface/data conventions, and ownership through the common input or contracts. Do not add a synchronization Agent when explicit shared information suffices.

Examples:
- From an agreed interface, implementation and test-case design can proceed in parallel; running those tests still waits for the implementation and environment.
- Baseline visual rules may be designed alongside a narrative from the same brief. Detailed charts that depend on final data or messages are not independent merely because a different designer draws them.

At convergence, inspect compatibility and missing cross-part obligations, not just whether every branch supplied a file. An execution node combines results when a real integrated artifact is needed; a Review judges whether the combination meets its criteria.

Within an explicitly declared stage, a sealed candidate may feed permitted internal consumers. Its producer need not wait for the later joint Gate. Outside that allowance, use the required approved inputs. Phase labels alone neither authorize candidate use nor justify serializing unrelated branches.

## 7. Normal Rework

Quality rework is a normal work loop, not a Runtime exception and not Workflow redesign.

```text
execution → submission → review
     ↑                    │
     └────── REWORK ──────┘
```

Rework remains with the original execution node and original AgentSession.

It creates:

- a new round;
- a new Submission version.

`allowed_rework_node_ids` bounds eligible execution owners; it is not an instruction to rework every listed node. Actual failed criteria must identify responsible node/output pairs through the existing review protocol.

Separate three scopes:

| Scope | Meaning |
|---|---|
| Repair | Work that must change to correct the observed defect. |
| Invalidation | Results or approvals whose actual supporting basis is no longer valid. |
| Re-verification | Checks needed to establish acceptance of the corrected versions. |

Example: A supplies calculations, B writes conclusions from A, D produces independent material, and R reviews their combined package. If A is wrong, A repairs the calculation and B updates affected conclusions. R needs a valid judgment on the new combination. D does not repeat production merely because its output appeared in the same ReviewBundle.

Counterexample: A, B, and D are correct, but integrator J copies a number incorrectly. Repair J and recheck its output; do not return all upstream work. Conversely, preserve no consumer that actually relies on a false input merely to minimize the reported rework scope.

Use `criterion_subjects` for explicit composite targets, `required_relations` for required exact derivations, and bounded `remediation_mappings` only for legally bound, directly dependent upstream owners. A permitted owner is not automatically the root cause; cross-target repair needs supported evidence. When attribution is unknown, request evidence-driven diagnosis within the assigned scope rather than accusing every ancestor.

Keep input `purpose` truthful: `content_basis` propagates content dependence; `test_subject` describes an inspected object; `historical_reference` records history. A report accurately observing a failed test subject need not itself be false. Do not relabel a real content dependency to avoid necessary invalidation.

Rework does not change frozen standards. A newly discovered request outside the contract needs authorized scope handling, not a defect invented against the old assignment. New candidates and stale Reviews do not automatically close unresolved Findings.

Runtime owns status changes, affected-work scheduling, and preservation of unrelated Sessions and environments. Rework relationships are not part of the forward DAG.

## 8. Criterion and Evidence

A **criterion** defines what condition counts as acceptable.

**Evidence** provides the traceable basis for making that judgment.

Example:

```text
Vague requirement:
The data must be accurate.

Better criterion:
Key figures in the report match the approved data source,
and derived values can be reproduced using the recorded method.

Evidence:
- original data location
- calculation script/formula
- recomputation result
- corresponding report location
```

Concrete criteria help the producer self-check, make Reviewer judgment more stable, and let defects be localized.

| Weak condition | More inspectable condition |
|---|---|
| The report is complete. | Each required question has a substantive, locatable answer, not merely a heading or placeholder. |
| The artifact looks professional. | Actual viewing reveals no clipping, overlap, or misleading hierarchy that prevents the intended audience from understanding required content. |
| Testing is complete. | Assigned checks identify their exact object/version, actual outcome, evidence, and any unexecuted or inaccessible conditions. |

Adapt these conditions to the selected specification and task; examples do not become extra requirements. A qualitative standard can be precise without an arbitrary score.

Use existing authority annotations to distinguish user/ProcessSpec requirements, justified design decisions, and recommendations. For every "must," identify the obligation or necessary interface it serves. Do not turn "avoid decorative illustrations" into "zero image objects," or "readable" into invented layout-density thresholds.

Mechanical criteria name real checks and prove only those checks' behavior. Semantic criteria identify the professional judgment and required evidence. Where the same standard is used, reference its existing ID rather than writing drifting variants in several contracts. A producer's self-check does not grant independent approval.

**Bad-artifact test:** imagine an output with all expected filenames but a missing conclusion, wrong unit, or inconsistent version. Determine which applicable criterion rejects it and what evidence localizes the failure. This is a design thought experiment, not a new required artifact or permission to fabricate test results.

## 9. Requirement Coverage

Coverage is not about making every ID appear.

It proves:

> Every mandatory ProcessSpec item has accountable responsibility, a real artifact, and the required quality verification. Source-linked criteria help preserve user requirements, but structural coverage alone does not prove semantic task fulfillment.

Good coverage answers:

```text
Who owns REQ-07?
      ↓
Which output actually satisfies it?
      ↓
Which criterion determines satisfaction?
      ↓
Which Review checks it when independent judgment is required?
```

Attaching all requirements to the last node when earlier nodes actually perform the work is formal coverage, not a compliant design.

## 10. Minimal Sufficiency

More nodes do not automatically mean higher quality.

Every new node adds:

- context setup;
- handoff;
- waiting;
- review overhead;
- potential information loss.

Split nodes only for a real reason:

- independent professional responsibility;
- independent deliverable or reuse value;
- useful parallelism;
- independent review or permission boundary;
- useful failure/rework isolation.

Conversely, work should usually be merged when it shares the same responsibility and inputs, produces one inseparable artifact, and has no independent downstream value.

IPD is not about ceremony.

It is about making **necessary responsibility and quality control happen early enough while avoiding unnecessary process tax**.

### Check Effort as Well as Topology

Inspect expected reading, production, handoff, and verification work along the longest required dependency chain. Use measured history when available; otherwise state qualitative assumptions, not invented timings or fixed global quotas. More parallel nodes help only if their useful independence outweighs duplicated reading and integration.

Apply three small design tests:
- **Remove a node mentally:** identify the work or mandatory governance responsibility lost. Keep it if justified; otherwise merge or remove it.
- **Remove a wait mentally:** identify the exact input or authorization that becomes unavailable. If none is needed, remove the artificial wait; never hide actual dependencies.
- **Move a feasibility check earlier:** if unavailable data, tools, or an interface could invalidate expensive downstream work, plan a small early check in the responsible node using authorized capabilities.

The Designer plans these checks; it does not execute the business task, launch unregistered helpers, or start recursive IPD Runs. Reuse suitable Skills and tools instead of prescribing a new production framework for every task. Do not add extra planning reports or review nodes solely to document that these design tests were considered.
