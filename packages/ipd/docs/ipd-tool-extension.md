# IPD Tool 与 Pi Extension

IPD 对外暴露一个名为 `ipd` 的 Tool，使用 discriminated union 提供 `start`、`resume`、`status`、`cancel` 四类 Action。

## 1. Tool 注册

当前 Pi Adapter 位于：

```text
packages/ipd/examples/ipd-extension.ts
```

注册信息：

```ts
name: "ipd"
label: "IPD 长程任务"
description: "启动、恢复、查询或取消一个由 Skill 驱动并经过逐节点质量门验收的 IPD 长程任务。"
executionMode: "parallel"
```

Prompt Guidelines 告诉外层 Agent：

- start 必须传当前 Pi Context 中存在的 skillName；
- waiting_user 时展示 question，并用相同 runId/escalationId 调用 resume；
- 以结构化 details 判断状态，不解析自然语言摘要。
- action 只有 `start`、`resume`、`status`、`cancel`；`retry`、`approve`、`get` 都不是合法动作；
- `failure.retryable=false` 时不得自动新建 Run。

对 Provider 暴露的是单一根对象 `IpdToolCommandParametersSchema`，使 Anthropic-compatible Tool API 能看到 action 和全部字段。`prepareArguments` 再使用严格的 discriminated-union `IpdToolCommandSchema` 校验各 action 的必填字段与额外字段，因此平面 Provider Schema 不会放宽内部命令协议。

## 2. 当前加载方式

该文件目前是源码仓 Extension 示例，不是 npm 安装后自动发现的正式产物。

从源码仓根目录运行：

```bash
./pi-test.sh -e packages/ipd/examples/ipd-extension.ts
```

如果已经构建 CLI，也可以：

```bash
./packages/coding-agent/dist/bundle/cli.js \
  -e "$PWD/packages/ipd/examples/ipd-extension.ts"
```

仅执行 `npm install` 不会把 `pi` 注册到 shell PATH。系统包管理器中的同名 `pi` 不是本仓库 CLI。

当前还没有：

- 自动安装到 `~/.pi/agent/extensions/`；
- npm 安装后的稳定 Extension export；
- 默认启用或自动发现 IPD Tool。

因此“日常开箱使用”仍是产品化缺口。

## 3. Command Schema

### 3.1 start

```ts
{
  action: "start";
  task: string;
  skillName: string;
  workflowTemplateId?: string;
  tokenBudget?: number;          // minimum 4
  expectedDurationMs?: number;   // minimum 1
  hardTokenLimit?: number;       // minimum 1
}
```

额外字段被拒绝。Runtime 还要求 Hard Limit 不低于软预算。

### 3.2 resume

```ts
{
  action: "resume";
  runId: string;
  escalationId: string;
  answer: string;
}
```

三个字符串都必须非空。

### 3.3 status

```ts
{
  action: "status";
  runId: string;
  detail?: "summary" | "nodes" | "full";
}
```

默认 detail=`summary`。

### 3.4 cancel

```ts
{
  action: "cancel";
  runId: string;
  reason?: string;
}
```

reason 如果提供必须非空。

## 4. `before_agent_start` 和 Skill

Extension 监听：

```text
before_agent_start
```

从 `event.systemPromptOptions.skills` 缓存：

```text
name
filePath
baseDir
```

它不使用 `loadSkills()` 再扫描目录，因此 Tool 看到的是 Pi 本轮实际装配的 Skill 列表。

start/resume 时 Controller：

1. 读取当前缓存中的 Skill 文件；
2. 创建不可变 content Hash Snapshot；
3. 要求当前模型存在；
4. 传给 Runtime。

start 的 `skillName` 不存在时，在 AssetProvider 和 Planner 创建 Run 前返回 `unknown_skill`。

resume 不带 skillName。Runtime 根据 Run 冻结的 name+hash 从当前 Snapshot 集合找回 Skill；文件变化或 Skill 不再加载时返回 `skill_unavailable`。

status/cancel 不读取 Skill，也不要求当前模型。

## 5. 上下文转发

Extension 传递：

| Pi Context | IPD 用途 |
|---|---|
| `ctx.cwd` | Workspace、项目资产和节点执行目录 |
| `ctx.model` | run_default 模型 |
| `ctx.thinkingLevel` | inherit thinking level |
| `ctx.modelRegistry` | 默认 Runtime 同步 Provider |
| `ctx.isProjectTrusted()` | 是否加载 `<cwd>/.pi/ipd` |
| Tool signal + `ctx.signal` | 合并 AbortSignal |

如果 Tool Signal 和 Context Signal 不同，Extension 使用 `AbortSignal.any()`。

## 6. Runtime 生命周期

Extension 对首次 Tool 调用惰性创建：

```text
Promise<IpdRuntime>
Promise<IpdToolController>
```

同一 Extension 实例内后续 Action 复用同一 Runtime、Ledger 和 Controller。`session_shutdown` 时关闭 Runtime/Ledger。

如果首次调用是 status/cancel，也会先创建默认 Runtime 以访问 Ledger。

## 7. Tool-call 幂等

Controller 使用：

```text
toolCallId → { requestHash, Promise<IpdToolResult> }
```

requestHash 当前包含：

```text
command
cwd
```

