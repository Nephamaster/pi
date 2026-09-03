# Workflow IR 与 Compiler

Workflow IR 是 ST Planner 和 GraphEngine 之间的冻结协议。当前唯一根类型是 `WorkflowDefinitionSchema`；模型输出、人工模板和 Ledger Snapshot 最终都必须符合这份 TypeBox Schema。

Planner 不通过一次巨型 Tool Call 直接提交完整根对象。它依次提交 Workflow Header、逐条 Acceptance、Execution Node Core、对应 Node Gate 和 Final Gate，`WorkflowSubmissionBuilder` 注入冻结 Skill、预算与 Staff Core，在本地组装并使用正式根 Schema 验证，之后候选才进入 Compiler。分段协议只是模型适配层，不改变冻结 IR。显式模板或上一版 Compiler 候选会预载到 Builder，后续修订可以只替换诊断片段。

## 1. WorkflowDefinition

```ts
interface WorkflowDefinition {
  schemaVersion: 1;
  id: string;
  version: string;
  name: string;
  objective: string;
  skill: { name: string; hash: string };
  acceptanceCriteria: Array<{ id: string; description: string }>;
  source: "generated" | "template";
  sourceTemplateId?: string;
  sourceTemplateVersion?: string;
  sourceTemplateHash?: string;
  globalBudget: BudgetDefinition;
  staff: { core: AgentCardRef[] };
  nodes: ExecutionNodeDefinition[];
  finalArtifactNodeIds: string[];
  finalGate: GateDefinition;
}
```

### 1.1 标识和版本

- `schemaVersion` 当前只能是 `1`；
- `id` 使用 Identifier 规则：字母开头，后续可含字母、数字、点、下划线和连字符；
- `version` 必须是 SemVer；
- `id + version` 表示一个 Workflow 资产版本；
- 相同 `id + version` 只能保存相同内容，内容变化必须提升版本。

### 1.2 Skill

当前 V1 要求 `skill` 必填，并且必须与 `ipd.start` 冻结的 Run Skill 名称和 SHA-256 完全一致。

Compiler 同时检查：

- Runtime 注册的 Skill 集合包含 Run Skill；
- Workflow 中的 Skill 名称和 Hash 与 Run Skill 相同。

未来允许无 Skill 的 Workflow 需要新的 Schema/Compiler 语义；当前不能通过省略或伪造 Hash 实现。

### 1.3 Staff Core

`staff.core` 不是由 ST 自由选择的员工列表。Runtime 在规划前从 `staff-core` AgentCard 中确定固定 Core，并通过 `WorkflowCompileContext.fixedStaffCore` 传给 Compiler。

Compiler 要求 Workflow 中的引用在数量、顺序、ID、版本和 Hash 上完全一致。固定 Staff Core 也不能成为业务 Execution Node 的生产者。

### 1.4 来源

- `source: generated` 不能带 `sourceTemplateId`；
- `source: template` 必须带已加载的 Template ID、Version 和 Hash 精确引用；
- 使用模板仍会产生本次完整候选、重新编译并保存新资产；
- GraphEngine 不区分模板派生和从零生成的 Workflow。

## 2. ExecutionNodeDefinition

```ts
interface ExecutionNodeDefinition {
  kind: "execution";
  id: string;
  objective: string;
  agentCardRef: AgentCardRef;
  requiredCapabilities: string[];
  knowledgeBaseRefs: string[];
  dependsOn: string[];
  inputs: ArtifactBinding[];
  output: ArtifactContract;
  skills: string[];
  tools: string[];
  permissions: NodePermissions;
  budget:
    | { mode: "unbounded" }
    | { mode: "bounded"; tokens: number; timeLimitMs: number };
  gate: GateDefinition;
  rework: { maxAttempts: number; targetNodeId: string };
  routes: {
    blocked: "staff" | "user" | "fail";
    exhausted: "staff" | "user" | "fail";
  };
}
```

Workflow 业务 DAG 中没有机械动作节点、Check Node、Reviewer Node 或 Staff Node。脚本、转换和文件操作只能作为 Execution Node 内部工具动作或 Gate 机械检查存在。

### 2.1 员工匹配

`agentCardRef` 是本次 Workflow 对独立 AgentCard 资产的引用，不表示 Card 归属于当前 Skill。

Compiler 检查：

