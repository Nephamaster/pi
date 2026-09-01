# IPD 风格多智能体系统代码构建方案

> 主设计依据：`IPD-tools.md`  
> 目标仓库：Pi monorepo  
> V1 执行底座：现有 `AgentSession`，后续增加 `AgentHarness v2` Adapter  
> 运行环境：仅支持 Node.js 24  
> 端到端验证：由调用方提供的 Skill 驱动，IPD 内核不绑定具体任务领域

## 1. 方案目标

本方案把 `IPD-tools.md` 中的组织与流程设计拆成可以直接进入代码实施、逐阶段验收和按事件追溯错误的工程任务。

V1 需要证明以下闭环真实成立：

```text
外层 Pi Agent
  → IPD Tool
  → 解析必填 Skill Snapshot
  → 加载并编译全部 AgentCard Asset
  → ST 按 Pi 治理规则获取可用记忆上下文（如有）
  → ST 编排并冻结 Workflow
  → Graph Engine 调度 Execution Node
  → 节点提交候选 Artifact
  → Gate 机械检查
  → ST Dynamic Reviewer 语义评审
  → PASS 后 Artifact 才对下游可见
  → 最终 Gate
  → Run 原子收口
```

V1 不以建设完整平台为目标，而以以下工程事实为验收标准：

1. Workflow 在执行前可以被 Schema 和 Compiler 确定性验证；
2. Graph Engine 是 Run、Node、Gate 和 Artifact 状态的唯一写者；
3. 每个 Execution Node 都绑定同时具有机械标准和语义标准的 Gate；
4. 机械检查通过后必须发生独立语义评审，不能只凭文件存在或命令成功准出；
5. 未通过 Gate 的 Artifact 不能成为下游正式输入；
6. 节点返工、阻塞、用户恢复、预算事件和最终结果都能从 Ledger 重建；
7. 每次 Agent 调用都能定位到 Run、Node、Attempt、Gate、Reviewer 和原始 Session JSONL；
8. 用户提供的真实 Skill 能完成至少一次包含并行、返工和最终验收的端到端 Run。

## 2. 已冻结的实现决策

### 2.1 执行底座

V1 使用 `@earendil-works/pi-coding-agent` 的 `AgentSession` 执行 ST、数字员工和 Dynamic Reviewer。

不直接修改 `AgentSession` 的运行语义。IPD 通过 `NodeRunner` 接口调用它，后续 `AgentHarness v2` 完成后只新增 Adapter，不替换 Graph Engine、Workflow IR 或 Ledger。

### 2.2 Package 状态

新增 `packages/ipd`，名称暂定为 `@earendil-works/pi-ipd`，V1 设置为 `private: true`。Package 按未来公开包的目录、导出和测试方式建设，但在端到端验证前不进入 npm 发布链。

V1 的 IPD Tool 通过一个显式加载的 Coding Agent Extension 暴露，不默认加入所有 Pi 会话。验收通过后再决定是否成为内建、默认关闭的能力或公开 Pi Package。

### 2.3 Tool 生命周期

IPD Tool 提供四个动作：

```text
start   创建 Run，并执行到完成、失败或需要用户输入
resume  提交用户回答，继续指定 Run
status  读取指定 Run 的权威状态
cancel  取消指定 Run
```

V1 不创建后台 daemon。`start` 和 `resume` 在当前工具调用内运行到下一个稳定状态，返回 `runId` 和结构化结果。

### 2.4 Skill 传递

当前 Pi 没有“外层 Agent 已自动选择并传递 Skill 对象”的运行时机制。因此 IPD Tool 的 `start` 必须接受 `skillName`：

- Extension 必须从当前 `ResourceLoader` 已加载的 Skill 中解析完整内容；
- Skill 不存在、不可读或不合法时，`start` 在创建 Run 前失败；
- ST 必须以该 Skill 为组织知识，自主设计 Workflow，或参考/复用已有 Workflow Asset 后形成本次 Workflow；
- Run 启动时保存 Skill 内容、来源路径和 Hash 快照，后续执行不读取变化后的文件替换既有事实。

### 2.5 权限和并行

V1 的权限是 Harness 能力边界，不宣称是操作系统安全沙箱：

- AgentCard 和 NodeDefinition 共同限定可用 Tool；
- NodeRunner 不加载未授权 Extension；
- 只读节点可以并行；
- 写节点必须声明 `writeScopes`；
- 写范围重叠的节点串行；
- 含 Bash 的节点默认获得整个工作区写锁；
- 真正的文件系统、进程和网络隔离由远程运行环境的容器完成。

### 2.6 Gate 不变量

每个 Execution Node 的 Gate 必须同时包含：

- 至少一项机械化准出标准；
- 至少一项语义准出标准；
- Reviewer 能力要求；
- Criterion 汇总规则；
- PASS、REWORK、BLOCKED 和 ESCALATE 路由。

机械检查失败时直接进入既定失败路由，不浪费语义 Reviewer。机械检查通过后必须创建 Dynamic Reviewer 检查交付物内容。不存在 `deterministicOnly` Gate。

Workflow IR 只允许出现“Execution Node + 其绑定 Gate”，不定义机械动作节点、脚本节点或通用 Check Node。若 ST 设计出的任一步骤只有机械动作、没有需要语义评审的业务 Artifact，Compiler 必须拒绝整套 Workflow，要求 ST 重新合并或重新划分节点。机械动作只作为 Execution Node 内部实现细节，或 Gate 的机械准出检查存在，不作为 Workflow 步骤。

### 2.7 存储

V1 使用 Node 24 内置的 `node:sqlite`：

- 实际运行版本 Node.js 24；
- `packages/ipd` 的 `engines.node` 设置为 `>=24`；
- Ledger 默认位于 `${agentDir}/ipd/ipd.sqlite`；
- Agent 原始 Session JSONL 位于 `${agentDir}/ipd/sessions/`；
- 业务 Artifact 留在任务工作目录；
- Ledger 保存 Artifact URI、Hash、大小、类型、生产者、证据和状态。

## 3. 当前 Pi 代码中的落点

