# Agency-Agents 可借鉴设计分析

> 面向 IPD 风格的多智能体长程任务范式  
> 分析基线：`msitarzewski/agency-agents` `main` 分支，提交 `ebe9c99`（2026-08-06）；2026-08-23 核对远端无更新。

## 1. 核心结论

Agency-Agents 的主体不是多智能体运行时，而是一套**可移植的专业角色库 + 流程作业手册 + 安装/格式转换工具**。其价值不在于已经解决了自动编排，而在于它把现实组织中的“专业分工”和“作业流程”沉淀成了结构化文本资产。

对我们最值得学习的是：

1. 用统一骨架定义专业 Agent，让角色成为可管理、可组合的资产；
2. 将长程任务分成阶段、并行工作流、汇聚点和质量门；
3. 用标准交接包传递上下文，而不是让下游 Agent 从零猜测；
4. 将执行者与验证者分离，用证据、有限重试和升级机制控制误差；
5. 以单一真实源和自动校验管理大规模角色及流程资产。

但不应直接复制它的长提示词、庞大角色数量和偏见化评审话术。我们需要把其“软性作业手册”提炼为**可编译的流程 IR、可校验的 AgentCard 和有状态的执行引擎**。

## 2. 项目实际构成

当前仓库共有 343 个受版本控制文件，其中 316 个是 Markdown；按前置元数据识别，共有 270 份 Agent 定义，分布在 17 个领域。Agent 文件平均约 268 行，说明其主要资产形态是“长文本角色说明书”。

| 层次 | 代表内容 | 实际作用 |
|---|---|---|
| 角色资产层 | 17 个 division 下的 Agent Markdown | 定义人格、职责、规则、交付物、工作流和成功指标 |
| 组织流程层 | `strategy/` 下的 NEXUS | 定义 7 阶段产品流程、质量门、交接模板和场景 Runbook |
| 机器可读索引 | `divisions.json`、`tools.json`、`strategy/runbooks.json` | 维护分类、工具安装目标和场景团队名单 |
| 工程辅助层 | 转换、安装、lint 和一致性检查脚本 | 把同一份角色源转换到 Claude Code、Codex、Gemini CLI 等工具 |

