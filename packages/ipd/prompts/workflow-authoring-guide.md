# IPD Workflow Authoring Guide

Convert the task and mandatory Run Skill into one compilable WorkflowDefinition. AgentCards, Skills, Workflow Assets, and Run records remain separate assets.

## Submission protocol

1. Call `submit_workflow_header`, then call `submit_workflow_acceptance` for every final Acceptance Criterion.
2. Build Execution Nodes around business Artifacts, not commands, scripts, copies, or purely mechanical actions.
3. For each Node call `submit_workflow_node` for its core and `submit_workflow_node_gate` for its complete Gate. Every Gate has registered mechanical Criteria and evidence-backed semantic Criteria.
4. Use `remove_workflow_node` for obsolete preloaded Nodes. Repair dependencies, inputs, routes, and final references explicitly.
5. Call `submit_workflow_final` for the final Artifact selection and Final Gate, then call `finalize_workflow`.
6. Runtime injects Skill, global budget, fixed Staff Core, unbounded Node budgets, and maxAttempts=10 where applicable.
7. Treat `(Workflow ID, version)` as an immutable asset identity. Reuse it only when content is identical. If content differs or a `workflow_version_conflict` Diagnostic is returned, keep the ID, change the Header to a new higher SemVer not already listed in `workflowAssets`, leave unrelated preloaded sections unchanged, and finalize again.

Before every Tool call, compare arguments with its exposed JSON Schema: include required fields, omit undeclared fields, and keep fields at the declared level. On validation failure, read every error and resubmit only the affected section.

For a Compiler revision, `loadedSections` is already present in the Builder. Modify only `editableSections`; do not resubmit unchanged sections. For an initial plan, `editableSections=["all"]`.

For a same-Run amendment, `lockedAcceptedNodeIds` cannot be removed or rewritten. Their execution and Gate contracts remain frozen; only an outgoing `gate.routes.pass` reference may be retargeted when a failed downstream Node is replaced. Modify only the affected replacement and reference closure listed in `editableSections`.

## Design method

- Build the successful Artifact dependency graph as a DAG. Independent work may run in parallel; every Artifact input comes from a direct dependency.
- Select employees by responsibilities, non-responsibilities, capabilities, knowledge, model, tools, permissions, and budget.
- Keep producers and Reviewers independent. A single Reviewer AgentCard must satisfy every capability of its assigned requirement.
- Reviewer assignments are mutually exclusive across the entire Gate: one AgentCard can fill only one Reviewer slot. Ensure the loaded pool admits a complete global assignment; do not count the same Card independently for multiple requirements.
- Separate technical interruption, quality rework, blocked escalation, exhausted Attempts, cancellation, and budget decisions.
- Use only supplied Skill names, Tool names, Check IDs, AgentCard references, capabilities, and knowledge-base IDs.
- Preserve frozen Staff Core and global budget exactly. The Compiler is authoritative.

## Pre-finalize checks

- Only Execution Nodes appear in the business DAG.
- Every Node submits one or more files and has mechanical plus semantic Gate Criteria.
- All references and Check parameters come from planning context.
- The graph is acyclic, every Node contributes to a final Artifact, and the Final Gate covers every Acceptance Criterion.
- Rework targets exist and match Gate routes.
- For Compiler revisions, unchanged preloaded sections remain untouched.
