# IPD Methodology Reference for Process Selection and Workflow Design

> Purpose: provide a shared IPD mental model for the Process Selector (ST) and Workflow Architect.
>
> This document distinguishes three categories:
>
> 1. IPD facts supported by public sources;
> 2. design principles abstracted from those facts;
> 3. engineering mappings used by this project.
>
> `ProcessSpec`, execution/review nodes, Compiler, Runtime, and similar terms are project-specific abstractions, not original Huawei IPD terminology.

## 1. Understand What IPD Is Before Memorizing Phase Names

Integrated Product Development (IPD) is first an **end-to-end product-development and business-management system**, not merely a project schedule and not a fixed flowchart.

Huawei public material describes IPD as a core R&D process and states that Huawei introduced it around 1999, combining:

- PRTM's PACE methodology;
- IBM consulting recommendations;
- Huawei's own long-term practice. [S1]

Huawei's public Market Management → IPD framing also distinguishes:

```text
Do the right things
        ↓
Do things right
```

Market/business management determines what should be done.

IPD structures how the chosen product or offering is developed and delivered correctly. [S1]

Therefore, IPD cannot be understood merely as:

```text
Concept → Plan → Develop → Qualify → Launch → Lifecycle
```

It also addresses questions such as:

- Does the work actually serve customer, market, and business objectives?
- Which professional responsibilities must participate early rather than arrive only at the end?
- What deliverables must become reliable inputs for later work?
- Who produces, and who independently decides whether the result is good enough to continue?
- How are requirements traced through design, implementation, verification, and delivery?
- When information is insufficient, risk remains open, or quality fails, should the work continue, add evidence, rework, redirect, or stop?

The process exists not to add ceremony, but to make critical responsibility, deliverables, and decision points explicit early enough to reduce late discovery and expensive rework in complex cross-functional work.

## 2. Core Structures Visible in Public Huawei / IPD Material

### 2.1 End-to-End Phases Are a High-Level Skeleton, Not a Step-by-Step Script

Huawei's public whitepaper presents a high-level IPD sequence:

```text
Concept → Plan → Develop → Qualify → Launch → Lifecycle
```

It also embeds specialized requirements such as security and configuration management across the phases rather than treating every specialty as an isolated parallel process. [S1]

Important implication:

> **A phase expresses maturity and responsibility boundaries; it does not require a one-phase-one-node implementation.**

One current task may contain several parallel professional work packages within what the source framework would call one phase.

Several closely aligned general activities may also be realized by one concrete task work package, as long as required responsibility, deliverables, and reviews remain intact.

### 2.2 IPD Is Cross-Functional Collaboration, Not Serial Handoffs Between Departments

Huawei case-study literature describes cross-functional matrix collaboration covering functions such as development, testing, R&D, marketing, technical service, finance, supply, procurement, and quality.

It distinguishes portfolio/investment governance from project execution and describes concurrent engineering in which manufacturing, procurement, market preparation, and product testing may overlap rather than run strictly serially. [S2]

IBM public IPD training likewise describes participation from all relevant functional areas as a cornerstone and distinguishes:

- IPMT — cross-functional management/governance;
- PDT — cross-functional project execution.

Typical PDT functions include project management, product marketing, finance, development, quality, testing, procurement, sales, and others. [S3]

The transferable lesson is not to copy exact job titles.

It is:

> **A process specification can require not only work to be performed, but also professional responsibilities to participate and certain responsibilities not to self-approve.**

### 2.3 Concurrent Engineering Is Important, but Requires Explicit Interfaces

"Integrated" does not mean everyone stays in one discussion.

It means professional responsibilities that should be involved early are involved early, while collaboration occurs through explicit inputs, deliverables, and review interfaces.

Huawei public material shows specialized security design, secure development, security testing, configuration management, traceability, and separation of responsibility embedded across multiple phases. [S1]

For this project:

- work that is truly independent should be allowed to run concurrently;
- work that requires unfinished results must wait;
- several results that together support one downstream task should converge at explicit controlled boundaries.

Parallelism exists to reduce unnecessary waiting while preserving responsibility and version traceability.

### 2.4 High-Level IPD Definitions Emphasize Governance, Roles, and Deliverables More Than Low-Level Actions

IBM Research observed that high-level enterprise IPD definitions rely heavily on natural-language documentation, diagrams, and clearly defined deliverables, with emphasis on:

- process principles;
- business objectives;
- governance;
- high-level structure;
- participating roles;

and relatively less emphasis on enumerating every low-level process action. [S4]

This supports the project's ProcessSpec / Workflow separation.

A ProcessSpec should define:

- required responsibilities;
- key controlled deliverables;
- role/capability expectations;
- reviews and handoff rules.

A Workflow answers:

- how this particular task is split into work packages;
- who performs each package;
- what can run in parallel;
- how concrete inputs and outputs are bound.

