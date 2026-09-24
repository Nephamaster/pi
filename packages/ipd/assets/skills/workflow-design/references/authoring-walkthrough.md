# Small Workflow: Complete Authoring Walkthrough

Read for the first unfamiliar Authoring V2 interaction or an end-to-end shape example. This is a **synthetic teaching fixture**, not a production ProcessSpec or employee assignment. It demonstrates a coherent sequence of typed edits, a missing completion-field diagnostic, local repair, and capture. Do not copy its IDs, task-specific criteria, or revision numbers into a real Run.

The preconditions below describe the synthetic task, specification, and employees assumed by the payloads; those demo assets are not shipped as registered resources in this Skill package. The sequence illustrates tool usage, not evidence that a production workflow has compiled or that a model completed the task. Use actual live validation results, not the illustrative expected outcome, before submitting a real workflow.

## Preconditions supplied by trusted control and catalog inspection

**Task:** Create a Markdown briefing and its source map using only these supplied facts: Release R is proposed, not approved. The pilot covers Team North only. Migration begins only after the owner has approved it. Preserve all three conditions. The briefing must be independently reviewed before delivery. Do not perform the release or migration.

The selected process is `demo-reviewed-brief@1.0.0`. It requires `prepare-brief`, the `brief-package` output with `brief-package.source` evidence, independent `brief-review` with `brief-review.accuracy` and `brief-review.complete`, and `source-fidelity`. These are fixture identities.

Catalog inspection has supplied `demo-writer@1.0.0` (production; `read`, `write`; owned writes under `outputs/produce`) and `demo-reviewer@1.0.0` (review; `read`; no writes). The `artifact-integrity` check is registered and checks manifest integrity, not content truth. There is no business Skill prerequisite or external action. The inline task supplies all source facts, so this example needs no guessed task-material paths.

The design is `produce → review-produce`. Trusted code computes input/selection hashes. The Reviewer reads the generated candidate input; it does not wait for its own approval. There are no artificial fix nodes or extra confirmation artifacts.

## Exact tool-call sequence

The fixture starts at revision 0, with no intervening writer. Real calls always use returned revisions. The first validation deliberately occurs before `delivery_outputs` is set to demonstrate local correction; this is a teaching omission, not a recommended habit.

### 1. Open the draft

`workflow_draft_open`

```json
{}
```

### 2. Look up the exact process source

`workflow_draft_read`

```json
{
  "view": "process",
  "kind": "sources",
  "ids": [
    "brief-review.accuracy"
  ]
}
```

### 3. Declare identities and output port

`workflow_draft_topology`

```json
{
  "expected_revision": 0,
  "operation_id": "demo-topology-1",
  "nodes": [
    {
      "node_id": "produce",
      "kind": "execution",
      "name": "Prepare briefing",
      "output_ids": [
        "content-output"
      ]
    },
    {
      "node_id": "review-produce",
      "kind": "review",
      "name": "Review briefing"
    }
  ]
}
```

### 4. Configure bounded responsibilities and actual fixture resources

`workflow_draft_configure_nodes`