- 引用的 ID、版本和 Hash 存在于当前 AgentCard Pool；
- Card 不是固定 Staff Core 成员；
- `requiredCapabilities` 全部存在于 Card；
- Node Tool 是 Runtime 已知 Tool 且被 Card 允许；
- Node 权限不超过 Card 权限；
- Node Skill 是当前 Run Skill，或属于 Card 声明的长期附加 Skill。

### 2.2 Knowledge Base

`knowledgeBaseRefs` 只引用所选 AgentCard 已声明的知识库。Compiler 检查：

- 引用 ID 存在于 Card；
- Card 编译时知识库路径已被 Card `readScopes` 覆盖；
- Workflow Node 的本次 `readScopes` 也覆盖知识库全部路径。

空数组表示本节点只依赖 Run Skill、任务和正式输入 Artifact，不额外启用 Card 知识库。

### 2.3 依赖和输入

`dependsOn` 定义成功路径中的直接依赖。`inputs` 必须引用直接依赖节点产生的 Artifact，并且 `artifactType` 必须与生产者 Output Contract 一致。

下游收到的不是生产者 Session 文本，而是已经通过 Gate 的正式 Artifact Manifest。

### 2.4 权限

```ts
interface NodePermissions {
  workspace: "read" | "write";
  readScopes: string[];
  writeScopes: string[];
  externalActions: boolean;
}
```

规则包括：

- Scope 必须是规范化相对工作区路径；
- read Node 不能声明 write scope；
- write Node 必须有非空 write scope；
- Node 的读写范围必须被 Card 对应范围包含；
- `externalActions: true` 需要 Card 同样允许。

权限是 Compiler 和调度协议，不是操作系统沙箱。

## 3. Artifact Contract

```ts
interface ArtifactContract {
  id: string;
  artifactType: string;
  description: string;
  businessPurpose: string;
}
```

Artifact Contract 描述节点输出的业务类型和目的，不编码物理文件角色。Execution Submission 支持一个或多个 `{path, mimeType}` 文件；Staff 通过 Gate Criteria 规定机械与语义验收方式。

## 4. GateDefinition

```ts
interface GateDefinition {
  id: string;
  mechanicalCriteria: MechanicalCriterion[];
  semanticCriteria: SemanticCriterion[];
  reviewers: ReviewerRequirement[];
  objectiveCoverage: string[];
  aggregation: {
    requiredMechanical: "all";
    requiredSemantic: "all";
    conflict: "staff_arbitration";
  };
  routes: {
    pass: string;
    rework: string;
    blocked: "staff" | "user" | "fail";
    escalate: "staff" | "user";
  };
}
```

### 4.1 机械 Criterion

每项机械 Criterion 指定：

- `checkId`；
- Check 参数；
- 描述；
- 所需证据说明。

Compiler 通过 Check Registry 验证 Check 是否存在以及参数是否符合该 Check 的 TypeBox Schema。

Planner 分段提交时使用 `parametersJson` 字符串，Runtime 会将其解析为这里的正式 `parameters` JSON 值，并立即按规划上下文中的 Check Schema 校验。冻结 Workflow 和人工模板始终使用 `parameters`，不保存 `parametersJson`。

### 4.2 语义 Criterion

语义 Criterion 必须：

- `required: true`；
- 声明 Reviewer capability；
- 声明需要检查的证据。

至少一个 Reviewer Requirement 必须覆盖每项 Criterion 的 capability 集合。

### 4.3 Reviewer 独立性

局部 Gate 排除当前节点生产者；Final Gate 排除 Workflow 中所有生产者。同一 Gate Run 内一张 AgentCard 只能占一个 Reviewer slot。Compiler 和 Runtime 共用同一个确定性二分匹配分配器，对全部 Requirement 做全局互斥分配，而不是逐项独立计数；分配器可以把先前的通用 Reviewer 改配给其他 slot，从而找到存在的完整匹配。

如果能力足够但只有生产者本人匹配，Diagnostic 是 `reviewer_not_independent`；如果整个池都没有足够匹配 Card，则是 `reviewer_unavailable`。

### 4.4 路由

- 局部 Gate `pass` 可以是 `continue`、`final` 或存在的 Node ID；
- Final Gate `pass` 必须是 `final`；
- `rework` 必须指向存在的 Node；
- Node `rework.targetNodeId` 必须与 Gate rework 路由相同；
- `maxAttempts` 最少为 1，不存在无限重试；当前 Builder 统一注入默认值 10。

## 5. Budget

Budget 有 unbounded 和 bounded 两种显式模式。unbounded Workflow 的全部 Node 必须同为 unbounded，Compiler 不执行 Token 求和或时间限制。bounded Workflow 的全部 Node 必须同为 bounded，并要求：