Skill procedures, tool calls, and one model's internal operation are lower-level execution methods and normally should not become fixed ProcessSpec nodes.

A good ProcessSpec constrains a **family of valid Workflows**, not one unique Workflow.

## 3. Organizational Responsibility: What IPMT/PDT Teaches Us and What We Do Not Copy

### 3.1 PDT: Cross-Functional Execution Responsibility

IBM IPD material describes PDT as a cross-functional team responsible for planning and executing a specific offering.

The PDT leader is responsible for:

- delivery;
- cross-functional team management;
- project planning;
- risk;
- decision-review preparation.

Functional representatives remain responsible for their own functional activities and deliverables. [S3]

Transferable implications:

- a long task should not rely on one universal Agent to research, design, implement, verify, and approve itself;
- distinct professional judgment should create distinct accountable work packages where needed;
- every package needs a clear responsible employee, inputs, outputs, and acceptance basis;
- cross-functional collaboration is represented through several meaningful nodes rather than several identities in one prompt.

### 3.2 IPMT / IRB: Governance and Investment Decision Responsibility

IBM material places IPMT / IRB in cross-functional management and investment/portfolio governance.

Decision Checkpoints can result in decisions such as:

```text
Go / No-Go / Redirect
```

and may be tied to committing resources for the next phase. [S3]

Huawei public executive material also describes IPD as both an R&D process and management system and mentions specialized governance around R&D investment. [S5]

**This project's first version does not replicate that complete investment-governance layer.**

The current review/Gate abstraction primarily judges whether an exact artifact version satisfies frozen quality criteria.

It is closer to technical/quality release control than to an enterprise DCP.

Do not expand a Reviewer into authority over:

- portfolio investment;
- budgets;
- project cancellation;
- organizational resource allocation

merely because the system is inspired by IPD.

If true portfolio management or resource reallocation is added later, it should be modeled explicitly.

## 4. DCP, TR, and the Project Gate Are Different Things

IBM DCP is a structured project decision checkpoint with explicit entrance/exit criteria and may support decisions such as Go, No-Go, or Redirect tied to continued resource commitment. [S3]

Huawei public material also shows technical review points such as TR1, TR2/TR3, TR4/TR4A/TR5, and TR6 distributed through the IPD phases. [S1]

The current project's Gate should not be described as full DCP.

A better mapping is:

- **Execution node** — produces a defined deliverable;
- **Review/Gate** — independently judges an exact version of that deliverable against frozen criteria;
- **Runtime** — records approval, blocks, or initiates normal rework;
- **not automatically included** — enterprise investment approval, portfolio control, budget commitment, or corporate release authority.

This distinction prevents Workflow Designers from mechanically adding executive approval layers to ordinary tasks merely because IPD contains DCP concepts.

## 5. Requirements and Traceability Are a Cross-Process Backbone

Huawei public material treats Requirement Management as a core IPD process and exposes different structured requirement models for system-device and independent-software scenarios.

The independent-software requirement lifecycle can return from delivery/acceptance back to earlier planning or implementation when requirements are not satisfied, illustrating an end-to-end traceability loop rather than one-time upfront confirmation. [S6][S7]

For this project, traceability means at minimum:

```text
Explicit user requirement / mandatory ProcessSpec item
        ↓
Responsible node
        ↓
Actual output
        ↓
Acceptance criterion and evidence
        ↓
Required Review where applicable
```

This is the purpose of `requirement_coverage`.

It is not an ID-completeness checklist.

It must prove that requirements have real responsibility, artifacts, and verification.

## 6. What ProcessSpec Means in This Project

Based on the public methodology and the project architecture:

> **A ProcessSpec is a process governance specification for a class of tasks. It states which activities and professional responsibilities must be present, which controlled deliverables and evidence must be produced, which reviews and handoffs are required, and which organizational or quality rules must remain true. It defines the boundary of valid Workflows, not the concrete execution graph for the current task.**

A ProcessSpec contains four major categories:

| ProcessSpec element | Problem it solves | Workflow Designer responsibility |
|---|---|---|
| Required Activity | Which responsibilities must not be lost | Instantiate as real work in this task; merge/split where reasonable, but do not remove responsibility |
| Required Deliverable | Which controlled artifacts must exist | Define the concrete file/data/design/implementation/evidence for this task |
| Required Review | Which artifacts require independent professional judgment | Configure real review, frozen criteria, evidence, and controlled downstream use |
| Workflow Rule | Which cross-node organizational principles must hold | Realize through responsibility separation, version/input binding, criteria, completion conditions, or other checkable structure |

A ProcessSpec is **not**:

- an executable DAG;
- a fixed node-count template;
- a list of phase names that must appear literally;
- an execution manual for business Agents;
- a set of IDs that can be attached to coverage at the end.

