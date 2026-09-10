# ProcessSpec Reading Guide

This reference explains how ST should interpret ProcessSpec fields during **process selection**.

It does not teach Workflow design and does not equate ProcessSpec fields with nodes.

## 1. `applicable_when`

Describes the task types, objects, delivery modes, or governance situations the ProcessSpec is intended for.

During selection, look for positive evidence in TaskInput.

Correct interpretation:

> The current task has these characteristics, so this ProcessSpec may apply.

Incorrect interpretation:

> The task name and ProcessSpec name contain similar words, therefore it applies.

If one applicability condition contains several substantive prerequisites, verify that those prerequisites are actually supported.

Do not fill missing prerequisites using model common sense.

## 2. `not_applicable_when`

Defines explicit boundaries where the ProcessSpec should not be used.

It often has stronger selection priority than general positive similarity.

If TaskInput clearly triggers one exclusion condition, eliminate the candidate.

If the answer depends on a decisive unresolved fact, do not default to "not excluded." Consider a blocked decision.

## 3. `required_activities`

Defines which **responsibilities must exist** after selecting the ProcessSpec.

ST does not determine how many nodes will later represent one activity.

ST asks:

- Does this responsibility genuinely belong in the governance scope of the current task?
- Does the ProcessSpec require obviously irrelevant mandatory activity?

`required_capabilities` describes the professional capability normally required to perform the activity.

It does not mean ST should select an employee now.

## 4. `required_deliverables`

Defines controlled artifacts the process requires and what evidence those artifacts must provide.

ST asks whether the current task genuinely needs:

- that kind of artifact; or
- the governance responsibility represented by that artifact.

Do not assume a required deliverable is the user-facing final deliverable.

It may be an internal:

- baseline;
- analysis;
- design specification;
- verification record;
- quality report.

If a ProcessSpec mandates a completely irrelevant real-world deliverable, that is evidence the ProcessSpec may be unsuitable.

It is not something the Workflow Designer may simply delete later.

## 5. `required_reviews`

Defines which artifacts require independent professional judgment and what quality aspects matter.

During selection, ask:

> Does the current task actually need this independent quality control, and does it correspond to a material risk?

`independent_agent: true` means later design must preserve producer/reviewer separation.

ST only understands this as an organizational obligation.

ST does not choose the Reviewer.

## 6. `workflow_rules`

Defines cross-activity, cross-deliverable, or whole-process organizational and quality principles.

Selection asks:

- does this rule provide necessary governance value for the task?
- or does it impose an obviously unnecessary constraint?

`enforced_by` indicates the intended enforcement layer such as:

- compiler;
- runtime;
- review.

ST does not validate the implementation of those enforcement layers and must not remove a rule because engine support is currently limited.

## 7. `source`

Explains provenance and authority boundaries.

Examples:

- project-authored bootstrap spec;
- public-source engineering mapping;
- formal internal ProcessSpec.

These sources have different authority.

ST should use the registered ProcessSpec's declared applicability and normative content.

Do not describe a project-derived ProcessSpec as an official Huawei internal template.

Likewise, authoritative provenance does not mean the ProcessSpec applies to every task.

## 8. "More Complete" Does Not Mean "More Appropriate"

A ProcessSpec with more phases, reviews, roles, or activities is not automatically better.

Good selection balances task complexity and governance cost:

```text
Under-governance
→ important responsibilities and quality risks remain uncontrolled

Good fit
→ sufficient responsibility, deliverables, and reviews
  without obvious unrelated process tax

Over-governance
→ substantial mandatory work is irrelevant to the current task
```

ST should seek the middle state rather than assuming "more process is safer."
