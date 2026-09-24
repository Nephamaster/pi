# Draft Tool Protocol — Authoring V2

Read when beginning unfamiliar authoring operations or resolving revision/paging questions. These are private control tools injected into the Designer Session. Do not list them as global `allowed-tools` or replace them with Shell/file writes.

You edit one possibly incomplete **AuthoringDraft V2**. Code materializes **WorkflowDefinition V3** and the Compiler validates it. Generated fields are not alternative tool inputs. Tool Schema is authoritative for exact types; this file explains usage and state effects.

## 1. Default tool path

| Tool | Payload after the mutation envelope | Purpose |
|---|---|---|
| `workflow_draft_open` | No envelope; `{}` | Obtain the draft summary, revision, defaults, and missing choices. |
| `workflow_draft_read` | No envelope; `view` plus selectors/paging | Read relevant objects, process entries, resources, or diagnostics. |
| `workflow_draft_topology` | `nodes`, `connections`, `remove_node_ids` as needed | Declare identities/output ports and initial real connections. |
| `workflow_draft_configure_nodes` | `nodes` array | Patch node contract, employee, resources, name, or environment override. |
| `workflow_draft_outputs` | `upsert` and/or `remove` | Define owned output content, paths, evidence, and process evidence references. |
| `workflow_draft_criteria` | `upsert` and/or `remove_ids` | Define standards and their production `output_bindings`. |
| `workflow_draft_inputs` | `upsert` and/or `remove` | Specify consumer/input source, requiredness, purpose, and access. |
| `workflow_draft_reviews` | `upsert` array | Assign judgments, exact subjects, legal repair owners, and relations. |
| `workflow_draft_stages` | `upsert` and/or `remove_ids` | Define stage members and controlled output exits. |
| `workflow_draft_governance` | Optional `metadata`, `prerequisites`, `requirements`, `decisions` | Record actual provenance and justified design decisions. |
| `workflow_draft_coverage` | `upsert` and/or `remove` | Map ProcessSpec obligations to real responsible work. |
| `workflow_draft_completion` | Only the completion fields being changed | Define required nodes/reviews, terminal outputs, and delivered subset. |
| `workflow_draft_validate` | No mutation envelope; `expected_revision`, optional `mode` | Check draft completeness or run compilation. Use `mode: "compile"` before submission. |
| `workflow_draft_submit` | Mutation envelope only | Revalidate and capture the exact revision; end the design turn. |

All mutation tools and submit require numeric `expected_revision` and a stable string `operation_id`. Do not add these fields to read/open or an `operation_id` to validate. Do not send a `{domain, data}` wrapper to model-facing tools; that is an internal representation.

## 2. Partial update rules

Batch edit arrays (`nodes`, `upsert`, `patch`, and removal lists) address records by ID, not by replacing the whole collection. Within a partial record edit, omission preserves existing values and a supplied array replaces that field, including `[]`; an emptied required list remains incomplete. Contracts and resource permissions merge supplied fields. Governance `requirements.upsert` and `decisions.upsert`, and coverage `upsert`, replace the complete matching record; use `requirements.patch` for partial requirement edits. Only supported optional overrides accept `null`: `environment_ref`, `prerequisites`, and review `decision_policy`.

Node declarations do not rewrite an existing contract or rename a node; use `configure_nodes` to change its name. Node kind and criterion kind cannot be changed in place. Topology can declare a connection; explicit reconnection belongs in `inputs`. Remove referring records before deleting their targets. An invalid atomic edit does not partially apply to unrelated objects.

Defaults supply workflow identity/version and owned path conventions; the workflow name remains a required design choice. Initial employee/resource configuration also defaults `participant_id` to `main`, `required_capabilities`, `skills`, and `knowledge_bases` to `[]`, and `external_actions` to `false`. These defaults do not choose an employee, tools, read/write scopes, input requiredness/purpose/access, criteria, repair owners, or completion obligations. Inspect defaults in mutation receipts; `workflow_draft_open` returns a summary, not a `defaults_applied` list. Omit an environment override to use the configured resolver.

## 3. Structured parameters, not JSON-in-a-string

For an existing output, the shape of a semantic criterion edit is:

```json
{
  "expected_revision": 4,
  "operation_id": "define-quality-1",
  "upsert": [{
    "criterion_id": "quality",
    "definition": {
      "kind": "semantic",
      "description": "The briefing preserves every supplied decision and condition without unsupported claims.",
      "evidence_requirements": ["A mapping from briefing passages to source statements"],
      "process_criterion_refs": []
    },
    "output_bindings": [{"node_id": "produce", "output_id": "content-output"}]
  }]
}
```