| IPD 能力 | 复用的现有代码 | 新增边界 |
|---|---|---|
| 模型和认证 | `packages/coding-agent/src/core/model-runtime.ts` | 不新建认证系统 |
| Agent 运行 | `createAgentSessionServices()`、`createAgentSessionFromServices()` | `AgentSessionNodeRunner` |
| Agent Loop | `packages/agent/src/agent.ts`、`agent-loop.ts` | 不修改循环语义 |
| 结构化输出 | TypeBox Tool Schema、faux provider | ST/Reviewer 提交工具 |
| Skill 发现 | `DefaultResourceLoader`、`BeforeAgentStartEvent.systemPromptOptions.skills` | `SkillSnapshotResolver` |
| Tool 权限 | `CreateAgentSessionOptions.tools/noTools/customTools` | AgentCard 与 Node 交集校验 |
| 会话追踪 | Coding Agent `SessionManager` JSONL | Attempt 关联 Session ID/File |
| 长程事实 | 无可直接复用的生产主链 | IPD SQLite Ledger |
| 调度和 Gate | 无 | Graph Engine、Gate Pipeline |
| 外层入口 | Coding Agent Extension `registerTool()` | IPD Tool Extension |
| 测试模型 | `packages/ai/src/providers/faux.ts` | 结构化 ST/Reviewer 脚本响应 |

不在 `packages/agent/src/agent-loop.ts` 中加入 Workflow、Gate、ST 或 Ledger 逻辑。Agent Loop 只负责单个 Agent 的模型—工具循环。

## 4. 目标代码结构

```text
packages/ipd/
  package.json
  tsconfig.build.json
  README.md
  src/
    index.ts
    errors.ts
    ids.ts
    clock.ts

    ir/
      schemas.ts
      types.ts
      compiler.ts
      graph.ts
      hash.ts

    registry/
      agent-card-registry.ts
      workflow-asset-registry.ts
      workflow-asset-store.ts
      check-registry.ts
      artifact-view-registry.ts
      asset-loader.ts
      in-memory-registry.ts

    ledger/
      types.ts
      sqlite-ledger.ts
      migrations.ts
      migrations/
        001_initial.sql

    runtime/
      ipd-runtime.ts
      graph-engine.ts
      scheduler.ts
      state-machine.ts
      budget-manager.ts
      workspace-locks.ts
      event-types.ts

    staff/
      workflow-planner.ts
      staff-coordinator.ts
      reviewer-selector.ts
      decision-runner.ts
      prompts.ts

    gate/
      gate-pipeline.ts
      mechanical-checker.ts
      semantic-reviewer.ts
      criterion-aggregator.ts
      final-gate.ts

    artifact/
      manifest.ts
      artifact-store.ts
      review-bundle.ts
      hash-file.ts

    adapter/
      node-runner.ts
      agent-session-node-runner.ts
      structured-agent-session.ts
      skill-snapshot-resolver.ts

    tool/
      command-schema.ts
      command-handler.ts
      result.ts

  examples/
    ipd-extension.ts

  test/
    ir/
    ledger/
    runtime/
    staff/
    gate/
    adapter/
    tool/
    e2e/
```

模块依赖方向固定为：

```text
ir ← registry
 ↑      ↑
ledger  artifact
   \    /
   runtime ← gate ← staff
      ↑
   adapter
      ↑
    tool
```

`ir`、`ledger` 和 `runtime` 不导入 Coding Agent。只有 `adapter/agent-session-node-runner.ts` 可以导入 `@earendil-works/pi-coding-agent`。

## 5. Workflow IR

### 5.1 AgentCard Asset 与运行时对象

AgentCard 是独立于 Workflow 的固有资产。用户可以在 AgentCard 目录中增加、修改或删除配置文件；ST 不能在规划 Workflow 时临时生成或改写 AgentCard。

配置文件使用统一 Schema，不允许自由发明字段。以下字段允许缺省：`version`、`model`、`skills`、`tools`、`permissions` 和 `defaultBudget`。

```ts
interface AgentCardAsset {
  id: string;
  version?: string;
  name: string;
  description: string;
  responsibilities: string[];
  nonResponsibilities: string[];
  capabilities: string[];
  model?: {
    selection?: "run_default" | "explicit";
    provider?: string;
    id?: string;
    thinkingLevel?: ThinkingLevel | "inherit";
  };
  skills?: string[];
  tools?: string[];
  permissions?: {
    workspace?: "read" | "write";
    readScopes?: string[];
    writeScopes?: string[];
    externalActions?: boolean;
  };
  defaultBudget?: {
    tokens?: number;
    timeoutMs?: number;
  };
}
```

Asset Loader 将配置文件编译成所有字段完整的 `CompiledAgentCard`。V1 缺省值固定为：

```ts
const AGENT_CARD_DEFAULTS = {
  version: "1.0.0",
  model: {
    selection: "run_default",
    thinkingLevel: "inherit",
  },
  skills: [],
  tools: ["read"],
  permissions: {
    workspace: "read",
    readScopes: ["."],
    writeScopes: [],
    externalActions: false,
  },
  defaultBudget: {
    tokens: 12_000,
    timeoutMs: 900_000,
  },
} as const;
```

缺省值采用最小权限原则。需要 Bash、写文件或外部操作的数字员工必须由用户在 AgentCard 中显式配置。

`run_default` 使用 IPD Tool 启动时外层会话的当前模型和 thinking level；`explicit` 必须同时指定 provider 和 model ID，AgentCard Compiler 负责验证该模型在当前 `ModelRuntime` 中可用且已配置认证。

AgentCard 的 `skills` 表示该数字员工固有的附加 Skill，缺省为空；它不控制本次 IPD Tool 强制传入的 Run Skill。ST 为节点分配 Skill 时只能从以下集合选择：

```text
本次 Run Skill ∪ 所选 AgentCard 的固有 skills
```

因此缺省 AgentCard 仍可被 ST 安排执行本次 Run Skill 定义的工作，但不能凭空获得其他专业 Skill。

每次 `ipd.start` 的顺序固定为：

```text
扫描 AgentCard 目录中的全部配置文件
  → Schema 校验
  → 应用缺省值
  → 解析模型、Skill、Tool 和权限
  → 生成 CompiledAgentCard Pool
  → 计算每个 Card 的 Hash
  → 将 Pool 摘要交给 ST 选择
```

Workflow 只保存选中的 AgentCard 引用，不内嵌或拥有 AgentCard：

```ts
interface AgentCardRef {
  id: string;
  version: string;
  hash: string;
}
```

Run 启动后把所选 Card 的引用和不可变 Snapshot 写入 Ledger，用于复现；运行结束不会修改原 AgentCard 文件。

调度时的有效权限是以下交集，不能取并集：

```text
AgentCard 权限 ∩ NodeDefinition 权限 ∩ Run 全局限制
```

### 5.2 WorkflowDefinition

