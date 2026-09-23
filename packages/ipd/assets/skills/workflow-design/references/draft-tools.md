# Draft Tool Protocol — Authoring V2

These private control tools are injected into the Workflow Designer Session. Do not list them as ordinary global `allowed-tools`. Do not substitute Bash, direct file writes, complete Workflow objects or JSON Patch when a tool is unavailable.

**AuthoringDraft V2 may be incomplete. Its deterministic output is the existing WorkflowDefinition V3, checked by the existing Compiler.** A saved edit is neither a valid Workflow nor permission to execute it. Business Run Skills remain optional; an absent method is not itself a resource block.

## 1. Tool Surface

All mutation tools and `workflow_draft_submit` take `expected_revision` and a stable `operation_id`. The payload column lists the remaining fields; live Tool Schema defines exact types.

| Tool | Payload | Behavior |
|---|---|---|
| `workflow_draft_open` | `{}` | Open the single draft; return summary, revision and missing choices. |
| `workflow_draft_read` | `view`, selectors, `limit`, `cursor` | Scoped read, not full Workflow output. |
| `workflow_draft_topology` | `nodes?`, `connections?`, `remove_node_ids?` | Declare node identity, optional output IDs, and real input sources. |
| `workflow_draft_configure_nodes` | `nodes` | Each item has `node_id` and changed name/contract/employee/resources/environment sections. |
| `workflow_draft_outputs` | `upsert?`, `remove?` | Edit output substance, type, purpose, path and evidence by node/output ID. |
| `workflow_draft_criteria` | `upsert?`, `remove_ids?` | Edit criterion definition and production output bindings. |
| `workflow_draft_inputs` | `upsert?`, `remove?` | Edit source, requiredness, purpose and access by consumer/input ID. |
| `workflow_draft_reviews` | `upsert` | Edit assignments, legal repair owners, relations, remediation and policy. |
| `workflow_draft_stages` | `upsert?`, `remove_ids?` | Edit stage identity, members and Gate-controlled exits. |
| `workflow_draft_governance` | `metadata?`, `prerequisites?`, `requirements?`, `decisions?` | Metadata is partial; requirements/decisions use upsert/remove_ids. |
| `workflow_draft_coverage` | `upsert?`, `remove?` | Edit rows keyed by ProcessSpec source and requirement_id. |
| `workflow_draft_completion` | supplied completion fields | Change only required nodes/reviews and final/delivery outputs supplied. |
| `workflow_draft_validate` | `expected_revision`, `mode?` | Draft completeness or full compile; return diagnostics, never the full Workflow. |
| `workflow_draft_submit` | envelope only | Revalidate and persist exact candidate/receipt, then end this design turn. |

Employee catalog and design-block tools remain available. New sessions do not receive `workflow_draft_apply`. `set_header` and `upsert_node` are not new tool names.

## 2. Partial Updates, Defaults and Deletions

Omitted fields keep their values. Supplied arrays replace only that field, including `[]`; a required empty array remains incomplete. Contracts and permissions merge supplied fields. `environment_ref: null`, `prerequisites: null` and review `decision_policy: null` clear those overrides; arbitrary null is rejected.

Node declarations do not overwrite contracts or existing names; use configure_nodes for name changes. Node and criterion kinds cannot change in place. Topology may declare a connection, but only inputs can explicitly reconnect it. All edits are atomic: a bad reference saves nothing. Remove incoming references before deleting their target; deletion does not cascade through unrelated work.

Defaults are limited: generated Workflow ID, version `1.0.0`, output root `outputs/<node>/<output>`, participant `main`, empty optional capability/Skill/knowledge lists, and external actions disabled when creating an employee binding. No employee, tool list, readable/writable paths, input requiredness/purpose, approval source, standard, repair owner or completion obligation is invented. Defaults are reported in edit receipts. Omit environment_ref to retain the configured default resolver.

## 3. Single-Source Relationships

Input source is `{kind: task_material, material_id}` or `{kind: node_output, node_id, output_id}`. Before compilation choose `required`. Node-output inputs also require truthful `purpose` (`content_basis`, `test_subject`, `historical_reference`) and an access policy:

| Policy | Generated fields |
|---|---|
| `{mode: approved, review_node_ids: [...]}` | approved input with those exact reviews |
| `{mode: stage_candidate, stage_id: ...}` | submitted input plus the corresponding stage internal use |
| `{mode: review_candidate}` | submitted input; only review nodes may use this policy |

The topology and input tools edit the same record. No independent edges/dependsOn graph exists. Normal rework is not a forward edge.

A review assignment is `{criterion_id, mode: single|composite, subjects: [{node_id, output_id}, ...]}`. Single means one subject; composite requires at least two. Code generates targets, explicit composite subjects and required candidate-reading inputs with `purpose: test_subject`.

