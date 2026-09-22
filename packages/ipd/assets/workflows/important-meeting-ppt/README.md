# Important meeting PPT 1.0.4

Governance: `project-important-meeting-presentation-simple@1.0.3` (packaged ProcessSpec).
This is the autonomous public-research variant, intended to work from a verbatim task without a supplied source pack.
It does not encode the topic, page count, budget or conclusions of a previous Run.

```text
meeting-brief ────────┐                   ┌─ storyline-design ─┐
                     ├─ baseline-gate ───┤                    ├─ design-gate
research-and-evidence┘                   └─ visual-design ────┘       │
                                            produce-and-finalize ────┘
                                                      │
                                                 release-gate
```

The production node consumes approved brief, research, storyline and visual system. The final reviewer receives those versions plus
all three sealed production outputs. Reviews return exact criterion-local rework; Runtime retains approval and
invalidation authority. The original task remains the source for final adequacy, not merely the producer's plan.

- Research must actually search and open sources, retain locatable excerpts/provenance, and produce substantive
  findings. An evidence-gap table cannot satisfy the research deliverable.
- Storyline and visual design run in parallel from the same approved baseline. Gate 2 reviews the two sealed
  packages together and sends material defects to the responsible designer. Production consumes both approved outputs.
- Storyline owns sequence and slide messages; visual design owns visual hierarchy and data/diagram expression. Agents
  choose their internal document format, layouts and production method within the assigned scope.
- Production uses the bound PPTX Skill, inspects the actual deck and supplies truthful, accessible visual evidence.
  Internal QA and source artifacts never become extra user delivery files.
- The only delivery is `release/meeting-report.pptx`; the filename/file-set is an explicit template constraint.
  An incompatible requested file-set needs an explicitly adapted workflow.
- Missing required work/evidence is FAIL/REWORK. BLOCKED means a concrete unavailable external prerequisite or
  inaccessible existing evidence. Never silently reinterpret the task to obtain PASS.

## Execution prerequisites

`web_search`, `fetch_content` and `get_search_content` are existing tool identifiers authorized by the Research Synthesist card; version 1.0.4
binds all three. A running Pi instance must expose real implementations, and its trusted execution backend must explicitly
support their read-only public retrieval semantics. This template does not provide those implementations or grant
general external mutation authority. Do not add names to a Profile's supportedTools list to bypass this requirement.

Authorize these existing Pi service tools with `PI_IPD_EXTERNAL_READ_TOOLS`; service tools are distinct from container
network access. Their required paging companion must also be bound explicitly, or compilation fails. Version 1.0.4 retains
the explicit paging and trusted retrieval receipts introduced in 1.0.2. PDF imports use the returned
node workspace path. `retrieved_at` is the time the service result was received, not publication time or proof of a live refresh.
No paid-model A/B or final-PPT quality acceptance is implied by schema or infrastructure tests.

## Nodes and handoff

| Node | Packaged role | Main internal output |
|---|---|---|
| Meeting Brief | Product Manager | `brief.md`: audience, decision, constraints and research questions |
| Evidence and Core Messages | Research Synthesist | Source-grounded content baseline and inspectable supporting evidence |
| Gate 1 - Brief and Evidence Baseline | Trend Researcher | Criterion-level independent review of brief and evidence |
| Storyline and Slide Architecture | Visual Storyteller | Storyboard or equivalent slide plan |
| Visual System and Data Expression | UI Designer | Visual direction and data/diagram guidance |
| Gate 2 - Presentation Design | Proposal Strategist | Joint review of both designs and their production compatibility |
| Build, Render and Finalize Deck | Visual Storyteller + bound `pptx` Skill | Editable deck, relevant source and honest validation evidence |
| Gate 3 - Independent Release Review | Evidence Collector | Independent inspection of final slide content, visuals and readiness |

UI Designer is bound for fixed-slide visual hierarchy and design-system work. The existing professional cards and
ProcessSpec are unchanged. The additional visual output is internal and receives one broad `visual.usable` judgment;
it does not become a user delivery file. Compared with 1.0.3, this version removes mandatory per-slide schema,
token matrices, label/capacity arithmetic, exact internal file names and prescriptive render formats. Gate 2 rejects
observable, material gaps rather than negotiating every design value. Final QA remains based on the actual deck and
evidence actually present in the sealed submission.

`prerequisites` gives an early no-material/no-retrieval diagnostic; normal tool and Profile validation still requires
all bound retrieval tools even if materials exist. Private/user-supplied sources must be explicitly bound by their
material IDs in a separately adapted workflow; this autonomous variant does not pretend to read unbound materials.

## Installation and versioning

Canonical asset: `packages/ipd/assets/workflows/important-meeting-ppt/1.0.4.json`.
Pi's template menu reads `<project>/.pi/ipd/workflow/important-meeting-ppt/1.0.4.json`.
Install as a new version; do not overwrite earlier versions or change a Run's frozen Baseline.
In this workspace the destination is a symlink to `/home/nepham/.pi/ipd/workflow`.
