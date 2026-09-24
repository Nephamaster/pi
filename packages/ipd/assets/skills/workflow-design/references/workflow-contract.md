# Authoring Contract Guide

Read the relevant section when deciding what a current draft tool should express. **The editable surface is Authoring V2.** The final section maps to generated Workflow V3 only for diagnostic interpretation. Do not send generated V3 nodes or inputs as tool payloads.

## 1. Work and resource configuration

`workflow_draft_configure_nodes.nodes[]` addresses an existing `node_id` and optionally changes:

| Section | Contents |
|---|---|
| `contract` | Objective, responsibilities, non-responsibilities, work requirements, constraints, optional requirement/decision references. |
| `employee` | Actual `agent_ref: {id, version}` and optional explicit `participant_id`. |
| `resources` | Required capabilities; named Skill/Tool references; `knowledge_bases: []`; permissions. |
| `environment_ref` | A registered alternative execution profile, or `null` to clear the override. Omit for the configured resolver. |

Tool/Skill references use `{"id":"registered-name"}`; employee references use an exact version. The schema has versioned knowledge references, but the current Compiler rejects every non-empty `knowledge_bases` binding with `knowledge_base_unsupported`; leave it empty. Do not insert ad-hoc model fields, hashes, or free-text prompt side channels. Model selection comes from the employee and Run. Bind only actual executable resources within the employee's authorization; a visible role description is not proof that every tool it mentions exists.

Resource `permissions` uses `read_paths`, `write_paths`, and `external_actions`. Paths must be authorized, normalized, relative, and aligned with the actual environment. The card is an authorization ceiling, not a request for maximum privilege. Keep the real material and candidate inputs explicit; broad-looking read paths do not authorize unrelated data.

One employee per node is the current implementation limit. Do not create generic placeholder employees to make an incomplete draft look complete.

## 2. Controlled outputs

`workflow_draft_outputs.upsert[]` identifies `node_id` and `output_id`, then supplies `artifact_type`, `description`, `business_purpose`, `path_prefix`, `evidence_requirements`, and `process_evidence_requirement_refs` as applicable to the complete result.

Evidence requirement references are exact nested `evidence_requirement_id` entries from the selected ProcessSpec, not the deliverable ID. Implement their meaning in the actual content/evidence instructions. A familiar output label is not sufficient implementation of a different process artifact type.

Use an owned relative path such as `outputs/produce/content-output`, not a sealed Submission path or an absolute host path. No `..` or trailing slash. Keep exportable outputs under the environment's authorized export root. In shared-workspace compatibility mode, different producer roots cannot overlap; private environments still require correct export ownership.

Standards are attached through `workflow_draft_criteria.output_bindings`, not an output `criterion_refs` field. Every controlled output must have the mechanical and semantic checks required by the current Compiler.

## 3. Standards, source authority, and process coverage

A criterion edit addresses `criterion_id`, a `definition` object, and optional replacement `output_bindings`.

| Definition kind | Required completed meaning |
|---|---|
| `mechanical` | Concrete description, registered `check_id`, its actual `parameters`, and evidence requirements. Manifest integrity is not business or visual correctness. |
| `semantic` | Concrete judgment description, non-empty evidence requirements, and exact applicable `process_criterion_refs` (an array, empty only when no process criterion applies). |

Optional `requirement_refs` and `blocking` express authority. Do not merge unrelated subjects under one criterion just to reduce the number of IDs. Reuse a definition deliberately; if one review applies one standard to multiple outputs, configure their complete composite subject set.

Keep three relationships distinct:

| Relationship | How it is authored |
|---|---|
| Original task meaning | Preserved raw task; task-specific contracts, outputs, and actual acceptance conditions. |
| Source/decision authority | `workflow_draft_governance.requirements` and `decisions`, referenced by contracts/criteria where needed. |
| ProcessSpec implementation | `workflow_draft_coverage` rows for `process_activity`, `process_deliverable`, `process_review`, and `process_rule`; plus nested evidence/criterion bindings. |

`requirements` entries have `requirement_id`, `description`, `authority`, `strength`, `source_ref`, and `source_quote`. User quotes must occur in the raw task; process quotes resolve to actual selected entries. Use the source helper instead of inventing a spec/version-qualified source string. Advisory requirements cannot support blocking acceptance. A design choice remains identified as such, supported by independent requirements; it is not a newly discovered user demand.

