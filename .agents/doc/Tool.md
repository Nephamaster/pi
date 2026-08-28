# 总体设计

这套工具系统的核心不是简单的 `name + execute()`，而是把工具拆成五个相对独立的维度：

```text
给模型看的声明
    ↓
运行时执行定义
    ↓
策略与权限 hook
    ↓
结果协议与持久化
    ↓
TUI 展示
```

对应三种主要类型：

| 类型 | 所在层 | 主要职责 |
|---|---|---|
| `Tool` | `pi-ai` | 模型可见的名称、描述、参数 schema |
| `AgentTool` | `pi-agent-core` | 增加执行函数、参数预处理、并发策略 |
| `ToolDefinition` | `coding-agent` | 增加 system prompt、扩展上下文和 UI renderer |

相关入口：

- [`pi-ai Tool`](D:/Code/NLP/Agent/pi/packages/ai/src/types.ts:502)
- [`AgentTool`](D:/Code/NLP/Agent/pi/packages/agent/src/types.ts:361)
- [`ToolDefinition`](D:/Code/NLP/Agent/pi/packages/coding-agent/src/core/extensions/types.ts:449)
- [`agent-loop 工具执行`](D:/Code/NLP/Agent/pi/packages/agent/src/agent-loop.ts:411)



# 一、工具从注册到模型可见

## 1. 工具声明

模型真正需要知道的只有：

```ts
interface Tool {
  name: string;
  description: string;
  parameters: TSchema;
  constrainedSampling?: false | ConstrainedSamplingConfig;
}
```

例如 `read` 的 schema：

```ts
Type.Object({
  path: Type.String(),
  offset: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
})
```

这些信息被放入模型请求的：

```ts
Context {
  systemPrompt,
  messages,
  tools
}
```

各 provider adapter 再把统一 `Tool` 转成 OpenAI、Anthropic、Google 等供应商自己的 tool/function 格式。

因此，agent loop 不处理供应商工具协议，只接收统一的最终结构：

```ts
{
  type: "toolCall",
  id: "call_123",
  name: "read",
  arguments: {
    path: "src/index.ts"
  }
}
```

## 2. `AgentTool`

运行时在模型声明之上增加：

```ts
interface AgentTool {
  name;
  label;
  description;
  parameters;
  prepareArguments?;
  executionMode?;
  execute(...);
}
```

字段语义：

- `name`：模型调用使用的稳定标识。
- `label`：UI 展示名称。
- `description`：发给模型。
- `parameters`：TypeBox/JSON Schema 参数约束。
- `prepareArguments`：兼容模型输出缺陷，在正式校验前修正参数。
- `executionMode`：该工具是否要求整个调用批次顺序执行。
- `execute`：真正产生副作用或查询结果。

## 3. `ToolDefinition`

`coding-agent` 又增加了：

```ts
promptSnippet?
promptGuidelines?
renderShell?
renderCall?
renderResult?
execute(..., ctx: ExtensionContext)
```

这里形成一个很好的分离：

- `description`、`parameters` 面向模型。
- `execute` 面向运行时。
- `promptSnippet`、`promptGuidelines` 面向 system prompt。
- `renderCall`、`renderResult` 面向 TUI。
- `details` 面向 UI、日志和持久化。

[`tool-definition-wrapper.ts`](D:/Code/NLP/Agent/pi/packages/coding-agent/src/core/tools/tool-definition-wrapper.ts) 负责把 `ToolDefinition` 转成核心层能执行的 `AgentTool`。



# 二、工具注册表与活动工具集

工具注册由 [`AgentSession`](D:/Code/NLP/Agent/pi/packages/coding-agent/src/core/agent-session.ts:2463) 管理。

系统维护两个注册表：

```text
_toolDefinitions
    完整定义：prompt 元数据、renderer、sourceInfo

_toolRegistry
    运行时 AgentTool：真正交给 Agent 执行
```

工具来源有三种：

- 内置工具
- 扩展通过 `registerTool()` 注册的工具
- SDK 通过 `customTools` 或 `baseToolsOverride` 提供的工具

注册表构建顺序是：

```text
内置工具
→ 扩展工具
→ SDK 自定义工具
```

同名自定义工具会覆盖内置工具。

## 活动工具

内置工具总共有：

```text
read bash edit write grep find ls
```

