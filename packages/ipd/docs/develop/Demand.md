建议不要写成一个超长文件，而是建立一套以“当前代码事实”为准的开发文档。原 `IPD-code-build-plan.md` 应保留为设计历史，不应继续承担现行开发手册职责。

推荐目录：

```text
packages/ipd/
├── README.md
├── docs/
│   ├── architecture.md
│   ├── runtime-lifecycle.md
│   ├── workflow-ir-and-compiler.md
│   ├── agent-cards-and-assets.md
│   ├── artifacts-and-gates.md
│   ├── ledger-and-recovery.md
│   ├── agent-session-adapter.md
│   ├── budget-blocking-and-failures.md
│   ├── ipd-tool-extension.md
│   ├── extension-points.md
│   ├── testing-and-acceptance.md
│   ├── operations-and-troubleshooting.md
│   └── known-limitations-and-roadmap.md
└── examples/
```

暂时先不写11、13、15

## 1. README：开发者入口

应回答：

- IPD Tool 解决什么问题。
- 当前 V1 已实现和未实现什么。
- Node 24、AgentSession、SQLite 等运行前提。
- 最短启动路径。
- AgentCard、Skill、Workflow 资产目录。
- 五类模型 Tool Action 与用户 `/ipd-resume` Command 示例。
- 文档导航。
- 核心代码入口导航。
- 当前测试和验收状态。

需要明确：

```text
当前 Adapter：AgentSession
未来 Adapter：Harness v2
当前 Skill：调用时强制传入
当前状态真相：SQLite Ledger
```

## 2. architecture.md：总体架构

内容包括：

- 包的目标和非目标。
- 模块分层与依赖方向。
- IR、Registry、Ledger、Runtime、Gate、Staff、Adapter、Tool 的职责边界。
- 哪些模块允许依赖 Coding Agent。
- GraphEngine 是状态推进者，Agent 无权直接改变状态。
- AgentCard、Workflow、Run、Artifact 之间的所有权关系。
- 一次 `ipd.start` 的完整时序图。
- 用户 `/ipd-resume`、模型 `resume_run/status/cancel` 时序图。
- 关键代码入口表。

需要明确区分：

- AgentCard：固有员工资产。
- Workflow：ST 编排后冻结的流程资产。
- Node Attempt：一次具体执行。
- AgentSession：Attempt 或 Decision 的模型运行容器。

## 3. workflow-ir-and-compiler.md：Workflow IR 与编译器

内容包括：

- `WorkflowDefinition` 完整字段说明。
- Execution Node、Gate、Artifact Contract、Route、Budget 的结构。
- Skill 必填规则。
- Workflow 如何引用 AgentCard。
- Success DAG 和返工边的区别。
- Compiler 全部不变量。
- “每个节点必须有机械和语义 Gate”的强制规则。
- 预算总和与预留预算规则。
- Reviewer 独立性规则。
- 最终 Artifact 和最终 Gate 覆盖规则。
- 编译 Diagnostic 格式及常见错误。
- Workflow Hash 和冻结规则。
- Workflow 版本升级规则。

必须加入合法与非法 Workflow 示例，并解释非法示例为何被拒绝。

## 4. agent-cards-and-assets.md：AgentCard 和资产管理

内容包括：

- AgentCard Schema。
- 必填字段、可选字段和默认值。
- `run_default` 与 `explicit` 模型选择。
- Pi 已配置模型的发现与认证检查。
- Skill、Tool、Permission 的解析规则。
- `staff` 和 Reviewer capability 的约定。
- 读写 Scope 的包含关系。
- 全局和项目资产目录。
- 项目可信状态对资产加载的影响。
- 冲突检测。
- 每次 `start` 重新扫描 Card Pool 的原因。
- Card Hash、版本和冻结快照。
- 如何新增一种员工角色。
- PPT AgentCard 作为示例，但明确它不是 Core 内置角色。

还应说明：

- 同一 `id + version` 不能有多个定义。
- Card 文件错误会阻止整个 Run 创建。
- Card 修改只影响后续 Run，不改变历史 Run 快照。

## 5. runtime-lifecycle.md：Runtime 与状态机

内容包括：

