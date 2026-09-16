# IPD 重构基线（PR 1）

## 范围与判定标准

本文件落实已批准的《IPD 整体架构与代码重构方案》第 7 节 PR 1，
不是另起一套架构。审查源基线为 `07095ad825ef76cd4d9896180233659447d3ca4f`；
本批从 `3e7736d1433e785631fa524409e9ebfea689ef34` 开始，后一个提交只增加方案文档。

本批只增加行为基线测试、CI 入口和职责清单，不改生产源码、Workflow Schema、
资产、锁文件、环境布局、模型策略或已有批准/返工语义。后续批次以可观察行为为边界，
不把当前类名、包装层数或已知错误固化成永久 API。

`packages/ipd/src` 在审查源基线中有 75 个文件、511,910 字节（Git blob 大小，
包含注释、类型和内嵌前端，不是代码行数、构建大小或运行内存）。后续统计应同时覆盖
移出的实现与新增依赖；仅移动文件、压缩排版或删除测试不计为收益。

## 1. 现有调用关系与策略归属

```text
外部 ipd Tool / 预置模板入口
  → IpdService：持久 Run + 后台执行句柄
    → ControlPlane：选择 / 设计 / 编译（模板路径跳过选择与设计）
    → WorkflowRuntime：就绪、派发、提交、评审、失效与完成
      → RetryingNodeWorker：当前还有整轮技术重试（PR 2 移除模型重试部分）
        → PiNodeWorker：本轮上下文、受控提交、环境绑定
          → NodeSessionAdapter：Session 绑定、派发与清理
            → PiNodeSessionFactory
              → Pi AgentSession / SessionManager / ModelRuntime
                → 原生模型与工具循环、retry、compaction、history、events
                → Pi ToolDefinition / Operations
                  → Docker EnvironmentProvider（或显式 legacy 路径）

环境稳定导出 → 私有 staging → SubmissionStore / Manifest → 机械检查
  → Review → Approval → 下游就绪 / 定点返工 / 最终交付

RunStore → DashboardSnapshot → 实时页 / 独立 HTML（只读）
```

此图是当前执行关系，不是要求部署多个服务。纯编译规则、治理状态、Pi 会话、
环境实例和观察页的生命周期不同，不能从某一层的 `idle` 推断另一层已完成。

| 职责 | 当前入口 | 目标唯一拥有者 | 本批动作 |
|---|---|---|---|
| 模型重试 | Pi `_prepareRetry` + IPD `RetryingNodeWorker` | Pi `AgentSession` | 证明真实 Factory 已保留原生重试；不提前删除外层 |
| 请求期限与压缩 | 原生 `SettingsManager` / `AgentSession` | Pi | 复用原生测试，不在 IPD 重写压缩算法 |
| 角色到 Session 的绑定 | Adapter、Worker、控制角色集合 | 一个薄绑定登记处 | 保留同 Session 的可观察行为，不要求保留多份 Map |
| 工作包与 Run 终态 | Runtime + Service | IPD 生命周期与业务规则 | 记录正常/错误/取消路径，保留治理回归 |
| 文件、命令、进程 | 原生工具 + environment + legacy adapter | 一个 Workspace 后端 | 继续原生工具和已有真实 Docker 测试 |
| 精确成果、证据和批准 | SubmissionStore、Gate、runtime-state | IPD 治理 | 保留，不以减行数删除信任边界 |
| 诊断 | Session 事件 + IPD telemetry | 原生事件/telemetry 加领域标签 | 本批只断言已有事件，不创建新事件平台 |
| 观察 | dashboard model/server/page | 版本化读模型 | 不让前端参与任何状态迁移 |

依赖方向继续使用仓库 `scripts/check-entry-graphs.mjs` 的检查机制。
当前脚本只对已声明的少数公共入口设预算，尚未实施完整 IPD 分层规则；
不能把“现有脚本通过”写成“IPD 已无跨层依赖”。新增边界规则在对应重构批次中落实，
不另建一套通用依赖图框架。

## 2. 实际 Session 配置基线

`PiNodeSessionFactory.create()` 使用 `SettingsManager.inMemory({}, { projectTrusted: false })`。
空设置会使用 Pi 默认值，不等于关闭 retry 或 compaction；也不是自动继承用户全局设置。
Factory 显式传入 `ModelRuntime`，模型和 thinking level 来自冻结员工配置或 Run 默认值。