```ts
interface WorkflowDefinition {
  schemaVersion: 1;
  id: string;
  name: string;
  objective: string;
  source: "generated" | "template";
  sourceTemplateId?: string;
  globalBudget: BudgetDefinition;
  staff: StaffDefinition;
  nodes: ExecutionNodeDefinition[];
  finalGate: GateDefinition;
}
```

Workflow 中只声明业务 Execution Node。ST Core、Dynamic Reviewer 和最终验收员在运行时创建为 Decision Node Instance，不进入成功 Artifact DAG。

### 5.3 ExecutionNodeDefinition

```ts
interface ExecutionNodeDefinition {
  id: string;
  objective: string;
  agentCardRef: AgentCardRef;
  dependsOn: string[];
  inputs: ArtifactBinding[];
  output: ArtifactContract;
  skills: string[];
  tools: string[];
  permissions: {
    workspace: "read" | "write";
    readScopes: string[];
    writeScopes: string[];
  };
  budget: NodeBudgetDefinition;
  gate: GateDefinition;
  rework: {
    maxAttempts: number;
    targetNodeId: string;
  };
  routes: {
    blocked: "staff" | "user" | "fail";
    exhausted: "staff" | "user" | "fail";
  };
}
```

### 5.4 GateDefinition

```ts
interface GateDefinition {
  id: string;
  mechanicalCriteria: MechanicalCriterion[];
  semanticCriteria: SemanticCriterion[];
  reviewers: ReviewerRequirement[];
  aggregation: {
    requiredMechanical: "all";
    requiredSemantic: "all";
    conflict: "staff_arbitration";
  };
  routes: {
    pass: string | "final";
    rework: string;
    blocked: "staff" | "user" | "fail";
    escalate: "staff" | "user";
  };
}
```

机械 Criterion 不允许保存 ST 临时生成的任意 Shell。它只能引用 `CheckRegistry` 中预先注册的检查器 ID，并提供经过 Schema 验证的参数：

```ts
interface MechanicalCriterion {
  id: string;
  description: string;
  checkId: string;
  parameters: JsonValue;
  requiredEvidence: string[];
}
```

语义 Criterion 必须明确评价内容和证据要求：

```ts
interface SemanticCriterion {
  id: string;
  description: string;
  required: true;
  reviewerCapabilities: string[];
  evidenceRequirements: string[];
}
```

### 5.5 Compiler 必须拒绝的配置

Compiler 按固定顺序执行并返回全部可定位错误：

1. TypeBox Schema 不合法；
2. ID 重复或引用不存在；
3. AgentCard 引用、强制传入的 Skill、Tool 或 Check ID 不存在；
4. 节点权限超过 AgentCard 权限；
5. 节点没有声明 `readScopes`，或写节点没有声明 `writeScopes`；
6. 成功 Artifact 依赖图存在环；
7. 输入 Artifact 没有唯一生产者；
8. 输出类型与下游输入契约不兼容；
9. 任一 Execution Node 没有 Gate；
10. Gate 缺少机械标准、语义标准或 Reviewer 要求；
11. Gate 路由指向不存在的节点；
12. 返工没有最大次数或形成无界控制环；
13. Reviewer 要求无法由员工池满足；
14. 执行者同时成为自己产物的唯一 Reviewer；
15. 节点预算之和没有为 ST、评审和返工保留空间；
16. 最终 Gate 没有覆盖原始用户目标。

Compiler 成功后：

- 对规范化 JSON 计算 Workflow Hash；
- 写入 Ledger；
- 冻结 Workflow 版本；
- 执行期间禁止修改拓扑和 Gate Criteria。

### 5.6 资产发现

V1 同时支持程序化 Registry 和文件资产。文件位置固定为：

```text
${agentDir}/ipd/agent-cards/*.{json,yaml}
${agentDir}/ipd/workflows/*.{json,yaml}
<cwd>/.pi/ipd/agent-cards/*.{json,yaml}
<cwd>/.pi/ipd/workflows/*.{json,yaml}
```

项目本地 IPD 资产只在 `ExtensionContext.isProjectTrusted()` 为 true 时加载。发生相同 ID 时不静默覆盖：Registry 生成 Collision Diagnostic，并要求用户或配置显式选择版本。

AgentCard Asset Loader 必须在 ST Planner 启动前读完所有 Card，并一次性返回已校验的运行时 Pool。ST 只能从该 Pool 中选择员工，不能在 Workflow 内定义新员工。V1 可以提供少量通用 ST、执行和评审 Card 示例，但不提供绑定某一业务领域的内置角色。

任一 AgentCard 文件 Schema、默认值解析、模型引用或权限配置失败时，`ipd.start` 返回完整 Asset Diagnostic 并停止，不允许静默跳过后让 ST 在不完整员工池上规划。

### 5.7 Workflow 资产化

Workflow Template 和 ST 新生成的 Workflow 都是长期资产，不是 Run 临时文件：

```text
${agentDir}/ipd/workflows/templates/
${agentDir}/ipd/workflows/generated/
<cwd>/.pi/ipd/workflows/templates/
<cwd>/.pi/ipd/workflows/generated/
```

ST 可以从零设计，也可以参考或复用已有 Workflow Asset，但两种路径都必须结合本次强制传入的 Skill 形成新的候选 `WorkflowDefinition` 并重新编译。

Compiler 通过后，Asset Store 使用规范化 Workflow ID、版本和 Hash 将配置持久化为 JSON 或 YAML。文件采用不可覆盖写入；相同 Hash 复用既有 Asset，不同内容产生新版本。Run 在 Ledger 中保存 `WorkflowAssetRef` 和不可变快照。

复用 Workflow Asset 时必须重新加载当前 AgentCard Pool 并校验其中的 `AgentCardRef`。若原 Card 已删除、版本变化或不再满足权限，ST 应选择当前可用 Card 形成新的 Workflow Asset 版本，不能修改旧文件或在运行时偷偷替换引用。

Run 成功、失败或取消后都不能删除 Workflow 配置文件。历史使用次数、成功、返工和 Gate 结果只作为 Asset Metrics 关联记录，不直接覆盖 Workflow 内容。

## 6. Runtime 状态机

### 6.1 Run 状态

```text
planning
  → compiling
  → ready
  → running
  ↔ waiting_user
  → succeeded | failed | cancelled
```

终态不可逆。`waiting_user` 只能通过匹配的 `resume(runId, escalationId)` 恢复。

### 6.2 Node 状态

