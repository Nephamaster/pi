# IPD Background for Process Selection and Workflow Design

Read this background when the organizational rationale or source boundary matters. It is not a mandatory pre-reading step on every Run. The main Skill provides the working model; the active task, selected ProcessSpec, and current tools govern actual work.

This reference separates public IPD descriptions, principles abstracted from them, and project-specific engineering mappings. `ProcessSpec`, AuthoringDraft, WorkflowDefinition, Compiler, Runtime, Session, and our Gate are project terms, not a claim that Huawei uses these exact technical objects.

## 1. A development and management system, not just six phase names

Huawei's public cybersecurity whitepaper describes the introduction of IPD around 1999, influenced by PRTM's PACE, IBM consulting, and Huawei's practice. It presents the high-level concept, plan, develop, qualify, launch, and lifecycle phases, alongside requirements such as security, configuration management, and traceability. [S1]

The MM → IPD distinction separates choosing the right business work from doing that work well. A phase chart alone does not explain why an offering matters, who is responsible, which specialties must contribute, what evidence is needed, or who decides whether to continue.

For this project, the useful principle is to make required responsibility, controlled deliverables, and quality decisions explicit early enough to prevent avoidable late discovery. Do not import the whole enterprise organization into every task.

## 2. Cross-functional responsibility and concurrent engineering

The Huawei case study discusses cross-department matrix collaboration across development, testing, marketing, service, finance, supply, procurement, and quality, including overlapping work rather than serial departmental handoffs. [S2]

IBM public IPD material distinguishes cross-functional portfolio/governance responsibility (IPMT/IRB) from project execution (PDT). A PDT leader coordinates the offering; functional representatives remain responsible for their professional activities and deliverables. [S3]

Transferable principles:

- Identify the professional responsibilities that actually matter to the task, not a fixed list of impressive job titles.
- Involve specialties early when their constraints can change the route.
- Make outputs, interfaces, and acceptance responsibilities explicit.
- Separate production from required independent judgment.
- Permit genuine parallelism when shared assumptions and dependencies are clear.

These principles do not require all professionals to share one conversation, nor one node for every discipline or phase. Repeated low-value handoffs are not evidence of integration.

## 3. DCP, technical review, and the project's Gate

IBM Decision Checkpoints have structured entrance/exit conditions and can support Go, No-Go, or Redirect decisions associated with resource commitment. Huawei's public material also presents technical review points across the development phases. [S1][S3]

The project's Gate primarily evaluates exact artifact versions against frozen quality criteria. It is a technical/quality-control adaptation, not full corporate investment approval. A PASS does not authorize portfolio allocation, budget commitments, real-world shipment, or publication outside the task's actual permissions.

This distinction prevents adding executive approval ceremonies to an ordinary deliverable because the source methodology contains investment governance. Any genuine business authorization needs its own explicit basis and mechanism.

## 4. High-level process definitions and concrete work

IBM Research describes high-level enterprise development processes through principles, business objectives, governance, structure, roles, and clearly defined deliverables, with less emphasis on enumerating every low-level action. [S4]

In the project, the separation is:

| Object | Responsibility |
|---|---|
| IPD background | Explains organizational and quality-control principles. |
| ProcessSpec | Defines mandatory activities/capabilities, controlled artifacts/evidence, reviews, applicability, and cross-work rules for a class of tasks. |
| Task-specific workflow | Defines how this task realizes those obligations: work packages, employees, actual inputs/outputs, criteria, dependencies, and completion. |
| Skill and tools | Provide professional methods and concrete authorized operations inside those responsibilities. |
| Compiler and Runtime | Validate formal relationships, freeze the adopted configuration, and execute the supported control semantics. |

A ProcessSpec constrains a family of workflows. It is neither a fixed executable DAG nor optional background prose. Concrete activities can be split or combined when required responsibilities, deliverables, timing, and independent review survive. A workflow must not attach unrelated process IDs cosmetically after an unconstrained plan is already written.