因此，仓库中的“源码”主要保证**资产安装、格式转换和静态一致性**，不负责真正的 DAG 调度、节点状态持久化、并发控制、资源配额或事务回滚。[README](https://github.com/msitarzewski/agency-agents/blob/ebe9c99acb5c96f9468de368d8bead775387d1a7/README.md) 也将项目定位为可浏览、复制、转换和安装的专家角色集合。

## 3. 可直接学习的设计

### 3.1 将角色定义从“一段 prompt”升级为可复用资产

Agency-Agents 的[统一角色模板](https://github.com/msitarzewski/agency-agents/blob/ebe9c99acb5c96f9468de368d8bead775387d1a7/CONTRIBUTING.md#agent-file-structure)包含两类信息：

- **Persona**：Identity & Memory、Communication Style、Critical Rules；
- **Operations**：Core Mission、Deliverables、Workflow、Success Metrics、Advanced Capabilities。

这种分组与我们的极简 Agent 理念相容：Persona 可进入 Static Frame，Operations 则应成为可按需检索的 Skill/角色能力描述，不必全部常驻 system prompt。

可将其抽象为我们的 AgentCard，但需补全运行时字段：

```yaml
agent_card:
  id: backend_architect
  version: 1.0.0
  responsibility: 系统方案和接口契约
  non_responsibilities: [产品优先级决策, 独立验收]
  input_schema: ArchitectureRequest
  output_schema: ArchitecturePackage
  model_profile: reasoning_high
  tools: [repo_read, diagram, docs_search]
  knowledge_bases: [architecture_standards]
  permissions: {write_scope: project_docs, external_action: false}
  budget: {tokens: 30000, timeout_s: 1800}
  evaluator: architecture_reviewer
  metrics: [schema_pass_rate, first_pass_gate_rate, defect_escape_rate]
```

**关键经验**：角色的价值不在于“人格写得像不像”，而在于职责边界、输入输出、权限和评价标准是否能被调度器理解。

### 3.2 流程资产分层：模式、Playbook 与 Runbook

[NEXUS](https://github.com/msitarzewski/agency-agents/blob/ebe9c99acb5c96f9468de368d8bead775387d1a7/strategy/nexus-strategy.md) 有三种尺寸：Full、Sprint 和 Micro；另用 Runbook 表达 Startup MVP、Enterprise Feature、Marketing Campaign 和 Incident Response 等场景。这与 IPD 中“重大任务走全流程、常规任务裁剪阶段、特殊任务使用专用模板”的思路一致。

我们可采用三层模型：

```text
Process Family（产品开发/版本演进/定制交付/技术预研）
  └─ Process Profile（完整/裁剪/快速）
       └─ Scenario Runbook（具体场景的节点、角色和参数）
```

不同之处在于：我们的流程选择应由任务类型、风险、不确定性、可逆性和验收成本决定，不应只用“Agent 数量 + 预估周期”分档。

### 3.3 阶段 Playbook 已具备“流程 IR”的雏形

NEXUS 的[7 个阶段 Playbook](https://github.com/msitarzewski/agency-agents/tree/ebe9c99acb5c96f9468de368d8bead775387d1a7/strategy/playbooks)普遍包含：

- Objective 与 Pre-Conditions；
- 活跃 Agent、输入、交付物和时间；
- 顺序步骤、并行 Wave/Workstream 和 Convergence Point；
- Quality Gate Checklist、Gate Keeper 与 Gate Decision；
- 传递到下一阶段的 Handoff Package；
- 驳回后返回开发阶段或架构阶段的路径。

这些字段可直接成为我们节点 IR 的参考，但还应补充结构化 schema、产物 URI、准入/准出表达式、超时、幂等键、重试策略和可执行的路由条件。

### 3.4 用结构化交接阻断上下文损失

[Handoff Templates](https://github.com/msitarzewski/agency-agents/blob/ebe9c99acb5c96f9468de368d8bead775387d1a7/strategy/coordination/handoff-templates.md) 的标准交接包包括：

- From/To、Phase、Task ID、优先级和时间戳；
- 已完成状态、相关文件、依赖和约束；
- 明确交付请求和可勾选验收标准；
- 质量要求、必需证据、下一接收者及格式。

其核心启发是：**Agent 之间不应传递整段对话，而应传递有类型、可校验、可定位原始产物的交接包。**

建议将交接拆为两部分：

- **Control Envelope**：任务 ID、流程版本、节点、路由、预算、权限和超时；
- **Artifact Manifest**：产物 URI、schema、版本、生成者、校验结果和证据。

### 3.5 将质量控制从终态检查改为阶段闭环

NEXUS 的 Build 阶段使用 **Developer ↔ Evidence Collector** 闭环，每个任务先验证再流转；失败时返回具体问题、证据和修复指令，最多重试 3 次后升级。Hardening 阶段再由 Reality Checker 执行端到端裁决。

对我们的意义是：

- 开发与验证角色分离，避免自证正确；
- 验收标准在节点启动前固化；
- 评审输出不只是 PASS/FAIL，还要包含指标、证据、失败原因和下一路由；
- 设置重试上限，避免评估-修改死循环；
- 局部闭环后仍需端到端评审，避免“各节点都对，整体仍错”。

### 3.6 按节点选择协作拓扑，而不是全局只用一种编排模式

仓库新增的 [Multi-Agent Systems Architect](https://github.com/msitarzewski/agency-agents/blob/ebe9c99acb5c96f9468de368d8bead775387d1a7/engineering/engineering-multi-agent-systems-architect.md) 区分了顺序链、并行扇出/扇入、层级式编排、评估-优化闭环和对等网状五种拓扑，并明确指出 Mesh 的循环依赖、共识死锁和上下文膨胀风险。

对 IPD 流程最合理的用法不是二选一，而是组合：

```text
顶层：阶段状态机 + 质量门
阶段内：层级式 Orchestrator 负责分解和调度
可独立任务：并行扇出/扇入
可度量产物：生成者-评估者闭环
需专家协商时：限轮次、有主持者的 Mesh
```

即：**流程骨架是显式的，节点内部的执行拓扑可由条件选择。**

### 3.7 把多智能体当作分布式系统治理

Multi-Agent Systems Architect 还系统给出了若干值得纳入后续版本的规则：

- 用结构化状态对象代替无限追加对话；
- 中间产物进外部存储，Agent 只按需检索；
- 在里程碑生成 checkpoint，失败时从最近合法状态续跑；
- 区分硬失败、静默失败、部分失败、级联失败、循环失败和上下文失败；
- 可重试外部操作必须幂等，非幂等操作必须定义补偿动作；
- 工具和数据遵循最小权限；
- 每次 Agent 调用共享 `trace_id`，记录输入、输出、成本、耗时和状态；
- 同时建立 Agent 级和 Pipeline 级评测，关注端到端正确率、失败恢复、成本、延迟和升级率。

这些内容目前仍是**角色指令中的设计知识**，并非 Agency-Agents 仓库已实现的基础设施；但它们可以成为我们的运行时需求清单。

### 3.8 用单一真实源管理资产，再编译到不同运行时

Agency-Agents 用 `divisions.json` 维护组织分类，用 `tools.json` 维护平台安装契约，用 [`runbooks.json`](https://github.com/msitarzewski/agency-agents/blob/ebe9c99acb5c96f9468de368d8bead775387d1a7/strategy/runbooks.json) 维护场景团队名单，再由 CI 检查文档、slug 和目录是否一致。同一角色源可转成 Markdown、TOML、YAML、SKILL 或工作区文件。

可借鉴为：

```text
AgentCard / Process IR / Gate Policy（唯一源）
  → schema 校验与版本管理
  → 编译为不同模型、Agent Runtime 或 Workflow Engine 的配置
```

这对资产库自演进尤其重要：运行中收集的失败率和复用次数应回写到资产元数据，但生产版流程必须经回归评测和发布门后才能更新，不能边跑边无审核改写。

## 4. 不应直接复制的部分

### 4.1 提示词不等于执行机制

[`Agents Orchestrator`](https://github.com/msitarzewski/agency-agents/blob/ebe9c99acb5c96f9468de368d8bead775387d1a7/specialized/agents-orchestrator.md) 在文本中声明了自动流转、状态跟踪、失败重试和升级，但这些是对 LLM 的指令，不是代码层状态机。仓库未提供持久化任务账本、工作队列、并发控制、节点幂等、事务补偿或可恢复执行。

[`runbooks.json`](https://github.com/msitarzewski/agency-agents/blob/ebe9c99acb5c96f9468de368d8bead775387d1a7/strategy/runbooks.json) 也只记录模式、文档和按激活时机分组的 Agent slug，没有节点依赖、I/O schema、路由条件和质量门表达式。自动检查脚本只保证 JSON 合法、slug 存在且文档路径有效。

### 4.2 “记住”不等于可验证的记忆系统

很多角色文件声称拥有 persistent memory，但仓库默认没有持久化实现。[带记忆的示例](https://github.com/msitarzewski/agency-agents/blob/ebe9c99acb5c96f9468de368d8bead775387d1a7/examples/workflow-with-memory.md) 依赖额外 MCP memory server，并明确说明“memory instructions are prompts, not code”。

我们应将记忆分为：流程状态库、不可变原始产物、可检索项目知识和用户长期偏好，而不是在 prompt 中笼统声明“你会记住”。

### 4.3 评审应默认严谨，但不应默认造出问题

Evidence Collector 要求首轮默认找出 3-5 个问题，Reality Checker 默认 `NEEDS WORK`。这可对抗“幻想式验收”，但也会制造确认偏差：评审者可能为满足角色设定而辫造缺陷。

我们应改为：

- 默认“未验证”，而非默认“失败”；
- 只根据预先固化的标准和可定位证据判定；
- 区分 `PASS / FAIL / INCONCLUSIVE / BLOCKED`；
- 对关键节点使用不同模型、规则校验器或人工复核，降低共同盲点。

### 4.4 角色越多不等于组织越强

270 份角色便于展示覆盖度，但实际编排时会带来角色重叠、选择困难、提示词负担和交接成本。即便仓库自己的 Multi-Agent Systems Architect 也建议：只在存在独立认知任务、需要独立配置或必须分离责任时才拆分 Agent。

首版应先保留 5-7 个核心职责，再用能力标签、Skill 和工具配置表达专业差异，避免每个细分技能都新建一个数字员工。

### 4.5 文档中的量化数字不能直接当作研究结论

NEXUS Executive Brief 中出现的“73% 交接失败”、“40%-60% 时间压缩”、“95% 缺陷捕获”等数字未提供可追溯实验或引用，只能视为方案作者的目标/宣传性表述。我们可学习其“为流程设计指标”的思路，但必须通过对照实验建立自己的基线。

### 4.6 人工复制上下文不能支撑长程任务

[标准 Startup MVP 示例](https://github.com/msitarzewski/agency-agents/blob/ebe9c99acb5c96f9468de368d8bead775387d1a7/examples/workflow-startup-mvp.md) 要求用户把上游完整输出复制给下游 Agent，并承认 Agent 不共享记忆。这适合演示协作模式，但随阶段增多会出现上下文膨胀、版本混乱和人工丢失。

我们应让下游 Agent 收到“状态快照 + 交接包 + 原始产物指针”，而不是全量对话转贴。

## 5. 面向我们首版 Demo 的落地建议

### 5.1 优先实现的最小能力

| 优先级 | 能力 | 从 Agency-Agents 吸收的经验 |
|---|---|---|
| P0 | 流程模板与版本 | NEXUS Mode + Scenario Runbook，但表达为可执行 IR |
| P0 | 节点 I/O 契约 | Playbook 的输入、交付物、前置条件和 Handoff Package |
| P0 | 状态机与任务账本 | Orchestrator 的 phase/task/retry 思路，但由代码强制 |
| P0 | 独立质量门 | Dev↔QA、证据优先、失败反馈和有限重试 |
| P0 | 产物库与可追溯性 | 交接模板中的文件、任务和证据关联 |
| P1 | AgentCard 匹配 | 角色库 + 专长/触发条件，补全权限、成本和历史表现 |
| P1 | 并行扇出/扇入 | NEXUS 的 parallel wave/workstream 与 convergence point |
| P1 | checkpoint/恢复 | 带记忆示例的 recall/rollback 意图，但改为明确状态语义 |
| P2 | 动态资源调度 | 待基础闭环可观测后，再用历史成功率、风险和边际收益分配资源 |

### 5.2 建议的首版执行闭环

```text
1. 选择流程模板并生成不可变 run_id
2. 校验当前节点准入条件
3. 根据 AgentCard 选择合格角色/实例
4. 发放受限的工具、上下文和资源预算
5. 验证输出 schema，登记产物和证据
6. 由独立评审节点判定 PASS / FAIL / INCONCLUSIVE / BLOCKED
7. 根据路由规则继续、局部重试、回退、换路线、升级或终止
8. 记录 trace、成本、耗时、重试和缺陷逃逸情况
```

这才是把 Agency-Agents 的角色与 NEXUS 方法从“依赖 LLM 自觉遵守”提升为“由运行时可验证地强制”。

## 6. 最终判断

Agency-Agents 最值得借鉴的不是 270 个角色文本本身，而是三种资产化思维：

1. **角色资产化**：专业职责、交付物和成功标准可复用；
2. **流程资产化**：阶段、并行关系、质量门和交接可模板化；
3. **治理资产化**：证据、重试、升级、权限、可观测性和评测可标准化。

我们的差异化方向应是：**保留它对组织分工和流程契约的洞察，用 IPD 式阶段决策和可执行 IR 补上其运行时缺口，同时以极简 Agent 的按需检索机制降低长提示词和过度拆角色带来的负担。**

## 参考资料

- [Agency-Agents 仓库](https://github.com/msitarzewski/agency-agents/tree/ebe9c99acb5c96f9468de368d8bead775387d1a7)
- [NEXUS 完整策略](https://github.com/msitarzewski/agency-agents/blob/ebe9c99acb5c96f9468de368d8bead775387d1a7/strategy/nexus-strategy.md)
- [NEXUS Quick Start](https://github.com/msitarzewski/agency-agents/blob/ebe9c99acb5c96f9468de368d8bead775387d1a7/strategy/QUICKSTART.md)
- [Handoff Templates](https://github.com/msitarzewski/agency-agents/blob/ebe9c99acb5c96f9468de368d8bead775387d1a7/strategy/coordination/handoff-templates.md)
- [Startup MVP Workflow](https://github.com/msitarzewski/agency-agents/blob/ebe9c99acb5c96f9468de368d8bead775387d1a7/examples/workflow-startup-mvp.md)
- [Workflow with Memory](https://github.com/msitarzewski/agency-agents/blob/ebe9c99acb5c96f9468de368d8bead775387d1a7/examples/workflow-with-memory.md)
- [Agents Orchestrator](https://github.com/msitarzewski/agency-agents/blob/ebe9c99acb5c96f9468de368d8bead775387d1a7/specialized/agents-orchestrator.md)
- [Multi-Agent Systems Architect](https://github.com/msitarzewski/agency-agents/blob/ebe9c99acb5c96f9468de368d8bead775387d1a7/engineering/engineering-multi-agent-systems-architect.md)
- [《基于组织流程控制的多智能体长程任务范式》](./基于组织流程控制的多智能体长程任务范式.pdf)
- [《极简 Agent 设计方案》](./极简%20Agent%20设计方案.pdf)

> 注：研究任务中的“OBP 模式”未有可核对的全称。本文仅根据其上下文，将它理解为“按设计、编码、自测、构建、测试、发布和回顾组成的产物驱动作业流程”；本文结论不依赖该缩写的确切定义。
