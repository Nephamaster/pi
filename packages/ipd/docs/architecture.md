# IPD V1 总体架构

本文描述 `packages/ipd` 当前实现的模块边界、资产关系和调用时序。它解释系统如何工作，不把未来 Harness v2、分布式调度或在线 Workflow 修改写成现有能力。

## 1. 目标与非目标

IPD V1 的目标是把一个当前必须带 Skill 的长程任务转换为可编译、可执行、逐节点验收且可恢复的多 Agent Run。

它重点解决：

- ST 在执行前生成结构化 Workflow；
- 通用数字员工按节点临时组合，而不是归属于某个 Skill；
- 每个业务 Artifact 同时经过机械与语义 Gate；
- Candidate Artifact 在准出前不进入下游；
- 并行、返工、阻塞、预算和取消由确定性 Runtime 控制；
- SQLite 保存可审计状态、事件、决策、用量和 Session 引用。

V1 不负责：

- 改写 Pi 的 Agent Loop；
- 用 Prompt 模拟状态机；
- 在线修改冻结 Workflow；
- 提供 OS 级沙箱；
- 提供分布式队列或跨进程 Agent 接管；
- 自建长期记忆系统；
- 自动选择是否使用 IPD；外层 Pi Agent 决定是否调用 Tool。

## 2. 总体调用关系

```text
外层 Pi Agent
  │
  │ ipd Tool command
  ▼
IpdToolController
  │ 解析 Skill Snapshot、Tool-call 幂等
  ▼
IpdRuntime
  │
  ├─ AssetProvider
  │    ├─ AgentCard Loader
  │    ├─ Fixed Staff Core Selector
  │    └─ Workflow Asset Loader / Store
  │
  ├─ WorkflowPlanner
  │    ├─ ST AgentSession
  │    ├─ Workflow Authoring Guide
  │    ├─ header / Node / Final Gate 分段提交
  │    ├─ finalize_workflow 本地组装
  │    └─ Workflow Compiler
  │
  └─ GraphEngine
       ├─ WorkspaceLockManager
       ├─ Execution AgentSession
       ├─ Artifact Manifest
       ├─ DynamicGateEvaluator
       │    ├─ MechanicalChecker
       │    ├─ ReviewerSelector
       │    ├─ Reviewer AgentSession
       │    └─ CriterionAggregator / Staff arbitration
       ├─ StaffBudgetController
       └─ SQLite Ledger
```

## 3. 模块职责

### 3.1 `ir/`

定义和编译静态资产：

- AgentCard、Workflow、Execution Node、Gate、Budget 和 Artifact Contract Schema；
- Scope 规范化和包含判断；
- AgentCard 编译、默认值和稳定 Hash；
- Workflow 关系、不变量、员工能力、知识库、权限和 DAG 校验；
- 冻结 `CompiledWorkflow`。

`ir/compiler.ts` 当前会使用 `registry/check-registry.ts` 校验机械 Check 参数。因此实际代码不是完全无依赖的纯类型层；Compiler 仍保持无模型、无文件写入和无运行状态修改。

### 3.2 `registry/`

负责定义资产集合和运行时插件集合：

- AgentCard Registry；
- Workflow Asset Registry 和不可覆盖文件 Store；
- Check Definition / CheckExecutor Registry；
- ArtifactView Registry；
- JSON、YAML 文件发现、解析、冲突诊断和编译。

Registry 不推进 Run 状态。

### 3.3 `ledger/`

SQLite Ledger 是运行事实源：

- 执行 Migration；
- 对 Run、Workflow Snapshot、AgentCard Snapshot、Attempt、Artifact、Gate、Reviewer、Criterion、Decision、Escalation、Budget 和 Event 提供事务 API；
- 校验状态转换；
- 对每个写操作执行幂等检查；
- 重建 `RunSnapshot`；
- 验证事件序列和状态关系一致性。

业务 Agent 不能直接访问 Ledger。当前可信写入方包括：

