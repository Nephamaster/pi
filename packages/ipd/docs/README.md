# IPD Tool V1 开发文档

本文档是 `@earendil-works/pi-ipd` 的开发者入口。

## 1. 适用对象

本文档面向需要完成以下工作的开发者：

- 理解一次 IPD Run 如何从 Skill 进入 ST 编排、执行、质量门和最终交付；
- 修改 Workflow IR、Compiler、Ledger、Graph Engine、Gate 或 Tool 接口；
- 新增 AgentCard、Workflow Asset、机械检查或 Artifact Review View；
- 接入 Pi 已配置的模型和 Skill；
- 调试失败、阻塞、预算超限、返工或恢复问题；
- 在 V1 现有边界内继续迭代，而不破坏可追溯性和质量门不变量。

## 2. 当前 V1 是什么

IPD Tool 是一个 Skill 驱动的多 Agent 长程任务运行时。它把普通模型调用组织为冻结 Workflow，并要求每个业务执行节点都同时通过机械检查和独立语义评审，之后交付物才会对下游可见。

当前主链为：

```text
Pi 当前会话
  → ipd.start（必须指定 Skill）
  → 加载并编译 AgentCard Pool
  → ST Planner 生成 WorkflowDefinition
  → Workflow Compiler 校验并冻结 Workflow
  → Graph Engine 调度 Execution Node Attempt
  → AgentSession 提交 Candidate Artifact
  → Mechanical Check
  → Dynamic Reviewer 语义评审
  → PASS / REWORK / BLOCKED / FAIL
  → Final Gate
  → accepted Artifact + Ledger Trace
```

V1 的核心约束是：

1. AgentCard 是独立固有资产，不属于 Workflow；
2. Workflow 必须由 Compiler 校验并冻结后才能执行；
3. Workflow 中只能出现 Execution Node，每个节点必须有机械和语义 Gate；
4. Agent 只能提交结构化结果，不能直接改变 Run、Node 或 Gate 状态；
5. Graph Engine 根据冻结 Workflow 和 Ledger 推进状态；
6. Candidate Artifact 在 Gate PASS 前不能被下游读取；
7. Reviewer 不能是对应 Artifact 的生产者；
8. 技术失败、质量失败、阻塞、预算和取消使用不同状态与路由；
9. `waiting_user` 只能由匹配的开放 Escalation 恢复；
10. Run 的状态、决策、用量和追溯信息以 SQLite Ledger 为准。

## 3. 当前已经实现的能力

| 领域 | 当前实现 |
|---|---|
| Workflow IR | TypeBox Schema、关系校验、DAG 校验、不变量校验和稳定 Hash |
| AgentCard | JSON/YAML 文件加载、角色边界、场景、原则、提示范式、知识库、模型/Skill/Tool/权限校验、Hash 和 Run 快照 |
| Workflow Asset | 模板加载、ST 生成、不可覆盖保存、相同内容复用、内容变化强制升版本 |
| Planner | 固定 ST Core、Workflow Authoring Guide、分段 Workflow 提交与本地组装、Compiler Diagnostic 修订循环 |
| Scheduler | DAG fan-out/fan-in、依赖 Artifact、Workspace Lock、Attempt Staging 和返工 |
| Artifact | 路径、角色、MIME 内容、大小、SHA-256、Candidate/Accepted/Rejected 生命周期 |
| Gate | 机械检查、Review Bundle、历史 Criterion 上下文、独立 Reviewer、Criterion 聚合和 ST 仲裁 |
| Ledger | SQLite、事务、幂等写入、状态快照、不可变事件序列和一致性检查 |
| Recovery | Attempt Workspace/Checkpoint、返工续作、稳定状态恢复、阻塞升级和严格 Resume |
| Budget | Usage 归集、80%/100% 软预算事件、ST 决策和 Hard Limit |
| Failure | 统一 Failure Category、retryable 标记和节点/Gate/Run 追溯字段 |
| Model Adapter | 基于 Pi `ModelRuntime` 的 AgentSession NodeRunner |
| Tool | `start`、`resume`、`status`、`cancel` 和进程内 Tool-call 幂等 |
| Extension | 缓存 Pi 当前 Skill，转发 cwd、模型、thinking level、trust 和 AbortSignal |

## 4. 当前明确没有实现的能力

