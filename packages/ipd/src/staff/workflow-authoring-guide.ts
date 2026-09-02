export const WORKFLOW_AUTHORING_GUIDE_VERSION = "1.5.2";

export const WORKFLOW_AUTHORING_GUIDE = `IPD Workflow Authoring Guide v${WORKFLOW_AUTHORING_GUIDE_VERSION}

Purpose
- Convert the task and mandatory Run Skill into one compilable WorkflowDefinition.
- Treat AgentCards, Skills, Workflow Assets, and Run records as separate assets.
- Use only the fixed Staff Core, loaded AgentCard Pool, Tools, and mechanical Checks supplied in the planning context.

Submission protocol
1. Call submit_workflow_header once with the Workflow identity, version, objective, and asset source.
2. Call submit_workflow_acceptance once for each final acceptance Criterion. A later call with the same Criterion id replaces it.
3. For each business Artifact Node, call submit_workflow_node with its execution core, then call submit_workflow_node_gate with {"nodeId":"the-node-id","gate":{...}}. A later call replaces that section.
4. For a preloaded template or Compiler revision, call remove_workflow_node with {"nodeId":"obsolete-node-id"} for every Node that no longer belongs in the candidate. This also removes that Node's Gate.
5. Call submit_workflow_final once with finalArtifactNodeIds and finalGate. A later call replaces that section.
6. Call finalize_workflow with {"confirmation":"finalize"}. If assembly reports an error, replace or remove only the affected sections and finalize again.
- Do not submit a complete Workflow in one tool call.
- Do not resubmit Skill, global budget, or fixed Staff Core. Runtime injects these frozen constraints during assembly.
- On a Compiler revision, the previous candidate is already loaded. Replace only diagnosed sections, then finalize again.
- When an explicit Workflow template is selected, Runtime preloads it. Submit a new header with source=template, sourceTemplateId, and a deliberate new version; replace only task-specific sections, then finalize.
- Do not preserve an obsolete preloaded Node merely to satisfy reachability. Remove it explicitly and repair affected dependencies, inputs, routes, and final Artifact references.
- Keep tool calls structural and concise. Do not restate the task in descriptions.
- parametersJson is a JSON-encoded string. It must match the selected Check parameter schema from mechanicalChecks.
- Before every tool call, compare the arguments against that Tool's exposed JSON Schema: include every required property, omit undeclared properties, and keep fields in their declared object.
- If a Tool reports validation errors, read every reported missing, extra, or invalid field, correct the affected section, and resubmit it. Do not repeat unchanged invalid arguments.

Complete minimal header skeleton
{
  "schemaVersion": 1,
  "id": "workflow-id",
  "version": "1.0.0",
  "name": "Workflow name",
  "objective": "One verifiable business objective",
  "source": "generated"
}

Complete acceptance Criterion skeleton
{"id": "acceptance-id", "description": "Observable final acceptance"}

Complete minimal Node skeleton
{
  "id": "node-id",
  "objective": "Produce one reviewable business Artifact",
  "agentCardRef": {"id": "employee-id", "version": "1.0.0", "hash": "64-character-card-hash"},
  "requiredCapabilities": ["required-capability"],
  "knowledgeBaseRefs": [],
  "dependsOn": [],
  "inputs": [],
  "output": {
    "id": "artifact-contract-id",
    "artifactType": "artifact-type",
    "description": "Primary and reviewable output",
    "businessPurpose": "Why the Artifact exists",
    "requiredRoles": ["primary", "review"]
  },
  "tools": ["read"],
  "permissions": {
    "workspace": "read",
    "readScopes": ["."],
    "writeScopes": [],
    "externalActions": false
  },
  "budget": {"tokens": 8000, "timeoutMs": 600000},
  "rework": {"maxAttempts": 2, "targetNodeId": "node-id"},
  "routes": {"blocked": "staff", "exhausted": "staff"}
}

Complete minimal Node Gate skeleton
{
  "nodeId": "node-id",
  "gate": {
    "id": "node-gate-id",
    "mechanicalCriteria": [{
      "id": "mechanical-id",
      "description": "Deterministic Artifact integrity requirement",
      "checkId": "registered-check-id",
      "parametersJson": "{}",
      "requiredEvidence": ["Artifact Manifest"]
    }],
    "semanticCriteria": [{
      "id": "semantic-id",
      "description": "Evidence-backed business acceptance",
      "required": true,
      "reviewerCapabilities": ["review-capability"],
      "evidenceRequirements": ["Actual reviewable Artifact content"]
    }],
    "reviewers": [{"id": "reviewer-requirement-id", "capabilities": ["review-capability"], "minCount": 1}],
    "objectiveCoverage": [],
    "aggregation": {"requiredMechanical": "all", "requiredSemantic": "all", "conflict": "staff_arbitration"},
    "routes": {"pass": "continue", "rework": "node-id", "blocked": "staff", "escalate": "staff"}
  }
}

Complete minimal final section skeleton
{
  "finalArtifactNodeIds": ["node-id"],
  "finalGate": {
    "id": "final-gate-id",
    "mechanicalCriteria": [{
      "id": "final-mechanical-id",
      "description": "Final Artifact integrity requirement",
      "checkId": "registered-check-id",
      "parametersJson": "{}",
      "requiredEvidence": ["Final Artifact Manifest"]
    }],
    "semanticCriteria": [{
      "id": "final-semantic-id",
      "description": "The final Artifact satisfies all acceptance criteria",
      "required": true,
      "reviewerCapabilities": ["review-capability"],
      "evidenceRequirements": ["Actual final Artifact content"]
    }],
    "reviewers": [{"id": "final-reviewer-requirement", "capabilities": ["review-capability"], "minCount": 1}],
    "objectiveCoverage": ["acceptance-id"],
    "aggregation": {"requiredMechanical": "all", "requiredSemantic": "all", "conflict": "staff_arbitration"},
    "routes": {"pass": "final", "rework": "node-id", "blocked": "staff", "escalate": "staff"}
  }
}

Authoring method
1. Read the user objective, constraints, acceptance criteria, Skill, supplied budget, fixed Staff Core, employee pool, mechanicalChecks, and optional templates.
2. Identify business Artifacts that require independent semantic acceptance. Build Execution Nodes around those Artifacts, not around commands, scripts, file copies, or purely mechanical actions.
3. Define the success Artifact DAG. Make independent work parallel only when read and write scopes do not conflict. Converge through dependencies and typed Artifact inputs.
4. Select each employee by role boundary, capabilities, applicable scenarios, principles, knowledge bases, model profile, tools, permissions, and budget. Copy the exact frozen AgentCard reference.
5. Give every Node a precise objective, accepted inputs, output contract, minimum permissions, bounded budget, and finite rework policy. Node read scopes must cover every selected knowledge-base path.
6. Define every Gate before execution with at least one registered mechanical Check and one evidence-backed semantic Criterion. Keep producers and Reviewers independent.
   - Every semantic Criterion reviewerCapabilities array must be a subset of at least one Reviewer Requirement capabilities array.
   - At least one independent AgentCard must itself provide every capability in that Reviewer Requirement. Capabilities cannot be combined across different Cards.
   - Do not use the producing AgentCard's specialized capabilities as reviewerCapabilities unless another independent Card also provides them.
7. Derive Gate Criteria from the user objective, Skill method, Artifact risks, and final acceptance burden. Do not invent criteria during execution.
8. Separate technical failure, quality rework, blocked escalation, exhausted attempts, cancellation, and budget routes. Never convert retry exhaustion into approval.
9. Preserve the supplied global budget and fixed Staff Core exactly. Use only supplied Skill names, Tool names, Check ids, AgentCard references, capabilities, and knowledge-base ids.
10. Use a template only as a reference. Produce a new candidate, revalidate current references, and submit every section through the protocol.

Pre-finalize checks
- Only Execution Nodes appear in the business DAG.
- Every Node produces primary plus reviewable content and has mechanical plus semantic Gate Criteria.
- Every reference is copied from planning context; every parametersJson matches mechanicalChecks.
- The success graph is acyclic, final Artifacts are reachable, and the Final Gate covers every acceptance criterion.
- Parallel branches have compatible workspace scopes.
- Rework is finite and points to a valid producing Node.
- Staff Core references and global budget exactly match planning context.

The Compiler is authoritative. When it rejects an assembled candidate, revise only the diagnosed sections; do not bypass the invariant.`;