```text
pending
  → ready
  → running
  → gate_checking
  → gate_reviewing
  → succeeded

gate_checking / gate_reviewing
  → rework_pending → ready
  → blocked
  → failed
```

只有 Graph Engine 可以提交状态转换。Agent 只能返回：

- Candidate Artifact；
- 节点级异常；
- Blocked 请求；
- Decision Node 的结构化决策。

### 6.3 Artifact 状态

```text
candidate → accepted
          → rejected
```

下游输入查询只返回 `accepted` Artifact。历史候选和被拒绝版本保留，用于返工距离和缺陷追溯。

### 6.4 Gate 状态

```text
pending
  → mechanical_checking
  → mechanical_failed
  → semantic_reviewing
  → passed | failed | inconclusive | blocked
```

`mechanical_failed` 不启动 Reviewer。进入 `semantic_reviewing` 后至少存在一个独立 Reviewer Instance。

## 7. Ledger 设计

### 7.1 核心表

| 表 | 作用 |
|---|---|
| `ipd_runs` | Run 当前快照、目标、状态和预算 |
| `workflow_versions` | 冻结的 Workflow JSON、Hash 和来源 |
| `node_instances` | 每个节点每次 Attempt 的状态和 Agent Session |
| `artifacts` | 候选及正式 Artifact Manifest |
| `gate_runs` | 每次 Gate 的机械与语义阶段状态 |
| `criterion_results` | 每项机械/语义 Criterion 的结果和证据 |
| `reviewer_instances` | Dynamic Reviewer 的 AgentCard、Session 和结果 |
| `decisions` | ST 编排、仲裁、预算和最终验收决策 |
| `escalations` | 向 ST 或用户提出的问题及回答 |
| `budget_usage` | Token、成本和耗时事实 |
| `ipd_events` | Append-only 运行事件 |

### 7.2 写入规则

每次状态变化在一个 SQLite Transaction 内完成：

```text
校验当前版本和合法迁移
  → 更新快照表
  → 追加 ipd_events
  → 提交事务
```

事件至少带有：

```ts
interface IpdEventEnvelope {
  eventId: string;
  sequence: number;
  runId: string;
  traceId: string;
  nodeId?: string;
  attemptId?: string;
  gateRunId?: string;
  reviewerInstanceId?: string;
  type: IpdEventType;
  timestamp: number;
  payload: JsonValue;
}
```

`sequence` 在单个 Run 内严格递增。状态表用于查询，事件表用于审计和恢复验证；二者在同一事务中更新，不维护第二份 JSON 状态真相。

### 7.3 SQLite 设置

打开数据库后固定执行：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

Migration 沿用仓库现有模式：SQL 文件版本化、`migrations` 表记录、每个 Migration 在事务中执行。

### 7.4 幂等

以下写操作必须接受 `idempotencyKey` 并建立唯一约束：

- Tool `start`；
- Tool `resume`；
- Node Attempt 启动；
- Artifact 登记；
- Reviewer 结果提交；
- Gate 最终决策；
- Run 终态收口。

重复调用返回已提交结果，不再次启动 Agent 或产生重复 Artifact。

## 8. Artifact 与 Review Bundle

### 8.1 ArtifactManifest

```ts
interface ArtifactManifest {
  id: string;
  runId: string;
  nodeId: string;
  attemptId: string;
  contractId: string;
  createdAt: number;
  inputs: string[];
  files: Array<{
    role: "primary" | "evidence" | "review";
    path: string;
    mimeType: string;
    sha256: string;
    size: number;
  }>;
  metadata: JsonValue;
}
```

Manifest 中的路径必须经过工作目录归一化。登记时立即计算 Hash；Gate 和下游读取时再次验证文件存在及 Hash，避免评审期间被静默替换。

### 8.2 Reviewer 如何读取交付物

Reviewer 不能只读取执行者的文字总结。`ArtifactViewRegistry` 根据 MIME 和 Artifact Role 形成 Review Bundle：

- 文本：原文或受控截断后的原文；
- JSON：Schema 验证结果及内容；
- 图片：作为 `ImageContent` 附件；
- 二进制：必须由 Skill 或节点同时提供可评审派生物；
- 超大产物：提供索引和按需读取工具，不直接塞入单次 Prompt。

### 8.3 Skill 定义交付物，不由 IPD 内核定义

IPD 内核不认识 PPT、代码、文档、表格或其他具体任务类型。强制传入的 Skill 与 ST 共同决定：

- 节点需要生产什么业务 Artifact；
- Primary、Evidence 和 Review 文件分别是什么；
- 如何生成可供 Reviewer 查看具体内容的 Review Bundle；
- 哪些机械 Check 适用；
- 哪些语义 Criterion 和 Reviewer 能力适用。

若交付物是不能直接读取的二进制格式，Workflow 必须要求 Execution Node 同时提交可语义评审的派生物。Compiler 只验证 Artifact Contract 和 Gate 定义完整，不在代码中硬编码任何领域文件名、格式或检查器。

## 9. AgentSession Adapter

### 9.1 NodeRunner 接口

```ts
interface NodeRunner {
  runExecutionNode(input: ExecutionNodeRunInput): Promise<ExecutionNodeRunResult>;
  runDecisionNode(input: DecisionNodeRunInput): Promise<DecisionNodeRunResult>;
  abort(attemptId: string): Promise<void>;
}
```

Graph Engine 只依赖该接口，不读取 `AgentSession` 内部字段。

Gate 同样通过接口注入：

```ts
interface GateEvaluator {
  evaluate(input: GateEvaluationInput): Promise<GateEvaluationResult>;
  abort(gateRunId: string): Promise<void>;
}
```

Graph Engine 阶段先使用 FakeGateEvaluator 验证调度和状态机，完整实现由 `GatePipeline` 提供。

### 9.2 每个节点创建独立 AgentSession

`AgentSessionNodeRunner` 每次 Attempt：

1. 根据 AgentCard 解析模型和 thinking level；
2. 创建独立 `SessionManager`，Session 文件写入 IPD Session 目录；
3. 创建 cwd-bound `AgentSessionServices`；
4. 禁止自动加载 Extension、Prompt、Theme 和无关 Skill；
5. 只注入节点需要的 Skill Snapshot、上游正式 Artifact 和节点短期记忆；
6. 工具集合取 AgentCard、Node 和 Run 限制的交集；
7. 构建节点专用 system prompt；
8. 执行并等待 `AgentSession` 完全 settled；
9. 从结构化提交工具捕获 Artifact Manifest 或 Decision；
10. 记录使用量、Session ID、Session File 和错误。