默认活动的是：

```text
read bash edit write
```

`grep`、`find`、`ls` 默认注册但不暴露，因为 `bash` 可以覆盖相当一部分查询能力。

工具还会经过：

- `allowedToolNames`
- `excludedToolNames`
- `initialActiveToolNames`

过滤。

调用 [`setActiveToolsByName()`](D:/Code/NLP/Agent/pi/packages/coding-agent/src/core/agent-session.ts:920) 会同时：

1. 更新 `agent.state.tools`；
2. 根据活动工具重新构建 system prompt；
3. 在下一 turn 更新模型请求中的工具集合。

所以“启用工具”不仅是执行权限变化，也会改变模型看到的提示词和 schema。



# 三、模型如何产生工具调用

模型流式输出时可能依次发出：

```text
toolcall_start
toolcall_delta
toolcall_delta
toolcall_end
```

这些事件只用于构造部分 `AssistantMessage` 和更新 UI。

工具不会在 `toolcall_start` 时执行。只有整个 assistant 消息最终完成后，agent loop 才会提取：

```ts
message.content.filter(c => c.type === "toolCall")
```

然后执行工具。

这样做是必要的，因为流式参数通常是不完整 JSON：

```text
delta 1: {"path":
delta 2: "src/index
delta 3: .ts"}
```

提前执行会产生不可恢复的副作用风险。

## 特殊 stop reason

收到 assistant 最终消息后：

- `error`：不执行任何工具，结束 Agent。
- `aborted`：不执行任何工具，结束 Agent。
- `length`：所有工具调用都转换成错误结果，不执行。
- 其他 stop reason：只要存在 tool call 就执行。

`length` 特别处理是因为 provider 的 JSON salvage 可能把截断参数修成“语法合法但内容缺失”的对象。例如：

```json
{"path":"src/in"}
```

它甚至可能通过 schema 校验，但显然不应该被执行。



# 四、工具调用的三阶段执行模型

每个调用被分成：

```text
Phase 1：prepare / clearance
Phase 2：execute effect
Phase 3：finalize
```

这是整个设计最重要的部分。

## Phase 1：准备和放行

实现在 [`prepareToolCall()`](D:/Code/NLP/Agent/pi/packages/agent/src/agent-loop.ts:600)。

顺序是：

```text
查找工具
→ prepareArguments
→ schema 校验
→ beforeToolCall
→ abort 检查
```

### 1. 查找工具

从当前 turn 快照里的 `currentContext.tools` 按名称查找。

找不到时产生错误结果：

```text
Tool xxx not found
```

不会抛出到整个 Agent 外部。

### 2. `prepareArguments`

这是模型兼容层，不是业务校验层。

例如 `edit` 会处理：

- 某些模型把 `edits` 输出成 JSON 字符串；
- 旧格式使用顶层 `oldText`、`newText`。

它会先转换成当前 schema，再进入正式校验。

### 3. schema 校验

[`validateToolArguments()`](D:/Code/NLP/Agent/pi/packages/ai/src/utils/validation.ts:285) 会：

1. `structuredClone()` 原始参数；
2. 尝试 TypeBox `Value.Convert()`；
3. 对普通 JSON Schema 做兼容类型转换；
4. 执行 schema validator；
5. 失败时生成包含路径和原始参数的详细错误。

例如：

```text
Validation failed for tool "read":
  - /path: Expected string

Received arguments:
{
  "path": 123
}
```

校验失败只产生一个 `isError` 工具结果，模型可以自行修正并再次调用。

### 4. `beforeToolCall`

核心 hook 收到：

```ts
{
  assistantMessage,
  toolCall,  // 原始调用
  args,      // 校验后的参数
  context
}
```

可以返回：

```ts
{
  block: true,
  reason: "Operation requires approval",
  terminate: true
}
```

如果被阻止：

- 不运行 `execute`；
- 生成 `isError: true` 的 toolResult；
- `reason` 返回给模型；
- `terminate` 参与批次终止判定。



# 五、扩展层的 `tool_call` hook

`AgentSession` 把核心 `beforeToolCall` 桥接到扩展事件：

```ts
pi.on("tool_call", async (event, ctx) => {
  // event.input 已经通过 schema 校验

  if (event.toolName === "bash") {
    return {
      block: true,
      reason: "Shell execution denied"
    };
  }
});
```