## 5. Traceability: preserve both meaning and the correct field mapping

Huawei Cloud's public requirement-management documentation shows scenario-specific requirement models and lifecycles connecting analysis/planning to implementation, delivery, acceptance, and return to earlier work when acceptance fails. [S6][S7]

Both original user intent and mandatory process obligations should remain traceable to responsible work, actual outputs, acceptance conditions, and evidence. **That general principle does not mean they use the same project field.**

| What must be preserved | Current project representation |
|---|---|
| User task meaning | `TaskInput.raw_task.text` remains authoritative; contracts, outputs, and criteria interpret it faithfully. Source-linked workflow requirements may annotate its origin without replacing it. |
| ProcessSpec implementation | `requirement_coverage` contains only `process_activity`, `process_deliverable`, `process_review`, and `process_rule` rows, authored through the coverage tool. |
| Specific process evidence and judgment obligations | Output `process_evidence_requirement_refs` and semantic `process_criterion_refs` bind exact nested entries. |
| Why a criterion is required or advisory | Source-linked `requirements` and justified `decisions`, plus their references and blocking strength. |

Do not invent `task_requirement` coverage. Do not confuse a workflow-local source annotation with a second Compiler-owned representation of the whole user request. Formal checks verify the supported structure and references; they do not prove that a model's interpretation or final business result is correct.

A complete table of IDs is insufficient if real responsibility, artifacts, or judgment are missing. Conversely, avoiding a separate user-requirement IR is not permission to omit user constraints from the work.

## 6. How ST applies the background

ST asks which existing specification's responsibilities, controlled artifacts, and quality controls fit the task, not which diagram has familiar-looking nodes. Huawei Cloud distinguishes system-device and independent-software models with different scenario characteristics; these product documents support selecting appropriately, not a universal process. [S6]

Check applicability/exclusions, principal work, professional breadth, relevant object complexity, stable and unknown conditions, material quality risk, and actual delivery. More phases or reviews do not imply better fit.

ST selects one unchanged registered version. It does not trim, combine, or edit the process, select staff, or assume that a mandatory irrelevant artifact can be removed later. A generic specification remains a normal candidate whose applicability needs evidence, not an automatic escape from uncertainty.

## 7. How the Workflow Designer applies it

Understand what failure each required responsibility prevents, which outputs form shared bases, what must be judged independently, and which integrated properties become assessable only after results converge.

Instantiate those obligations for the actual task. The same broad responsibility can mean an interface baseline in software, a question/data definition in analysis, or an audience/material scope in content delivery. Preserve its meaning rather than copying its label.

Separate meaningful work packages where expertise, permission, useful parallelism, consumption, or defect isolation warrants it. Do not turn every tool action into an Agent node. Keep production assignments bounded enough that employees can recognize when to submit.

Design deliverables, evidence, reviews, and real dependencies together. A criterion should identify what is assessed, what counts as acceptable, and how evidence supports the judgment. A review of a plan cannot prove that its execution succeeded.

Real forward dependencies must not create circular waits. The project permits named internal candidate uses inside an explicit stage when supported by the selected obligations, while stage exits still require valid Gates. This is a project mechanism, not a rule derived from an IPD phase name.

## 8. Rework, versions, and continuous responsibility

Quality rework is normal work, not a reason to silently rewrite the plan or lower standards. The project keeps normal rework with the original responsible work and continuing Session; permitted disaster recovery preserves logical identity under the runtime's recovery rules. These are project requirements, not claims about Huawei's Session implementation.

A review judges exact versions. Updated outputs need valid corresponding evidence/approval. Separate the work that must change, approvals or derived results that lose support, and checks that must be repeated. Preserve independent valid work; do not retain an actually dependent false result merely to minimize the repair set.

A joint Gate can need renewed judgment without all of its producers working again. If an integrator alone introduced a defect, correction belongs there. Runtime implements invalidation and routing; the Designer provides accurate dependencies and legal repair owners.