Generated inputs have reserved `reviewin-...` IDs. A legal explicit required review_candidate input for the same target is preserved instead of duplicated. Additional background and mapped repair-owner inputs remain explicit. Do not author a new reserved input ID or manually edit generated relationships.

Criterion `output_bindings` drives production output criterion_refs. A review-only composite criterion may have no production binding; a producer must not be made to claim it independently proves a joint property. Actual approval sources, allowed repair owners and remediation mappings are still explicit choices, checked by the unchanged Compiler. Generated reading is not an authorization grant.

## 4. Views and Diagnostics

Use summary/topology to orient, then nodes with required `node_ids` and optional sections (`identity`, `contract`, `agent`, `outputs`, `inputs`, `review`). Other views are criteria, stages, governance, coverage, completion, incomplete, validation, catalog, process and operation. Select criterion IDs, relevant ProcessSpec sections/IDs, resource kind/query or an exact operation ID as applicable.

Read pages return current_revision, items, total_items, truncated and next_cursor. Continue using the same selection. A changed revision or view content invalidates the cursor. Oversized selected records are lossless JSON-text fragments with offsets; finish their paging before interpreting the incomplete text. Text and details expose only the selected page, not a hidden full state object.

Validation returns a bounded initial diagnostic list; use view=validation for all pages. Compiler paths map back to authoring objects and suggested editors. Draft-only validity means current authoring choices are complete, not that runtime governance has passed. Only compile mode runs formal Workflow validation. Neither permits weakening standards to remove diagnostics.

### Source Binding and Local Requirement Repair

`workflow_draft_read` with `view: "process", kind: "sources"` lists exact `source_ref`, `source_quote` and source kind, including review criteria. Filter with `ids` or `query`. These refer to entries in the selected ProcessSpec, not the specification ID, version or ProcessSelection ID.

For an applicable process requirement, use `requirements.from_process: [{requirement_id, source_id, strength, description?}]` in `workflow_draft_governance`. The program copies the exact source reference/quote and sets process authority. You still choose its meaning, strength, criteria and substantive coverage. It adds no criteria or approvals. Unknown or ambiguous entries fail without saving the batch.

For an existing requirement, `requirements.patch: [{requirement_id, source_ref: "exact-entry-id"}]` changes only supplied fields and preserves unchanged descriptions and quotes. Other requirement fields may likewise be explicitly patched; the final Compiler still checks all provenance and authority. To change the selected source and copy its quote together, use `from_process` with explicit strength. Do not use the same requirement ID in multiple edit forms in one call.

Read `view: "governance", ids: ["requirement-id"]` for only the relevant object. A failed batch does not advance revision; a lost successful receipt should be retried with the same operation ID and payload.

## 5. Two Independent Calls

These examples declare a skeleton and update only its work contract. Revisions and IDs must come from actual responses; this is not a complete Workflow.

`workflow_draft_topology`:

```json
{
  "expected_revision": 0,
  "operation_id": "declare-A-1",
  "nodes": [
    {"node_id": "A", "kind": "execution", "name": "Analyze", "output_ids": ["analysis"]},
    {"node_id": "R", "kind": "review", "name": "Review analysis"}
  ]
}
```

`workflow_draft_configure_nodes`:

```json
{
  "expected_revision": 1,
  "operation_id": "scope-A-1",
  "nodes": [{
    "node_id": "A",
    "contract": {
      "objective": "Produce supported answers to the assigned questions",
      "responsibilities": ["Analyze supplied evidence"],
      "non_responsibilities": ["Approve the completed work"],
      "work_requirements": ["Submit complete answers with evidence; disclose unresolved facts"],
      "constraints": ["Do not invent source data"]
    }
  }]
}
```

No other node, tools, permissions or criteria are changed by the second call. Remaining choices remain visible as incomplete.

## 6. Revisions, Capture and Compatibility

Repeat a lost edit with the same operation ID and identical payload. The original applied revision is returned together with the current revision. Different content under that ID is a conflict. For a new logical edit, inspect current affected fields and use a new ID. Revisions are not model-turn counters.

Submit requires the exact current revision and a stable ID. It revalidates rather than trusting cached success, persists a content-addressed candidate and receipt, and closes model editing. A replay cannot replace a later revision or reopen cancelled control. Independent Compiler feedback may reopen the same draft only through trusted control, preserving the original Designer Session. No tool starts the business workflow.

Legacy files are not silently converted while an old writer could still be active. Trusted control may call `migrateLegacy(runId, true)` only after confirming that writer is stopped. Migration validates fields, preserves an exact backup and rejects ambiguity or unsupported information. Frozen Workflows/Baselines remain unchanged. A timed-out writer lock is not proof that its old process is dead; operator recovery must establish ownership before removal.

The programmatic legacy apply adapter is retained for existing trusted callers before domain authoring begins. It is not a model tool and cannot overwrite domain edits. Legacy operation IDs are retained and cannot be reused as new edit/submission identities.