- `WorkflowPlanner`：创建 Run、进入 compiling、冻结 Workflow、记录规划 Decision；
- `GraphEngine`：执行期 Node、Artifact、Gate、Reviewer、Escalation 和 Run 状态；
- `StaffBudgetController`：预算事件、预算 Decision、等待或失败；
- Tool/Extension Adapter 不直接写状态。

因此当前准确边界是：**Ledger Repository 是唯一状态写入接口；GraphEngine 是执行期 Node/Gate 调度者；模型 Agent 只有结构化提交权。**

### 3.4 `staff/`

负责治理类 Decision：

- `workflow-authoring-guide.ts`：版本化 ST Workflow 编写规则；
- `workflow-planner.ts`：调用固定 Staff Core 中的 planning 成员，生成和修订 Workflow；
- `reviewer-selector.ts`：按 capability 和独立性选择 Reviewer。

默认 Runtime 在规划前固定全部带 `staff-core` capability 的 AgentCard，并要求其中存在 `workflow-planning` 成员。Workflow 候选不能替换这组 Core。

### 3.5 `artifact/`

负责业务文件的可信表示：

- 将结构化 `ArtifactSubmission` 转换为带真实路径、大小和 SHA-256 的 `ArtifactManifest`；
- 验证 Manifest 与当前文件和 Artifact Contract 一致；
- 从 Artifact 文件及其 View 生成模型可读取的 `ReviewBundle`；
- 为文本、JSON、图片和不支持的 MIME 生成不同 Review Material。

Artifact 文件仍位于工作区，Ledger 只保存 Manifest 和 Hash。

### 3.6 `gate/`

负责准出判断：

- 先执行机械 Criterion；
- 机械全部通过后构造实际 Review Bundle；
- 排除生产者并选择独立 Reviewer；
- 调用 Reviewer AgentSession；
- 按 required Criterion 聚合，不做多数投票批准；
- 冲突或 INCONCLUSIVE 时调用固定 Staff Core 中的质量治理成员仲裁。

Gate 不修改业务文件。

### 3.7 `runtime/`

`IpdRuntime` 是高层门面：

- start 前加载资产；
- 根据 `ifBudget` 构造显式 unbounded 或 bounded 预算；
- 调用 Planner；
- Planner 成功后调用 GraphEngine；
- 将 Ledger Snapshot 转换为 Tool Result。

`GraphEngine` 负责：

- Ready Attempt 计算；
- fan-out/fan-in；
- Workspace Lock；
- 为每个有界写范围创建隔离 Attempt Workspace，返工从上一 Attempt 的工作副本继续；
- Execution Node 调用；
- Candidate Artifact 登记；
- 局部 Gate 和 Final Gate；
- 技术重试、质量返工、阻塞升级、恢复和取消；
- Execution、Reviewer 和 Staff Usage 登记。

Gate 在 Attempt Workspace 中读取 Candidate；只有 PASS 后，Manifest 文件才发布到当前 Run 的共享 `workspace/` 和 `accepted/`。失败、超时和取消 Attempt 保留在 `.pi/ipd/runs/<run-id>/work/`，不进入下游；Final Gate PASS 后最终文件发布到同一 Run 的 `final/`。项目既有 `outputs/` 不复制进新 Run。

### 3.8 `adapter/`

这是当前唯一允许直接依赖 `@earendil-works/pi-coding-agent` 的运行适配层，主要负责：

- `ModelRuntime` 和 Pi Provider 接入；
- 每次 Attempt/Decision 创建独立 AgentSession；
- 关闭自动 Extension、Skill、Prompt、Theme 和 Context 加载；
- 注入冻结 Skill、AgentCard、Node、Gate 和正式 Artifact；
- 约束 Tool 集合；
- 对 PDF 使用 `pdftotext` 可读视图，并阻止 Office/ZIP/BIN 原始字节进入文本上下文；
- 对 Execution Session 执行累计生成 Token、Tool Call 和 80%/90% 收口保护；
- 捕获 Artifact、Workflow 分段、Review 和 Staff Decision 的结构化提交；
- 返回 Session、Usage、Timeout 和 Failure Trace；
- 装配默认 Ledger、Planner、GraphEngine、Gate 和 BudgetController。

