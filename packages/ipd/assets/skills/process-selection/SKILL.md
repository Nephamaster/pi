---
name: process-selection
description: Select an existing, versioned IPD ProcessSpec for a supplied TaskInput. Use as the Staff Team process selector before workflow design; compare applicability and necessary governance, then submit one justified selection or a precise blocked decision.
compatibility: Requires the IPD process catalog and submit_process_selection tools injected by trusted control. It does not create ProcessSpecs or execute the business task.
---

# Select an IPD ProcessSpec

## Scope and working model

Select the governance rules for this task, not an executable graph. A **ProcessSpec** defines required responsibilities, deliverables, independent reviews, and cross-work rules for a class of tasks. The Workflow Designer later implements those obligations with concrete work packages and employees.

Select exactly one registered version. Do not create, edit, combine, or trim specifications; select employees; or design nodes. Keep the original user task unchanged. A staffing gap does not make a suitable process conceptually inapplicable.

## 1. Establish the information you actually have

Read `TaskInput.raw_task.text`, its source, material descriptions, any material content already supplied, and `unresolved_facts`. Identify only what changes process choice: task purpose, principal work, delivery object, essential constraints, professional breadth, and material quality risks.

A material's `reference` is a locator, not its contents. In the current control Session, `read` accesses locked Skill files, not arbitrary task or workspace files. Do not guess filenames, inspect Run directories, or claim to have read unprovided attachments. Use an additional material-reading capability only if it is explicitly exposed and authorized.

If a decisive fact is unavailable, explain its effect on selection. A fact ID may be cited only if it already exists; otherwise describe the missing fact in the blocked reason without inventing an ID. Non-decisive details can remain unresolved for later work.

## 2. Discover plausible specifications

Call `search_process_specs` using discriminative task and governance terms. The current search matches text, not semantic embeddings: use terms from the catalog's language and try a meaningful broader synonym after an empty result. For a small or unfamiliar catalog, `query: "*"` gives a compact initial inventory.

Search results are summaries, not applicability decisions. Call `get_process_spec` with the returned `id` and `version` for each serious candidate. Never guess versions. Ranking, task-name similarity, and `default_executable` do not establish fit.

The current search returns a limited list, not proof that the entire catalog was exhausted. A full-size result may hide other candidates. Refine queries around missing task responsibilities before claiming that no suitable specification exists; do not repeat equivalent searches without a new question.

## 3. Apply exclusion, applicability, and sufficiency in that order

| Decision | Action |
|---|---|
| A known exclusion applies | Reject that candidate; positive similarities cannot override it. |
| A decisive applicability condition is unknown | Do not assume it is true. Determine whether another candidate is justified independently. |
| Positive applicability is supported | Inspect required activities, deliverables, reviews, and rules for substantive fit. |
| Mandatory work is irrelevant or insufficient | Reject the fit; do not assume the Designer can delete obligations or invent missing governance. |
| Several candidates are justified | Prefer adequate domain fit with less irrelevant mandatory work, not the longest specification or an automatic generic fallback. |

Stop comparison when the choice has supported applicability, no known exclusion, sufficient necessary governance, and a reasoned comparison with the main plausible alternative. You need a justified decision over the available catalog, not proof of a globally optimal process. A tie that does not change required governance is not itself a block. An unknown that may change exclusions or material mandatory responsibilities is.

## 4. Submit once the decision is justified

Use `submit_process_selection`, not a prose-only final answer. Follow its live Schema.

| Outcome | Supply |
|---|---|
| `selected` | `status`, exact `process_spec_id` and `process_spec_version`, concise `rationale`, valid `process_requirement_refs`, and `unresolved_fact_refs`. |
| `blocked` | `status`, a precise `reason`, and `unresolved_fact_refs`. Explain the decisive information gap, conflict, unsuitable catalog, or discovery limitation. |

A useful rationale states the relevant task characteristics, which obligations fit them, and why the main alternative is less suitable when there is one. Reference only relevant activity, deliverable, review, or rule IDs from the chosen specification. Do not list every ID, invent user-task requirement IDs, or expose a long search diary.

If a lookup fails, return to the catalog for the exact identity. If submission validation fails, correct the named field or reference and resubmit; do not change the task to make the decision pass. A successful structured submission ends selection. It does not approve task execution or guarantee staffing.

## Consult only what the current decision needs

| Need | Reference |
|---|---|
| Meaning of a ProcessSpec field or source authority | [ProcessSpec reading guide](references/process-spec-reading-guide.md) |
| Competing candidates, uncertain facts, or search convergence | [Decision method](references/process-selection-method.md) |
| Worked selection, exclusion, non-decisive unknown, and blocked payloads | [Selection examples](references/selection-examples.md) |
| IPD organizational rationale, TR/DCP distinction, or provenance | [IPD background](references/ipd-methodology.md) |

Do not load every reference before acting. The working model above is sufficient to begin an ordinary selection; examples demonstrate decisions, not production catalog entries to copy.
