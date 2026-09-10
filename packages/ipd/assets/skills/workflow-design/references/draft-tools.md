# Draft Tool Protocol

This reference describes the current `workflow_draft_*` tools.

These are private control-plane tools injected into the Workflow Designer Session.

They are intentionally not declared as ordinary frontmatter `allowed-tools`, so asset assembly does not treat private control tools as missing globally registered tools.

If these tools are unavailable, do not replace them with Bash or direct file writes.

## 1. Call Sequence and Parameters

| Tool | Input | Result / Important Notes |
|---|---|---|
| `workflow_draft_open` | `{}` | Create or open the single managed draft for this Run. Returns `draftId` and `revision`. Do not open a second draft. |
| `workflow_draft_read` | `{}` | Read the complete current draft and revision. Use for context recovery, change verification, or conflict handling. |
| `workflow_draft_apply` | `draft_id`, `expected_revision`, `operation_id`, non-empty `operations` | Atomically apply a group of operations. Use the returned latest revision. Do not assume a failed request was saved. |
| `workflow_draft_validate` | `expected_revision` | Validate without modifying the draft. Returns `valid` and `diagnostics`, each with `path/message`. |
| `workflow_draft_submit` | `expected_revision` | Revalidates and captures the candidate for the control plane. Does not directly start execution or grant approval. |

`open/read` return a field named `draftId`.

`apply` expects the same identity in `draft_id`.

Copy the actual returned value. Do not guess or alter it.

`expected_revision` must be the real integer returned by the draft manager.

Do not infer revisions from the number of model turns.

## 2. Complete Operation Set

| kind | Payload | Update Semantics |
|---|---|---|
| `set_header` | `header` | Set `schema_version`, `workflow_id`, `workflow_version`, `name`; no `task_input_ref` or `process_selection_ref`. |
| `upsert_criterion` | `criterion` | Add or replace the complete criterion by `criterion_id`. |
| `upsert_node` | `node` | Add or replace the complete node by `node_id`; must provide the whole node. |
| `remove_node` | `node_id` | Remove only the node. Caller must also repair inputs, review targets, coverage, and completion references. |
| `set_requirement_coverage` | `coverage` | Replace the entire coverage array; not append. |
| `set_completion` | `completion` | Replace the full completion definition. |

There are no operations such as:

- `set_edge`;
- `append_skill`;
- `patch_node`;
- `remove_criterion`.

Do not emit undefined operation kinds.

After replacing or removing nodes, inspect whether old criteria or references are still needed.

If a legitimate change cannot be expressed by the current tool interface, report the interface limitation. Do not bypass the draft manager by editing its storage directly.

## 3. Small-Batch Example

This example edits only the header. It is not a complete Workflow.

Replace `draft_id` and `expected_revision` with actual values returned by `open/read`.

```json
{
  "draft_id": "<draftId returned by open>",
  "expected_revision": 0,
  "operation_id": "design-header-001",
  "operations": [
    {
      "kind": "set_header",
      "header": {
        "schema_version": 1,
        "workflow_id": "task-delivery",
        "workflow_version": "1.0.0",
        "name": "Task Delivery Workflow"
      }
    }
  ]
}
```

`operation_id` identifies one logical edit within this draft.

If an already-saved edit must be retried because the response was lost, retry with:

- the same operation ID;
- the same operations.

Do not generate a duplicate edit merely because the revision changed.

If the content itself changes, use:

- a new operation ID;
- the current revision.

If an operation-ID conflict occurs, inspect prior results instead of blindly replaying the operation under a different ID.

Validation failure does not modify the draft.

After any modification, validate again.

Only a validation result corresponding to the latest revision can justify submission.

If Tool Schema, Compiler diagnostics, and this document conflict, the live interface is the formal source of truth. Report the mismatch instead of treating it as authorization to change the user task or ProcessSpec.
