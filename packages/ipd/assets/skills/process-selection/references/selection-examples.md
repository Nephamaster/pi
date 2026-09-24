# Selection Examples

Read when you need an end-to-end decision example. All IDs below belong to a **synthetic two-entry catalog**, not the production registry. Never select them in a real Run unless that exact fixture has been explicitly provided. The examples share this catalog meaning:

| Exact entry | Applicability and mandatory responsibility | Exclusion |
|---|---|---|
| `demo-reviewed-brief@1.0.0` | Source-bounded briefing; production, source map, independent fidelity/completeness review. Supporting IDs: `prepare-brief`, `brief-package`, `brief-review`, `source-fidelity`. | Principal work is implementing or operating a system. |
| `demo-software-change@1.0.0` | Software implementation and tests; independent implementation review. Supporting IDs: `implement-change`, `change-package`, `change-review`. | Briefing only, with no implementation. |

Assume catalog search and exact `get_process_spec` reads have returned these entries in the fixture. Exact lookup uses `{id, version}`; submission uses the different field names `{process_spec_id, process_spec_version}`. For example:

```json
{
  "id": "demo-reviewed-brief",
  "version": "1.0.0"
}
```

## S1. A justified selection

**Task:** Create a Markdown briefing and its source map using only these supplied facts: Release R is proposed, not approved. The pilot covers Team North only. Migration begins only after the owner has approved it. Preserve all three conditions. The briefing must be independently reviewed before delivery. Do not perform the release or migration.

**Judgment:** Read the exact candidate and select it without creating nodes or choosing employees.

`submit_process_selection`:

```json
{
  "status": "selected",
  "process_spec_id": "demo-reviewed-brief",
  "process_spec_version": "1.0.0",
  "rationale": "The requested work is a supplied-fact briefing with independent acceptance, which this process directly governs. The software-change process is excluded because no implementation is requested.",
  "process_requirement_refs": [
    "prepare-brief",
    "brief-package",
    "brief-review",
    "source-fidelity"
  ],
  "unresolved_fact_refs": []
}
```

## S2. A familiar output word does not decide the process

**Task:** Implement a command-line text formatter, add automated tests, and provide a short change report.

**Judgment:** Reject the briefing process even though the request mentions a report.

`submit_process_selection`:

```json
{
  "status": "selected",
  "process_spec_id": "demo-software-change",
  "process_spec_version": "1.0.0",
  "rationale": "The main deliverable is implemented software and tests; the report is secondary. A briefing-only process does not govern this implementation.",
  "process_requirement_refs": [
    "implement-change",
    "change-package",
    "change-review"
  ],
  "unresolved_fact_refs": []
}
```

## S3. A non-decisive unknown does not block

**Task:** Create a Markdown briefing and its source map using only these supplied facts: Release R is proposed, not approved. The pilot covers Team North only. Migration begins only after the owner has approved it. Preserve all three conditions. The briefing must be independently reviewed before delivery. Do not perform the release or migration.

**Supplied unresolved facts:**

```json
[
  {
    "fact_id": "tone-preference",
    "description": "The preferred prose tone is not confirmed.",
    "source": "user-message:demo"
  }
]
```

**Judgment:** Continue selection and retain only the existing relevant fact ID.

`submit_process_selection`:

```json
{
  "status": "selected",
  "process_spec_id": "demo-reviewed-brief",
  "process_spec_version": "1.0.0",
  "rationale": "The source-bounded briefing and independent review requirements are clear. The unconfirmed prose tone does not change process applicability or required governance and is preserved for later handling.",
  "process_requirement_refs": [
    "prepare-brief",
    "brief-package",
    "brief-review",
    "source-fidelity"
  ],
  "unresolved_fact_refs": [
    "tone-preference"
  ]
}
```

## S4. A decisive unknown blocks selection

**Task:** Prepare the project handover. It is not yet confirmed whether this requires implementation changes or only a reviewed briefing.

**Supplied unresolved facts:**

```json
[
  {
    "fact_id": "handover-scope",
    "description": "Implementation versus briefing-only scope is undecided.",
    "source": "user-message:unknown"
  }
]
```

**Judgment:** Do not invent scope or manufacture a default selection.

`submit_process_selection`:

```json
{
  "status": "blocked",
  "reason": "Whether handover requires software implementation or only a reviewed briefing changes which mandatory responsibility is required. The supplied task does not resolve that choice. Confirm the actual handover scope.",
  "unresolved_fact_refs": [
    "handover-scope"
  ]
}
```

## S5. No applicable process in a known complete fixture catalog

**Task:** Carry out physical vibration qualification on supplied hardware and report measured results.

**Judgment:** Do not disguise physical testing as document writing. The absence claim applies only to this explicitly complete two-entry fixture.

`submit_process_selection`:

```json
{
  "status": "blocked",
  "reason": "In this two-entry demonstration catalog, neither a briefing-only process nor a software-change process governs the requested physical qualification work. A suitable published process is needed.",
  "unresolved_fact_refs": []
}
```

## What the examples do not prove

A valid payload and plausible explanation do not demonstrate model reliability or that real staff/tools are available. A one-page search is not evidence that a large real catalog is exhausted. Do not use the fixture's "two-entry catalog" absence conclusion outside that explicit setup. All unknown-fact references must come from the actual TaskInput.