```json
{
  "expected_revision": 1,
  "operation_id": "demo-configure_nodes-2",
  "nodes": [
    {
      "node_id": "produce",
      "contract": {
        "objective": "Produce the requested source-bounded briefing and source map.",
        "responsibilities": [
          "Preserve all supplied facts and conditional statements."
        ],
        "non_responsibilities": [
          "Approve the briefing.",
          "Execute release or migration actions."
        ],
        "work_requirements": [
          "Create the complete briefing and source map from the inline task facts.",
          "Check that proposed status, Team North scope, and owner approval condition remain intact. Submit when the content and source map are complete."
        ],
        "constraints": [
          "Do not add unsupported facts or perform external actions."
        ]
      },
      "employee": {
        "agent_ref": {
          "id": "demo-writer",
          "version": "1.0.0"
        },
        "participant_id": "writer"
      },
      "resources": {
        "required_capabilities": [
          "production"
        ],
        "skills": [],
        "tools": [
          {
            "id": "read"
          },
          {
            "id": "write"
          }
        ],
        "knowledge_bases": [],
        "permissions": {
          "read_paths": [
            "."
          ],
          "write_paths": [
            "outputs/produce"
          ],
          "external_actions": false
        }
      }
    },
    {
      "node_id": "review-produce",
      "contract": {
        "objective": "Independently assess the exact briefing package.",
        "responsibilities": [
          "Check fidelity to the inline task facts and internal completeness."
        ],
        "non_responsibilities": [
          "Rewrite the briefing to match personal style."
        ],
        "work_requirements": [
          "Read the actual candidate and source map. Report criterion-local evidence and precise repair locations."
        ],
        "constraints": [
          "Do not modify the candidate or introduce new acceptance conditions."
        ]
      },
      "employee": {
        "agent_ref": {
          "id": "demo-reviewer",
          "version": "1.0.0"
        },
        "participant_id": "reviewer"
      },
      "resources": {
        "required_capabilities": [
          "review"
        ],
        "skills": [],
        "tools": [
          {
            "id": "read"
          }
        ],
        "knowledge_bases": [],
        "permissions": {
          "read_paths": [
            "outputs/produce"
          ],
          "write_paths": [],
          "external_actions": false
        }
      }
    }
  ]
}
```

### 5. Define the usable output and nested process evidence binding

`workflow_draft_outputs`

```json
{
  "expected_revision": 2,
  "operation_id": "demo-outputs-3",
  "upsert": [
    {
      "node_id": "produce",
      "output_id": "content-output",
      "artifact_type": "text-bundle",
      "description": "A complete Markdown briefing and a statement-to-source map.",
      "business_purpose": "Give the recipient a source-faithful briefing and let the Reviewer inspect each factual claim.",
      "path_prefix": "outputs/produce",
      "evidence_requirements": [
        "Identify the inline source for each substantive claim and retained condition."
      ],
      "process_evidence_requirement_refs": [
        "brief-package.source"
      ]
    }
  ]
}
```

### 6. Copy process authority through the source helper

`workflow_draft_governance`

```json
{
  "expected_revision": 3,
  "operation_id": "demo-governance-4",
  "metadata": {
    "workflow_id": "demo-briefing",
    "workflow_version": "1.0.0",
    "name": "Demonstration briefing workflow"
  },
  "requirements": {
    "from_process": [
      {
        "requirement_id": "req-fidelity",
        "source_id": "brief-review.accuracy",
        "strength": "required"
      }
    ]
  }
}
```

### 7. Define mechanical and semantic checks as structured objects

`workflow_draft_criteria`

```json
{
  "expected_revision": 4,
  "operation_id": "demo-criteria-5",
  "upsert": [
    {
      "criterion_id": "integrity",
      "definition": {
        "kind": "mechanical",
        "description": "Files match the recorded manifest; this check does not prove factual accuracy.",
        "check_id": "artifact-integrity",
        "parameters": {},
        "evidence_requirements": []
      },
      "output_bindings": [
        {
          "node_id": "produce",
          "output_id": "content-output"
        }
      ]
    },
    {
      "criterion_id": "fidelity",
      "definition": {
        "kind": "semantic",
        "description": "The briefing retains proposed status, the Team North-only pilot scope, and the owner-approval prerequisite without unsupported additions.",
        "evidence_requirements": [
          "Corresponding passages in the exact briefing and source map."
        ],
        "process_criterion_refs": [
          "brief-review.accuracy"
        ],
        "requirement_refs": [
          "req-fidelity"
        ],
        "blocking": true
      },
      "output_bindings": [
        {
          "node_id": "produce",
          "output_id": "content-output"
        }
      ]
    },
    {
      "criterion_id": "completeness",
      "definition": {
        "kind": "semantic",
        "description": "The briefing and source map are complete, mutually consistent, and contain substantive coverage of every requested fact.",
        "evidence_requirements": [
          "The exact briefing and its source map, including locatable coverage."
        ],
        "process_criterion_refs": [
          "brief-review.complete"
        ]
      },
      "output_bindings": [
        {
          "node_id": "produce",
          "output_id": "content-output"
        }
      ]
    }
  ]
}
```