节点不能用自然语言“我完成了”作为成功结果。Execution Node 只允许通过 `submit_artifact` Tool 提交候选 Manifest；Decision Node 只允许通过相应结构化 Decision Tool 提交结果。

### 9.3 Session 隔离

默认节点 Session 不继承外层对话全文，只得到：

- 原始任务的必要摘要；
- 本节点目标和边界；
- 冻结的 Workflow 版本与节点配置；
- 正式上游 Artifact Manifest；
- 本节点历史 Attempt 和返工意见；
- 当前 Gate Criteria；
- 分配的 Skill、Tool 和预算。

节点模型不得看到其他并行节点未通过 Gate 的候选产物。

## 10. Staff Teams 实现

### 10.1 Workflow Planner

ST Planner 使用独立 AgentSession，并只暴露 `submit_workflow` 结构化工具。

输入：

- 用户原始目标和约束；
- Skill Snapshot；
- 全局预算；
- AgentCard 摘要；
- Workflow Template 摘要；
- Compiler 规则摘要。

输出必须是 `WorkflowDefinition`。流程如下：

```text
ST 生成候选 Workflow
  → TypeBox 校验
  → Compiler 校验
  → 成功则冻结
  → 失败则把结构化错误返回 ST 修订
  → 超过规划修订上限则 Run failed
```

规划修订次数和业务节点返工次数分开记录，不能混用。

### 10.2 ST Core

V1 的 ST Core 是逻辑团队，不维护持续群聊。每次被事件唤醒时，从 Ledger 构造 `STControlRecord`：

- 原始目标；
- Workflow Hash；
- Node、Gate 和 Artifact 状态；
- 未解决风险；
- 预算使用；
- 历次 Decision；
- Pi 治理下允许提供的记忆上下文或引用（如有）；
- 当前允许动作集合。

ST Core 只通过结构化 Decision Tool 返回以下动作之一：

```text
retry_node
route_rework
select_reviewer
continue_over_budget
reduce_future_budget
ask_user
fail_run
```

V1 不允许 ST 修改冻结 Workflow 拓扑或 Gate Criteria。

### 10.3 ST 记忆遵循 Pi 治理

IPD 不定义独立的长期记忆格式、目录、检索器或写入策略，也不假设记忆内容一定是用户偏好、任务经验或执行反思。

ST 使用记忆时遵循以下边界：

- 只通过 Pi 当前运行时正式提供的记忆或上下文机制获取信息；
- 访问范围、检索策略、写入策略和生命周期全部遵循 Pi 的治理规则；
- IPD Adapter 不绕过 Pi 直接扫描自定义记忆目录；
- IPD 不自行推断并写入用户偏好，也不自动创建反思记忆；
- 如果当前 Pi 版本没有可供 `AgentSession` 使用的长期记忆接口，V1 不额外实现一套，ST 仍使用任务、Skill、Workflow Asset 和 Ledger 完成工作；
- 后续 Pi 增加或调整记忆能力时，只修改 AgentSession Adapter 的上下文装配，不改变 Workflow IR、Graph Engine 或 Gate 协议；
- 无论记忆来自何处，都不能绕过冻结 Workflow、权限或 Gate Criteria。

### 10.4 Dynamic Reviewer

ReviewerSelector 根据以下条件从 AgentCard Registry 选择 Reviewer：

1. 满足 Semantic Criterion 的 capability；
2. 具有读取 Artifact 的权限；
3. 不是该 Artifact 的执行者；
4. 符合 Gate 指定的模型或独立性要求；
5. 剩余预算足够。

每个 Reviewer 独立获得 Criterion、Review Bundle 和必要上下文，不能看到其他 Reviewer 的结论。

Reviewer 输出：

```ts
interface SemanticReviewDecision {
  decision: "PASS" | "FAIL" | "INCONCLUSIVE" | "BLOCKED";
  criteria: Array<{
    criterionId: string;
    result: "PASS" | "FAIL" | "INCONCLUSIVE" | "BLOCKED";
    evidence: EvidenceReference[];
    rationale: string;
    requiredRework: string[];
  }>;
}
```

## 11. Gate Pipeline

每次 Candidate Artifact 严格执行：

```text
1. Manifest Schema 校验
2. 文件存在、路径和 Hash 校验
3. 逐项 Mechanical Criterion
4. 机械失败 → 保存证据 → REWORK/BLOCKED
5. 机械通过 → ReviewerSelector
6. 并行启动互相独立的 Dynamic Reviewer
7. 保存逐 Criterion 结果和证据
8. CriterionAggregator 汇总
9. 冲突或 INCONCLUSIVE → ST Core 仲裁
10. PASS → Artifact accepted → 解锁下游
11. 非 PASS → 按冻结路由返工、升级或失败
```

`CriterionAggregator` 不做简单多数投票：

- 任一必需机械 Criterion 失败，Gate 失败；
- 任一必需语义 Criterion 确认失败，不能 PASS；
- 证据不足是 `INCONCLUSIVE`，不能视为通过；
- Reviewer 冲突进入 ST 仲裁；
- 重试耗尽只能升级、询问用户或失败，不能自动 PASS。

最终 Gate 复用同一 Pipeline，但其 Semantic Criteria 必须重新面向用户原始目标，不能只汇总各节点局部 PASS。

## 12. Scheduler 与并行控制

Scheduler 只把满足以下条件的节点标为 Ready：

- 所有依赖节点已经 `succeeded`；
- 所需 Artifact 均为 `accepted`；
- 节点未超过 Attempt 上限；
- 预算策略允许启动；
- Workspace Lock 可获得；
- Run 未取消或等待用户。

Workspace Lock 规则：

```text
read + read                     可并行
read + write(不重叠)           可并行
write + write(不重叠)          可并行
readScopes 与 writeScopes 重叠  串行
writeScopes 彼此重叠            串行
含 bash                        获取全工作区写锁
```

V1 采用进程内异步调度，不引入消息队列。每次节点或 Gate 状态提交后重新计算 Ready Set。

读写锁基于规范化后的 `readScopes` 和 `writeScopes` 计算；只声明 `workspace: read` 不能替代具体读取范围。对于 read、edit、write 等路径可识别 Tool，节点访问声明范围以外的路径会被 Hook 拒绝并形成可追溯错误。Bash 无法通过字符串分析获得可靠的路径隔离，因此一律获取全工作区写锁，真正的越界防护依赖外部容器。V1 的这些规则是 Harness 约束，不是操作系统安全边界。

