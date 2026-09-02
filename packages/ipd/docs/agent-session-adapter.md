# AgentSession Adapter

IPD V1 通过 `NodeRunner` 接口隔离流程运行时与 Pi Agent 实现。当前唯一实现是 `AgentSessionNodeRunner`；GraphEngine、Gate 和 Ledger 不读取 AgentSession 内部状态。

## 1. NodeRunner 协议

```ts
interface NodeRunner {
  runExecutionNode(input: ExecutionNodeRunInput): Promise<ExecutionNodeRunResult>;
  runDecisionNode(input: DecisionNodeRunInput): Promise<DecisionNodeRunResult>;
  abort(instanceId: string): Promise<void>;
}
```

GraphEngine 只依赖：

- 成功的结构化 Submission；
- 结构化 Failure；
- NodeRunTrace；
- abort 能力。

它不依赖消息数组、模型事件或 Pi TUI。

## 2. 为什么每次调用使用独立 AgentSession

每个以下实例都会创建独立 Session：

- Workflow Planner revision；
- Execution Node Attempt；
- Dynamic Reviewer；
- Gate Staff arbitration；
- Budget Staff Decision；
- Blocked Staff Decision。

目的：

- 并行节点不共享候选 Artifact 和未批准上下文；
- Reviewer 不继承生产者对话；
- Attempt 重试有独立 Session Trace；
- Usage、Timeout、Abort 和工具集合按实例记录；
- 进程恢复可以放弃中断 Session，并从完整 Attempt 重放。

V1 不维护持续 Staff 群聊。

## 3. Session 创建

`runStructured()` 每次：

1. 解析 AgentCard 模型；
2. 应用 Token Budget；
3. 创建 in-memory SettingsManager，`projectTrusted: false`；
4. 调用 `createAgentSessionServices()`；
5. 创建独立 `SessionManager`；
6. 计算有效 Tool；
7. 加入当前结构化提交 Tool；Planner 加入七类分段组装 Tool；
8. 创建 AgentSession；
9. 执行一次 Prompt，等待 Tool/模型循环结束；
10. 校验一次最终结构化提交；Planner 在此之前可以提交和替换多个分段；
11. 提取 Session Stats；
12. dispose Session。

默认 Session 文件目录：

```text
${agentDir}/ipd/sessions/
```

## 4. 资源隔离

创建 Services 时设置：

```text
noExtensions: true
noSkills: true
noPromptTemplates: true
noThemes: true
noContextFiles: true
```

所以节点不会自动继承：

- 外层 Extension；
- Pi 自动发现 Skill；
- Prompt Template；
- Theme；
- AGENTS.md/项目 Context；
- 外层完整对话。

IPD 显式注入冻结 Skill 内容和节点所需事实。

## 5. Prompt 组成

所有 AgentSession system prompt 包含 AgentCard：

- 角色 description；
- applicable scenarios；
- responsibilities / non-responsibilities；
- principles；
- deliverables；
- promptProfile approach/communication/verification；
- knowledge base ID、描述和路径；
- 节点权限边界；
- 完整 Skill Snapshot。

Execution user prompt 增加：

- Run ID、Workflow Hash 和任务；
- Node ID、Objective；
- Output Contract；
- Gate Criteria；
- accepted Input Manifest；
- rework instructions。

Reviewer prompt 增加实际 Review Material；Staff prompt 增加 allowedActions 和 Control Context；Planner 额外注入版本化 Workflow Authoring Guide。

## 6. Skill Snapshot

```ts
interface SkillSnapshot {
  name: string;
  path: string;
  baseDir: string;
  content: string;
  hash: string;
}
```

Controller 读取 Skill 文件并对 content 做 SHA-256。NodeRunner 每次调用前重新计算并比较 Hash，防止伪造 Snapshot。

Execution Node 只接收 `node.skills` 中实际分配的 Snapshot：

- 每个 Node Skill 必须存在；
- 不能额外注入 Node 未分配的 Skill；
- 当前 Run Skill 独立于 AgentCard，可分配给任何合适员工；
- Card 的附加 Skill 只有在 Workflow Node 明确分配并且 Runtime 有 Snapshot 时才可用。

当前 Planner、Reviewer 和 Staff Decision 只注入 Run Skill，不自动加载 Card 的附加 Skill。

## 7. 模型选择

### 7.1 `run_default`

```yaml
model:
  selection: run_default
  thinkingLevel: inherit
```

NodeRunner 直接使用 Tool 调用上下文传入的 Pi 当前 `Model<Api>`。thinking level 为 inherit 时使用外层当前值。

### 7.2 `explicit`

```yaml
model:
  selection: explicit
  provider: configured-provider
  id: configured-model
  thinkingLevel: high
```

NodeRunner 调用自己的 ModelRuntime `getModel(provider, id)`。Card Asset Loader 已要求模型存在且 Provider 配置认证；运行时再次找不到则返回 configuration_error。

### 7.3 默认 ModelRuntime 装配