实现位于 [`AgentSession._installAgentToolHooks()`](D:/Code/NLP/Agent/pi/packages/coding-agent/src/core/agent-session.ts:479)。

多个扩展 handler 按扩展注册顺序串行执行：

- 所有 handler 共享同一个 `event.input`。
- 前面的 handler 可以原地修改参数。
- 后面的 handler 能看到修改结果。
- 第一个返回 `block: true` 的 handler 立即结束链路。
- handler 抛异常会阻止执行并生成错误结果。

一个重要边界是：

> 扩展对 `event.input` 的修改发生在 schema 校验之后，修改后不会重新校验。

因此扩展可以进行灵活修正：

```ts
event.input.timeout = Math.min(event.input.timeout, 60);
```

但也可能把合法参数改成非法参数。权限或参数重写扩展必须自行保证修改后的结构正确。

未知工具、schema 非法、响应 `length` 等在进入 hook 前就已经失败，因此不会触发 `tool_call` hook。



# 六、Phase 2：执行工具副作用

实现在 [`executePreparedToolCall()`](D:/Code/NLP/Agent/pi/packages/agent/src/agent-loop.ts:670)。

调用签名：

```ts
execute(
  toolCallId,
  validatedArgs,
  signal,
  onUpdate
)
```

## 错误归一化

工具实现应当在失败时抛异常：

```ts
throw new Error("File not found");
```

agent loop 会转换成：

```ts
{
  content: [
    { type: "text", text: "File not found" }
  ],
  details: {}
}
```

并设置：

```ts
isError: true
```

所以单个工具失败不会击穿整个 agent loop。模型会看到错误结果，可以选择修正参数、换工具或向用户解释。

## 流式更新

长时间工具可以调用：

```ts
onUpdate({
  content: [{ type: "text", text: partialOutput }],
  details: partialDetails
});
```

产生：

```text
tool_execution_update
```

这些 partial result：

- 只用于 UI 和观察者；
- 不写入模型上下文；
- 不持久化为正式 toolResult；
- 不参与最终返回值；
- 工具 Promise settle 后再调用会被忽略。

agent loop 会等待已经发出的 update 事件处理完成，然后才进入 finalization，保证最终事件不会越过仍在处理的 partial update。



# 七、Phase 3：结果 finalization

实现在 [`finalizeExecutedToolCall()`](D:/Code/NLP/Agent/pi/packages/agent/src/agent-loop.ts:713)。

工具执行后调用 `afterToolCall`：

```ts
{
  assistantMessage,
  toolCall,
  args,
  result,
  isError,
  context
}
```

可以按字段覆盖：

```ts
{
  content?,
  details?,
  isError?,
  usage?,
  terminate?
}
```

覆盖是浅层字段替换，不会深度 merge。

例如：

```ts
return {
  content: redactSecrets(result.content),
  isError: false
};
```

如果工具本身抛异常，`afterToolCall` 仍然会收到错误结果，因此它可以：

- 添加诊断信息；
- 对错误脱敏；
- 把特定错误恢复成成功结果。

但如果 `afterToolCall` 自己抛异常，原始结果会被替换成 hook 的错误结果。此时工具副作用可能已经发生，只是模型得到的是失败信息。



# 八、扩展层的 `tool_result` hook

扩展可以修改最终结果：

```ts
pi.on("tool_result", async (event, ctx) => {
  return {
    content: sanitize(event.content),
    details: event.details,
    isError: event.isError
  };
});
```

多个 handler 同样串行运行：

```text
handler 1 输出
→ 更新 currentEvent
→ handler 2 看到 handler 1 的结果
→ ...
```

可以覆盖：

- `content`
- `details`
- `isError`
- `usage`

扩展 `tool_result` 当前不能设置 `terminate`。

与 `tool_call` 不同，某个 `tool_result` handler 抛异常时：

- ExtensionRunner 记录扩展错误；
- 继续运行其他 handler；
- 不把工具结果整体转换成失败。

完成扩展 hook 后，`AgentSession` 还会统一处理图片：

- 必要时缩放；
- 修正格式；
- 添加处理提示；
- 失败时保留原始图片，不静默丢失。

相关实现：

