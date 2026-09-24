# Work-Package, Handoff, and Review Judgment

Read the relevant section when a design choice is unclear. These are methods for the Designer, not mandatory extra documents, tool-call quotas, or acceptance standards. The selected ProcessSpec and the user task determine actual obligations.

## 1. Choose responsibility boundaries, not a sequence of job titles

A work package owns a professional result. It can include reading, searching, calculating, drafting, testing, and revision in one continuing Session. Keep tightly coupled decisions together when they share essential context and naturally produce one result. Split for distinct expertise/permission, independently consumed results, genuine parallelism, independent judgment, or useful fault isolation.

A deterministic conversion or fixed test is usually part of an authorized tool/Skill procedure. It does not require a separate Agent merely because it is a distinct action. Conversely, a larger package should not hide independent professional decisions that need separate review.

**Change-together test:** after one plausible defect, which parts must be reconsidered together? Give independent outputs their own identity and owned paths when that helps preservation; do not split one inseparable result into many files without consumers. Runtime cannot infer independence from a large undifferentiated handoff that every consumer uses in full.

**Deletion test:** mentally remove a node. Keep it if a necessary output, professional responsibility, independent check, or ProcessSpec obligation disappears. Otherwise merge or remove it. This is not permission to delete a required review because it is expensive.

## 2. Write an assignment with a submission boundary

A member receives its contract and inputs, not the Designer's whole deliberation. Make purpose, owned decisions, input scope, excluded work, required evidence, and submission readiness understandable without that history. Fix important interfaces and outcomes; let the bound professional method handle valid implementation variation.

| Open-ended instruction | Bounded alternative |
|---|---|
| Research comprehensively and keep improving the report. | Answer the assigned questions from authorized sources. Supply substantive answers, support for material claims, and permitted limitations. Submit when the necessary answers and evidence are complete; do not gather more sources just to increase volume. |
| Create a detailed design for every possible case. | Specify the decisions, structure, interfaces, and constraints production needs. Leave valid local choices to the producer unless the task requires an exact implementation. |
| Make the artifact perfect. | Produce the complete requested artifact, perform applicable checks on its actual version, fix identified defects, and submit with truthful evidence. |
| Make all tests pass. | Execute the assigned tests against the specified object and report actual outcomes and limitations. A complete test report may truthfully show a defective product. |

Missing required answers or checks cannot be relabeled "limitations" merely to submit. Where the task explicitly permits uncertainty, preserve it with its consequences. Where the missing condition prevents a legal result, report the concrete block. Stopping an unproductive search does not equal success.

Do not wait for an output's later approval before submitting the candidate that enables that review. Submission readiness and authorized downstream use are different events.

## 3. Design outputs for their consumers

For each output identify who needs it and which decisions/work it enables. Provide a short entry point, complete usable content, and locators for original evidence. A source-backed analysis can lead with conclusions and unresolved issues, then evidence locations; it need not duplicate every exploratory note in several overlapping reports.

Compactness must not move core research or design work to the next node. Reviewers need access to inspectable sources, not only a producer's summary. Keep all required controlled artifacts, even when consumers benefit from a shorter reading path. Decide separately what belongs in user-facing delivery.

**Consumer blind read:** using only its planned inputs, contract, and bound methods, could a fresh employee identify the relevant source versions, units/time range, unresolved facts, output ownership, and completion conditions? Repair missing information explicitly; do not broadcast all member conversations or silently assume knowledge of unprovided attachments.

Critical production instructions belong in `contract.work_requirements`; output `description` and `business_purpose` complement rather than replace them.

## 4. Parallelize actual independence

The forward dependency graph must not contain circular waiting. It is derived from actual input and approval bindings, not a separately authored edge graph. A phase label neither creates a necessary wait nor authorizes early use of unapproved work.

Before branching, settle the shared scope, terminology, version/units, interface assumptions, and ownership needed by both branches. At convergence, check combined properties, not only that files exist.

Examples:

- From a fixed interface, implementation and test-case design can overlap. Test execution still needs the implementation and a usable environment.
- From a common brief, baseline typography/layout rules can overlap research. Exact data charts and page-specific visuals still depend on actual messages and data.
- Independent source analyses can overlap only if their questions and source scopes are defined; assigning everyone "research this topic" invites duplicated effort.

