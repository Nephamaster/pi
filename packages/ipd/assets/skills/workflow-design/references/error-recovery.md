# Local Recovery for Design Errors

Read after a relevant error. First distinguish a known rejected edit, an unknown outcome, and a true design block. Preserve the task, chosen ProcessSpec, required standards, independent review, and valid unrelated work.

## Recovery procedure

Read the error's exact tool, field path, expected condition, and whether anything was saved. Inspect the smallest affected object or operation receipt. Correct the cause with a coherent small edit; then validate the relevant state. Do not resend a large unchanged payload to see whether it succeeds this time.

| Symptom | Correct action | Not a fix |
|---|---|---|
| `must be object` / `upsert.0: must be object` | Check actual parameter types. Send objects/arrays as structured values. Reduce to the affected edit if necessary. | Renaming the operation ID while retaining an escaped JSON string. |
| Unexpected property | Put the intended information in an existing supported contract field or remove an invented property. | Adding `constraints_note`, prompt bypasses, or similar fields. |
| Unknown catalog ID/version | Inspect the registry and copy the exact compatible identity. | Guessing versions or pretending an unavailable role exists. |
| Bad process source reference/quote | Read `view: "process", kind: "sources"`; patch the wrong field or use `from_process` to copy a new source/quote together. | Using the specification ID/version or selection ID as an item source. |
| Missing evidence/criterion bindings | Link the actual nested ProcessSpec IDs and implement their meaning. | Filling arbitrary strings or dropping the corresponding process obligation. |
| Missing draft choice | Supply the named real choice; incomplete authoring is normal. | Fake employees, empty obligatory arrays, or claiming validation passed. |
| Revision conflict | Read current affected fields/revision; formulate a new logical edit from that state. | Treating revision as model-turn count. |
| Lost receipt or timeout with uncertain outcome | Read the operation receipt; replay the same ID and identical original payload when required. | Blindly issuing the operation under a new ID. |
| Same ID, different payload | Use a new ID for a genuinely changed request after resolving the original outcome. | Reusing an applied operation ID for a correction. |
| Reference deletion blocked | Remove or update actual referring records first; leave unrelated work intact. | Deleting broad sections to make validation quiet. |
| Self-approval cycle / stage error | Check real required inputs, review subjects, and lawful candidate-use/exit policy. | Marking essential inputs optional or removing a mandatory Gate. |
| Permission / Skill-only read denial | Use only exposed locked Skill paths; retain inaccessible material as a stated gap when decisive. | Trying alternative guessed workspace paths or requesting unrestricted Shell access. |
| Tool/protocol unavailable | Report the concrete capability or protocol gap for trusted control. | Directly editing draft files, installing control tools, or migrating storage yourself. |

## Structured value example

Incorrect shape, shown only as a counterexample:

```json
{"prerequisites":"{\"minimum_materials\":1,\"retrieval_tools\":[]}"}
```

Correct field shape:

```json
{"prerequisites":{"minimum_materials":1,"retrieval_tools":[]}}
```

These fragments are not full calls. A real governance call also needs its current revision and operation ID. The values must reflect the actual task; do not copy a minimum-material count as a universal rule. Escaped JSON can additionally contain syntax errors: automatically parsing arbitrary strings is not a substitute for producing a valid typed call.

## Correct only the broken source binding

For an already existing requirement, this governance edit fixes the reference while preserving other fields:

```json
{
  "expected_revision": 12,
  "operation_id": "fix-source-ref-2",
  "requirements": {
    "patch": [{"requirement_id":"req-content","source_ref":"content-review.criterion.1"}]
  }
}
```

Use the actual revision and source record. If both the selected source and quote need changing, use `from_process` with explicit strength instead. Do not assume a patch creates a missing requirement.

## A failure count is a guard, not an acceptance policy

Repeated tool errors can stop the design round. The response is to correct the error, not hide it, retry until the guard fires, or weaken the contract. If the same corrected shape is consistently rejected or changes in transit, preserve the specific evidence for host investigation; do not diagnose a model/provider bug without evidence.

An ordinary correctable draft error is not `report_workflow_design_blocked`. Use that submission when verified task, resource, or expressiveness constraints actually prevent any legal design after relevant alternatives. For example, a required real-world test with no authorized execution channel is a gap; a missing optional business Skill alone is not.

Do not create a new Session to erase a diagnostic history. Trusted control owns reopening captured drafts, interrupted-writer recovery, migration, and any later baseline change.