- [`runner.ts`](D:/Code/NLP/Agent/pi/packages/coding-agent/src/core/extensions/runner.ts:877)
- [`tool-result-images.ts`](D:/Code/NLP/Agent/pi/packages/coding-agent/src/utils/tool-result-images.ts:22)

立即失败的调用，例如未知工具、校验失败、被 block，不经过 `afterToolCall/tool_result`，但仍会产生执行结束和消息事件。



# 九、工具结果协议

工具返回：

```ts
interface AgentToolResult<TDetails> {
  content: (TextContent | ImageContent)[];
  details: TDetails;
  usage?: Usage;
  addedToolNames?: string[];
  terminate?: boolean;
}
```

## `content`

模型可见的正式结果：

```ts
[
  { type: "text", text: "Successfully wrote file" },
  { type: "image", data: "...base64...", mimeType: "image/png" }
]
```

应保持紧凑，因为它会占用模型上下文。

## `details`

主要提供给：

- TUI renderer
- 日志
- Session JSONL
- SDK 调用者

例如 `edit` 的 details：

```ts
{
  diff,
  patch,
  firstChangedLine
}
```

provider 通常不会把 `details` 作为工具文本发送给模型。

## `usage`

记录工具自身可能产生的模型或计算用量，但不并入主 LLM 上下文 token accounting。

## `addedToolNames`

表示这个工具运行后，哪些工具从当前 transcript 位置开始可用。

它主要支持 provider 的 deferred tool loading：

```text
调用 load_tools
→ result.addedToolNames = ["database_query"]
→ 后续 provider 请求从这个位置加载 database_query schema
```

对于不支持原生 deferred tools 的 provider，仍然直接使用当前 `Context.tools`。

## `terminate`

不写入最终 `ToolResultMessage`，只用于控制当前批次后的自动继续。

批次只有在以下条件下才终止：

```ts
所有 finalized result 的 terminate 都是 true
```

例如：

```text
A terminate=true
B terminate=false
→ 继续调用模型
```

这样一个并行工具不能单独意外终止整个批次。

`terminate` 只禁止“因为工具结果而自动继续”。新的 steering 或 follow-up 消息仍可启动下一 turn。



# 十、并行与顺序执行

默认模式是：

```ts
toolExecution = "parallel"
```

选择规则：

```text
全局 sequential
    → 整批顺序执行

批次中任意工具 executionMode="sequential"
    → 整批顺序执行

否则
    → 并行执行
```

## 顺序模式

每个调用完整走完：

```text
start
→ prepare
→ execute/update
→ after
→ end
→ toolResult message
→ 下一个调用
```

abort 后，当前调用 settle，后续调用不再开始。

## 并行模式

并行模式不是简单的 `Promise.all(tool.execute)`，而是：

```text
按模型源顺序执行所有 preflight
→ 被允许的调用并发执行
→ tool_execution_end 按完成顺序发出
→ toolResult message 按模型源顺序写入
```

例如模型返回：

```text
A：慢工具
B：快工具
```

典型事件顺序：

```text
tool_execution_start A
tool_execution_start B
tool_execution_update A
tool_execution_end B
tool_execution_end A
message_start toolResult(A)
message_end   toolResult(A)
message_start toolResult(B)
message_end   toolResult(B)
turn_end
```

这里刻意区分两种顺序：

- 完成事件按真实时间顺序，UI 能立即看到快工具完成。
- 正式消息按模型调用顺序，保证上下文和 JSONL 确定性。

如果某个调用在 preflight 阶段立即失败，它可能在其他实际 effect 启动前就发出 `tool_execution_end`。



# 十一、完整事件序列

单个成功工具调用的事件顺序：

```text
message_start assistant
message_update...
message_end assistant

tool_execution_start
tool_execution_update...
tool_execution_end

message_start toolResult
message_end toolResult

turn_end
turn_start
下一次模型请求
```

`tool_execution_start` 更准确地表示“开始处理这个调用”，因为它发生在工具查找和参数校验之前，不保证副作用已经开始。

`Agent` 在接到事件时会先更新内部状态：

- `tool_execution_start`：加入 `pendingToolCalls`
- `tool_execution_end`：移除 `pendingToolCalls`
- `message_end`：正式追加到消息列表

然后顺序等待 listener。

因此 `AgentSession` 收到 `message_end(toolResult)` 时，Agent 状态已经包含该结果。



# 十二、持久化语义