`createDefaultIpdRuntime()` 创建隔离 ModelRuntime：

- `authPath = ${agentDir}/auth.json`；
- `modelsPath = ${agentDir}/models.json`；
- create/refresh 不允许网络模型目录更新；
- 同步外层 ModelRegistry 已注册的 Native Provider 和 Provider Config。

它不读取或复制 API Key 到 AgentCard、Workflow 或 Ledger。

## 8. Tool 集合

Execution 有效 Tool：

```text
AgentCard.tools ∩ Node.tools
+ submit_artifact
```

Decision 有效 Tool：

```text
AgentCard.tools
+ 对应提交 Tool
```

内置名称：

```text
read bash edit write grep find ls powershell
```

其他名称必须通过 `AgentSessionNodeRunnerOptions.customTools` 提供实际 ToolDefinition。只在 Card 写名字但没有定义会返回 configuration_error。

Submission Tool 不由 AgentCard 预先声明；NodeRunner 按运行类型强制加入。

## 9. 结构化提交

| 类型 | Tool | 结果 |
|---|---|---|
| Execution | `submit_artifact` | 文件、摘要、metadata |
| Workflow Planner | `submit_workflow_header` | Workflow ID、版本、名称、目标和来源；Skill、预算和固定 Staff 由 Runtime 注入 |
| Workflow Planner | `submit_workflow_acceptance` | 单条最终验收 Criterion，可按 ID 替换 |
| Workflow Planner | `submit_workflow_node` | 单个 Execution Node Core；`kind` 和 Run Skill 由 Runtime 注入 |
| Workflow Planner | `remove_workflow_node` | 从预载模板或上一版候选中删除过时 Node 及其 Gate |
| Workflow Planner | `submit_workflow_node_gate` | 单个 Node 的完整 Gate，可按 Node ID 替换 |
| Workflow Planner | `submit_workflow_final` | Final Artifact 节点和 Final Gate，可替换 |
| Workflow Planner | `finalize_workflow` | 本地组装并验证完整 WorkflowDefinition |
| Reviewer | `submit_review` | Decision、逐 Criterion 证据和返工 |
| Staff | `submit_decision` | allowed action、rationale、evidence |

Execution、Reviewer 和 Staff 使用 `SingleSubmission`，要求恰好一次合法调用。Planner 使用 `WorkflowSubmissionBuilder`：

- 不再让模型一次生成整个深层 Workflow；
- Header、Acceptance、Node Core、Node Gate 和 Final Gate 分开接受；
- 显式模板和 Compiler 上一版候选会预载到 Builder，修订只需替换诊断片段；
- 过时的预载 Node 可显式删除；Builder 同时删除对应 Gate，其余依赖、输入、路由和 Final Artifact 引用仍由 ST 修订并交给 Compiler 校验；
- 机械 Check 的 `parametersJson` 在 Runtime 中解析，并按实际 Check Schema 校验；
- 所有分段组装后再用正式 `WorkflowDefinitionSchema` 验证；
- `finalize_workflow` 成功后才把候选交给 Compiler；
- Tool Schema 校验错误会作为 Tool Result 返回给模型，模型可以按缺失、多余或非法字段修正对应分段；
- 结构化提交按 Assistant Turn 计数：同一轮批量调用即使有多个错误也只算一次失败；连续 3 个提交轮次失败才中止 Session，任一全成功提交轮次会清零计数；
- Planner 整个 Session 最多允许 64 次 Tool Call。

通用失败规则：

- 0 次 → `missing_submission`；
- 多次、参数 Schema 失败或无有效值 → `invalid_submission`；
- 自然语言“已完成”不算成功；
- Staff action 不在 allowedActions 时拒绝。

## 10. Execution 配置防御校验

即使 Workflow 已由 Compiler 校验，NodeRunner 仍检查：

- Node AgentCardRef 等于提供的 Card Snapshot；
- requiredCapabilities 存在于 Card；
- knowledgeBaseRefs 属于 Card，Node read scope 覆盖路径；
- Node Tool 被 Card 允许；
- workspace、read/write scope 和 external action 不超过 Card；
- Node Skill Snapshot 精确匹配分配。

这些检查用于防止自定义 Runtime 直接调用 NodeRunner 时绕过 Compiler。

注意：当前 Pi 内置文件 Tool 本身没有接收 IPD Scope 作为 OS 强制参数。权限同时依赖 Compiler、Prompt、Workspace Lock 和 Tool 配置，不等价于文件系统沙箱。

## 11. Token Budget

CommonRunInput 可带 `tokenBudget`。NodeRunner 不修改注册模型对象，而是创建浅副本：

```text
selected.maxTokens = min(model.maxTokens, tokenBudget)
```

使用位置：

- Execution：Node `budget.tokens`；
- Planner：`globalBudget.staffTokens`；
- Budget Staff：`staffTokens`；
- Blocked Staff：`staffTokens`；
- Reviewer：BudgetController 收缩后的 reviewer budget；没有收缩 Decision 时不覆盖模型 `maxTokens`。