以下能力不应从设计文档或类型名称中推断为已经存在：

- Harness v2 Adapter；当前只有 AgentSession Adapter；
- 运行中修改已经冻结的 Workflow 拓扑或 Gate Criteria；
- 分布式 Scheduler 或跨进程 Agent 调用接管；
- 操作系统级安全沙箱；权限和 Workspace Scope 是 IPD 协议与调度约束，不是 OS 隔离；
- IPD 自己维护的长期记忆系统；
- 自动写入用户偏好、执行反思或自演进记忆；
- 精确 Review Bundle 的独立 Ledger 持久化；当前可以从 hash-bound Artifact Manifest 重建；
- 跨进程持久化的 Tool-call ID 幂等；当前 Tool Controller 的调用缓存位于进程内；
- 默认接入任意外层自定义 Tool；内置工具可直接使用，自定义 `ToolDefinition` 必须显式传给 Runtime Factory；
- 真实模型默认回归测试；仓库测试使用 faux provider，真实 Provider Eval 需要单独授权和预算。

更完整的限制和后续演进条件将记录在 `known-limitations-and-roadmap.md`。

## 5. 运行环境

### 5.1 Node.js

`packages/ipd/package.json` 当前声明：

```text
Node.js >= 24
```

V1 只支持 Node 24，不维护 Node 22 兼容分支。

### 5.2 Pi AgentDir

默认 Pi AgentDir 是：

```text
~/.pi/agent
```

如果设置了 `PI_CODING_AGENT_DIR`，IPD 使用该目录代替默认位置。默认 Runtime 从 AgentDir 读取 `models.json`、`auth.json` 和全局 IPD 资产。

### 5.3 SQLite

默认 Ledger 路径是：

```text
${agentDir}/ipd/ipd.sqlite
```

`createDefaultIpdRuntime()` 可以通过 `ledgerPath` 显式覆盖。SQLite 使用 WAL、外键和事务；不应绕过 Repository API 直接修改状态表。

### 5.4 模型

AgentCard 支持两种模型方式：

```yaml
model:
  selection: run_default
  thinkingLevel: inherit
```

`run_default` 使用调用 `ipd` Tool 时 Pi 当前会话的模型和 thinking level。

```yaml
model:
  selection: explicit
  provider: openai
  id: configured-model-id
  thinkingLevel: low
```

`explicit` 必须能在 Pi ModelRuntime 中找到，并且 Provider 已配置认证，否则 AgentCard 加载失败。

真实 `ipd.start` 会创建多个 Planner、Execution、Reviewer 和 Staff AgentSession，可能消耗大量真实模型额度。常规自动化测试必须使用 faux provider。

## 6. 资产目录

### 6.1 Skill

Pi 默认发现：

```text
~/.pi/agent/skills/<skill-name>/SKILL.md
<cwd>/.pi/skills/<skill-name>/SKILL.md
```

`ipd.start` 必须传入当前 Pi 上下文已经加载的 `skillName`。Tool Controller 读取 Skill 文件内容并计算 Snapshot Hash；未知 Skill 不创建 Run。

### 6.2 AgentCard

```text
~/.pi/agent/ipd/agent-cards/**/*.{json,yaml,yml}
<cwd>/.pi/ipd/agent-cards/**/*.{json,yaml,yml}
```

项目目录只在 `ExtensionContext.isProjectTrusted()` 为 `true` 时加载。每次 `start` 都重新扫描全部 Card；任何 Schema、引用、权限或冲突 Diagnostic 都会终止启动。

默认 Runtime 将 capability 包含 `staff-core` 的 AgentCard 固定为 ST Core，并要求其中至少一张 Card 同时包含 `workflow-planning`。该 Card 负责 Planner；预算、阻塞和质量仲裁分别优先选择具备对应治理 capability 的固定 Core 成员。ST 生成的 Workflow 必须原样保留该固定 Core。Workflow 只能引用本次加载并编译成功的 Card。

### 6.3 Workflow

Runtime 递归加载：

```text
~/.pi/agent/ipd/workflows/
<cwd>/.pi/ipd/workflows/
```

推荐将人工模板放在：

```text
~/.pi/agent/ipd/workflows/templates/
<cwd>/.pi/ipd/workflows/templates/
```