`AgentSession` 处理事件的顺序是：

```text
扩展事件
→ UI/SDK listeners
→ SessionManager 持久化
```

在 `message_end` 时，以下消息都会写入当前 JSONL 会话树：

```text
user
assistant
toolResult
```

因此：

- partial tool update 不持久化；
- final tool result 持久化；
- 并行结果按 assistant 源顺序持久化；
- `details`、`usage`、`addedToolNames` 一并保存；
- `terminate` 不保存。

当前生产链路存在一个重要崩溃窗口：

```text
工具副作用已经发生
→ 进程崩溃
→ toolResult 尚未写入 JSONL
```

恢复后无法确定工具是“没有执行”还是“执行成功但没记录”。

因此当前工具系统不提供 exactly-once，即“副作用恰好执行一次”保证。



# 十三、七个内置工具

| 工具 | 功能 | 关键设计 |
||||
| `read` | 读取文本或图片 | 支持 offset/limit、图片缩放、头部截断 |
| `bash` | 执行 shell 命令 | 流式输出、超时、abort、进程树终止、尾部截断 |
| `edit` | 精确替换文件片段 | 多块编辑、唯一匹配、重叠检测、diff/patch |
| `write` | 创建或完整覆盖文件 | 自动创建父目录 |
| `grep` | 搜索文件内容 | ripgrep、regex/literal、上下文行、匹配上限 |
| `find` | 按 glob 搜索文件 | fd、`.gitignore`、结果上限 |
| `ls` | 列出目录 | 排序、目录 `/` 后缀、数量上限 |

## 统一输出限制

默认限制定义在 [`truncate.ts`](D:/Code/NLP/Agent/pi/packages/coding-agent/src/core/tools/truncate.ts:11)：

```text
2000 行
50 KB
```

- `read` 保留头部，并提示下一次 `offset`。
- `bash` 保留尾部，并把完整输出写到临时文件。
- `grep/find/ls` 保留头部并给出缩小查询或提高 limit 的提示。
- grep 单行额外限制为 500 字符。

这是 agent 工具设计中的重要原则：工具必须主动控制返回上下文，而不能把无限输出直接送给模型。

## 可替换 operations

每个内置工具基本都把底层 I/O 抽象成 operations：

```ts
ReadOperations
BashOperations
EditOperations
WriteOperations
GrepOperations
FindOperations
LsOperations
```

例如可以把 bash 替换成 SSH：

```text
AgentTool
→ BashOperations.exec()
→ SSH host
```

而 agent loop 不需要变化。

## 文件修改并发

`edit` 和 `write` 使用 [`file-mutation-queue.ts`](D:/Code/NLP/Agent/pi/packages/coding-agent/src/core/tools/file-mutation-queue.ts)。

语义是：

- 同一真实文件的修改顺序执行；
- 不同文件仍可并发；
- 队列只在当前 Node 进程内生效；
- `read` 不进入 mutation queue；
- 多进程之间仍可能竞争。

`edit` 会先在内存中完成所有匹配和冲突检查，再执行一次写入。因此一个调用中不会出现“前两个 replacement 已应用，第三个才发现不匹配”的逻辑半完成状态，但实际文件写入本身不是事务性 temp-file rename。



# 十四、`edit` 为什么设计得比较复杂

[`edit-diff.ts`](D:/Code/NLP/Agent/pi/packages/coding-agent/src/core/tools/edit-diff.ts:304) 的规则是：

1. 所有 `oldText` 都匹配原始文件，而不是前一个 replacement 的结果。
2. 每个 `oldText` 必须唯一。
3. 多个 edit 不能重叠。
4. replacement 按位置逆序应用，避免前面的修改破坏后续 offset。
5. 支持一定程度的 fuzzy whitespace 匹配。
6. fuzzy 情况下尽量保留未修改行的原始字节。
7. 保留 BOM 和原始换行符风格。
8. 结果生成 display diff 和标准 unified patch。

例如：

```text
原文件：A B C D

edit 1：A → X
edit 2：C → Y
```

两个 edit 都对 `A B C D` 匹配，最终再逆序应用，而不是先得到 `X B C D` 后再匹配第二个。

这让多块 edit 的语义稳定、可预览、可验证。



# 十五、Bash 的流式执行