## 7. How the Workflow Designer Should Use ProcessSpec

### 7.1 First: Understand the Governance Intent

Do not start by counting activities.

Ask:

- What typical failure is this ProcessSpec trying to prevent?
- Which professional responsibilities must participate early?
- Which artifacts must become reliable baselines for downstream work?
- Which results cannot be self-approved by the producer?
- Which integrated properties can be judged only after multiple outputs converge?

Example:

A content-delivery ProcessSpec may require:

```text
requirements baseline → content development → independent validation → formal delivery
```

Its point is not the phase names.

Its point is to avoid:

- requirement loss from jumping directly into production;
- factual errors;
- unreviewed final artifacts.

### 7.2 Second: Instantiate the ProcessSpec for the Current Task

The same required activity becomes different concrete work in different tasks.

"Requirements analysis" may become:

- requirement/interface baseline for software;
- audience/material/delivery baseline for a report;
- problem/data/metric baseline for data analysis.

Preserve the **responsibility semantics**, not the source label.

### 7.3 Third: Split Only Work Packages with Independent Value

A separate node is usually justified when at least one condition holds:

- different professional capability or permission is needed;
- true parallelism exists;
- the output has independent downstream use or independent review value;
- local failure/rework isolation is useful;
- the ProcessSpec requires responsibility separation.

Otherwise, merge.

IPD is intended to control complexity, not create process tax.

### 7.4 Fourth: Make Deliverables and Reviews a Real Quality Loop

Define the artifact and acceptance criteria first, then select the Reviewer.

A criterion must answer:

- what is checked;
- what counts as satisfied;
- what evidence supports the judgment.

Review rejection is normal rework.

It returns to the responsible execution node.

Do not create a separate "fix role" for every rework case.

### 7.5 Fifth: Optimize Dependencies and Parallelism Last

Forward relationships come from real data/artifact dependencies.

- if there is a dependency, wait;
- if there is no dependency, allow concurrency;
- if several approved results are needed, converge explicitly.

Do not create parallelism merely to demonstrate multi-Agent behavior.

Do not serialize every professional responsibility merely because the source methodology uses high-level phases.

## 8. How the Process Selector Should Understand ProcessSpec

Process selection happens before Workflow design.

ST should not ask:

> Which ProcessSpec has nodes that look most like this task?

It should ask:

> Which ProcessSpec provides the most appropriate governance responsibilities, deliverables, and quality controls for this class of task?

Huawei Cloud CodeArts Req publicly illustrates scenario-specific IPD models, such as system-device and independent-software models with different characteristics around:

- software/hardware coupling;
- requirement stability;
- iteration frequency;
- development cycle;
- quality/stability needs.

The documentation recommends choosing an appropriate model based on enterprise scale, business needs, and application scenario. [S6]

Useful process-selection dimensions include:

| Dimension | Typical Question |
|---|---|
| task nature | Is this content delivery, software implementation, product verification, research exploration, or another class? |
| final deliverable | Is there a concrete file/system/analysis result? Does it require independent quality approval? |
| professional breadth | Does the task require several distinct professional responsibilities? |
| object complexity | Is the object software, software+hardware, a physical product, data, content, etc.? |
| requirement stability | Are objectives and key inputs mostly stable or likely to change significantly? |
| verification cost/risk | Are errors easy to detect and fix, or do they involve high-cost safety/compliance/physical validation? |
| delivery cadence | One-time delivery, rapid iteration, or long staged maturity? |
| mandatory conditions | Do `applicable_when` and `not_applicable_when` actually match? |

The current first version allows ST only to select one existing complete ProcessSpec.

ST does **not** trim, combine, or modify it.

Therefore, if a professional ProcessSpec contains mandatory work clearly unsuitable for the task, ST should not select it and expect the Workflow Designer to delete those obligations later.

Choose another ProcessSpec or report that no suitable one exists.

A minimal default ProcessSpec should be selected only when it actually satisfies its own applicability conditions, not simply because no better search result appeared.

## 9. Ten Common Misunderstandings

1. **"IPD is just a six-stage waterfall."**  
   Wrong. The stages are high-level structure; IPD also emphasizes cross-functional collaboration and concurrent engineering.

2. **"If a ProcessSpec has eight activities, the Workflow must have eight execution nodes."**  
   Wrong. Activities are responsibility requirements, not node-count requirements.

3. **"ProcessSpec phase names must appear literally in the Workflow."**  
   Wrong. Preserve responsibility semantics, not labels.

4. **"All work should be parallel to demonstrate Multi-Agent."**  
   Wrong. Parallelism follows real independence.

5. **"Adding a Review to every intermediate artifact is more IPD-compliant."**  
   Wrong. Preserve required reviews and independent checks that genuinely reduce quality risk.

