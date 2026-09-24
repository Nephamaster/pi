# Reading a ProcessSpec for Selection

Read this file when a field's meaning affects inclusion or exclusion. It explains ProcessSpec V2, not an execution graph. The actual registered specification supplies the requirements; examples here add none.

## Fields and questions

| Field | Selection question | Mistake to avoid |
|---|---|---|
| `applicable_when` | Which actual task characteristics support applicability? Does a stated condition contain prerequisites? | Treating matching words as evidence; assuming an unprovided fact. |
| `not_applicable_when` | Does a known fact trigger an exclusion? Is a decisive condition still unknown? | Offsetting a hard exclusion with other positive features. |
| `required_activities` | Do these professional responsibilities belong to this task? | Counting activities as nodes, or planning employee assignments. |
| `required_deliverables` | Are these real artifacts or control responsibilities necessary for the work? | Assuming every artifact must be delivered to the user, or that irrelevant artifacts may be deleted later. |
| `required_reviews` | Do the required object, timing, expertise, independence, and standards address material risks? | Replacing independent judgment with producer self-checking. |
| `workflow_rules` | Do these cross-work rules fit the task and avoid unrelated obligations? | Treating a natural-language rule as already enforced code. |
| `source` | Is this a formal internal specification, project-authored process, or public-methodology adaptation? | Describing a project adaptation as an official Huawei template. |
| `default_executable` | How is this asset classified by the host? | Treating it as unconditional applicability, sufficient resources, or permission to fall back. |

Interpret applicability statements according to their actual meaning. Some describe alternative task classes; others contain joint prerequisites. Do not mechanically assume all list items are conjunctive or that any matching phrase is sufficient. Name a material ambiguity instead of silently choosing the easier interpretation.

## Identity and traceability

Use the exact `process_spec_id` and `version` returned by `get_process_spec`. `submit_process_selection.process_requirement_refs` accepts supporting activity IDs, deliverable IDs, review IDs, and workflow-rule IDs from that specification. It is not a requirement-coverage table and need not enumerate the entire process.

ProcessSpec V2 also contains nested `evidence_requirement_id` and `process_criterion_id` entries. They matter to later workflow authoring, but are not extra ID categories for the selection submission. Do not substitute an evidence or criterion ID for an activity/review reference simply because it is precise.

`required_capabilities` and `reviewer_capabilities` describe later staffing needs. Understand the responsibility; do not select staff or relax capability requirements. `independent_agent: true` requires later production/judgment separation; role names alone do not establish independence.

## Internal artifacts and actual user delivery

A research basis, design specification, or verification record may be a necessary internal artifact even when the user requests one final file. This is not automatically irrelevant process work. Conversely, a mandatory manufacturing qualification artifact is not made appropriate by renaming it a report when the task has no manufacturing scope.

Distinguish the responsibility from a particular implementation. Combining aligned work packages can preserve an obligation; deleting a required deliverable or independent review cannot. You select an unchanged specification, not an implicit future tailoring plan.

## Source and authority boundaries

A reputable source does not make a process suitable for every task. Judge the registered normative content and applicability, and preserve its stated authority. Public IPD background helps explain organization; it does not authorize new corporate investment decisions, release permissions, numerical targets, or benchmark-specific requirements.

Keep facts actually supplied in TaskInput separate from material locators, assumptions, and missing facts. A structured selection records a reasoned choice, not a certification that attachments were read or that the downstream workflow can execute.
