# Important meeting PPT 1.1.0

Governance: the unchanged packaged `project-important-meeting-presentation-simple@1.0.3`.
This is a reusable **single-PPTX, public-research** workflow, not a topic-specific Run and not the separate
seven-review `project-reviewed-content-delivery` process. The raw task supplies the actual meeting subject,
audience, language, duration and page requirements. Older workflow versions remain unchanged.

## Work and control flow

```text
meeting-brief ──┬── research-and-evidence ── baseline-gate ── storyline-design ──┐
                │                           (also reviews brief)               ├── design-gate
                └── visual-design ────────────────────────────────────────────┘        │
                                                                             produce-and-finalize
                                                                                      │
                                                                                 release-gate
```

The four pre-production execution nodes share one `pre-production` StageScope. This is a quality scope,
not an additional Agent. Only research and visual preparation may consume the exact submitted brief before
Gate 1. The scope has early exits for brief/content through `baseline-gate` and later exits for storyboard/visual
foundation through `design-gate`. Production consumes all four approved exits. There is no approval cycle,
implicit message handoff, or permission to consume another node's mutable work.

The graph remains **five execution nodes and three independent reviews**, not a new role for every check:

| Node | Bound role | Responsibility and readiness boundary |
|---|---|---|
| `meeting-brief` | Product Manager | Preserve the task and give research a bounded question agenda; submit before the later joint Gate. |
| `research-and-evidence` | Research Synthesist | Actually answer that agenda with source-grounded content; stop repetitive searches once required substance and evidence are sufficient. |
| `baseline-gate` | Trend Researcher | Check scope and decision-critical retained evidence, including whether research used the exact brief version. |
| `storyline-design` | Visual Storyteller | Form production-ready messages and sequence from the approved content, not a second research report. |
| `visual-design` | UI Designer | Prepare reusable visual conventions from the brief only, in parallel with research; no fabricated data or unfinished-storyline dependency. |
| `design-gate` | Proposal Strategist | Assess each design and the explicit joint `design.compatible` criterion without redesigning them to personal taste. |
| `produce-and-finalize` | Visual Storyteller + `pptx` Skill | Compose, render, inspect and finalize the actual deck; reuse the Skill and make changes driven by observed defects. |
| `release-gate` | Evidence Collector | Independently inspect content, visual evidence, file-use evidence and the exact release/production/QA combination. |

Visual preparation does **not** own data-specific charts or final page composition. Storyline owns the messages
and evidence; production combines them with the reusable foundation. This limited responsibility makes early
parallelism real. A brief change can affect both branches; a research-only correction does not make the visual
foundation's content invalid merely because its sibling or a shared review changes.

## What changes from 1.0.4

- The research agenda now has a real input edge: `meeting-brief` → `research-and-evidence`, rather than instructions
  to use a brief that the researcher never receives. This adds a short prerequisite but avoids duplicate scope decisions;
  the net timing effect still needs measurement.
- Visual preparation starts with the submitted brief and no longer depends on the research output. Task-specific
  visual decisions remain with the later content-aware work, so this does not conceal a true dependency.
- Every producer has a task-specific candidate-submission boundary. Required missing work remains a defect or a
  genuine block; stopping endless refinement is not permission to omit work or lower standards.
- Handoffs have a concise navigation entry, complete usable content and source locators. They do not require duplicate
  summaries, research diaries, per-slide schemas, token matrices, source quotas or invented numeric style limits.
- `design.compatible` explicitly covers both designs. `release.package-consistent` explicitly covers the working deck,
  release file and QA. The same criterion is defined once and has an exact `criterion_subjects` set.
- Production uses an early representative create/render check within its own work, local previews during revision,
  then actual whole-deck final validation. Rendered evidence is retained, but model requests need not repeatedly load it all.
- The file-set check accepts exactly one `.pptx` rather than enforcing an arbitrary basename. Use an explicitly requested
  basename; otherwise `meeting-report.pptx` is the production default. The file-set check does not prove editability or opening.

These are Workflow asset changes. No Runtime, Schema, ProcessSpec, AgentCard, model routing, checklist/reviewlist
protocol, dependency or recursive-IPD capability is added.

## Precise repair

Review Findings carry exact criterion-local output targets. The template defines bounded `remediation_mappings`
only for a reviewed output's directly bound content owner; mapped repair requires supported root-cause evidence.
It does not grant unrestricted ancestor routing.