### 8. Assign independent judgments; code derives candidate-reading inputs

`workflow_draft_reviews`

```json
{
  "expected_revision": 5,
  "operation_id": "demo-reviews-6",
  "upsert": [
    {
      "review_node_id": "review-produce",
      "assignments": [
        {
          "criterion_id": "fidelity",
          "mode": "single",
          "subjects": [
            {
              "node_id": "produce",
              "output_id": "content-output"
            }
          ]
        },
        {
          "criterion_id": "completeness",
          "mode": "single",
          "subjects": [
            {
              "node_id": "produce",
              "output_id": "content-output"
            }
          ]
        }
      ],
      "allowed_rework_node_ids": [
        "produce"
      ]
    }
  ]
}
```

### 9. Map process obligations to their actual implementation

`workflow_draft_coverage`

```json
{
  "expected_revision": 6,
  "operation_id": "demo-coverage-7",
  "upsert": [
    {
      "source": "process_activity",
      "requirement_id": "prepare-brief",
      "responsible_node_ids": [
        "produce"
      ],
      "output_refs": [
        {
          "node_id": "produce",
          "output_id": "content-output"
        }
      ],
      "criterion_refs": []
    },
    {
      "source": "process_deliverable",
      "requirement_id": "brief-package",
      "responsible_node_ids": [
        "produce"
      ],
      "output_refs": [
        {
          "node_id": "produce",
          "output_id": "content-output"
        }
      ],
      "criterion_refs": [
        "integrity",
        "fidelity",
        "completeness"
      ]
    },
    {
      "source": "process_review",
      "requirement_id": "brief-review",
      "responsible_node_ids": [
        "review-produce"
      ],
      "output_refs": [
        {
          "node_id": "produce",
          "output_id": "content-output"
        }
      ],
      "criterion_refs": [
        "fidelity",
        "completeness"
      ]
    },
    {
      "source": "process_rule",
      "requirement_id": "source-fidelity",
      "responsible_node_ids": [
        "review-produce"
      ],
      "output_refs": [
        {
          "node_id": "produce",
          "output_id": "content-output"
        }
      ],
      "criterion_refs": [
        "fidelity"
      ]
    }
  ]
}
```

### 10. Record most completion fields

`workflow_draft_completion`

```json
{
  "expected_revision": 7,
  "operation_id": "demo-completion-8",
  "required_node_ids": [
    "produce",
    "review-produce"
  ],
  "final_outputs": [
    {
      "node_id": "produce",
      "output_id": "content-output"
    }
  ],
  "required_review_node_ids": [
    "review-produce"
  ]
}
```

### 11. Validate and inspect the missing delivery choice

`workflow_draft_validate`

```json
{
  "expected_revision": 8,
  "mode": "compile"
}
```

Expected condition: validation is not valid because `delivery_outputs` is still missing. Use the actual returned diagnostic, not a fabricated message. Validation does not increment the revision or mean the graph executed.

### 12. Repair only delivery_outputs

`workflow_draft_completion`

```json
{
  "expected_revision": 8,
  "operation_id": "demo-add-delivery-9",
  "delivery_outputs": [
    {
      "node_id": "produce",
      "output_id": "content-output"
    }
  ]
}
```

### 13. Compile the completed revision

`workflow_draft_validate`

```json
{
  "expected_revision": 9,
  "mode": "compile"
}
```

Required outcome before capture: compile-mode validation returns valid for revision 9 in the supplied fixture. If real validation reports another problem, inspect and repair it instead of assuming this expected outcome occurred.

### 14. Capture the exact revision

`workflow_draft_submit`

```json
{
  "expected_revision": 9,
  "operation_id": "demo-capture-1"
}
```

## Interpretation

The example makes nine successful mutations; reads and validation do not consume edit revisions. Changing a correction payload creates a new operation, while an uncertain successful receipt uses the original operation identity. Submission captures a candidate for independent compilation; it is not the user's delivered briefing and does not run either node.

For other tasks, replace the work and standards with the selected process's actual obligations. Add stages or composite review only when real dependencies and evidence require them. The source helper copies authority, not substantive task fulfillment; the Designer must still make the criteria meaningful.
