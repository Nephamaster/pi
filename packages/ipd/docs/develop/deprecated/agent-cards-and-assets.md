# AgentCard 与资产管理

AgentCard 是跨 Skill、跨 Workflow 复用的数字员工定义。它描述员工的长期角色边界、专业能力、适用场景、工作原则、提示范式、知识来源、模型规格、Tool、权限和预算，不描述本次任务如何组织。

## 1. 资产边界

```text
AgentCard：谁能做什么、不能做什么
Skill：某类工作的知识和方法
Workflow：本次任务把哪些员工和 Skill 分配到哪些节点
Ledger：本次运行实际发生的事实
```

Workflow 对 AgentCard 的引用只是一次任务分配。Card 文件名和 ID 不应使用 `ppt-*`、`coding-task-*` 等 Skill 或 Workflow 专属命名。

例如：

- `research-synthesist` 可以参与演示、技术报告、政策分析或产品研究；
- `artifact-production-engineer` 可以根据不同 Run Skill 构建 PPTX、文档或其他格式化 Artifact；
- `evidence-reviewer` 可以评审多种实际交付内容。

## 2. 文件位置和格式

默认 Runtime 每次 `start` 重新扫描：

```text
~/.pi/agent/ipd/agent-cards/**/*.{json,yaml,yml}
<cwd>/.pi/ipd/agent-cards/**/*.{json,yaml,yml}
```

项目 Card 仅在 `ExtensionContext.isProjectTrusted()` 为 `true` 时加载。

Loader 会：

1. 递归发现 JSON/YAML 文件；
2. 解析文件；
3. 执行 TypeBox Schema；
4. 应用默认值；
5. 校验 Skill、Tool、模型、Scope 和知识库路径；
6. 计算稳定 Hash；
7. 加入 AgentCard Registry。

任一文件有 Diagnostic 时，本次资产准备失败，不会静默跳过后继续规划。

## 3. AgentCard Schema

```ts
interface AgentCardAsset {
  id: string;
  version?: string;
  name: string;
  description: string;
  responsibilities: string[];
  nonResponsibilities: string[];
  capabilities: string[];
  applicableScenarios?: string[];
  principles?: string[];
  deliverables?: string[];
  promptProfile?: {
    approach: string[];
    communication: string[];
    verification: string[];
  };
  knowledgeBases?: Array<{
    id: string;
    description: string;
    paths?: string[];
  }>;
  model?: AgentCardModel;
  skills?: string[];
  tools?: string[];
  permissions?: AgentCardPermissions;
  defaultBudget?: {
    tokens?: number;
    timeoutMs?: number;
  };
}
```

不允许额外字段。

## 4. 必填字段

### 4.1 Identity

- `id`：字母开头，后续可包含字母、数字、点、下划线和连字符，最大 128 字符；
- `name`：面向人和 Prompt 的角色名称；
- `description`：稳定角色定位，不写本次任务目标；
- `version`：可省略，默认 `1.0.0`，显式值必须是 SemVer。

### 4.2 职责边界

- `responsibilities` 至少一项；
- `nonResponsibilities` 必须存在，但可以是空数组；
- `capabilities` 至少一项。

职责应专精并互斥。例如：

```text
implementation-engineer：实现，不审批自己的实现
verification-engineer：独立验证，不修改产品实现
evidence-reviewer：语义评审，不替生产者返工
```

这些自然语言边界会进入 AgentSession Prompt；生产者与 Reviewer 的实例独立性还会由 Compiler 和 ReviewerSelector 确定性校验。

## 5. 专业行为字段

### 5.1 `applicableScenarios`

描述该角色适合承担的任务形态，供 ST 选人判断。它不是 Skill 名单。

```yaml
applicableScenarios:
  - 代码变更需要独立实现和集成
  - 上游已经提供需求与架构约束
```

### 5.2 `principles`

描述跨任务稳定的工作原则，例如来源优先、最小修改、证据独立、不可审批自身产物。

### 5.3 `deliverables`

描述角色通常能生产的交付类型。真正的本次 Output Contract 仍由 Workflow Node 定义。

### 5.4 `promptProfile`

```yaml
promptProfile:
  approach:
    - 从失败行为和现有调用链定位最小修改点
  communication:
    - 区分已验证事实和推断
  verification:
    - 运行受影响精确测试和静态检查
```

如果提供 `promptProfile`，三个数组都必须至少一项。省略时 Compiled Card 使用空数组，NodeRunner 提供保守默认提示。

这些字段不是装饰元数据；`buildIdentity()` 会把它们写入 Execution 和 Decision AgentSession 的 system prompt，Planner Context 也会获得完整内容。

## 6. Knowledge Base

```yaml
knowledgeBases:
  - id: workspace-implementation
    description: 当前代码、接口、测试和正式设计 Artifact
    paths:
      - .
```

Knowledge Base 当前是权限约束的知识引用，不是独立向量数据库：

- `id` 在单张 Card 中必须唯一；
- `paths` 可省略；
- 路径必须是相对 Workspace Scope；
- 每条路径必须被 Card `permissions.readScopes` 覆盖；
- Workflow Node 必须通过 `knowledgeBaseRefs` 明确启用；
- Node `readScopes` 也必须覆盖其路径；
- AgentSession Prompt 会提供 ID、说明和可读取路径；
- IPD 不自动扫描、向量化或写入这些知识来源。

没有路径的 Knowledge Base 通常表示由 Runtime 提供的 Run Skill、任务和 accepted Artifact 上下文。

## 7. 模型规格

### 7.1 `run_default`

```yaml
model:
  selection: run_default
  thinkingLevel: high
```