| 配置/行为 | 当前来源 | 重构必须保留的边界 |
|---|---|---|
| retry / compaction 默认启用 | Pi SettingsManager | 配置与重试执行交给原生机制；具体次数可由未来可信策略配置 |
| 请求 timeout / HTTP idle timeout | Pi SDK 与原生设置 | 不增加一套平行的 provider watchdog |
| 扩展、Skill、Context 发现 | Factory 禁止自动发现，仅显式绑定 | 不能为复用设置开放任意宿主扩展 |
| 工具可见性 | lockedTools + controlTools 允许名单 | 未绑定的宿主 custom Tool 不得暴露 |
| 消息历史 | `SessionManager.create()` | 原始错误和工具结果保留，IPD 不复制对话数据库 |
| 有效候选结束 | sequential 提交工具 + `terminate: true` | 候选捕获不是批准；混合批次的原生终止语义不变 |
| 质量返工 | 后续 prompt + 新 round capture | 继续原 Session；不得静默创建新的空 Session |

新增测试使用真实 `PiNodeSessionFactory`、Pi 循环、SessionManager 和提交工具。
只有模型响应由仓库的 faux provider 提供，使用合成任务、临时文件和 `faux-key`，
不访问真实模型、生产系统或用户凭证。原生 compaction 的行为直接运行已有 suite，
不复制一份到 IPD 中。

## 3. 正常、失败与取消路径

**正常路径：** Runtime 派发精确输入；Pi 执行模型/工具循环；捕获候选后停止自动续答；
Runtime 导出、封存、检查并记录。Review 只评价指定的成果版本；Approval 决定下游准出。
Pi 空闲、工具返回 0 或 `captured: true` 都不等于 IPD 成功。

**技术错误：** Pi 先执行原生重试；最终错误由 Factory 报给上层，当前外层 Worker
还可能重复整轮调用。PR 2 将移除这层模型重试。本批测试“不重放已完成工具工作”
仅指一次真实 Pi prompt 的原生重试，不宣称现有 IPD 外层已经移除。

**协议补正：** 提交不合法时，工具返回诊断，不设置成功终止标记，继续同一 Session。
这不是模型重试，更不是质量 Gate 要求的新返工 round。

**质量返工：** 受影响的批准及消费关系失效，责任执行节点收到定点反馈；未受影响的
分支保留。新版本重新提交并评审，不能降低标准以获得通过。

**取消/暂停：** 当前 Service 的运行 Promise、Session 与环境资源所有权尚未完整统一。
PR 3 负责 blocked/paused 的保留、继续、释放及迟到提交隔离；本批只运行现有取消测试，
不把已知生命周期缺口写成“预期正确行为”。

## 4. 可执行行为基线

既有测试是基线的一部分，不为增加测试数量复制实现。新增项只补跨层交接。
CI 中的 `native-and-governance-baseline` 与真实 Docker job 独立，环境测试失败时仍能
看到原生/治理结果；它不能代替 Docker 验收。完整仓库检查继续由现有 CI 执行。

| 必须保持的行为 | 测试文件（相对对应包） | 方式 |
|---|---|---|
| Factory 保留原生重试，已完成副作用不重放，错误仍在原始历史中 | IPD `test/native-session-contract.test.ts` | 新增：真实 Session + faux provider + 临时文件 |
| 合法提交停止自动续答；非法提交继续补正；不暴露未绑定工具 | 同上 + `test/structured-submissions.test.ts` | 新增交接测试，保留已有工具级断言 |
| 后续质量 round 继续同 Session，并保留上轮结果；最终错误不制造候选 | 同上 + `test/pi-node-session-factory.test.ts` | 不 mock Pi 的状态或持久化 |
| 重试成功、耗尽、取消及事件顺序 | coding-agent `test/suite/agent-session-retry-events.test.ts` | 复用原生 faux suite |
| 自动压缩/overflow 后继续；手动压缩行为；模型级配置 | coding-agent `test/suite/agent-session-compaction.test.ts`、`agent-session-compaction-model-overrides.test.ts` | 复用原生 suite，不新增压缩引擎 |
| 工具图片、编辑、截断与文件变更顺序 | coding-agent `test/suite/agent-session-tool-result-images.test.ts`、`test/tools.test.ts`、`test/file-mutation-queue.test.ts` | 复用原生工具测试 |
| 唯一会话绑定、并行保护和释放 | IPD `test/node-session-adapter.test.ts`、`test/pi-node-worker.test.ts` | 既有测试 |
| 精确输入、联合评审失效、必需评审与 Run 完成 | IPD `test/runtime-state.test.ts`、`test/p0-runtime-safety.test.ts` | 既有阶段 Gate 行为，不强制一执行一评审 |
| 定点返工、结构化评审和最终交付 | IPD `test/runtime-rework.test.ts`、`test/review-validation.test.ts`、`test/workflow-runtime.test.ts` | 既有测试 |
| 逐输出封存、不可变身份、取消与故障边界 | IPD `test/submission-store.test.ts`、`test/failure-boundaries.test.ts`、`test/ipd-service.test.ts` | 既有测试；不暗示所有取消缺口已修 |
| 模板绑定与 Compiler 约束 | IPD `test/compiler.test.ts`、`test/workflow-asset-store.test.ts` | 既有测试 |
| 实际 Docker 工具链、隔离和输出导出 | IPD `test/docker-provider.integration.test.ts` | 原 `real-docker-provider` job；本批不删、不 mock、不改断言 |

