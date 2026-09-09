# IPD Tool 与 Pi Extension

IPD 对外暴露一个模型可调用的 `ipd` Tool，以及一个只能由用户触发的 `/ipd-resume` Extension Command。Tool 使用 discriminated union 提供 `start`、`resume_run`、`status`、`watch`、`cancel` 五类 Action。

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
- waiting_user 时展示 question 和 `/ipd-resume <runId> <escalationId>`，不得代替用户回答；
- 以结构化 details 判断状态，不解析自然语言摘要。
- action 只有 `start`、`resume_run`、`status`、`watch`、`cancel`；`resume`、`retry`、`approve`、`get` 都不是合法模型动作；
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

当前仓库项目设置另外固定安装：

```text
npm:pi-web-access@0.27.0
```

项目被信任后，Pi 会先加载该 Package Extension，注册 `web_search`、`fetch_content`、`source_check` 和 `get_search_content`；IPD Runtime 首次创建时通过 `pi.getToolDefinitions()` 继承这些定义。IPD 不再内置 Bing RSS 搜索后端，也不会在缺少外部搜索 Extension 时伪造降级结果。

## 3. Command Schema

### 3.1 start

```ts
{
  action: "start";
  task: string;
  skillName: string;
  workflowTemplateId?: string;
  workflowTemplateVersion?: string;
  workflowTemplateHash?: string;
  ifBudget?: boolean;            // default false
  tokenBudget?: number;          // minimum 4
  timeBudgetMs?: number;         // minimum 1
  expectedDurationMs?: number;   // estimate only
  hardTokenLimit?: number;       // minimum 1
}
```

额外字段被拒绝。Version/Hash 只有与 `workflowTemplateId` 同时提供时才合法；只给 ID 时按 SemVer 选择最新版本。默认 `ifBudget=false`，此时不能传 Token/时间/Hard Limit，Runtime 不设置 IPD 预算上限。`ifBudget=true` 时必须同时提供 `tokenBudget` 和 `timeBudgetMs`，Hard Limit 不能低于软预算。`expectedDurationMs` 只记录预估。

### 3.2 用户 `/ipd-resume`

```text
/ipd-resume <runId> <escalationId>
```

该命令不属于 Tool Schema，LLM 无法调用。Command 先验证 Run 当前确实等待精确 Escalation，再让用户从 `allowedResolutions` 中选择明确动作，然后采集非空回答并要求二次确认，最后调用 `IpdToolController.resumeAsUser()`。取消选择、输入或确认时 Run 保持 waiting_user。成功回答会写入 `user_answer_receipt` Decision，记录 resolution、`source=user_command` 和接收时间。

### 3.3 status

```ts
{
  action: "status";
  runId: string;
  detail?: "summary" | "nodes" | "full";
}
```

默认 detail=`summary`。

### 3.4 resume_run

```ts
{
  action: "resume_run";
  runId: string;
}
```

用于 Pi 进程退出后按 Run ID 接管 `planning/compiling/replanning/ready/running` Run，不回答 Escalation，也不创建新 Run。冻结 Skill name/hash 必须仍存在于当前 Pi Context。

### 3.5 watch

```ts
{
  action: "watch";
  runId: string;
  afterSequence?: number;
  detail?: "summary" | "nodes" | "full";
}
```

watch 是带 Event cursor 的只读 status；`changedSinceSequence` 表示最新 sequence 是否大于调用方游标。

### 3.6 cancel

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

start/resume_run 和用户 Command 恢复时 Controller：

1. 读取当前缓存中的 Skill 文件；
2. 创建不可变 content Hash Snapshot；
3. 要求当前模型存在；
4. 传给 Runtime。

start 的 `skillName` 不存在时，在 AssetProvider 和 Planner 创建 Run 前返回 `unknown_skill`。

用户 Command 恢复不带 skillName。Runtime 根据 Run 冻结的 name+hash 从当前 Snapshot 集合找回 Skill；文件变化或 Skill 不再加载时返回 `skill_unavailable`。

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
  → 启动后台 Planner/Graph
  → 立即返回 running + runId
```

后台执行不绑定 start Tool 的 AbortSignal。调用者使用 status 查询当前快照，或使用 `watch {runId, afterSequence}` 判断是否出现新事件。

## 9. 用户 Command Resume 行为

```text
用户输入 /ipd-resume runId escalationId
  → 校验匹配的 waiting_user question
  → Pi UI 选择允许的恢复动作
  → 输入回答并二次确认
  → 读取全部当前 Skill Snapshot
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
    allowedResolutions: Array<"retry_node" | "request_replan" | "continue_run" | "fail_run">;
  };
  artifacts?: ArtifactManifest[];
  failure?: IpdFailure;
  progress: {
    phase: string;
    workflowRevision?: number;
    activeNodeIds: string[];
    readyNodeIds: string[];
    waitingNodeIds: string[];
    lastEvent?: { sequence: number; type: string; timestamp: number };
    changedSinceSequence?: boolean;
    runRoot?: string;
  };
  usage: BudgetSnapshot;
  details: IpdToolResultDetails;
}
```

### 12.1 status

内部 planning、compiling、replanning、ready、running 映射为公开 `running`。

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
  "ifBudget": true,
  "tokenBudget": 120000,
  "timeBudgetMs": 3600000,
  "expectedDurationMs": 2400000,
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
    "context": "{\"nodeId\":\"analysis\"}",
    "allowedResolutions": ["retry_node", "request_replan", "fail_run"]
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

### 用户 Resume

```text
/ipd-resume run-123 run-123:escalation:analysis:attempt-1
```

### status

```json
{
  "action": "status",
  "runId": "run-123",
  "detail": "nodes"
}
```

### resume_run

```json
{
  "action": "resume_run",
  "runId": "run-123"
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

- `test/ipd-tool-command.test.ts`：五类模型 Tool Schema、Action 字段隔离和模型 resume 拒绝；
- `test/ipd-extension-e2e.test.ts`：Skill 缓存、上下文、AbortSignal、重复 start、status、用户 Command resume、cancel 和结构化结果；
- `test/graph-engine.test.ts`：严格 Resume 和取消；
- `test/default-ipd-runtime.test.ts`：固定 Staff Core 选择。