### 12.1 进程重启恢复

V1 只自动恢复已经提交到 Ledger 的稳定状态，不假定进程中断前的 Agent 调用仍然存活。Runtime 启动时扫描非终态 Run：

1. `pending`、`ready`、`rework_pending` 和 `waiting_user` 按 Ledger 状态继续；
2. 遗留的 `running`、`gate_checking` 和 `gate_reviewing` Attempt 标记为 `interrupted`；
3. 释放进程内 Workspace Lock，并保留原 Session JSONL 和候选文件用于诊断；
4. 未完成 Gate 的 Candidate Artifact 不转为 `accepted`；
5. 对 `replay: safe` 的纯读取操作可创建新 Attempt 重试；
6. 含 Bash、文件写入或外部副作用的 Attempt 默认 `replay: never`，交给 ST 决定检查现状、重新执行、询问用户或失败；
7. 所有恢复动作写入新的 Event，不能改写中断前记录。

V1 不从 Assistant 流中间位置续传；恢复单位是 Node Attempt。

## 13. 预算管理

预算分为：

- Run 全局软预算；
- ST/规划预算；
- Execution Node 预算；
- Reviewer 预算；
- 返工与缓冲预算；
- 用户明确要求时才存在 Hard Limit。

每个独立 AgentSession 结束后记录其 Usage。达到预警阈值时产生事件：

```text
budget_warning       预计达到软预算的 80%
budget_reached       达到或超过软预算
hard_limit_reached   达到用户绝对限制
```

软预算事件唤醒 ST Core；Hard Limit 由 Graph Engine 停止新节点并进入用户升级或失败路由。

## 14. IPD Tool 接口

### 14.1 输入

```ts
type IpdToolCommand =
  | {
      action: "start";
      task: string;
      skillName: string;
      workflowTemplateId?: string;
      tokenBudget?: number;
      expectedDurationMs?: number;
      hardTokenLimit?: number;
    }
  | {
      action: "resume";
      runId: string;
      escalationId: string;
      answer: string;
    }
  | {
      action: "status";
      runId: string;
      detail?: "summary" | "nodes" | "full";
    }
  | {
      action: "cancel";
      runId: string;
      reason?: string;
    };
```

### 14.2 输出

```ts
interface IpdToolResult {
  runId: string;
  status:
    | "running"
    | "waiting_user"
    | "succeeded"
    | "failed"
    | "cancelled";
  summary: string;
  question?: {
    escalationId: string;
    prompt: string;
    context: string;
  };
  artifacts?: ArtifactManifest[];
  failure?: IpdFailure;
  usage: BudgetSnapshot;
}
```

Tool Result 的 `details` 保存完整结构，文本内容只提供给外层 Agent 做用户沟通。外层 Agent 不根据文本自行推断 Run 状态。

### 14.3 Extension Adapter

`examples/ipd-extension.ts` 负责：

1. 注册 `ipd` Tool；
2. 从 Tool `ExtensionContext` 获取 cwd、当前模型和 `agentDir` 配置；
3. 监听 `before_agent_start`，缓存本轮 `systemPromptOptions.skills`；
4. 将必填 `skillName` 解析为不可变 Skill Snapshot，解析失败时不创建 Run；
5. 获取或创建进程内 `IpdRuntime`；
6. 把 Tool 的 AbortSignal 转发给 Runtime；
7. 不直接写任何 Run 状态。

## 15. 错误分类与追溯

### 15.1 错误类型

```text
validation_error     IR、Manifest、Decision Schema 错误
compile_error        Workflow 关系和不变量错误
auth_error           模型认证失败
provider_error       Provider 请求失败
tool_error           节点工具执行失败
timeout              节点或 Reviewer 超时
artifact_error       文件、Hash、类型或证据错误
quality_failure      Gate Semantic Criterion 未满足
blocked              缺少信息、权限或外部依赖
budget_exceeded      Hard Limit 超出
cancelled            用户或上游取消
internal_error       Harness/Engine 缺陷
```

技术失败、质量失败和阻塞必须走不同路由。不能对错误方案进行无差别自动重试。

### 15.2 统一错误结构

```ts
interface IpdFailure {
  code: string;
  category: IpdFailureCategory;
  message: string;
  retryable: boolean;
  runId: string;
  traceId: string;
  nodeId?: string;
  attemptId?: string;
  gateRunId?: string;
  reviewerInstanceId?: string;
  cause?: JsonValue;
  evidence?: EvidenceReference[];
}
```

### 15.3 最小追溯链

任一最终缺陷必须能反向定位：

```text
最终 Artifact
  → 最终 Gate Criterion
  → Reviewer Decision
  → Review Bundle
  → 上游 Artifact 版本
  → Producer Node Attempt
  → AgentCard + Workflow Hash
  → AgentSession JSONL
  → Tool/Provider 错误和 Usage
```

## 16. 分阶段代码实施计划

每一阶段只在上一阶段验收通过后开始。任何阶段失败都应能在该阶段自己的单元测试或状态断言中暴露，不把基础错误拖到真实 Skill 端到端测试。

### 阶段 0：Package 骨架与测试基线

代码任务：

1. 新增私有 `packages/ipd` workspace；
2. 配置 `package.json`、Node 24 Engine、`tsconfig.build.json`、Vitest；
3. 增加 `src/index.ts` 和测试目录；
4. 把 Package 加入根构建顺序，位置在 `coding-agent` 之后；
5. 建立 `IpdError`、Clock、ID Generator 测试替身。

验收：

- Package 可独立 typecheck/build；
- 一个最小单元测试通过；
- `npm run check` 不新增警告；
- 不改变现有 Pi CLI 行为。

### 阶段 1：IR Schema 与 Compiler

代码任务：

1. 实现 AgentCard、Workflow、Node、Gate、Artifact Schema；
2. 实现 AgentCard 缺省值、Asset Compiler 和目录 Loader；
3. 实现 Registry 接口和 InMemory/File Registry；
4. 实现 Compiler 的全部静态校验；
5. 实现成功 Artifact DAG 检查；
6. 实现规范化 JSON、Hash 和 Frozen Workflow；
7. 为每条 Compiler 错误提供稳定 code 和 JSON path。

重点测试：