- Run、Node、Gate、Reviewer、Artifact、Escalation 的状态图。
- 每种状态允许的转换。
- GraphEngine 调度循环。
- DAG fan-out/fan-in。
- Ready Node 判定条件。
- WorkspaceLock 读写冲突规则。
- Bash 节点为什么更保守。
- Candidate Artifact 的不可见规则。
- Gate PASS 后下游如何解锁。
- 技术重试、质量返工和阻塞恢复的不同路径。
- Attempt 编号和耗尽逻辑。
- cancel 和 AbortSignal 的传播。
- 进程中断后的恢复单位为什么是 Attempt。

每个状态转换最好附：

- 谁触发。
- Ledger 写入什么。
- 对应 Event。
- 对应测试文件。

## 6. artifacts-and-gates.md：Artifact、Check、Reviewer 和 Gate

内容包括：

- Artifact Submission 与 Artifact Manifest 的区别。
- Execution Artifact 支持一个或多个文件；文件业务作用由 Staff 在 Workflow/Gate 中定义，不在 Artifact 层编码固定角色。
- 路径、大小和 SHA-256 校验。
- Candidate、Accepted、Rejected 生命周期。
- Mechanical Check 注册和执行。
- Review Bundle 如何由实际文件生成。
- 默认支持的文本、JSON、图片 View。
- Dynamic Reviewer 选择算法。
- 执行者不能评审自己的规则。
- 多 Reviewer 聚合规则。
- PASS、REWORK、INCONCLUSIVE、BLOCKED 的语义。
- ST 仲裁的权限边界。
- Final Gate 与局部 Gate 的区别。
- 如何新增 CheckExecutor 或 ArtifactViewProvider。

需要明确当前限制：

- 精确 Review Bundle 尚未独立持久化到 Ledger。
- 不支持的 MIME 只能作为引用，不能冒充可审查材料。

## 7. ledger-and-recovery.md：Ledger、幂等与恢复

内容包括：

- SQLite 数据库位置。
- 所有表的用途和关联关系。
- 状态表与 Event 表的区别。
- 单 Run `sequence` 单调递增规则。
- 事务边界。
- Idempotency Key 规则。
- Snapshot 如何重建。
- `verifyRunConsistency()` 检查内容。
- AgentCard 和 Workflow 快照。
- Session ID、Session JSONL 的记录位置。
- 进程重启后的恢复算法。
- 哪些工作可以自动重试。
- 哪些副作用节点必须进入人工确认。
- Migration 编写和升级规范。
- 如何检查和调试一个失败 Run。

应包含常用 SQLite 查询示例。

## 8. agent-session-adapter.md：模型与 AgentSession 接入

内容包括：

- 每个 Attempt 为什么使用独立 AgentSession。
- 当前模型和 thinking level 如何传入。
- `run_default` 如何使用 Pi 当前模型。
- `explicit` 如何读取 Pi 模型和认证配置。
- Skill Snapshot 如何注入。
- 为什么禁用自动加载无关 Skill、Extension、Theme 和 Context。
- Execution、Reviewer、Planner、Staff 使用的结构化提交 Tool。
- Tool 集合如何取交集。
- Token Budget 如何限制模型 `maxTokens`。
- Timeout 和 Abort 行为。
- Session 文件和 Usage 获取方式。
- Faux Provider 与真实 Provider 的区别。
- 如何未来增加 Harness v2 Adapter，而不修改 Runtime 协议。

需要突出真实模型会产生费用，faux provider 不计费。

## 9. budget-blocking-and-failures.md

内容包括：

- Usage 的四类归集：staff、execution、review、rework。
- 80% warning、100% reached、Hard Limit。
- ST 可执行的预算动作。
- Reviewer 后续预算收缩。
- Hard Limit 为什么不能被 ST 绕过。
- Node blocked 后的 ST 决策流程。
- 用户 Escalation 创建规则。
- `waiting_user` 和严格 Resume。
- 错误 escalationId 为什么不能改变状态。
- 统一 `IpdFailure` 结构。
- 所有 Failure Category 与 retryable 规则。
- 技术失败、质量失败、阻塞、预算失败的路由差异。

最好为每种失败给出一条短执行轨迹。

## 10. ipd-tool-extension.md：Tool API

内容包括：

- `start/resume_run/status/watch/cancel` Tool Schema 与用户 `/ipd-resume` Command。
- 每个参数的含义和默认值。
- Skill 必填和未知 Skill 行为。
- Tool-call ID 幂等。
- 相同 Tool ID 不同参数的冲突行为。
- `IpdToolResult` 完整结构。
- `summary` 和 `details` 的职责区别。
- `question`、`artifacts`、`failure`、`usage` 的解释。
- `before_agent_start` 如何缓存 Pi Skill。
- cwd、model、thinking level、trust 和 AbortSignal 如何转发。
- Extension 安装方法。
- 外层 Agent 应如何处理 `waiting_user`。
- 外层 Agent 不应从文本推断状态。