```text
所有 Node budget.tokens 之和
+ staffTokens
+ reviewerTokens
+ reworkTokens
<= globalBudget.tokens
```

如果存在 `hardTokenLimit`，它不能低于软预算 `tokens`。

预算是计划容量，不等于 AgentSession 实际 Usage；实际用量由 Runtime 记录。

## 6. Success DAG 与返工边

成功 Artifact 依赖必须是 DAG：

```text
Node A accepted Artifact
  → Node B
  → Final Artifact
```

Compiler 使用 `dependsOn` 进行拓扑排序并拒绝环。

返工不是成功依赖边：

```text
Node B Gate FAIL
  → B rework_pending
  → 新 Attempt
```

因此 Workflow 可以返工，但成功 Artifact DAG 仍必须无环。

Compiler 还要求每个 Node 最终能贡献到 `finalArtifactNodeIds`。孤立但从不进入最终交付的节点会得到 `unreachable_node`。

## 7. Final Artifact 与 Final Gate

- `finalArtifactNodeIds` 必须全部引用存在的 Node；
- Final Gate 从这些节点读取最新 accepted Artifact；
- Final Gate `objectiveCoverage` 必须覆盖所有 `acceptanceCriteria.id`；
- 未知或遗漏的 Acceptance Criterion 会阻止编译；
- Final Gate 使用与局部 Gate 相同的机械、语义、Reviewer 和聚合协议。

## 8. 合法 Workflow 示例

以下示例省略了第二个员工，但包含一条完整合法主链。Hash 使用占位符表示 Runtime 编译后的真实值。

```yaml
schemaVersion: 1
id: reviewed-analysis
version: 1.0.0
name: Reviewed Analysis
objective: 生成有来源且经过独立评审的分析
skill:
  name: analysis-skill
  hash: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
acceptanceCriteria:
  - id: accurate
    description: 关键结论有来源且与任务一致
source: generated
globalBudget:
  mode: bounded
  tokens: 80000
  timeLimitMs: 3600000
  staffTokens: 10000
  reviewerTokens: 12000
  reworkTokens: 10000
staff:
  core:
    - id: staff-workflow-architect
      version: 1.0.0
      hash: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
nodes:
  - kind: execution
    id: analysis
    objective: 综合正式输入并形成可复查分析
    agentCardRef:
      id: research-synthesist
      version: 1.0.0
      hash: cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
    requiredCapabilities: [research, evidence-synthesis]
    knowledgeBaseRefs: [run-evidence-space]
    dependsOn: []
    inputs: []
    output:
      id: analysis-output
      artifactType: analysis
      description: 分析正文和审查材料
      businessPurpose: 支持用户决策
    skills: [analysis-skill]
    tools: [read, write]
    permissions:
      workspace: write
      readScopes: [inputs, sources]
      writeScopes: [outputs/research]
      externalActions: false
    budget: { mode: bounded, tokens: 20000, timeLimitMs: 900000 }
    gate:
      id: analysis-gate
      mechanicalCriteria:
        - id: files-valid
          description: 文件存在且 Hash 一致
          checkId: artifact-integrity
          parameters: {}
          requiredEvidence: [Artifact Manifest]
      semanticCriteria:
        - id: analysis-accurate
          description: 结论有来源且没有越过证据
          required: true
          reviewerCapabilities: [artifact-review]
          evidenceRequirements: [分析正文, 来源引用]
      reviewers:
        - id: evidence-review
          capabilities: [artifact-review]
          minCount: 1
      objectiveCoverage: []
      aggregation:
        requiredMechanical: all
        requiredSemantic: all
        conflict: staff_arbitration
      routes:
        pass: continue
        rework: analysis
        blocked: staff
        escalate: staff
    rework: { maxAttempts: 10, targetNodeId: analysis }
    routes: { blocked: staff, exhausted: fail }
finalArtifactNodeIds: [analysis]
finalGate:
  id: final-gate
  mechanicalCriteria:
    - id: final-files-valid
      description: 最终文件存在且 Hash 一致
      checkId: artifact-integrity
      parameters: {}
      requiredEvidence: [Artifact Manifest]
  semanticCriteria:
    - id: final-accurate
      description: 最终交付覆盖用户目标
      required: true
      reviewerCapabilities: [artifact-review]
      evidenceRequirements: [最终正文, 来源]
  reviewers:
    - id: final-evidence-review
      capabilities: [artifact-review]
      minCount: 1
  objectiveCoverage: [accurate]
  aggregation:
    requiredMechanical: all
    requiredSemantic: all
    conflict: staff_arbitration
  routes:
    pass: final
    rework: analysis
    blocked: staff
    escalate: staff
```