## 9. Boundaries and recurring misunderstandings

| Misreading | Correct interpretation |
|---|---|
| IPD is a fixed waterfall | High-level phases coexist with cross-functional and concurrent work. |
| One process activity means one node | Activities constrain responsibility; task-specific work packages realize it. |
| Every artifact needs a new Agent Gate | Preserve required and genuinely valuable judgment; do not add ceremony. |
| More roles always improve reliability | New responsibilities must justify their setup, handoff, and coordination costs. |
| PASS is corporate DCP or release authority | The project Gate is scoped quality acceptance, not unrestricted business permission. |
| Self-report or complete IDs prove quality | Inspect actual work and evidence; formal correctness is not semantic correctness. |
| A workflow may delete inconvenient process requirements | Change the selected/published process only through authorized governance, not hidden tailoring. |
| All early inputs must await one final joint review | Model actual maturity and permitted candidate use without self-approval cycles. |

The objective is sufficient organization to control quality risk, not maximal ceremony. Public sources justify the organizational ideas; they do not uniquely determine node types, schemas, error budgets, permission backends, or task performance.

## Sources and confidence boundary

The following source register is retained from the reviewed project methodology. This Skill revision corrects project mappings and reorganizes usage; it is not a fresh audit of every source or a copy of Huawei internal ProcessSpecs.

**S1 — Huawei official whitepaper.** *Cyber Security Perspectives: Making cyber security a part of a company's DNA* (2013), section 7.5 / figures 4–6. Used for IPD introduction, MM/IPD framing, high-level phases, technical reviews, security/configuration practices, and traceability.
https://www-file.huawei.com/-/media/corporate/pdf/cyber-security/hw-cyber-security-wp-2013-en.pdf

**S2 — Huawei case study.** *New product development paradigm from the perspective of consumer innovation: A case study of Huawei's integrated product development*, Journal of Innovation & Knowledge (2024). Used for cross-functional organization and concurrent engineering, not as an internal procedure manual.
https://doi.org/10.1016/j.jik.2024.100482

**S3 — IBM public IPD training.** *IBM Integrated Product Development*, 2010/2011. Used for IPMT/IRB/PDT, structured checkpoints, roles, and deliverables; not presented as Huawei's current internal process.
https://pmicv.org/static/uploaded/Files/Documents/2011%20Presentations/IBM_Corporate_IPD_Process_PMI-CV_Sept_14_2011.pdf

**S4 — IBM Research.** Stanley M. Sutton Jr., *Concepts in the definition of an enterprise development process*, ICSSP (2011). Used for high-level process definition emphasizing objectives, governance, roles, and deliverables.
https://research.ibm.com/publications/concepts-in-the-definition-of-an-enterprise-development-process

**S5 — Huawei executive material.** *On the Record: Huawei Executives Speak to the Public*, volume I. Used for IPD as R&D/management and investment governance. Public introduction dates differ slightly around 1998–1999; no technical design is inferred from that difference.
https://www-file.huawei.com/-/media/corp/facts/pdf/on_the_record_huawei_executives_speak_to_the_public_volume_i_en.pdf

**S6 — Huawei Cloud CodeArts Req.** Built-in IPD requirement models. Used for scenario-dependent models, not a complete corporate IPD manual.
https://support.huaweicloud.com/intl/en-us/productdesc-projectman/projectman_07_3001.html

**S7 — Huawei Cloud CodeArts Req.** Independent-software original/R&D requirement flows. Used for requirement lifecycle and acceptance feedback.
https://support.huaweicloud.com/intl/en-us/usermanual-projectman/codeartsreq_01_6106.html
https://support.huaweicloud.com/intl/en-us/usermanual-projectman/codeartsreq_01_8115_01.html

When formal internal specifications become available, their authorized applicability and obligations govern their registered process. They do not silently change the current task, selected version, or runtime capabilities. This background remains explanatory.