应提供四类调用的完整输入输出示例。

## 11. extension-points.md：二次开发指南

按扩展类型分别说明：

- 新增 AgentCard。
- 新增 Workflow Template。
- 新增 CheckExecutor。
- 新增 ArtifactViewProvider。
- 新增 NodeRunner Adapter。
- 新增 BudgetController。
- 新增 Staff Decision 类型。
- 新增 Artifact MIME 支持。
- 新增 Tool Action 时需要修改哪些 Schema、Runtime 和测试。
- 新增 Ledger 表和 Migration。
- 新增 Failure Category。

每个扩展点都要列出：

```text
接口
注册位置
生命周期
允许做什么
禁止做什么
最小测试
兼容性影响
```

## 12. testing-and-acceptance.md：测试体系

内容包括：

- 单元测试、集成测试、faux E2E、真实 Skill E2E 的分层。
- 为什么禁止真实 Provider 出现在普通回归测试中。
- 如何运行单个测试。
- 如何运行 IPD 全套测试。
- `npm run check` 的要求。
- 如何构造 FakeNodeRunner、FakeGateEvaluator。
- 如何验证并行、返工、阻塞、恢复和预算。
- 如何验证 Ledger 一致性。
- 如何增加回归测试。
- 阶段 10 presentation-skill 验收方法。
- 真实模型 Eval 的成本和安全约束。
- 验收报告模板。

## 13. operations-and-troubleshooting.md

内容包括：

- Node 24 要求。
- Pi AgentDir 与环境变量。
- Skill、AgentCard、Workflow、SQLite、Session 文件位置。
- Python/Node Skill 依赖属于 Skill 自身，不属于 IPD Core。
- 模型不可用和认证失败排查。
- AgentCard Diagnostic 排查。
- Workflow Compiler 失败排查。
- Artifact Hash/路径失败排查。
- Run stalled、waiting_user、failed 的排查。
- SQLite 查询和 Session JSONL 定位方法。
- LibreOffice 缺失时的正确降级。
- 如何区分产品缺陷、测试 flake 和环境缺陷。
- 不得输出或记录 API Key。

## 14. known-limitations-and-roadmap.md

当前应明确记录：

- AgentSession Adapter 是 V1 实现，Harness v2 尚未接入。
- 精确 Review Bundle 尚未独立持久化。
- 没有 Workflow 在线修改。
- 没有分布式 Scheduler。
- 没有操作系统级安全沙箱。
- 自定义 ToolDefinition 需要显式注入。
- 真实视觉 QA 依赖 Skill 环境中的渲染能力。
- Tool-call 幂等当前是进程内级别。
- Pi 没有正式长期记忆接口时，IPD 不自行实现记忆。
- presentation-skill 当前依赖安全问题。
- 计划中的演进方向及进入条件。

## 15. ADR：重要设计决策记录

建议单独增加：

```text
docs/adr/
├── 0001-sqlite-as-state-source.md
├── 0002-agentcard-independent-assets.md
├── 0003-gate-mechanical-and-semantic.md
├── 0004-agent-session-per-attempt.md
├── 0005-workflow-immutable-after-compile.md
├── 0006-skill-snapshot-required.md
└── 0007-no-independent-memory-system.md
```

ADR 应记录：

- 当时的问题。
- 选择的方案。
- 被否决的方案。
- 选择原因。
- 对未来开发的约束。
- 什么条件下允许重新评估。

## 所有文档应统一包含的元素

每份文档都应尽量包含：

- 当前行为，而不是仅写设计愿景。
- 对应源码入口。
- 不变量。
- 一条正常执行示例。
- 一条失败示例。
- 对应测试。
- 扩展方式。
- 已知限制。
- 修改该模块时必须同步更新的文档和测试。

最关键的是建立“事实优先级”：

```text
TypeBox Schema / 状态机 / Ledger Migration
    > Runtime 实际代码
    > 当前开发文档
    > 历史构建方案与分析材料
```

这样后续开发者才不会把早期设计稿中的计划行为误认为当前已经实现的能力。