A StageScope permits declared internal consumers to use sealed candidates before a joint Gate. It does not eliminate review, authorize arbitrary workspace access, or justify external irreversible actions. Cross-stage use remains governed by declared exit Gates.

**Delete-a-wait test:** what actual input or approval would be missing if the consumer began now? Remove an artificial dependency only when the answer is none. Never hide a real dependency for a more attractive diagram.

## 5. Put reviews where evidence and responsibility meet

A useful Gate protects a common basis before error spreads, judges compatibility after independent work converges, or verifies the actual final object before use. It needs the relevant evidence at that point. A plan cannot prove a test ran, and a design cannot prove the finished file renders correctly.

Preserve mandatory ProcessSpec review scope, timing, and independence. Consolidation is valid only when all those obligations survive. Producer self-checking and deterministic checks can avoid needless repetition but do not replace required independent professional judgment.

Use an execution node for real integration work and a review node for judgment. Do not make a Reviewer silently produce the missing artifact, or add an integration node solely to forward files.

Write criteria that specify object, acceptable condition, inspection method, and evidence. Qualitative criteria can be precise without arbitrary scores. "No truncation that hides required values in the actual rendered artifact" is more useful than an unsupported "design score ≥95". A mechanical checker proves only what it executes.

Reviewers should identify blocking nonconformities separately from advisory improvements. No defect quota, default failure, preference-based redesign, or new standards. A missing required deliverable/required evidence is normally a defect; inaccessible checking conditions may block judgment. Neither is approval.

## 6. Plan local repair before failure

| Scope | Question |
|---|---|
| Repair | Which owned output needs changing to correct the demonstrated defect? |
| Invalidation | Which results or approvals no longer have a valid supporting basis? |
| Re-verification | Which checks must establish acceptance of the changed versions or combination? |

**A/B/D example:** A computes facts, B derives conclusions from A, D supplies independent material, and R judges the combined package. A's factual defect requires A's repair and B's actual affected updates. R must judge the corrected combination. D's valid content, Session, and environment should not be recreated merely because D appeared in the same bundle.

**J counterexample:** A, B, and D are correct; integrator J copies one value incorrectly. Repair J and the necessary checking evidence, not all upstream producers. If a later review actually proves a source defect, route through the permitted direct-upstream mapping with evidence rather than pretending it is only an integration problem.

`allowed_rework_node_ids` lists eligible owners, not everyone to restart. Composite subjects define what is jointly judged. `required_relations` states exact derivations to inspect; it does not create production dependence. `remediation_mappings` bounds possible cross-target repair and requires real owner inputs and content lineage.

Keep input `purpose` truthful. `content_basis` expresses correctness dependence. `test_subject` marks an inspected object: a report accurately recording a failed test need not itself be false. `historical_reference` retains history, not a route around invalidation.

Rework changes outputs, not frozen standards. A newly discovered out-of-scope request needs authorized scope handling, not an invented defect against the old contract. A new candidate or unrelated PASS does not automatically close a Finding. Runtime owns actual invalidation, scheduling, and preservation; the Designer must supply truthful relations and responsible targets.

## 7. Inspect effort and stopping, not just topology

Estimate qualitatively what each member must read, produce, and recheck along the critical dependency chain. Use observed timing only when available. Look for duplicated research, oversized internal specifications, blind full-document rewrites, and reviews that repeat the same inspection without a distinct responsibility.

Move low-cost checks of route-changing uncertainties early: required data availability, format support, or a representative production/render path. Prefer putting the check inside the responsible node's method unless it has independent delivery or governance value.

Before submission, imagine a plausible artifact with correct filenames but a missing conclusion, wrong unit, or mixed version. Identify the criterion and evidence that reject it. Then inject an upstream defect, an integration-only defect, and missing evidence into the planned responsibility map. Check that correction reaches the right owner and preserves genuinely independent work.

These thought experiments guide design; they do not justify fabricated verification results or additional reports. Stop refining the design once actual task/process obligations, usable contracts, lawful relations, and formal compilation are satisfied.
