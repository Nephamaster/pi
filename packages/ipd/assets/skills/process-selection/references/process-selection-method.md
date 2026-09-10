# Process Selection Decision Method

Use this reference when:

- the ProcessSpec catalog contains many candidates;
- several candidates appear applicable;
- unresolved facts may affect the choice.

This is not a fixed scoring formula.

## 1. Build a Task Governance Profile

Extract only TaskInput characteristics supported by actual sources.

Consider at least:

| Dimension | Question |
|---|---|
| task nature | Is the primary work research, content delivery, software implementation, product verification, data analysis, or another class? |
| final delivery | Does the user need a file, system, analytical conclusion, decision material, or immediate answer? Is acceptance explicit? |
| professional breadth | Are several materially different professional responsibilities required? |
| object complexity | Is the object text, data, software, software+hardware, a physical product, etc.? |
| requirement stability | Are objectives and key inputs stable, or do unknowns still determine the process type? |
| quality risk | Are errors difficult to detect early or expensive to fix late? |
| verification cost | Does the result require independent verification, real environments, professional testing, or high-cost validation? |
| delivery cadence | One-time delivery, rapid iteration, or long staged maturity? |

These dimensions are for understanding, not numeric scoring.

## 2. Use Three Selection Layers

### A. Hard Exclusion

Any `not_applicable_when` explicitly triggered by TaskInput eliminates the candidate.

If a decisive unknown prevents you from determining whether an exclusion applies, mark the candidate as unresolved rather than assuming it passes.

### B. Positive Applicability

Check whether `applicable_when` has concrete evidence in TaskInput.

You should be able to identify actual task facts.

"Semantic similarity" is not enough.

### C. Governance Fit

For candidates that pass the first two layers, compare:

- whether required activities cover the task's major responsibilities;
- whether required deliverables match the controlled artifacts the task needs;
- whether required reviews correspond to real quality risks;
- whether workflow rules match the task's organization;
- whether obvious irrelevant mandatory work exists.

## 3. Candidate Comparison Table

You may internally use:

| Candidate | Exclusion | Positive Evidence | Main Governance Value | Obvious Process Tax | Decisive Unknown | Conclusion |
|---|---|---|---|---|---|---|
| Spec A | none | strong | directly covers research + formal delivery | low | none | preferred |
| Spec B | none | medium | delivery covered, professional validation weak | low | none | under-governed |
| Spec C | triggered | - | - | - | - | eliminated |

Do not convert this table into a fake total score.

A hard exclusion cannot be outweighed by other positive points.

## 4. Professional Spec vs Generic Spec

When both a professional spec and a general/default spec are applicable:

- prefer the professional spec if it truly provides better-fit responsibility and review for the task object and risk;
- do not prefer it merely because it is "professional" if it imposes large irrelevant mandatory work;
- choose the generic spec when it sufficiently governs the task and the professional spec lacks real applicability;
- block when decisive facts are missing and the two choices imply materially different mandatory governance.

A default spec is an ordinary candidate, not an automatic fallback.

## 5. Classify Unresolved Facts

### Non-Decisive Unknown

Does not change the selected process type, only later execution detail.

Action:

- selection may proceed;
- include the fact in `unresolved_fact_refs` when relevant.

### Decisive Unknown

Changes:

- positive applicability;
- exclusion applicability;
- which candidate is better;
- the task's process class.

Action:

- `blocked`;
- explain what must be known and why it changes the process decision.

### Selection-Irrelevant Unknown

Does not affect process applicability or governance type.

Action:

- do not force it into the rationale for completeness;
- TaskInput remains the source of truth for downstream handling.

## 6. Typical `blocked` Conditions

Normally block when:

1. no ProcessSpec applicability condition can be reliably supported by TaskInput;
2. all plausible candidates are explicitly excluded;
3. several candidates have materially different governance but decisive information is missing;
4. user requirements conflict such that the process class cannot be determined;
5. no current ProcessSpec honestly covers the task class.

Do not automatically treat "the employee pool lacks a capability" as case 5.

That is normally a later implementation gap.

## 7. Recommended Rationale Structure

For `selected`, compress the rationale into three logical parts:

```text
Task characteristics:
What delivery, complexity, and quality-control needs matter.

Process fit:
Which applicability conditions and mandatory responsibilities of the selected spec address those needs.

Comparison:
Why it is better than the main alternative, if one exists,
and which non-decisive unresolved facts remain.
```

For `blocked`, answer:

```text
What fact is missing or conflicting;
which applicability/exclusion judgment it affects;
why reliable selection is impossible without inventing facts.
```

Avoid:

- "After comprehensive consideration, choose X";
- reproducing the whole ProcessSpec;
- exposing long internal reasoning;
- invented risk scores or confidence percentages.

## 8. Final Decision Principle

> **Eliminate clearly inapplicable specs first. Among genuinely applicable candidates, choose the one that sufficiently controls the task's major complexity and quality risks without obvious irrelevant process tax. If decisive information is missing, stop guessing and return blocked.**