Coverage rows name the ProcessSpec item, responsible nodes, concrete output refs, and criterion refs. Mandatory activity responsibility belongs to capable execution work; required review responsibility belongs to a capable review node. Do not attach everything to the last node or equate complete IDs with semantic quality. No `task_requirement` coverage type exists.

## 4. Inputs and real dependencies

`workflow_draft_inputs.upsert[]` addresses `consumer_node_id` and `input_id`. Choose a task-material source by registered material ID, or a node-output source by exact node/output identity. Material contents must ultimately be readable by the assigned execution capability; a descriptor alone does not prove access.

Node-output sources require explicit `required`, `purpose`, and `access`. Use approved work when approval is a prerequisite, named `stage_candidate` access only for permitted internal uses, and `review_candidate` for the reviewer's subject. Do not mark an essential input optional to evade blocking.

`content_basis` expresses correctness dependence; `test_subject` identifies what was inspected; `historical_reference` preserves history. Purpose is a truth about use, not an optimization switch for suppressing invalidation.

## 5. Review subjects, stages, and repair mappings

`workflow_draft_reviews.upsert[]` names `review_node_id`, `assignments`, and `allowed_rework_node_ids`, with optional `required_relations`, `remediation_mappings`, and `decision_policy`.

An assignment associates one semantic `criterion_id` with `mode` and its exact `subjects`. Code creates review targets, explicit composite subjects, and necessary required candidate inputs. Mechanical criteria belong to checkers, not duplicate semantic review votes. The fixed aggregation is `all_required`; do not author alternative voting, arbitrary routing, or automatic replacement.

Independence concerns the actual scoped participants, Sessions, and production contributions. Distinct role labels do not prove it; a shared capable role asset does not itself erase separation between independently assigned instances. Respect the selected process and current independence validation.

Reviewer `external_actions` remains false. In legacy shared-workspace mode, write paths and mutation/Shell tools are forbidden. In a supported private inspection environment, an authorized Reviewer may create its own test/render evidence while sealed source submissions stay read-only. Do not confuse permission to validate with ownership of the delivered artifact.

For A → B → joint R, approved A as B's prerequisite would create a cycle if R approves A only after B exists. A legal stage instead names member work, permits B's exact candidate input, and requires R at its exits. `workflow_draft_stages` edits members/exits; code derives internal uses from input access. An exit uses `output: {node_id, output_id}` and `gate_node_ids`. Preserve actual process timing; a stage is not a way to bypass an earlier mandatory Gate.

For composite judgments, enumerate all subjects. `required_relations` entries use `consumer` and `basis` output refs to demand exact derivation in the frozen review bundle. The actual consumer must already have the truthful production dependency.

A `remediation_mappings` entry has `criterion_id`, `observed`, and `owner`. The owner must be a directly depended-on output with required review access and an allowed repair node. This only permits evidence-based attribution; it does not automatically blame every listed owner. Keep integration-only errors at the integrator. Keep independent D intact when only A and A's actual consumers are affected.

## 6. Completion and prerequisites

Set all four completion groups: `required_node_ids`, `final_outputs`, `delivery_outputs`, and `required_review_node_ids`. Delivery is a subset of terminal outputs, limited to what the user should receive. Internal evidence need not become extra user-facing files. Required process reviews must actually gate success.

Optional `prerequisites` uses `minimum_materials` and `retrieval_tools`. In the verified code, insufficient material count can be satisfied by a listed, registered retrieval tool actually bound to execution. This check does not prove source quality, content availability, or that network policy permits every destination. Do not manufacture a retrieval dependency for a task whose authorized inline inputs are sufficient.

## 7. Generated V3: diagnostic mapping only

| Authoring V2 choice | Generated Workflow V3 result |
|---|---|
| `employee` + `resources` | Single entry in `agents[]`. |
| Criterion `output_bindings` | Producer output `criterion_refs`. |
| Input `access` | `availability`, approval-review references, and stage membership/use relationships. |
| Review `assignments` | `targets`, `criterion_subjects`, and required candidate-reading inputs. |
| Stage members/exits + candidate input policy | `stages[].internal_uses` and exit constraints. |
| Coverage tool rows | `requirement_coverage`. |
| Trusted Run input/selection | `task_input_ref` and `process_selection_ref`, computed by trusted code. |

These fields help interpret Compiler paths. They are not additional authoring obligations. Do not compute trusted hashes, manually create derived edges, or submit a whole WorkflowDefinition as an edit. Fix the authoring object named in the diagnostic using the appropriate domain tool.