Token Budget 同时限制单次模型输出和整个 Planner/Execution Session 的累计生成 Token；超过时返回 `budget_exceeded`。Execution 在 80%/90% Token 或时间阈值收到收口指令，默认最多 96 次 Tool Call，超过返回 `tool_limit_exceeded`。Planner 上限仍为 64 次 Tool Call。输入、Cache Read 和 Cache Write 按真实 Session Stats 计量，因此总 Provider Usage 仍可能高于生成 Token Budget。

`agentCard.defaultBudget.tokens` 当前作为员工资产信息交给 ST 参考，但 NodeRunner 不会自动使用它覆盖 Execution/Decision Token 上限；实际调用以 Workflow/Controller 显式传入预算为准。

## 12. Timeout

优先级：

```text
input.timeoutMs
  ?? agentCard.defaultBudget.timeoutMs
```

Timeout 到达时：

1. 标记 timedOut；
2. 调用 `session.abort()`；
3. 等待 Prompt 返回；
4. 返回 `failure.code = timeout`；
5. 保留已产生 Session Trace 和 Usage。

Execution Graph 传入 Node `budget.timeoutMs`。Decision 通常使用 Card 默认 Timeout。

Gate Reviewer 和 Gate Staff Arbitration 由 GraphEngine 显式传入 Gate 所属预算周期：Node Gate 使用对应 Node 的 `budget.timeoutMs`，Final Gate 使用 Workflow 的 `globalBudget.timeoutMs`。只有直接调用 GateEvaluator 且未提供该值时，才回退到 Reviewer/Staff AgentCard 的默认 Timeout。

Execution 在 80% 和 90% Deadline 通过 Session steering 提醒停止扩展、保留当前工作并调用 `submit_artifact`；100% 才执行硬 abort。

### 12.1 IPD 安全 Read

IPD Session 用同名 Tool 覆盖 Pi 原生 `read`：普通文本和图片仍委托原实现；PDF 通过本机 `pdftotext -layout` 转成有行数上限的文本；PPTX/DOCX/XLSX/ZIP/BIN 拒绝原始文本读取，要求使用 Skill 转换器或 Artifact View。

## 13. Abort

外部 AbortSignal：

- 调用开始前已经 aborted：不发送 Prompt；
- 运行中 aborted：调用 session.abort；
- `NodeRunner.abort(instanceId)`：查找 active Session、abort 并 `waitForIdle()`；
- 返回 `failure.code = aborted`。

GraphEngine cancel 会对全部 active Attempt 和 Gate Reviewer 调用 abort。

## 14. NodeRunTrace 与 Usage

```ts
interface NodeRunTrace {
  runId: string;
  instanceId: string;
  sessionId?: string;
  sessionFile?: string;
  provider: string;
  model: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    costUsd: number;
    toolCalls: number;
  };
}
```

数据来自 `session.getSessionStats()`。配置阶段在 Session 创建前失败时返回零 Usage 的 empty trace。

GraphEngine/Planner/BudgetController 把 Trace 写入 budget_usage；Session JSONL 用于模型和 Tool 级追溯。

## 15. Failure 映射

NodeRunner 直接返回：

```text
configuration_error
auth_error
provider_error
blocked
missing_submission
invalid_submission
budget_exceeded
timeout
aborted
```

捕获异常时使用简单消息匹配识别 auth/api key/login，其余创建阶段异常通常是 configuration_error，模型调用异常通常是 provider_error。

GraphEngine 再把这些代码转换为统一 IpdFailure Category 和 retryable。

## 16. Faux Provider 与真实 Provider

普通回归测试使用 `fauxProvider()`：

- 不访问网络；
- 不需要 API Key；
- 响应和 Tool Call 由测试预置；
- Usage 是模拟统计；
- cost 为 0。

真实 `ipd.start` 使用 Pi 当前或 Card explicit 模型，会创建多个 AgentSession 并真实消耗 Provider Token/费用。不得把 Stage 测试中的 faux Usage 当成实际账单，但它能暴露 Prompt 规模和调用数量。

## 17. Harness v2 适配边界

未来 Harness v2 应实现同一个 NodeRunner：

- 保持 Execution/Decision 输入结构；
- 保持 Artifact、分段 Workflow、Review 和 Staff Decision Submission；
- 返回相同 Failure 和 Trace；
- 支持 abort；
- 不直接写 Ledger；
- 不改变 Workflow IR、Gate、Budget 和 GraphEngine。

需要替换的是 `adapter/` 装配，不是业务状态机。

## 18. 对应测试

- `test/agent-session-node-runner.test.ts`：Tool 约束、Prompt、Submission、模型、Timeout、Abort；
- `test/workflow-planner.test.ts`：Planner Skill、Authoring Guide 和修订；
- `test/dynamic-gate-evaluator.test.ts`：Reviewer/Staff Decision；
- `test/ipd-extension-e2e.test.ts`：Extension 上下文、AbortSignal 和 faux 完整 Run。