[`bash.ts`](D:/Code/NLP/Agent/pi/packages/coding-agent/src/core/tools/bash.ts:320) 的执行流程是：

```text
解析 timeout
→ 添加 commandPrefix
→ spawnHook 修改 command/cwd/env
→ 创建 shell 子进程
→ 合并采集 stdout/stderr
→ 每 100ms 最多发送一次 partial update
→ abort/timeout 时杀进程树
→ 等待进程 settle
→ 生成最终结果
```

行为细节：

- 没有默认 timeout。
- timeout 单位为秒。
- 非零 exit code 被视为工具错误。
- 错误内容仍包含命令已有输出。
- 输出过大时只向模型返回最后 2000 行或 50KB。
- 完整输出写入临时文件。
- 可以暴露 `PI_SESSION_ID`、`PI_MODEL` 等环境变量。
- `spawnHook` 可以修改命令、cwd 和环境变量。
- Windows 下使用平台 shell 配置，工具名虽叫 `bash`，不代表一定启动 GNU Bash。



# 十六、TUI 展示

[`ToolExecutionComponent`](D:/Code/NLP/Agent/pi/packages/coding-agent/src/modes/interactive/components/tool-execution.ts) 独立管理每个 `toolCallId`。

组件状态包括：

```text
流式参数
参数是否完整
执行是否开始
partial result
final result
展开/折叠
error/success/pending 背景
renderer 私有状态
```

工具可以实现：

```ts
renderCall(args, theme, context)
renderResult(result, options, theme, context)
```

如果 renderer 抛异常，TUI 会回退到通用文本渲染，不影响工具执行。

图片结果会根据终端能力使用 Kitty 等协议展示，不支持时退化为文本提示。

因此 UI renderer 是纯展示能力，不处于副作用执行链上。



# 十七、安全边界

当前核心没有内置 sandbox 或逐调用批准框。

具体表现：

- `bash` 使用当前用户权限。
- 文件路径允许绝对路径、`~`、`../`。
- cwd 是相对路径解析基准，不是安全边界。
- allowed/excluded tools 只是模型暴露控制，不是运行时授权系统。
- Project Trust 只控制是否加载项目扩展和资源。
- `beforeToolCall/tool_call` 是实现审批、路径限制和命令策略的主要 hook。
- `AbortSignal` 只是协作式取消；自定义工具必须主动处理。
- 第三方 operations 或扩展工具可能忽略 abort。

如果要实现权限系统，合理位置是：

```text
tool_call hook
→ 规范化参数
→ 路径/命令分析
→ 用户确认或策略判断
→ block / allow
```

但因为扩展修改参数后不重新校验，安全扩展最好在最终放行前自行再次验证。



# 十八、Harness v2 将如何改进工具执行

Harness v2 设计文档在 [`harness-v2.md`](D:/Code/NLP/Agent/pi/packages/agent/docs/harness-v2.md:2330)。

它计划在当前三阶段模型中插入 durable boundary：

```text
规划整个工具批次
→ 为每个结果分配 durable id
→ 持久化 tool batch plan
→ clearance
→ 持久化 tool_started
→ 执行副作用
→ 按源顺序持久化结果
```

工具还会声明：

```ts
replay?: "never" | "safe"
```

恢复规则大致是：

- `safe`：未知状态下可以重新执行。
- `never`：无法确认结果时不能盲目重放。
- 所有 effect 经过注入的 `Effects` 边界。
- manual drive 可以在每个 effect 前暂停，测试任意崩溃点。

不过当前 `AgentHarness` 的 prompt/tool runtime 尚未完成。生产 `Agent + AgentSession` 仍使用本文前面描述的非 durable 工具执行链。



# 最终心智模型

可以把一次工具调用记成：

```text
活动 ToolDefinition
→ provider 获得 name/description/schema
→ 模型流式生成 toolCall
→ assistant 消息完成
→ prepareArguments
→ schema validation
→ tool_call 权限 hook
→ execute + partial updates
→ tool_result 修改 hook
→ 图片归一化
→ tool_execution_end
→ ToolResultMessage
→ Agent 状态
→ Session JSONL
→ 下一轮模型请求
```

这套设计最突出的特征是：

> 模型声明、执行副作用、权限策略、持久化结果和 UI 展示彼此分离；并行执行追求速度，正式消息顺序追求确定性。