Harness v2 尚未接入；未来应新增 NodeRunner Adapter，而不是修改 Workflow IR 和 Ledger 协议。

### 3.9 `tool/` 与 `examples/ipd-extension.ts`

`tool/` 提供：

- 五类模型 Tool Command Schema 与用户专用 Resume Command；
- Tool-call ID 进程内幂等；
- Skill 文件读取和 Snapshot；
- 模型 Tool 的 start/resume_run/status/watch/cancel 分发，以及用户专用 `/ipd-resume` Command；
- `IpdToolResult` 类型。

`examples/ipd-extension.ts` 负责 Pi Extension API 适配。它缓存 `before_agent_start` 提供的 Skill 列表，并把 cwd、当前模型、thinking level、项目可信状态和 AbortSignal 传给 Controller。

该 Extension 当前仍是源码仓示例，不是 npm 安装后的自动发现组件。

## 4. 资产和实例的所有权

| 对象 | 定义者 | 生命周期 | 是否可在 Run 中修改 |
|---|---|---|---|
| Skill | Pi Skill 资产 | 独立于 IPD | 启动后使用 Snapshot，不读取后续修改 |
| AgentCard | 用户/项目资产 | 跨 Run 复用 | 不可；Run 冻结当前完整 Card Pool Snapshot |
| Fixed Staff Core | Runtime 从 `staff-core` Card 中确定 | 每次 start 前重新解析，Workflow 内冻结 | ST 不能替换 |
| Workflow Asset | 人工模板或 ST 生成 | 跨 Run 复用 | 文件不可覆盖；内容变化必须升版本 |
| Workflow Snapshot | Planner + Compiler | 单 Run、多 revision | 单个 revision 不可修改；受控 Amendment 只追加新 revision |
| Node Attempt | GraphEngine | 单 Run、单次尝试 | 只能按状态机迁移 |
| AgentSession | NodeRunner | 单 Attempt 或 Decision | Session 自身不是真相源 |
| Artifact | Execution Attempt | 单 Run | Manifest 登记后只改变 candidate/accepted/rejected 状态 |
| Gate Run | GraphEngine | 单 Attempt 或 Final Gate | 标准来自冻结 Workflow，不能临时变化 |
| Ledger Event | Ledger | 单 Run、不可变 | 不可修改，只追加 |

AgentCard 与 Skill 不存在永久归属关系。Workflow 中的 `agentCardRef`、`skills`、`requiredCapabilities` 和 `knowledgeBaseRefs` 只表达本次节点分配。

## 5. `ipd.start` 时序

```text
外层 Agent
  │ start(task, skillName, budget...)
  ▼
Extension
  │ 使用 before_agent_start 缓存的 Skill 元数据
  ▼
IpdToolController
  │ 读取 Skill 文件并生成 content Hash
  │ 同一 toolCallId + 相同参数返回同一 Promise
  ▼
IpdRuntime.start
  │ 校验软预算和 Hard Limit 关系
  │ 生成 runId / traceId
  ▼
AssetProvider.prepare
  │ 扫描全局 Card + 受信任项目 Card
  │ 编译完整 AgentCard Pool
  │ 固定 Staff Core 和 Planner Card
  │ 读取 Workflow Assets
  ▼
WorkflowPlanner.planAndFreeze
  │ Ledger: planning → compiling
  │ Planner AgentSession 读取 Skill、员工池、固定 Core、模板和手册
  │ submit_workflow_header → submit_workflow_acceptance × N
  │ submit_workflow_node + submit_workflow_node_gate × N
  │ submit_workflow_final → finalize_workflow
  │ Runtime 组装完整 WorkflowDefinition
  │ Compiler 校验
  │ 失败：记录候选和 Diagnostic，有限修订
  │ 成功：保存 Workflow Asset，Ledger 冻结 Workflow/Card Snapshot
  ▼
GraphEngine.run
  │ ready → running
  │ 调度 Ready Attempts
  │ Execution → Candidate → Gate → Accepted/Rework/Blocked
  │ 所有 Node succeeded → Final Gate
  │ Final PASS → Run succeeded
  ▼
IpdRuntime.result
  │ 汇总 accepted Artifacts、Question、Failure 和 Usage
  ▼
外层 Agent
```