This is a shape example for a locally defined standard. Use the real revision/IDs and applicable ProcessSpec criterion references. `definition` is an object and `upsert` is an array of objects, not escaped JSON strings. Do not put `criterion_id` inside `definition` or `criterion_refs` inside an output edit.

For a governance edit, `prerequisites` is likewise an object (or explicit supported `null`), not text. Its material-count/retrieval alternative is a real prerequisite, not a field to fill with arbitrary defaults just to eliminate a warning.

## 4. Single-source relationship edits

An input edit has `consumer_node_id`, `input_id`, and selected fields. Its source is one of:

```json
{"kind": "task_material", "material_id": "brief"}
```

```json
{"kind": "node_output", "node_id": "produce", "output_id": "content-output"}
```

Set `required` explicitly. Node-output inputs also need a truthful `purpose` and one access policy:

| Policy | Use |
|---|---|
| `{"mode":"approved","review_node_ids":["review-produce"]}` | Consume the exact approved output after the named Gates. |
| `{"mode":"stage_candidate","stage_id":"analysis-stage"}` | Permitted internal candidate use inside that explicit stage. |
| `{"mode":"review_candidate"}` | Review-node access to the candidate under judgment. |

Task-material sources do not take node-output access/purpose fields. These JSON fragments show shapes, not pre-existing production identities.

A review assignment contains `criterion_id`, `mode: "single"` or `"composite"`, and `subjects: [{node_id, output_id}, ...]`. Single requires one subject; composite requires at least two. Code derives targets, complete composite subject sets, and required candidate-reading inputs. Do not author reserved `reviewin-...` IDs or reproduce these generated relationships manually. Explicit extra background/repair-owner inputs still need lawful binding.

A criterion's `output_bindings` creates producer criterion references. A review-only composite criterion may have no producer binding: one producer must not be made to claim it independently verifies the entire combination. Every produced output still needs its own required checks.

Stages derive `internal_uses` from `stage_candidate` inputs. `required_relations` checks exact derivation within the review bundle; it is not a second dependency graph. Repair mappings authorize only bounded, evidence-supported ownership. See the authoring contract guide when using these advanced relations.

## 5. Scoped reads and source binding

Use `view: "nodes"` with `node_ids` and optional sections (`identity`, `contract`, `agent`, `outputs`, `inputs`, `review`). Other useful views include `summary`, `topology`, `criteria`, `stages`, `governance`, `coverage`, `completion`, `incomplete`, `validation`, `catalog`, `process`, and `operation`.

Page responses expose `current_revision`, `items`, `total_items`, `truncated`, and `next_cursor`. Follow the cursor using the same selection. Changed revision/view content invalidates it. Oversized items may be lossless JSON-text fragments with offsets: finish the relevant record before interpreting it. This tool-result transport format does not mean mutation arrays should be sent as strings.

For exact process source references, read:

```json
{"view":"process","kind":"sources","ids":["content-review.criterion.1"]}
```

The read result contains `source_ref`, `source_quote`, and `source_kind`. In `workflow_draft_governance`, put that returned `source_ref` into a `requirements.from_process` entry's `source_id`, alongside `requirement_id`, explicit `strength`, and optional task-specific `description`. The program copies the source ID/quote and process authority. This does not create criteria, coverage, or approval. It does not authorize weakening a process requirement.

To fix a single source reference on an existing requirement, use `requirements.patch` with its ID and changed fields. To switch the source and copy its matching quote together, use `from_process`. Do not edit the same requirement ID through multiple edit forms in one call.

## 6. Receipts, correction, and submission

For the next logical edit, use the current revision from an actual response. A known failed atomic edit does not advance it. If uncertain whether an edit succeeded, read `view: "operation"` with that operation ID. Replaying the same ID and identical original payload retrieves its receipt; changed content under the same ID is a conflict. Applied revision and current revision may differ after intervening edits.

Validation completeness is not execution approval. Read the named missing choices/diagnostics and use the suggested editor; then inspect only the changed object and relevant diagnostics. A valid draft-mode result is not a substitute for compile-mode validation.

Submit revalidates, persists a candidate and receipt, and closes editing. Successful capture ends the model turn; only trusted control may request a further design revision. Do not write draft files, use retired `workflow_draft_apply`, remove writer locks, or attempt storage migration. Unavailable tools or incompatible persisted authoring formats are host/control problems, not permission to bypass the protocol.