只跑新增测试（仓库 Node 24、依赖安装完成后）：

```bash
cd packages/ipd
node ../../node_modules/vitest/dist/cli.js --run test/native-session-contract.test.ts
```

完整的本批精选测试命令见 `.github/workflows/ipd-refactor-baseline.yml`。
使用显式文件列表，不运行可能根据环境凭证激活的整个 e2e suite。
代码检查仍需 `npm run check`，不能用 TypeScript 语法解析或 mock 结果代替。

## 5. 保留、合并、删除/退役清单

| 当前实现 | 处置 | 批次 | 必须同步保留/证明 |
|---|---|---|---|
| ProcessSpec / Workflow / Compiler / coverage | 保留，集中规则 | PR 5 | 规范语义和模板兼容，不恢复大型推断 TaskInput |
| Submission / Manifest / Gate / Approval / Rework | 保留 | PR 3/5 | 精确版本、联合失效、定点返工、最终文件集合 |
| `RetryingNodeWorker` 的模型 transient 整轮重试 | 删除，由 Pi 接管 | PR 2 | 原生重试、补正与质量 round 分开；未知副作用不重放 |
| Adapter / Worker / 控制角色的重复 Session 状态与转发 | 合并为薄绑定层 | PR 2/3 | 唯一身份、并行保护、原 Session 继续、清理 |
| `omitConsumedImages` 的“成功回答即已消费”规则 | 替换，不删原始历史 | PR 2 | Pi 压缩、可重读引用、已保存检查结论 |
| 普通/日志 Bash、probe、process bridge 的不同启动路径 | 合并启动契约 | PR 4 | 相同解释器、PATH、取消、日志、真实 Skill 探针 |
| legacy sandbox 与 file-scope 路径 | 显式兼容入口，验收后隔离 | PR 4 | 默认路径失败不自动弱化隔离；安装态依赖验证 |
| Service active Promise Map 被当作全部资源所有权 | 替换为受管理 Run 生命周期 | PR 3 | blocked 可查询/继续/放弃，取消有界，迟到提交无效 |
| RunState 中重复静态资产和重复扫描 | 瘦快照、静态索引 | PR 5 | Store 原子语义及只读 getRun 表示，不迁移数据库 |
| 内联 dashboard 程序 | 独立校验、构建时内嵌 | PR 5 | 单 HTML 离线快照、同一读模型；不引 React 工程 |
| 分散诊断事件 | 复用 Pi 事件与 pi-telemetry | PR 2/3/5 | 领域身份、脱敏、被动记录，不影响执行结果 |
| 根依赖与 IPD dist 构建入口 | 核实真实消费者后整理 | PR 5 | 不凭名字删包；源码与安装态行为一致 |

每批 PR 同时说明新拥有者和旧实现退出位置。第一批故意没有生产代码删除项，
因为它建立的是删除前的证据，不将已知缺陷永久固定成测试要求。

## 6. 尚未闭环的事项与交接

这些是后续批次的任务，不是本批已经修复：

- 登录 Shell 与预检选择不同 Python 的风险，须在真实 Profile 通过实际工具入口验证。
- process bridge 的递归参数与启动握手缺陷。
- blocked 状态下的资源归属、同 Session/lease 继续和取消。
- 超时后的代际封锁与有界清理。
- 离线模板缺少研究能力，却通过“未编造”检查，未保证用户任务适足性。
- 模型 `terminated` 缺少充分请求元数据，底层原因仍未知，不能直接归因于图片或上下文。

本批完成状态、实际运行记录和阻塞见 `Checkpoint/IPD-refactor.md` 与 PR 的 CI。
源码审查/语法检查、faux 行为测试、真实 Docker、真实业务验收是不同证据层，不能相互代称。
PR 1 未通过约定基线之前，不推进 PR 2 的机制删除，也不自行合并。