6. **"A Review PASS is equivalent to a DCP."**  
   Wrong. The current Gate is quality release, not full investment governance.

7. **"A strong employee can produce and approve everything itself."**  
   Usually wrong. When independence is required, production and review must be separated.

8. **"Complete coverage IDs prove ProcessSpec compliance."**  
   Wrong. Real responsibility, deliverables, criteria, and review mappings must exist.

9. **"A ProcessSpec is an executable Workflow template."**  
   Wrong. It constrains a family of Workflows.

10. **"More nodes are safer."**  
    Wrong. Valueless nodes add handoff, context, and rework cost and create more failure points.

## 10. The Most Important Sentence for This Project

> **IPD provides a general governance solution for organizing a class of complex work reliably. The Workflow Designer's job is to translate that general solution into the smallest sufficient, efficient, executable, and verifiable Workflow for the current user task without losing the responsibilities, deliverables, and quality controls that make the general solution valuable.**

The Process Selector chooses the right general solution.

The Workflow Designer instantiates it.

Neither role should treat the ProcessSpec as a fixed executable graph, and neither should reduce it to optional background text.

---

## Sources and Confidence Boundaries

**S1 | Huawei official whitepaper**  
Huawei, *Cyber Security Perspectives: Making cyber security a part of a company's DNA* (2013), Section 7.5 / Figures 4–6.  
Supports: Huawei introduced IPD around 1999; influence from PACE, IBM recommendations, and Huawei practice; MM→IPD framing; high-level phases; TR points; specialized requirements embedded across phases; traceability and separation of responsibility.  
https://www-file.huawei.com/-/media/corporate/pdf/cyber-security/hw-cyber-security-wp-2013-en.pdf

**S2 | Peer-reviewed Huawei case study**  
*New product development paradigm from the perspective of consumer innovation: A case study of Huawei's integrated product development*, Journal of Innovation & Knowledge, 2024.  
Supports: cross-department matrix collaboration, IPMT/IRB/PDT responsibilities, end-to-end collaboration, concurrent engineering.  
https://doi.org/10.1016/j.jik.2024.100482

**S3 | IBM Corporate IPD public training material**  
*IBM Integrated Product Development (IPD)*, 2010/2011.  
Supports: structured end-to-end process, project/brand tailoring, cross-functional IPMT/PDT, DCP Go/No-Go/Redirect decisions, activities/inputs/deliverables/roles. Huawei public material acknowledges IBM consulting influence; this source is used to explain IPD lineage and organizational logic, not as a Huawei internal template.  
https://pmicv.org/static/uploaded/Files/Documents/2011%20Presentations/IBM_Corporate_IPD_Process_PMI-CV_Sept_14_2011.pdf

**S4 | IBM Research**  
Stanley M. Sutton Jr., *Concepts in the definition of an enterprise development process*, ICSSP 2011.  
Supports: high-level IPD definitions emphasize principles, business objectives, governance, high-level structure, roles, and deliverables more than low-level action structure.  
https://research.ibm.com/publications/concepts-in-the-definition-of-an-enterprise-development-process

**S5 | Huawei official executive interview**  
Eric Xu, Huawei UK media roundtable / *Voices of Huawei*.  
Supports: Huawei treats IPD as both an R&D process and a management system and uses specialized governance for R&D investment. Public sources differ slightly between "established in 1998" and "introduced in 1999"; this reference treats the introduction/establishment period as 1998–1999 and does not infer additional process detail from that discrepancy.  
https://www-file.huawei.com/-/media/corp/facts/pdf/on_the_record_huawei_executives_speak_to_the_public_volume_i_en.pdf

**S6 | Huawei Cloud CodeArts Req official documentation**  
Built-in IPD requirement models.  
Supports: choosing models based on enterprise scale, business needs, and application scenarios; system-device and independent-software models have different applicable characteristics.  
https://support.huaweicloud.com/intl/en-us/productdesc-projectman/projectman_07_3001.html

**S7 | Huawei Cloud CodeArts Req official documentation**  
Independent-software original requirement flow and R&D requirement flow.  
Supports: requirement lifecycle from analysis/planning/implementation through delivery/acceptance and returning to earlier stages when acceptance is not satisfied.  
https://support.huaweicloud.com/intl/en-us/usermanual-projectman/codeartsreq_01_6106.html  
https://support.huaweicloud.com/intl/en-us/usermanual-projectman/codeartsreq_01_8115_01.html

### Usage Boundary

Public sources support the general methodology and selected public organizational/phase/review structures.

This document is **not** a substitute for Huawei's internal ProcessSpecs and is not an official Huawei training manual.

When first-party internal ProcessSpecs become available, their applicability conditions, roles, activities, deliverables, reviews, and rules should override the generic summaries here.

This reference remains useful as a shared methodological background for process selection and workflow design.