规则：

- 相同 Tool ID、相同 command、相同 cwd：返回同一个 Promise；
- 相同 Tool ID 但输入不同：同步抛出 `idempotency_conflict`；
- 失败 Promise 也会缓存；
- 不同 Tool ID 的相同 start 会创建不同 Run；
- 缓存不写 SQLite，进程重启后丢失。

模型、thinking level 和 Skill 文件 Hash 当前不在 Tool requestHash 中；同一 Tool ID 重放始终以首次 Promise 为准。

## 8. start 行为

```text
Controller Snapshot 当前全部 Skill
  → 找到 skillName
  → Runtime 校验预算
  → 每次重新加载 AgentCard/Workflow Assets
  → 固定 Staff Core
  → Planner 生成和冻结 Workflow
  → GraphEngine 执行到 succeeded/failed/cancelled/waiting_user
  → 返回完整 IpdToolResult
```

当前 start Tool 调用等待 Planner 和 GraphEngine 到达稳定结果，不是创建后台任务后立即返回 runId。Tool 标记 parallel，使 Pi 可以并行执行独立 Tool Call，但调用者通常在 start 返回后才知道新 runId。

## 9. resume 行为

```text
读取全部当前 Skill Snapshot
  → Run 存在
  → 找到冻结 Skill name+hash
  → GraphEngine.resume
  → 回答精确 Escalation
  → 恢复 Graph
  → 返回完整结果
```

GraphEngineError 会转换为 IpdRuntimeError，Extension 返回结构化错误。

## 10. status 行为

status 直接调用 `runtime.status()`，不写 Event 或状态。

detail：

### summary

```ts
{
  detail: "summary";
  run: RunRecord;
  escalations: EscalationRecord[];
}
```

### nodes

增加：

```text
nodes
gates
```

### full

```ts
{
  detail: "full";
  snapshot: RunSnapshot;
}
```

无论 detail，顶层 Result 仍包含公开 status、question、accepted artifacts、failure 和 usage。

## 11. cancel 行为

活动 Run 会 abort Node/Gate 并等待稳定取消结果；非活动非终态 Run 直接进入 cancelled；终态 Run 返回原状态。

不同 Tool ID 的重复 cancel 依靠 Graph/Ledger 终态与幂等规则保持安全。

## 12. IpdToolResult

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

### 12.1 status

内部 planning、compiling、ready、running 映射为公开 `running`。

### 12.2 artifacts

当前返回 Snapshot 中全部 accepted Artifact，而不只返回 `finalArtifactNodeIds` 的文件。调用方需要根据 Manifest `nodeId` 或完整 Workflow 判断最终交付。

### 12.3 usage

汇总全部 Budget Usage，并给出 staff/execution/review/rework 分类 Token。

### 12.4 failure

只有 Run `failure_json` 符合完整 IpdFailure 结构时返回。Node/Gate 局部错误需要查看 full details。

## 13. AgentToolResult

Extension 成功时：

```ts
{
  content: [{ type: "text", text: conciseText }],
  details: IpdToolResult
}
```

失败时：

```ts
{
  content: [{ type: "text", text: "IPD Tool 调用失败：..." }],
  details: {
    error: { code, message, diagnostics? }
  },
  isError: true
}
```

文本摘要可能变化；外层 Agent 应读取 `details.status`、`details.question`、`details.artifacts` 和 `details.failure`。

## 14. 完整调用示例

### start

```json
{
  "action": "start",
  "task": "根据仓库事实生成经过独立验证的技术分析",
  "skillName": "technical-analysis",
  "workflowTemplateId": "reviewed-analysis",
  "tokenBudget": 120000,
  "expectedDurationMs": 3600000,
  "hardTokenLimit": 180000
}
```

### waiting result

```json
{
  "runId": "run-123",
  "status": "waiting_user",
  "summary": "IPD 任务等待用户补充信息（Run: run-123）",
  "question": {
    "escalationId": "run-123:escalation:analysis:attempt-1",
    "prompt": "请确认允许使用哪项正式数据源",
    "context": "{\"nodeId\":\"analysis\"}"
  },
  "usage": {
    "totalTokens": 24500,
    "softTokenLimit": 120000,
    "byCategory": {
      "staff": 6000,
      "execution": 12000,
      "review": 6500,
      "rework": 0
    }
  }
}
```

该示例省略了其他 Usage 数字字段和内部 details。

### resume

```json
{
  "action": "resume",
  "runId": "run-123",
  "escalationId": "run-123:escalation:analysis:attempt-1",
  "answer": "使用 data/approved.csv"
}
```

### status

```json
{
  "action": "status",
  "runId": "run-123",
  "detail": "nodes"
}
```

### cancel

```json
{
  "action": "cancel",
  "runId": "run-123",
  "reason": "用户停止本次任务"
}
```

## 15. 对应测试

- `test/ipd-tool-command.test.ts`：四类 Schema 和 Action 字段隔离；
- `test/ipd-extension-e2e.test.ts`：Skill 缓存、上下文、AbortSignal、重复 start、status、resume、cancel 和结构化结果；
- `test/graph-engine.test.ts`：严格 Resume 和取消；
- `test/default-ipd-runtime.test.ts`：固定 Staff Core 选择。