Skill 或 AgentCard 解析失败发生在 Planner 创建 Run 之前，不会留下半创建 Run。Planner 开始后发生的失败会进入 Ledger。

## 6. 用户 `/ipd-resume` 时序

```text
/ipd-resume runId escalationId
  → Pi UI 采集回答并二次确认
  → Controller.resumeAsUser(runId, escalationId, answer)
  → Controller 重新读取当前可用 Skill 文件
  → Runtime 查找 Run 冻结的 skill name + hash
  → Skill Snapshot 不存在或 Hash 改变：拒绝恢复
  → GraphEngine 要求 Run == waiting_user
  → 查找相同 runId 下 status=open 的精确 escalationId
  → Ledger 回答 Escalation
  → 若关联 Node，记录 user_answer / retry_node Decision
  → waiting_user → running
  → 从原阻塞 Node 创建下一 Attempt
```

错误 Escalation ID、关闭的 Escalation、空回答或非 waiting Run 都不会恢复任务。

## 7. `status` 时序

```text
status(runId, detail)
  → 读取 RunSnapshot
  → 不创建 Event，不改变状态
  → summary：Run + Escalation 摘要
  → nodes：增加 Node 与 Gate
  → full：返回完整 Snapshot
```

公开状态把 `planning`、`compiling`、`ready` 和 `running` 统一映射为 `running`；完整 Ledger Snapshot 仍保留内部状态。

## 8. `cancel` 时序

活动 Run：

```text
cancel
  → abort GraphEngine AbortController
  → NodeRunner.abort(active Attempt)
  → GateEvaluator.abort(active Reviewer)
  → 活动 Node → cancelled
  → Run → cancelled
```

非活动但非终态 Run 由 GraphEngine 直接写入 cancelled。对 succeeded、failed、cancelled Run 重复调用返回原终态。

## 9. 关键源码入口

| 行为 | 文件 |
|---|---|
| Schema | `src/ir/schemas.ts` |
| AgentCard 编译 | `src/ir/agent-card.ts` |
| Workflow Compiler | `src/ir/compiler.ts` |
| ST 编写手册 | `src/staff/workflow-authoring-guide.ts` |
| ST Planner | `src/staff/workflow-planner.ts` |
| 高层 Runtime | `src/runtime/ipd-runtime.ts` |
| 执行调度 | `src/runtime/graph-engine.ts` |
| Workspace Lock | `src/runtime/workspace-locks.ts` |
| Dynamic Gate | `src/gate/dynamic-gate-evaluator.ts` |
| SQLite Ledger | `src/ledger/sqlite-ledger.ts` |
| AgentSession Adapter | `src/adapter/agent-session-node-runner.ts` |
| 默认装配 | `src/adapter/default-ipd-runtime.ts` |
| Tool Controller | `src/tool/ipd-tool-controller.ts` |
| Pi Extension 示例 | `examples/ipd-extension.ts` |

## 10. 当前架构限制

- Extension 仍需源码方式显式加载；
- AgentSession 是唯一 NodeRunner 实现；
- Tool-call 幂等缓存不跨进程；
- Review Bundle 在 Gate 运行时生成，但未作为独立 Ledger 对象保存；
- AgentCard knowledge base 是受权限约束的引用，IPD 没有独立向量检索服务；
- Workspace Scope 不等于 OS 沙箱；
- Planner、BudgetController 和 GraphEngine 都是可信 Runtime 写入方，当前没有单一 GraphEngine 命令总线。
