# 当前限制与 Roadmap

本文只记录当前代码中真实存在的限制和进入下一阶段的条件，不表示这些能力已经排期或承诺实现。

## 1. Extension 尚未产品化安装

当前入口是：

```text
packages/ipd/examples/ipd-extension.ts
```

源码仓可通过：

```bash
./pi-test.sh -e packages/ipd/examples/ipd-extension.ts
```

加载，但：

- `npm install` 不会注册全局 `pi` 命令；
- Extension 不会自动安装到 AgentDir；
- `@earendil-works/pi-ipd` 当前是 private package；
- example 使用源码相对导入，不是稳定发布入口；
- Pi 默认不会发现并启用 IPD。

进入条件：明确 IPD 是内置可选能力、独立插件还是单独发布包；解决 coding-agent/IPD 依赖方向和安装卸载生命周期；增加安装产物测试。

## 2. 当前只有 AgentSession Adapter

`AgentSessionNodeRunner` 是唯一实现。Harness v2 未接入。

进入条件：Harness v2 能稳定提供结构化 Tool、独立 Session/Trace、Usage、Timeout 和 Abort；新 Adapter 通过现有 NodeRunner 契约和同一套 Graph/Gate 回归。

## 3. 当前强制 Run Skill

Tool start、Run 表、Workflow Schema 和 Planner 都要求 Skill name/hash。

未来“不强制 Skill”不是把字段传空，而需要：

- 新 Tool Schema；
- Run/Workflow Schema 和 Migration 决策；
- Planner 在无 Skill 时的组织知识来源；
- Resume 的 Snapshot 校验替代方案；
- 兼容或版本升级策略。

## 4. Workflow 冻结后不能修改

Compiler 成功后拓扑、AgentCardRef、Gate Criteria、Budget 和路由全部冻结。

没有：

- 在线增删 Node；
- 运行中更换生产员工；
- 动态修改 Gate；
- Workflow Amendment 审批和版本链。

进入条件：先定义 Amendment IR、谁能提出、谁能批准、对已运行 Attempt/Artifact 的影响、Hash/版本和恢复语义。

## 5. Final Gate 不支持局部返工

Schema 有 `finalGate.routes.rework`，Compiler 也校验目标 Node，但当前 GraphEngine 对 Final Gate 非 PASS 直接令 Run failed。

原因是目标 Node 已是 succeeded，当前 Attempt 状态机和 accepted Artifact lineage 没有“从 Final Gate 打回旧成功节点”的协议。

进入条件：定义 supersede lineage、旧 accepted Artifact 可见性、下游重新执行范围、Attempt 创建规则和 Final Gate 返工上限，再实现对应状态机和测试。

## 6. Attempt Staging 不覆盖工作区外副作用

有界工作区写入已通过 Attempt Workspace 隔离并在 Gate PASS 后发布，但 Bash 绝对路径、网络请求和其他 external action 仍可能产生工作区外副作用。`writeScopes:["."]` 会被拒绝，不会伪装成已隔离。

进入条件：Harness v2 或 OS Sandbox 提供可声明、可提交、可回滚的外部副作用协议，并定义 unknown-outcome 恢复语义。

## 7. Review Bundle 未独立持久化

Gate 运行时从 hash-bound Manifest 生成 Review Bundle，Reviewer Session 收到实际内容，但 Ledger 没有：

- Bundle JSON；
- Bundle Hash；
- Material 截断状态快照；
- View Provider 版本；
- Bundle 与 Reviewer Instance 的独立关系表。

文件未变化时可以重建，但无法证明重建结果和当时输入逐字一致。

进入条件：定义 Review Bundle Record、Hash、大小策略和 Migration，并保持图片数据不会让 SQLite 无界膨胀。

## 8. Knowledge Base 只是受控引用

AgentCard 可以声明 Knowledge Base ID、描述和相对路径；Workflow Node 显式引用，Compiler 校验权限；Prompt 提供这些信息。

IPD 不提供：

- 向量索引；
- 检索器；
- 内容版本管理；
- 外部知识服务认证；
- 自动记忆写入。

进入条件：Pi 提供正式治理接口或引入独立 Knowledge Provider 契约，并能把访问范围、版本和证据写入 Trace。

## 9. 没有独立长期记忆系统

AgentSession Adapter 关闭自动 Context Files，节点只接收显式 Skill、Artifact 和控制上下文。

当前 Pi 没有提供给这些独立 AgentSession 的正式长期记忆接口，因此 IPD 不扫描自定义记忆目录、不推断用户偏好、不写反思文件。

未来只应在 Adapter 上接 Pi 正式能力，不改变 Workflow、Gate 和 Ledger 权限边界。

## 10. Workspace Permission 不是 OS 沙箱

Compiler、NodeRunner Prompt 和 WorkspaceLock 使用 read/write scope，但内置 Tool 没有接受 IPD Scope 作为系统调用级强制策略。

特别是 Bash：

- 调度上按全工作区读写锁处理；
- 命令仍由本地 shell 执行；
- IPD 不分析 Shell 命令真实路径和副作用。

进入条件：Tool 层提供可验证 Scope enforcement、容器/沙箱或远端执行后端，并保持 Artifact 路径和 Session Trace 一致。

## 11. 自定义 Tool 不能从外层自动继承

默认 Runtime 只认识内置 Tool 名称。自定义 Tool 必须通过 `CreateDefaultIpdRuntimeOptions.customTools` 显式注入。