使用 `ipd` Tool 调用时 Pi 当前模型。`thinkingLevel: inherit` 继承外层会话；也可以为不同角色固定 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`。

预置员工通过不同 thinking level 表达模型规格差异，但不硬编码用户未配置的 Provider。

### 7.2 `explicit`

```yaml
model:
  selection: explicit
  provider: openai
  id: configured-model-id
  thinkingLevel: medium
```

`provider` 和 `id` 必须同时存在。默认 Runtime 使用 Pi AgentDir 的 `models.json`、`auth.json` 和已注册 Provider；模型不存在或未配置认证时 Card 编译失败。

Card 不保存 API Key。

## 8. Skill

```yaml
skills: []
```

缺省为空。本次 Run Skill 始终可以由 Workflow 分配给能力和权限适合的员工，不需要写入 Card。

`card.skills` 只用于员工长期固有的附加 Skill 授权：

- 必须存在于 Pi 当前加载 Skill 集合；
- Workflow Node 可以分配 Run Skill，或 Card 声明的附加 Skill；
- 不应通过 Skill 名称定义员工身份；
- 当前预置的 12 张通用 Card 均为 `skills: []`。

## 9. Tool

默认：

```yaml
tools:
  - read
```

默认 Runtime 识别：

```text
read bash edit write grep find ls powershell
```

自定义 Tool 必须以 `ToolDefinition` 显式传给 `createDefaultIpdRuntime()`。Card 中声明但 Runtime 未注册的 Tool 会导致资产编译失败。

Workflow Node Tool 必须同时：

- 被 Runtime 注册；
- 被所选 Card 允许；
- 被本次 Node 明确列出。

NodeRunner 实际暴露的是 Card 和 Node 的交集，再加当前结构化提交 Tool。

## 10. Permission

默认：

```yaml
permissions:
  workspace: read
  readScopes:
    - .
  writeScopes: []
  externalActions: false
```

规则：

- `workspace: read` 不能有 write scope；
- `workspace: write` 必须有至少一个 write scope；
- Scope 必须是相对工作区路径，不能使用 `..` 越界；
- Workflow Node 权限必须是 Card 权限的子集；
- Card 允许外部动作不代表本次 Node 自动允许；Node 仍需显式声明。

当前权限由 Schema、Compiler、NodeRunner 配置检查和 Workspace Lock 使用，但不是 OS 级文件沙箱。

## 11. 默认预算

```yaml
defaultBudget:
  tokens: 12000
  timeoutMs: 900000
```

AgentCard Budget 是未声明 Run 预算模式时的独立调用默认值。bounded IPD Run 使用 Workflow/Node 显式预算；unbounded IPD Run 不设置 Token/Timeout，也不会回退到 Card 默认值形成隐含限制。

## 12. 默认值

省略可选字段后的 Compiled Card 默认值：

```yaml
version: 1.0.0
applicableScenarios: []
principles: []
deliverables: []
promptProfile:
  approach: []
  communication: []
  verification: []
knowledgeBases: []
model:
  selection: run_default
  thinkingLevel: inherit
skills: []
tools: [read]
permissions:
  workspace: read
  readScopes: [.] 
  writeScopes: []
  externalActions: false
defaultBudget:
  tokens: 12000
  timeoutMs: 900000
```

## 13. 固定 Staff Core

默认 Runtime 选择全部带 `staff-core` capability 的 Card，并要求其中存在 `workflow-planning`。

当前预置 Core：

| Card | 主要治理 capability |
|---|---|
| `staff-workflow-architect` | `workflow-planning`、`organization-design` |
| `staff-delivery-governor` | `delivery-governance`、`budget-governance` |
| `staff-quality-governor` | `quality-governance`、`risk-governance` |

分派规则：

- Planner：`workflow-planning`；
- 预算 Decision：优先 `budget-governance`；
- blocked Resolution：优先 `delivery-governance`；
- Reviewer 冲突仲裁：优先 `quality-governance`。

Workflow Compiler 要求候选原样保留固定 Core，并禁止 Core Card 作为 Execution Node 生产业务 Artifact。

## 14. Hash、冲突和 Snapshot

AgentCard Hash 来自应用默认值后的规范内容，不包含文件路径。以下变化会改变 Hash：

- 角色、职责和 capability；
- 场景、原则、交付物和 Prompt Profile；
- Knowledge Base；
- 模型、Skill、Tool、权限和预算。

Registry 使用 `id + version` 识别冲突。不同文件定义相同 ID/version 时，无论内容是否相同都返回 `asset_collision`，不会静默决定优先级。

Compiler 返回当前完整 AgentCard Pool；Ledger 冻结该 Pool，而不只保存生产者。这样运行时可以从同一冻结池动态选择 Reviewer，并在恢复时不读取已变化的外部 Card 文件。

Card 文件修改只影响后续 Run；已经冻结的 Run 使用 Ledger Snapshot。

## 15. 新增员工

1. 先确认新职责不能通过已有 capability、Skill 或 Prompt Profile 表达；
2. 使用通用角色名称，不使用具体 Skill/Workflow 前缀；
3. 写清职责和非职责，尤其是生产与审批边界；
4. 配置适用场景、原则、交付物和 Prompt Profile；
5. 配置最小模型规格、Tool、知识来源和权限；
6. 为可写角色限制 write scope；
7. 将文件放入全局或受信任项目 Card 目录；
8. 使用 Asset Loader 测试 Schema、引用和冲突；
9. 如果 Workflow 需要该角色，Node 用 `requiredCapabilities` 表达要求，不按 Card 名称猜测能力。

项目预置示例位于 `.pi/ipd/agent-cards/`。它们是项目资产，不是 `packages/ipd` Core 内置角色。
