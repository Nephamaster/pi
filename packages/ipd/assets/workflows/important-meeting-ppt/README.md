# Important meeting PPT 1.0.2

Governance: `project-important-meeting-presentation-simple@1.0.3` (packaged ProcessSpec).
This is the autonomous public-research variant, intended to work from a verbatim task without a supplied source pack.
It does not encode the topic, page count, budget or conclusions of a previous Run.

```text
meeting-brief ────────┐
                     ├─ baseline-gate ─ presentation-design ─ design-gate
research-and-evidence┘                                         │
                                         produce-and-finalize ─┘
                                                  │
                                             release-gate
```

The production node consumes approved brief, research and design. The final reviewer receives those versions plus
all three sealed production outputs. Reviews return exact criterion-local rework; Runtime retains approval and
invalidation authority. The original task remains the source for final adequacy, not merely the producer's plan.

- Research must actually search and open sources, retain locatable excerpts/provenance, and produce substantive
  findings. An evidence-gap table cannot satisfy the research deliverable.
- Narrative and visual planning belong to one accountable design package, avoiding contradictory parallel plans.
- Production includes generator/source, actual Skill validation, every-slide PNGs and recorded visual observations.
  Internal QA and source artifacts never become extra user delivery files.
- The only delivery is `release/meeting-report.pptx`; the filename/file-set is an explicit template constraint.
  An incompatible requested file-set needs an explicitly adapted workflow.
- Missing required work/evidence is FAIL/REWORK. BLOCKED means a concrete unavailable external prerequisite or
  inaccessible existing evidence. Never silently reinterpret the task to obtain PASS.

## Execution prerequisites

`web_search`, `fetch_content` and `get_search_content` are existing tool identifiers authorized by the Research Synthesist card; version 1.0.2
binds all three. A running Pi instance must expose real implementations, and its trusted execution backend must explicitly
support their read-only public retrieval semantics. This template does not provide those implementations or grant
general external mutation authority. Do not add names to a Profile's supportedTools list to bypass this requirement.

Authorize these existing Pi service tools with `PI_IPD_EXTERNAL_READ_TOOLS`; service tools are distinct from container
network access. Their required paging companion must also be bound explicitly, or compilation fails. Version 1.0.2 adds
paging and trusted retrieval receipts without changing the graph, criteria or other nodes. PDF imports use the returned
node workspace path. `retrieved_at` is the time the service result was received, not publication time or proof of a live refresh.
No paid-model A/B or final-PPT quality acceptance is implied by schema or infrastructure tests.

`prerequisites` gives an early no-material/no-retrieval diagnostic; normal tool and Profile validation still requires
all bound retrieval tools even if materials exist. Private/user-supplied sources must be explicitly bound by their
material IDs in a separately adapted workflow; this autonomous variant does not pretend to read unbound materials.

## Installation and versioning

Canonical asset: `packages/ipd/assets/workflows/important-meeting-ppt/1.0.2.json`.
Pi's template menu reads `<project>/.pi/ipd/workflow/important-meeting-ppt/1.0.2.json`.
Install as a new version; do not overwrite 1.0.0/1.0.1 or change an active Run's frozen Baseline.
In this workspace the destination is a symlink to `/home/nepham/.pi/ipd/workflow`.