- 合法单链、fan-out/fan-in Workflow；
- 成功路径循环；
- 缺少机械或语义标准；
- 无 Reviewer；
- 非法返工循环；
- 权限越界；
- AgentCard 缺省字段正确补齐；
- 所有 AgentCard 在 ST 启动前完成加载；
- Workflow 尝试内嵌或临时定义 AgentCard；
- 仅包含机械动作、没有语义业务 Artifact 的节点；
- Artifact 类型不匹配；
- 最终 Gate 未覆盖用户目标。

阶段验收物：一个不调用模型即可编译并冻结的通用 Skill Workflow Fixture，以及一组独立加载的 AgentCard Asset。

### 阶段 2：SQLite Ledger

代码任务：

1. 实现初始 Migration；
2. 实现 Run、Workflow、Node、Artifact、Gate、Decision、Budget 和 Event Repository；
3. 实现事务化状态迁移；
4. 实现 Run 内单调 Sequence；
5. 实现 Idempotency Key；
6. 实现 `getRunSnapshot()` 和 `verifyRunConsistency()`；
7. 实现关闭与进程重开后的状态读取；
8. 保存 Workflow Asset 引用、Workflow Snapshot、AgentCard 引用和 AgentCard Snapshot。

重点测试：

- Migration 重复执行；
- 非法状态迁移被拒绝；
- Snapshot 和 Event 同事务提交；
- 重复调用不产生重复记录；
- 进程模拟重启后快照一致；
- Artifact 候选、拒绝和接受版本共存。

阶段验收物：使用纯 Repository API 完整重放一个手工 Run，不涉及 Agent。

### 阶段 3：Artifact、Check 与 Workspace Lock

代码任务：

1. 实现 Artifact Manifest 校验、路径归一化和 SHA-256；
2. 实现 `CheckRegistry` 和 Mechanical Checker；
3. 实现 `ArtifactViewRegistry` 和 Review Bundle；
4. 实现 Workspace Lock Manager；
5. 实现文本、JSON、图片的基础 Artifact View；
6. 定义一个与领域无关的二进制 Artifact + Review Bundle Fixture。

重点测试：

- 文件缺失和 Hash 漂移；
- 非法工作目录逃逸；
- 未注册 Check ID；
- Mechanical Criterion 逐项证据；
- 重叠写范围串行；
- 读写范围重叠时串行；
- 只读节点并行；
- Bash 节点获取全局写锁。

阶段验收物：不调用模型即可完成通用 Artifact Fixture 的全部机械检查，并生成 Reviewer 可读取具体内容的 Review Bundle。

### 阶段 4：AgentSession NodeRunner

代码任务：

1. 实现 NodeRunner 抽象；
2. 实现 AgentSession Session/Services 工厂；
3. 实现节点 system prompt 与受限资源装配；
4. 实现 `submit_artifact`、`submit_workflow`、`submit_review`、`submit_decision` Tool；
5. 实现模型、Skill、Tool 和权限交集；
6. 实现 Usage、Session ID/File 和错误回传；
7. 实现 Abort 和 Timeout。

重点测试全部使用 faux provider：

- Execution Node 正确提交 Manifest；
- 只说“完成”但未调用 Tool 时失败；
- 非法结构化输出失败；
- Tool allowlist 生效；
- 不加载无关 Extension/Skill；
- Agent Session JSONL 与 Attempt 正确关联；
- Abort 后状态和 Session 可追溯。

阶段验收物：独立运行一个 Skill 驱动的假业务节点，并登记候选 Artifact。

### 阶段 5：ST Planner 与 Workflow 冻结

代码任务：

1. 实现 Skill Snapshot；
2. 实现 Workflow Asset Registry 和不可覆盖 Asset Store；
3. 实现 ST Planner Prompt；
4. 实现结构化 Workflow 提交；
5. 实现 Compiler 错误反馈和有限规划修订；
6. 实现 Workflow Asset 不可覆盖持久化；
7. 实现 Workflow 冻结和 planning/compiling/ready 状态迁移；
8. 保存每次候选 Workflow 和拒绝原因。

重点测试：

- 从零设计 Workflow；
- 复用 Template 后形成独立 Workflow；
- 首次 Compiler 失败、第二次修复成功；
- 修订耗尽后 Run failed；
- Skill 文件变化不影响已启动 Run；
- 未提供 Skill 时拒绝创建 Run；
- Run 终态后 Workflow Asset 文件仍然存在；
- Planner 无权直接启动节点。

阶段验收物：输入任意任务和必填 Skill Fixture，生成、持久化并冻结合法 Workflow。

### 阶段 6：Graph Engine 与 Scheduler

代码任务：

1. 实现 Run/Node 状态机；
2. 实现 Ready Set 计算；
3. 实现 Execution Node 调度；
4. 实现 fan-out/fan-in；
5. 实现 Workspace Lock；
6. 实现返工 Attempt；
7. 实现 Cancel；
8. 实现稳定状态运行循环。

本阶段先使用 FakeNodeRunner 和 FakeGateEvaluator，避免模型错误或语义评审错误掩盖调度错误。

重点测试：

- 单链执行；
- 并行只读节点；
- 写冲突串行；
- 汇聚前等待全部依赖；
- 候选 Artifact 不解锁下游；
- 返工生成新 Attempt；
- Attempt 耗尽后按路由处理；
- Cancel 不再启动新节点；
- 模拟进程中断后把活跃 Attempt 标记为 interrupted，并按 replay 策略继续。

阶段验收物：FakeNodeRunner 完整跑通带并行和一次返工的 Workflow。

### 阶段 7：完整 Gate Pipeline 与 Dynamic Reviewer

代码任务：

1. 接入 Mechanical Checker；
2. 实现 ReviewerSelector；
3. 实现独立 Reviewer AgentSession；
4. 实现逐 Criterion 结构化结果；
5. 实现 CriterionAggregator；
6. 实现 ST 冲突仲裁；
7. 实现 Gate 路由和 Artifact 正式接受；
8. 实现最终端到端 Gate。

重点测试：

- 机械失败时 Reviewer 不启动；
- 机械通过后 Reviewer 必须启动；
- Reviewer 读取实际 Review Bundle；
- 执行者不能评审自己；
- 任一必需语义 Criterion 失败时不能 PASS；
- INCONCLUSIVE 不能 PASS；
- Reviewer 冲突进入 ST 仲裁；
- 重试耗尽不能强制通过；
- 最终 Gate 能发现局部 Gate 遗漏的问题。

阶段验收物：faux provider 下完成“机械通过—语义失败—返工—语义通过”的完整闭环。

### 阶段 8：预算、阻塞和用户恢复

代码任务：