ExtensionContext 的 ToolInfo 不包含可直接传给独立 AgentSession 的执行函数，因此不能仅凭外层已注册名字安全继承。

进入条件：Pi 提供受治理的 ToolDefinition 导出/授权机制，或 IPD 插件定义自己的 Tool Registry。

## 12. Tool-call 幂等只在进程内

`IpdToolController` 缓存 `toolCallId → Promise`，重启后丢失。Ledger 写操作本身有持久幂等，但新的 start 在进程重启后可能创建新 Run。

进入条件：定义 Tool Invocation 表或外部 idempotency key，明确跨 Session、跨进程和过期清理语义。

## 13. start 是长调用

start 等待 Planner 和 Graph 到达 succeeded/failed/cancelled/waiting_user 才返回。调用者在返回前通常拿不到 runId。

这限制了长时间后台运行和独立 status polling。

进入条件：增加 durable start receipt、后台 Run ownership、进程恢复和主动通知机制，同时保持 Tool 调用幂等。

## 14. Tool Result 返回全部 Accepted Artifact

`IpdRuntime.result()` 当前返回 Run 中所有 accepted Manifest，不只返回 Final Artifact Node。

调用方可以从 `nodeId` 和 full Workflow 判断最终文件，但顶层没有单独 `finalArtifacts` 字段。

进入条件：明确是否保留全部 `artifacts` 并新增 `finalArtifacts`，避免破坏现有外层 Agent。

## 15. AgentCard default token 尚未自动执行

`defaultBudget.timeoutMs` 被 Decision Node Timeout 使用；`defaultBudget.tokens` 当前主要作为 ST 规划信息。

Execution 使用 Workflow Node Budget，Planner/Staff 使用 Workflow staffTokens，Reviewer 只有在预算收缩时收到显式 Token Budget，否则使用模型 maxTokens。

进入条件：定义 Card default、Workflow allocation 和模型 maxTokens 的明确优先级，并避免双重计算。

## 16. Staff Core 配置依赖 capability 约定

默认 Runtime 把所有 `staff-core` Card 固定为 Core，并选 `workflow-planning` 作为 Planner。没有单独 `staff-team.yaml` 或环境级 Core Profile。

优点是简单确定；限制是无法在同一 Card Pool 中定义多个可选固定 Core Team。

进入条件：出现多个组织 Profile 的真实需求后，再引入独立 StaffTeam Asset 和显式选择规则。

## 17. Staff 决策仍是短 Session

Budget、blocked、arbitration 每次创建独立 Staff AgentSession，没有持续群聊或共享模型记忆。事实由 Ledger Context 提供。

当前 blocked 和 budget Context 是专用小结构，不是完整统一 `STControlRecord` 类型。

进入条件：不同 Staff Decision 出现重复上下文字段或恢复缺口时，抽象只读 STControlRecord Builder。

## 18. Failure 分类仍有粗粒度路径

Execution Tool Call 超限使用 `tool_limit_exceeded/tool_error`；Attempt 耗尽和 stalled 收口会保留最后 Node/Gate Failure。仍未覆盖的 Runtime 自身异常才使用 `internal_error`。

进入条件：先基于真实缺陷统计定义稳定映射，再扩展 NodeRunner/Tool Failure，避免仅增加名义枚举。

## 19. Reviewer 选择是确定性首匹配

ReviewerSelector 按 ID/version 排序并选择前 `minCount` 个未使用匹配 Card。它不使用：

- 历史成功率；
- 成本；
- 缺陷逃逸率；
- 模型多样性；
- 当前并发负载。

进入条件：Ledger 积累足够客观指标，并有对照实验说明动态选择收益超过复杂度和 Token 成本。

## 20. 单进程 Scheduler

GraphEngine active Runs、Workspace Lock 和 Tool-call Cache 都是进程内对象。SQLite 可跨重启保存稳定状态，但不支持多个进程共同抢占和执行同一 Run。

进入条件：定义 lease、heartbeat、owner、fencing token 和幂等命令，再评估队列或分布式 Runtime。

## 21. presentation-skill 是项目验收资产

presentation-skill 不属于 IPD Core 依赖。当前项目验收环境曾发现：

- 缺少 LibreOffice/soffice 时只能做静态 QA；
- `pptxgenjs@4.0.1` 的传递依赖 `image-size@1.2.1` 命中高危 DoS 公告。

这些是具体 Skill/环境问题，不应在 Core 中硬编码 PPT 规则。使用该 Skill 前应由其维护者升级依赖并提供正式渲染环境。

## 22. Roadmap 原则

后续能力只有满足以下条件才进入 Core：

1. 有真实运行数据证明当前缺口造成可重复失败；
2. 能定义 Schema、状态、权限、幂等和恢复语义；
3. 能在 faux provider 下稳定回归；
4. 不破坏 AgentCard、Skill、Workflow 和 Ledger 解耦；
5. 不让模型获得直接状态写入或绕过 Gate 的权力；
6. 成本和流程税相对质量收益可测量。

建议优先级：

```text
P0  Extension 正式安装入口
P0  Final Gate 返工协议
P0  Review Bundle 持久化
P1  Attempt Workspace 垃圾回收与外部副作用协议
P1  持久 Tool invocation / 后台 start
P1  Tool Scope enforcement
P2  StaffTeam Profile、知识 Provider、指标驱动 Reviewer
P3  Harness v2、在线 Amendment、分布式 Scheduler
```

优先级是技术建议，不是已经承诺的发布计划。