ST 生成并通过编译的 Workflow 保存到：

```text
~/.pi/agent/ipd/workflows/generated/<workflow-id>/<version>/<hash>.json
<cwd>/.pi/ipd/workflows/generated/<workflow-id>/<version>/<hash>.json
```

项目可信时写入项目 `generated` 目录，否则写入 AgentDir。相同 ID、版本和内容复用原文件；相同 ID、版本但内容不同会拒绝保存，ST 必须提升版本。

### 6.4 AgentSession Trace

默认 Runtime 将节点 Session 写入：

```text
${agentDir}/ipd/sessions/
```

Ledger 保存相关 Session ID 和 Session File，可由 Artifact、Attempt、Gate、Reviewer 和 Criterion 反向定位到具体 JSONL。

## 7. 最短运行路径

### 7.1 准备 Skill 和 AgentCard

至少需要：

- 一项当前 Pi 已加载的 Skill；
- 一组 capability 包含 `staff-core` 的固定 ST Core AgentCard，其中至少一张包含 `workflow-planning`；
- 至少一张能承担业务节点的 AgentCard；
- 至少一张 capability 能匹配 Gate Reviewer 要求、且独立于生产者的 AgentCard。

没有可用 Staff Card、Reviewer 或执行者时，ST 无法编译合法 Workflow。

### 7.2 加载 Extension 示例

从源码仓根目录启动 Pi 时，可以加载当前示例：

```bash
./pi-test.sh -e packages/ipd/examples/ipd-extension.ts
```

仅执行 `npm install` 不会把 `pi` 注册为全局命令；当前 Extension 也尚未作为自动发现的安装产物发布。

该文件只负责 Extension 适配：注册 `ipd` Tool、缓存 Pi 当前 Skill、获取上下文并调用 `IpdToolController`。它不直接写 Ledger 状态。

### 7.3 启动 Run

外层 Agent 调用的结构化参数示例：

```json
{
  "action": "start",
  "task": "生成一份经过独立质量门验收的技术方案",
  "skillName": "technical-proposal",
  "tokenBudget": 120000,
  "expectedDurationMs": 3600000,
  "hardTokenLimit": 180000
}
```

`tokenBudget` 是软预算。`hardTokenLimit` 只有用户明确提供时才存在，并且不能低于软预算。

### 7.4 处理用户问题

当结果为 `waiting_user` 时，外层 Agent 应读取结构化 `details.question`，向用户展示问题，并使用原始 `runId` 和精确 `escalationId` 恢复：

```json
{
  "action": "resume",
  "runId": "run-id",
  "escalationId": "exact-open-escalation-id",
  "answer": "用户提供的补充信息"
}
```

错误、关闭或属于其他 Run 的 Escalation ID 不会改变状态。

### 7.5 查询与取消

```json
{
  "action": "status",
  "runId": "run-id",
  "detail": "full"
}
```

`status` 是只读操作。

```json
{
  "action": "cancel",
  "runId": "run-id",
  "reason": "用户取消"
}
```

对终态 Run 重复取消不会改变既有终态。

## 8. Tool 返回值

成功 Tool 调用的 `details` 是完整 `IpdToolResult`，主要字段为：

```ts
interface IpdToolResult {
  runId: string;
  status: "running" | "waiting_user" | "succeeded" | "failed" | "cancelled";
  summary: string;
  question?: {
    escalationId: string;
    prompt: string;
    context: string;
  };
  artifacts?: ArtifactManifest[];
  failure?: IpdFailure;
  usage: BudgetSnapshot;
  details: IpdToolResultDetails;
}
```

文本 `content` 只用于外层 Agent 沟通。调用方必须根据结构化 `details.status`、`details.question`、`details.artifacts` 和 `details.failure` 判断下一步，不能解析自然语言摘要推断状态。

## 9. 代码导航

```text
packages/ipd/src/
├── ir/          AgentCard/Workflow Schema、Compiler、Hash、Scope
├── registry/    AgentCard、Workflow、Check、Artifact View 注册和文件资产加载
├── ledger/      SQLite Migration、Repository、状态机、Snapshot、Event
├── artifact/    Artifact Manifest、文件 Hash、Review Bundle
├── staff/       Workflow Planner、Reviewer Selector
├── gate/        Mechanical Checker、Dynamic Gate、Criterion Aggregator
├── runtime/     Graph Engine、Workspace Lock、预算、Failure、IpdRuntime
├── adapter/     AgentSession NodeRunner、默认 Runtime 装配、Prompt、提交 Tool
└── tool/        Tool Command Schema、Controller、Result
```