1. 实现 Usage 归集；
2. 实现软预算阈值和 ST Decision；
3. 实现 Hard Limit；
4. 实现节点 → ST → 用户 Escalation；
5. 实现 `waiting_user`；
6. 实现带 `escalationId` 的 Resume；
7. 按当前 Pi 实际能力接入 ST 可用的受治理记忆上下文；若无正式接口则保持无额外记忆；
8. 实现错误分类和统一 Failure。

重点测试：

- 软预算超出后 ST 允许继续；
- ST 收缩后续 Reviewer 预算；
- Hard Limit 阻止新节点；
- 缺少信息进入 waiting_user；
- 错误 escalationId 不能恢复；
- 正确回答恢复原阻塞节点；
- ST 只能取得 Pi 治理规则允许的记忆上下文；
- 没有 Pi 记忆接口时，流程仍可正常运行；
- IPD 不产生绕过 Pi 的独立记忆文件或写入；
- 技术失败、质量失败和阻塞走不同路由。

阶段验收物：一个 Run 在中途等待用户回答，跨 Tool 调用恢复并成功完成。

### 阶段 9：IPD Tool Extension

代码任务：

1. 实现 Tool Command Schema；
2. 实现 start/resume/status/cancel；
3. 实现 Extension Adapter；
4. 接入当前 cwd、模型、Skill 列表和 AbortSignal；
5. 实现简洁文本结果和完整 `details`；
6. 增加 Tool 调用级 Idempotency。

重点测试：

- 四类 Action Schema；
- start 缺少 Skill 时 Schema 拒绝；
- 未知 Skill；
- 重复 start；
- status 不改变状态；
- resume 只恢复匹配 Escalation；
- cancel 幂等；
- 外层 Agent 可以根据结构化结果向用户提问或交付 Artifact。

阶段验收物：从普通 Pi Agent 会话中调用 IPD Tool 完成 faux Skill Run。

### 阶段 10：真实 Skill 端到端验收

前置条件：用户把目标 Skill 放入 Pi 可发现的 Skill 路径。首个验收可以使用用户提供的 PPT Skill，但 IPD Package 中不得出现 PPT 专用 Schema、文件名、AgentCard、Workflow 或 CheckExecutor。

ST 根据该 Skill 生成的端到端 Workflow 至少包含：

```text
业务目标分析
  ├─ 可并行执行节点 A
  └─ 可并行执行节点 B
        ↓ 汇聚
中间交付节点
        ↓
最终交付节点
        ↓
最终端到端 Gate
```

验收场景必须覆盖：

1. 至少两个无写冲突节点并行；
2. 每个 Execution Node 都有机械与语义 Gate；
3. 至少一次语义 Gate 失败并返工；
4. 下游只读取通过 Gate 的 Artifact；
5. 最终 Reviewer 查看由 Skill 和 Workflow 定义的实际交付内容，而不是执行者总结；
6. 最终输出 Primary Artifact、Review Bundle 和完整 Run Trace；
7. 能从最终 Slide 反查到生产节点、Reviewer、Criterion 和 Session JSONL；
8. 可选真实模型 Eval 记录 Token、时间、成本和 Gate 结果。

本阶段先运行针对新增测试文件的精确测试，再运行 `npm run check`。除非用户另行要求，不运行完整 `npm test` 或 `npm run build`。

## 17. 测试分层

| 层级 | 是否调用 LLM | 目的 |
|---|---|---|
| Schema/Compiler 单元测试 | 否 | 验证静态不变量 |
| Ledger 单元测试 | 否 | 验证事务、幂等和恢复 |
| Scheduler 单元测试 | 否，FakeNodeRunner | 验证状态机和并发 |
| Agent Adapter 集成测试 | Faux provider | 验证结构化 AgentSession 调用 |
| Gate 集成测试 | Faux provider | 验证机械+语义闭环 |
| Tool 集成测试 | Faux provider | 验证跨调用生命周期 |
| Skill E2E | 先 Faux，后可选真实模型 | 验证完整业务闭环 |
| Comparative Eval | 真实模型，可选 | 对比单 Agent 与 IPD 流程收益 |

不允许基础状态机测试依赖真实 Provider。所有回归测试必须能在无 API Key 环境运行。

## 18. 阶段提交与验收纪律

每个阶段形成独立可审查变更，至少包含：

1. 本阶段代码；
2. 本阶段聚焦测试；
3. Schema 或 Migration 变更说明；
4. 新增状态和事件清单；
5. 已知限制；
6. 一份可定位的验收输出。

实现过程中遵守以下顺序：

```text
Schema
  → Repository
  → State Machine
  → Fake Runner
  → AgentSession Adapter
  → ST
  → Gate
  → Tool
  → Skill E2E
```

不能先写一个自由协作 Demo，再事后补状态和 Gate；否则无法判断 Demo 成功是流程保证还是模型偶然服从。

## 19. V1 明确不做

- 不完成或迁移到 AgentHarness v2；
- 不在线修改冻结 Workflow；
- 不自动覆盖稳定 AgentCard 或 Workflow 资产；
- 不实现分布式队列和多进程 Worker；
- 不建设大型 Dashboard；
- 不做基于主观总分的员工排名；
- 不允许 Reviewer 简单多数投票替代 Criterion；
- 不用重试耗尽代替质量通过；
- 不把模型自报 Progress 当作权威状态；
- 不在 IPD 内实现操作系统安全沙箱；
- 不把任何具体 Skill 或业务领域逻辑硬编码到 Graph Engine。

## 20. V1 完成定义

只有同时满足以下条件，V1 才算完成：

1. `packages/ipd` 的 Schema、Compiler、Ledger、Runtime、ST、Gate、Adapter 和 Tool 均有聚焦测试；
2. 所有 Execution Node 的 Gate 都同时执行机械与语义准出；
3. Graph Engine 是状态唯一写者，Agent 无法直接推进状态；
4. Run 能跨用户交互暂停和恢复；
5. Run 能在进程重启后从 SQLite 读取并恢复到合法稳定状态；
6. 真实 Skill 生成的交付物经过具体内容的语义评审；
7. 至少一次返工路径被完整记录；
8. 最终 Artifact 可以反向追溯到全部输入、Attempt、Gate、Reviewer 和 Session；
9. 无 API Key 的 faux provider 测试稳定通过；
10. `npm run check` 无错误、警告和 info。

完成这些能力后，再评估 Harness v2 Adapter、在线 Workflow Amendment、公开 npm Package、资产推荐、自演进和分布式执行。