| Observed defect | Repair intent |
|---|---|
| Research claim unsupported; brief correct | Research owner corrects the content; unrelated visual work is retained. Actual content consumers and affected judgments are refreshed by Runtime. |
| Storyboard drops an otherwise correct answer | Storyline owner repairs its message/coverage; research and visual foundation do not reproduce their correct outputs. |
| Two designs materially conflict | Gate 2 cites both subjects but targets the actual responsible designer(s), not both by default. |
| Production copies a correct value incorrectly or clips a label | Production repairs the affected deck/output and evidence; approved upstream artifacts are not rewritten. |
| A later Gate establishes a real upstream error | Use only the frozen mapping, exact owner evidence and supported root cause; Runtime invalidates actual dependants and obtains fresh judgments. |
| QA points at an older deck | Repair QA when the current deck is sound; the joint package judgment must be renewed, not every upstream production task. |

A revoked joint approval can require re-review without requiring all assessed content to be regenerated. The template
specifies responsibilities and truthful dependencies; Runtime owns actual invalidation, Session retention and scheduling.
It never hides a dependency to manufacture an apparent reduction in rework.

## Artifacts and evidence

Production declares three disjoint outputs:

| Output | Contents | Delivered to user? |
|---|---|---|
| `presentation-deck` | Editable working deck and only the source/assets needed for revision | No |
| `final-presentation-package` | Exactly one finalized PPTX | Yes |
| `validation-evidence` | Candidate-linked renders, extracted slide content and honest check records | No |

All three are required final outputs. The QA record identifies the candidate hash, the actual checks and their scope;
working and release deck identities must agree. A package/extension check, producer assertion or successful shell pipeline
is not proof of factual, rendering or business correctness.

The existing Evidence Collector is **read-only**. It can inspect saved candidate content, images and check evidence,
but this template does not grant it Bash, a PPTX renderer or the ability to independently rerun binary-format tests.
Missing evidence the producer owed is FAIL; genuinely inaccessible checking conditions may be BLOCKED. Neither is PASS.
Use an explicitly adapted asset/capability configuration when the task demands additional independent execution.

## Preconditions and adaptation boundary

The workflow is suitable when the requested analysis can be supported by authorized public retrieval and the primary
delivery is one editable PPTX. It does not freeze a topic, claim a universal ideal slide count, or provide specialist
legal/clinical/financial approval. Tasks needing professional judgments outside the bound roles require adaptation.

`web_search`, `fetch_content` and `get_search_content` are real tool IDs authorized by the Research Synthesist card.
A running Pi must expose their implementations and trusted read-only semantics. Authorize service tools with
`PI_IPD_EXTERNAL_READ_TOOLS`; that does not grant general container egress. Required paging tools must remain bound.
Follow actual import paths and retrieval receipts. A receipt timestamp is not publication time or proof of a live refresh.

The production `pptx` Skill, its required tools, compatible environment and rendering dependencies must actually exist.
No workflow text substitutes for missing software or permissions. No model choice or timing estimate is encoded here.

`prerequisites` retains the early no-material/no-retrieval diagnostic. All declared retrieval tools are still required
by normal compilation. **This generic asset has no `task_material` bindings.** Supplied private documents, brand templates,
restricted datasets, offline-only research, or a different user-facing file set require an explicitly adapted Workflow
with actual material IDs and compatible resources. It must not claim to consume those materials through the raw task alone.

## Installation and validation

Canonical asset: `packages/ipd/assets/workflows/important-meeting-ppt/1.1.0.json`.
Pi's template menu reads `<project>/.pi/ipd/workflow/important-meeting-ppt/1.1.0.json`.
Copy the new version to that configured workflow asset directory; account for any existing directory symlink.
The launch path rebinds the placeholder TaskInput and ProcessSelection references. Do not execute the zero-hash
placeholders directly or overwrite a running Run's frozen Baseline. Select this version explicitly for the next test.

The package's presentation-template tests include Compiler checks for the new variant and negative cases for stage
bypass, missing composite subjects and unauthorized remediation. These establish formal relationships, not real
retrieval availability, PPTX software readiness, model behavior or final-deck quality. Measure a new end-to-end Run
before claiming a speedup, using the same task, model conditions and independent quality bar.

Historical variants remain available: 1.0.1/1.0.2 were the earlier research-and-design chain; 1.0.3 introduced parallel
design; 1.0.4 removed prescriptive layout and internal-document machinery. 1.1.0 changes the input graph and quality
bindings without silently changing those earlier published files.