实际合法性还取决于 Runtime 提供的真实 Skill Hash、AgentCard Hash、固定 Staff Core、知识库路径和 Check Registry；示例中的占位 Hash 不能直接运行。

## 9. 非法示例

### 9.1 员工能力不匹配

```yaml
requiredCapabilities: [software-implementation]
agentCardRef: research-synthesist
```

如果该 Card 不含 `software-implementation`，Compiler 返回 `required_capability_missing`。

### 9.2 知识库越权

```yaml
knowledgeBaseRefs: [workspace-implementation]
permissions:
  readScopes: [docs]
```

如果知识库路径是 `.`，Node 只读 `docs`，返回 `knowledge_base_permission_exceeded`。

### 9.3 ST Core 生产业务 Artifact

```yaml
agentCardRef: staff-workflow-architect
```

固定 Core 成员不能作为 Execution Node 生产者，返回 `employee_role_conflict`。

### 9.4 只有机械 Gate

```yaml
semanticCriteria: []
```

Schema 直接拒绝。即使伪造一个没有实际判断意义的语义描述，Compiler 当前也无法理解其业务深度；ST Authoring Guide、实际 Reviewer 和开发审查仍需防止这种规避。

### 9.5 成功依赖成环

```text
A dependsOn B
B dependsOn A
```

返回 `success_graph_cycle`。

### 9.6 修改固定 Core

Workflow 增加、删除、重排或替换 `staff.core` 都返回 `staff_core_mismatch`。

## 10. Diagnostic

```ts
interface IpdDiagnostic {
  code: IpdDiagnosticCode;
  path: string;
  message: string;
  source?: string;
}
```

Compiler 返回全部可发现 Diagnostic，并按 `path + code` 排序。Planner 将 Diagnostic 连同上一版候选写入 Ledger Decision，并把该候选预载给下一次 ST Planner AgentSession；模型只需重提被诊断的分段再 finalize。

常见代码：

| Code | 含义 |
|---|---|
| `schema_invalid` | TypeBox 结构不合法 |
| `skill_mismatch` | Workflow Skill 与 Run Snapshot 不一致 |
| `staff_core_mismatch` | Workflow 修改了固定 ST Core |
| `unknown_agent_card` | Card ID/version/hash 不存在 |
| `required_capability_missing` | 所选员工不具备节点要求能力 |
| `knowledge_base_unknown` | Node 引用了 Card 不拥有的知识库 |
| `knowledge_base_permission_exceeded` | Node 读范围不覆盖知识库路径 |
| `employee_role_conflict` | 固定 Core 被用于业务生产 |
| `permission_exceeded` | Tool、Skill 或权限超过 Card |
| `reviewer_unavailable` | 整个员工池的 Reviewer 数量或能力不足 |
| `reviewer_not_independent` | 单项看似有候选，但排除生产者或全局互斥分配后无法同时满足全部 Requirement |
| `success_graph_cycle` | 成功依赖成环 |
| `unreachable_node` | Node 不贡献最终 Artifact |
| `budget_invalid` | 节点与预留预算超过全局预算 |
| `final_coverage_incomplete` | Final Gate 未覆盖用户验收目标 |

## 11. Hash、冻结与保存

编译成功后：

1. 对结构化 Workflow 进行规范 JSON Hash；
2. `freezeDeep()` 冻结定义；
3. 保存到 `~/.pi/ipd/workflow/<workflow.id>/<version>/<hash>.json`；
4. Ledger 保存 Workflow JSON、Hash 和来源；
5. Ledger 同时快照当前编译 AgentCard Pool，供动态 Reviewer 和恢复使用；
6. Run 状态从 compiling 进入 ready。

相同 Hash 复用已有文件；同一 ID/version 出现不同 Hash 时 AssetStore 返回类型化 `version_conflict`。Planner 将其转换为 `/version` 上的 `workflow_version_conflict` Diagnostic，保留上一候选并进入下一 revision；模型只需通过 `submit_workflow_header` 提交尚未使用的更高 SemVer，再次 finalize。只有真实 Hash、读写或持久化错误才以 `asset_write_failed` 终止 Run。运行结束不会删除 Workflow Asset。