主要入口：

| 目的 | 源码入口 |
|---|---|
| 公共导出 | `src/index.ts` |
| AgentCard 编译 | `src/ir/agent-card.ts` |
| Workflow 编译 | `src/ir/compiler.ts` |
| SQLite Ledger | `src/ledger/sqlite-ledger.ts` |
| 状态转换规则 | `src/ledger/state-machine.ts` |
| Workflow 编写手册 | `src/staff/workflow-authoring-guide.ts` |
| Workflow 规划 | `src/staff/workflow-planner.ts` |
| DAG 调度 | `src/runtime/graph-engine.ts` |
| 高层 Runtime | `src/runtime/ipd-runtime.ts` |
| 动态质量门 | `src/gate/dynamic-gate-evaluator.ts` |
| AgentSession Adapter | `src/adapter/agent-session-node-runner.ts` |
| Workflow 分段提交与组装 | `src/adapter/workflow-submission-builder.ts` |
| 默认装配 | `src/adapter/default-ipd-runtime.ts` |
| Tool Controller | `src/tool/ipd-tool-controller.ts` |
| Extension 示例 | `examples/ipd-extension.ts` |

## 10. 开发验证

修改代码后，先运行受影响的精确测试。例如：

```bash
cd packages/ipd
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" \
  --run test/graph-engine.test.ts
```

需要运行仓库非 E2E 回归时，从仓库根目录使用：

```bash
./test.sh
```

所有代码修改最终必须通过：

```bash
npm run check
```

不要使用真实 Provider 编写普通回归测试。`packages/ipd/test` 中的 AgentSession 集成测试使用 faux provider，不需要 API Key，也不产生真实模型费用。

测试或脚本创建的 `__pycache__` 和 Vitest 结果缓存不应作为代码资产保留。

## 11. 事实来源优先级

如果文档和代码出现冲突，按以下顺序确定当前行为：

```text
TypeBox Schema / 状态机 / Ledger Migration
  → Runtime 与 Adapter 实际代码
  → packages/ipd/docs 当前开发文档
  → 历史构建方案、分析报告和阶段记录
```

`.agents/doc/IPD/IPD-code-build-plan.md` 是构建阶段的设计输入和决策记录，不是当前实现的最终 API 文档。修改行为时应同时更新对应源码、聚焦测试和本开发文档体系。

## 12. 文档目录

本系列按以下顺序编写：

1. [README.md](README.md)：开发者入口与当前 V1 边界；
2. [architecture.md](architecture.md)：模块结构、依赖方向和端到端调用链；
3. [workflow-ir-and-compiler.md](workflow-ir-and-compiler.md)：Workflow IR、Compiler 和不变量；
4. [agent-cards-and-assets.md](agent-cards-and-assets.md)：AgentCard、目录、加载和版本；
5. [runtime-lifecycle.md](runtime-lifecycle.md)：Graph Engine、调度和状态机；
6. [artifacts-and-gates.md](artifacts-and-gates.md)：Artifact、Check、Review Bundle 和 Gate；
7. [ledger-and-recovery.md](ledger-and-recovery.md)：SQLite、事务、事件、幂等和恢复；
8. [agent-session-adapter.md](agent-session-adapter.md)：模型、Skill、Tool、Session 和 Usage；
9. [budget-blocking-and-failures.md](budget-blocking-and-failures.md)：预算、阻塞、Escalation 和 Failure；
10. [ipd-tool-extension.md](ipd-tool-extension.md)：四类 Tool Action 和 Extension Adapter；
11. [testing-and-acceptance.md](testing-and-acceptance.md)：测试分层、faux E2E 和真实 Skill 验收；
12. [known-limitations-and-roadmap.md](known-limitations-and-roadmap.md)：当前限制和后续进入条件。

ST Planner 的运行时手册框架另见 [st-workflow-authoring-guide.md](st-workflow-authoring-guide.md)。

专题文档应以实际代码路径、协议和测试为依据，不把未实现计划写成现有功能。
