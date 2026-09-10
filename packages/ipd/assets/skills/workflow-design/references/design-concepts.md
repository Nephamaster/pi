# Design Concepts and Judgment Principles

This reference explains common IPD and graph-execution terms used during Workflow design.

You only need a practical understanding. You do not need graph-theory knowledge or Runtime implementation details.

## 1. Relationship Between IPD, ProcessSpec, and Workflow

The point of IPD is not to "split a task into more steps."

Its purpose is to reduce error accumulation and late rework in long, cross-functional work through:

- explicit responsibility;
- structured deliverables;
- cross-functional collaboration;
- staged quality review.

In this system:

- **ProcessSpec** is the process governance specification for a class of tasks;
- **WorkflowDefinition** is the concrete execution design for one current TaskInput;
- **Runtime** executes the frozen Workflow, controls state, versions, approval, and rework; Agents do not directly control the global process.

A ProcessSpec is not a fixed Workflow.

It describes how this class of task should be organized so that key responsibility and quality control are not lost.

Therefore, Workflow design is neither:

```text
Turn each ProcessSpec line into a node
```

nor:

```text
Freely design a Workflow and attach coverage IDs later
```

It is:

```text
Preserve ProcessSpec responsibility / deliverable / review semantics
                             +
             Use TaskInput to define concrete work packages
                             ↓
               Produce this task's WorkflowDefinition
```

## 2. Execution Node

An execution node is a **professional work package accountable for a specific result**.

A good execution node normally has:

- a clear objective;
- exact inputs;
- one capable responsible employee;
- a concrete output;
- acceptance criteria fixed in advance;
- limited and explicit write permission.

A node is not "one model call."

The persistent Session for one node may contain:

- multiple reasoning steps;
- tool calls;
- submission correction;
- formal quality rework.

## 3. Review Node / Gate

A review node represents independent quality judgment.

It reads an exact Submission version and evidence, then evaluates frozen semantic criteria.

Review does not exist merely to "read it again" or "find some problems."

It ensures that:

- a producer cannot approve itself through a completion claim;
- downstream work uses only the required approved outputs;
- defects can be mapped to a criterion, output, and responsible rework owner.

Whether the same AgentCard may be reused depends on ProcessSpec independence requirements and Compiler rules.

The current implementation binds one employee per review node.

## 4. Submission, Approved Input, and Versioning

An execution node submits an exact versioned **Submission**.

A Review evaluates that exact version.

If downstream work requires an `approved` input, it must consume the specific Submission version that has passed the required review, not the producer's mutable workspace file.

This provides traceability for:

- who produced what;
- which version passed which review;
- which version downstream actually consumed.

It also allows rework invalidation to affect only downstream work that truly consumed an older version.

## 5. Forward Dependency / DAG

Normal execution dependencies come from input bindings.

If B needs an output from A, then A is a forward dependency of B.

These forward dependencies form a DAG: **Directed Acyclic Graph**.

The practical meaning is simple:

> Normal execution must not contain a circular wait where A waits for B and B also waits for A.

You do not manually maintain a separate dependency graph.

Correctly configure node inputs; the Compiler derives and validates the forward graph.

## 6. Fan-out and Fan-in

**Fan-out** means one approved result enables several independent downstream work packages.

```text
        ┌→ B
A ──────┼→ C
        └→ D
```

**Fan-in** means one downstream work package requires several upstream results.

```text
B ─┐
C ─┼→ E
D ─┘
```

Parallelism is a means, not a goal.

Run work in parallel only when it is genuinely independent.

If one work package requires another result, declare the dependency rather than forcing concurrency for appearance.

## 7. Normal Rework

Quality rework is a normal work loop, not a Runtime exception and not Workflow redesign.

```text
execution → submission → review
     ↑                    │
     └────── REWORK ──────┘
```

Rework remains with the original execution node and original AgentSession.

It creates:

- a new round;
- a new Submission version.

Rework targets are declared through `allowed_rework_node_ids`.

They are not part of the forward DAG.

## 8. Criterion and Evidence

A **criterion** defines what condition counts as acceptable.

**Evidence** provides the traceable basis for making that judgment.

Example:

```text
Vague requirement:
The data must be accurate.

Better criterion:
Key figures in the report match the approved data source,
and derived values can be reproduced using the recorded method.

Evidence:
- original data location
- calculation script/formula
- recomputation result
- corresponding report location
```

The more concrete the criterion:

- the better the producer can self-check;
- the more stable the Reviewer judgment can be;
- the easier it is to localize rework.

## 9. Requirement Coverage

Coverage is not about making every ID appear.

It proves:

> Every user requirement and mandatory ProcessSpec item has accountable responsibility, a real artifact, and the required quality verification.

Good coverage answers:

```text
Who owns REQ-07?
      ↓
Which output actually satisfies it?
      ↓
Which criterion determines satisfaction?
      ↓
Which Review checks it when independent judgment is required?
```

Attaching all requirements to the last node when earlier nodes actually perform the work is formal coverage, not a compliant design.

## 10. Minimal Sufficiency

More nodes do not automatically mean higher quality.

Every new node adds:

- context setup;
- handoff;
- waiting;
- review overhead;
- potential information loss.

Split nodes only for a real reason:

- independent professional responsibility;
- independent deliverable or reuse value;
- useful parallelism;
- independent review or permission boundary;
- useful failure/rework isolation.

Conversely, work should usually be merged when it shares the same responsibility and inputs, produces one inseparable artifact, and has no independent downstream value.

IPD is not about ceremony.

It is about making **necessary responsibility and quality control happen early enough while avoiding unnecessary process tax**.
