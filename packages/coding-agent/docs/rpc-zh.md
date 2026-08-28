# RPC 模式

RPC 模式通过 stdin/stdout 上的 JSON 协议实现 coding agent 的无头（headless）操作。这适合把 agent 嵌入其他应用、IDE 或自定义 UI。

**Node.js/TypeScript 用户注意**：如果你在构建 Node.js 应用，考虑直接从 `@earendil-works/pi-coding-agent` 使用 `AgentSession`，而不是派生一个子进程。API 见 [`src/core/agent-session.ts`](../src/core/agent-session.ts)。基于子进程的 TypeScript 客户端见 [`src/modes/rpc/rpc-client.ts`](../src/modes/rpc/rpc-client.ts)。

## 启动 RPC 模式

```bash
pi --mode rpc [options]
```

常用选项：
- `--provider <name>`：设置 LLM provider（anthropic、openai、google 等）
- `--model <pattern>`：模型模式或 ID（支持 `provider/id` 和可选 `:<thinking>`）
- `--name <name>` / `-n <name>`：启动时设置会话显示名
- `--no-session`：禁用会话持久化
- `--session-dir <path>`：自定义会话存储目录

## 协议概览

- **命令**：发送到 stdin 的 JSON 对象，每行一个
- **响应**：带 `type: "response"` 的 JSON 对象，指示命令成功/失败
- **事件**：以 JSON 行流式输出到 stdout 的 agent 事件

所有命令都支持可选的 `id` 字段用于请求/响应关联。提供时，对应的响应会包含相同的 `id`。`bash_execution_update` 事件也包含其来源 `bash` 命令的 `id`。

### 帧（Framing）

RPC 模式使用严格的 JSONL 语义，LF（`\n`）是唯一记录分隔符。

这对客户端很重要：
- 只按 `\n` 拆分记录
- 通过剥离结尾 `\r` 接受可选的 `\r\n` 输入
- 不要使用把 Unicode 分隔符当作换行符的通用行读取器

特别是，Node `readline` 对 RPC 模式不符合协议，因为它还按 `U+2028` 和 `U+2029` 拆分，而这两个字符在 JSON 字符串内是合法的。

## 命令

### 提示（Prompting）

#### prompt

向 agent 发送用户提示。命令响应在提示被接受、排队或处理后发出。接受后事件继续异步流式。

```json
{"id": "req-1", "type": "prompt", "message": "Hello, world!"}
```

带图片：
```json
{"type": "prompt", "message": "What's in this image?", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

**流式期间**：如果 agent 已在流式，必须指定 `streamingBehavior` 来排队消息：

```json
{"type": "prompt", "message": "New instruction", "streamingBehavior": "steer"}
```

- `"steer"`：agent 运行时排队消息。它在当前 assistant 回合执行完其工具调用后、下一次 LLM 调用前投递。
- `"followUp"`：等 agent 完成。消息只在 agent 停止时投递。

如果 agent 在流式且未指定 `streamingBehavior`，命令返回错误。

**扩展命令**：如果消息是扩展命令（如 `/mycommand`），即使在流式期间也立即执行。扩展命令通过 `pi.sendMessage()` 管理自己的 LLM 交互。

**输入展开**：技能命令（`/skill:name`）和提示模板（`/template`）在发送/排队前展开。

响应：
```json
{"id": "req-1", "type": "response", "command": "prompt", "success": true}
```

`success: true` 表示提示被接受、排队或立即处理。`success: false` 表示提示在接受前被拒绝。接受之后的失败通过正常的事件和消息流报告，而不是作为同一请求 id 的第二个 `response`。

`images` 字段可选。每张图片使用 `ImageContent` 格式：`{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}`。

#### steer

agent 运行时排队一条转向（steering）消息。它在当前 assistant 回合执行完其工具调用后、下一次 LLM 调用前投递。技能命令和提示模板会被展开。不允许扩展命令（改用 `prompt`）。

```json
{"type": "steer", "message": "Stop and do this instead"}
```

带图片：
```json
{"type": "steer", "message": "Look at this instead", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

`images` 字段可选。每张图片使用 `ImageContent` 格式（与 `prompt` 相同）。

响应：
```json
{"type": "response", "command": "steer", "success": true}
```

控制转向消息处理方式见 [set_steering_mode](#set_steering_mode)。

#### follow_up

排队一条后续消息，在 agent 完成后处理。只在 agent 没有更多工具调用或转向消息时投递。技能命令和提示模板会被展开。不允许扩展命令（改用 `prompt`）。

```json
{"type": "follow_up", "message": "After you're done, also do this"}
```

带图片：
```json
{"type": "follow_up", "message": "Also check this image", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

`images` 字段可选。每张图片使用 `ImageContent` 格式（与 `prompt` 相同）。

响应：
```json
{"type": "response", "command": "follow_up", "success": true}
```

控制后续消息处理方式见 [set_follow_up_mode](#set_follow_up_mode)。

#### abort

中止当前 agent 操作。

```json
{"type": "abort"}
```

响应：
```json
{"type": "response", "command": "abort", "success": true}
```

#### new_session

开始新会话。可被 `session_before_switch` 扩展事件处理器取消。

```json
{"type": "new_session"}
```

带可选的父会话跟踪：
```json
{"type": "new_session", "parentSession": "/path/to/parent-session.jsonl"}
```

响应：
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": false}}
```

如果被扩展取消：
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": true}}
```

### 状态（State）

#### get_state

获取当前会话状态。

```json
{"type": "get_state"}
```

响应：
```json
{
  "type": "response",
  "command": "get_state",
  "success": true,
  "data": {
    "model": {...},
    "thinkingLevel": "medium",
    "isStreaming": false,
    "isCompacting": false,
    "steeringMode": "all",
    "followUpMode": "one-at-a-time",
    "sessionFile": "/path/to/session.jsonl",
    "sessionId": "abc123",
    "sessionName": "my-feature-work",
    "autoCompactionEnabled": true,
    "messageCount": 5,
    "pendingMessageCount": 0
  }
}
```

`model` 字段是完整的 [Model](#model) 对象或 `null`。`sessionName` 字段是通过 `set_session_name` 设置的显示名，未设置时省略。

#### get_messages

获取对话中的所有消息。

```json
{"type": "get_messages"}
```

响应：
```json
{
  "type": "response",
  "command": "get_messages",
  "success": true,
  "data": {"messages": [...]}
}
```

消息是 `AgentMessage` 对象（见 [Message Types](#message-types)）。

### 模型（Model）

#### set_model

切换到特定模型。

```json
{"type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-20250514"}
```

响应包含完整的 [Model](#model) 对象：
```json
{
  "type": "response",
  "command": "set_model",
  "success": true,
  "data": {...}
}
```

#### cycle_model

循环到下一个可用模型。只有一个可用模型时返回 `null` 数据。

```json
{"type": "cycle_model"}
```

响应：
```json
{
  "type": "response",
  "command": "cycle_model",
  "success": true,
  "data": {
    "model": {...},
    "thinkingLevel": "medium",
    "isScoped": false
  }
}
```

`model` 字段是完整的 [Model](#model) 对象。

#### get_available_models

列出所有已配置的模型。

```json
{"type": "get_available_models"}
```

响应包含完整的 [Model](#model) 对象数组：
```json
{
  "type": "response",
  "command": "get_available_models",
  "success": true,
  "data": {
    "models": [...]
  }
}
```

### 思考（Thinking）

#### set_thinking_level

为支持推理/思考的模型设置等级。

```json
{"type": "set_thinking_level", "level": "high"}
```

等级：`"off"`、`"minimal"`、`"low"`、`"medium"`、`"high"`、`"xhigh"`、`"max"`

`"xhigh"` 和 `"max"` 只在所选模型支持时暴露。一些模型（包括 GPT-5.6）两者都支持。

响应：
```json
{"type": "response", "command": "set_thinking_level", "success": true}
```

#### cycle_thinking_level

循环可用的思考等级。模型不支持思考时返回 `null` 数据。

```json
{"type": "cycle_thinking_level"}
```

响应：
```json
{
  "type": "response",
  "command": "cycle_thinking_level",
  "success": true,
  "data": {"level": "high"}
}
```

#### get_available_thinking_levels

列出当前模型支持的思考等级。无推理支持的模型返回 `["off"]`。

```json
{"type": "get_available_thinking_levels"}
```

响应：
```json
{
  "type": "response",
  "command": "get_available_thinking_levels",
  "success": true,
  "data": {
    "levels": ["off", "minimal", "low", "medium", "high"]
  }
}
```

### 队列模式（Queue Modes）

#### set_steering_mode

控制转向消息（来自 `steer`）的投递方式。

```json
{"type": "set_steering_mode", "mode": "one-at-a-time"}
```

模式：
- `"all"`：当前 assistant 回合执行完其工具调用后投递所有转向消息
- `"one-at-a-time"`：每完成一个 assistant 回合投递一条转向消息（默认）

响应：
```json
{"type": "response", "command": "set_steering_mode", "success": true}
```

#### set_follow_up_mode

控制后续消息（来自 `follow_up`）的投递方式。

```json
{"type": "set_follow_up_mode", "mode": "one-at-a-time"}
```

模式：
- `"all"`：agent 完成时投递所有后续消息
- `"one-at-a-time"`：每次 agent 完成投递一条后续消息（默认）

响应：
```json
{"type": "response", "command": "set_follow_up_mode", "success": true}
```

### 压缩（Compaction）

#### compact

手动压缩对话上下文以减少 token 用量。

```json
{"type": "compact"}
```

带自定义指令：
```json
{"type": "compact", "customInstructions": "Focus on code changes"}
```

响应：
```json
{
  "type": "response",
  "command": "compact",
  "success": true,
  "data": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "estimatedTokensAfter": 32000,
    "usage": {
      "input": 32000,
      "output": 1200,
      "cacheRead": 0,
      "cacheWrite": 0,
      "totalTokens": 33200,
      "cost": {"input": 0.01, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.03}
    },
    "details": {}
  }
}
```

`estimatedTokensAfter` 是对压缩后立即重建的消息上下文的启发式估算，不是 provider 精确的 token 计数。`usage` 报告生成摘要的 LLM 调用，可能被自定义压缩处理器省略。

#### set_auto_compaction

在上下文接近满时启用或禁用自动压缩。

```json
{"type": "set_auto_compaction", "enabled": true}
```

响应：
```json
{"type": "response", "command": "set_auto_compaction", "success": true}
```

### 重试（Retry）

#### set_auto_retry

启用或禁用瞬态错误（过载、限流、5xx）时的自动重试。

```json
{"type": "set_auto_retry", "enabled": true}
```

响应：
```json
{"type": "response", "command": "set_auto_retry", "success": true}
```

#### abort_retry

中止进行中的重试（取消延迟并停止重试）。

```json
{"type": "abort_retry"}
```

响应：
```json
{"type": "response", "command": "abort_retry", "success": true}
```

### Bash

#### bash

执行 shell 命令并把输出加入对话上下文。命令运行期间输出以 `bash_execution_update` 事件流式；响应包含最终结果。

```json
{"id": "req-1", "type": "bash", "command": "ls -la"}
```

包含 `id` 可把流式 `bash_execution_update` 事件关联到该命令。

响应：
```json
{
  "id": "req-1",
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "total 48\ndrwxr-xr-x ...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": false
  }
}
```

输出被截断时包含 `fullOutputPath`：
```json
{
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "truncated output...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": true,
    "fullOutputPath": "/tmp/pi-bash-abc123.log"
  }
}
```

**bash 结果如何到达 LLM：**

`bash` 命令立即执行并返回 `BashResult`。内部会创建一个 `BashExecutionMessage` 并存入 agent 的消息状态。

发送下一个 `prompt` 命令时，所有消息（包括 `BashExecutionMessage`）在发给 LLM 前被转换。`BashExecutionMessage` 被转换为如下格式的 `UserMessage`：

````
Ran `ls -la`
```
total 48
drwxr-xr-x ...
```
````

这意味着：
1. Bash 输出在**下一个提示**中进入 LLM 上下文，而不是立即
2. 可以在一个提示前执行多个 bash 命令；所有输出都会包含

#### abort_bash

中止运行中的 bash 命令。

```json
{"type": "abort_bash"}
```

响应：
```json
{"type": "response", "command": "abort_bash", "success": true}
```

### 会话（Session）

#### get_session_stats

获取 token 用量、成本统计和当前上下文窗口用量。

```json
{"type": "get_session_stats"}
```

响应：
```json
{
  "type": "response",
  "command": "get_session_stats",
  "success": true,
  "data": {
    "sessionFile": "/path/to/session.jsonl",
    "sessionId": "abc123",
    "userMessages": 5,
    "assistantMessages": 5,
    "toolCalls": 12,
    "toolResults": 12,
    "totalMessages": 22,
    "tokens": {
      "input": 50000,
      "output": 10000,
      "cacheRead": 40000,
      "cacheWrite": 5000,
      "total": 105000
    },
    "cost": 0.45,
    "contextUsage": {
      "tokens": 60000,
      "contextWindow": 200000,
      "percent": 30
    }
  }
}
```

`tokens` 和 `cost` 包括 assistant 消息、工具报告的用量，以及整个会话中的压缩/分支摘要生成。`contextUsage` 包含用于压缩和页脚显示的实际当前上下文窗口估算。

没有模型或上下文窗口可用时省略 `contextUsage`。压缩后，`contextUsage.tokens` 和 `contextUsage.percent` 为 `null`，直到压缩后的新 assistant 响应提供有效用量数据。

#### export_html

将会话导出为 HTML 文件。

```json
{"type": "export_html"}
```

带自定义路径：
```json
{"type": "export_html", "outputPath": "/tmp/session.html"}
```

响应：
```json
{
  "type": "response",
  "command": "export_html",
  "success": true,
  "data": {"path": "/tmp/session.html"}
}
```

#### switch_session

加载另一个会话文件。可被 `session_before_switch` 扩展事件处理器取消。

```json
{"type": "switch_session", "sessionPath": "/path/to/session.jsonl"}
```

响应：
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": false}}
```

如果扩展取消了切换：
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": true}}
```

#### fork

从活动分支上之前的某条用户消息创建新分叉。可被 `session_before_fork` 扩展事件处理器取消。返回被分叉消息的文本。

```json
{"type": "fork", "entryId": "abc123"}
```

响应：
```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"text": "The original prompt text...", "cancelled": false}
}
```

如果扩展取消了分叉：
```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"text": "The original prompt text...", "cancelled": true}
}
```

#### clone

在当前位置把当前活动分支复制到新会话。可被 `session_before_fork` 扩展事件处理器取消。

```json
{"type": "clone"}
```

响应：
```json
{
  "type": "response",
  "command": "clone",
  "success": true,
  "data": {"cancelled": false}
}
```

如果扩展取消了克隆：
```json
{
  "type": "response",
  "command": "clone",
  "success": true,
  "data": {"cancelled": true}
}
```

#### get_fork_messages

获取可用于分叉的用户消息。

```json
{"type": "get_fork_messages"}
```

响应：
```json
{
  "type": "response",
  "command": "get_fork_messages",
  "success": true,
  "data": {
    "messages": [
      {"entryId": "abc123", "text": "First prompt..."},
      {"entryId": "def456", "text": "Second prompt..."}
    ]
  }
}
```

#### get_entries

按追加顺序获取所有会话条目（不含会话头）。会话是带稳定 id 的追加式（append-only）条目树，所以条目 id 可作为持久游标：把你见过的最后一个条目 id 作为 `since` 传入，只获取严格在它之后的条目，即使客户端重启过。与 `get_messages` 不同，这包括压缩前的历史和废弃分支。

```json
{"type": "get_entries"}
```

带游标：
```json
{"type": "get_entries", "since": "abc123"}
```

响应：
```json
{
  "type": "response",
  "command": "get_entries",
  "success": true,
  "data": {
    "entries": [
      {"type": "message", "id": "def456", "parentId": "abc123", "timestamp": "...", "message": {"role": "user", "...": "..."}}
    ],
    "leafId": "def456"
  }
}
```

`leafId` 是当前叶条目的 id（空会话为 `null`），客户端可一次往返判断活动分支是否移动。如果 `since` 不匹配任何条目 id，响应为 `success: false`。

#### get_tree

以条目树的形式获取会话。每个节点是 `{entry, children, label?, labelTimestamp?}`。格式正确的会话有单个根；孤儿条目（父链断裂）也作为根出现。

```json
{"type": "get_tree"}
```

响应：
```json
{
  "type": "response",
  "command": "get_tree",
  "success": true,
  "data": {
    "tree": [
      {
        "entry": {"type": "message", "id": "abc123", "parentId": null, "...": "..."},
        "children": [
          {"entry": {"type": "message", "id": "def456", "parentId": "abc123", "...": "..."}, "children": []}
        ]
      }
    ],
    "leafId": "def456"
  }
}
```

#### get_last_assistant_text

获取最后一条 assistant 消息的文本内容。

```json
{"type": "get_last_assistant_text"}
```

响应：
```json
{
  "type": "response",
  "command": "get_last_assistant_text",
  "success": true,
  "data": {"text": "The assistant's response..."}
}
```

没有 assistant 消息时返回 `{"text": null}`。

#### set_session_name

为当前会话设置显示名。名字显示在会话列表中，帮助识别会话。

```json
{"type": "set_session_name", "name": "my-feature-work"}
```

响应：
```json
{
  "type": "response",
  "command": "set_session_name",
  "success": true
}
```

当前会话名可通过 `get_state` 的 `sessionName` 字段获取。要在启动 RPC 模式时设置初始名字，给 `pi --mode rpc` 进程传 `--name <name>` 或 `-n <name>`。

### 命令（Commands）

#### get_commands

获取可用命令（扩展命令、提示模板和技能）。这些可通过 `prompt` 命令加 `/` 前缀调用。

```json
{"type": "get_commands"}
```

响应：
```json
{
  "type": "response",
  "command": "get_commands",
  "success": true,
  "data": {
    "commands": [
      {"name": "session-name", "description": "Set or clear session name", "source": "extension", "path": "/home/user/.pi/agent/extensions/session.ts"},
      {"name": "fix-tests", "description": "Fix failing tests", "source": "prompt", "location": "project", "path": "/home/user/myproject/.pi/agent/prompts/fix-tests.md"},
      {"name": "skill:brave-search", "description": "Web search via Brave API", "source": "skill", "location": "user", "path": "/home/user/.pi/agent/skills/brave-search/SKILL.md"}
    ]
  }
}
```

每个命令有：
- `name`：命令名（用 `/name` 调用）
- `description`：人类可读描述（扩展命令可选）
- `source`：命令类型：
  - `"extension"`：在扩展中通过 `pi.registerCommand()` 注册
  - `"prompt"`：从提示模板 `.md` 文件加载
  - `"skill"`：从技能目录加载（名字带 `skill:` 前缀）
- `location`：从哪里加载（可选，扩展没有该字段）：
  - `"user"`：用户级（`~/.pi/agent/`）
  - `"project"`：项目级（`./.pi/agent/`）
  - `"path"`：通过 CLI 或设置的显式路径
- `path`：命令来源的绝对文件路径（可选）

**注意**：内置 TUI 命令（`/settings`、`/hotkeys` 等）不包含在内。它们只在交互模式下处理，通过 `prompt` 发送不会执行。

## 事件（Events）

agent 运行期间，事件以 JSON 行流式输出到 stdout。事件通常不包含 `id` 字段；`bash_execution_update` 在提供了来源 `bash` 命令 `id` 时会包含它。

### 事件类型

| 事件 | 描述 |
|-------|-------------|
| `agent_start` | Agent 开始处理 |
| `agent_end` | 一次底层 agent 运行完成（之后仍可能有重试、压缩或排队续接） |
| `agent_settled` | Agent 运行完全结束；没有剩余自动重试、压缩重试或排队续接 |
| `turn_start` | 新回合开始 |
| `turn_end` | 回合完成（包含 assistant 消息和工具结果） |
| `message_start` | 消息开始 |
| `message_update` | 流式更新（文本/思考/工具调用增量） |
| `message_end` | 消息完成 |
| `bash_execution_update` | 直接 RPC bash 命令输出块 |
| `tool_execution_start` | 工具开始执行 |
| `tool_execution_update` | 工具执行进度（流式输出） |
| `tool_execution_end` | 工具完成 |
| `queue_update` | 待处理的转向/后续队列变化 |
| `compaction_start` | 压缩开始 |
| `compaction_end` | 压缩完成 |
| `auto_retry_start` | 自动重试开始（瞬态错误后） |
| `auto_retry_end` | 自动重试完成（成功或最终失败） |
| `summarization_retry_scheduled` | 为瞬态压缩或分支摘要总结错误调度了重试 |
| `summarization_retry_attempt_start` | 重试的总结请求开始 |
| `summarization_retry_finished` | 总结重试循环完成 |
| `extension_error` | 扩展抛出了错误 |

### agent_start

agent 开始处理提示时发出。

```json
{"type": "agent_start"}
```

### agent_end

一次底层 agent 运行完成时发出。包含此运行生成的所有消息。如果 `willRetry` 为 true，随后会有自动重试。

```json
{
  "type": "agent_end",
  "messages": [...],
  "willRetry": false
}
```

### agent_settled

完整的会话级运行结束后发出。此时 Pi 不会通过重试、压缩重试或排队的后续消息自动继续。

```json
{"type": "agent_settled"}
```

### turn_start / turn_end

一个回合由一次 assistant 响应及其产生的所有工具调用和结果组成。

```json
{"type": "turn_start"}
```

```json
{
  "type": "turn_end",
  "message": {...},
  "toolResults": [...]
}
```

### message_start / message_end

消息开始和完成时发出。`message` 字段包含一个 `AgentMessage`。

```json
{"type": "message_start", "message": {...}}
{"type": "message_end", "message": {...}}
```

### message_update（流式）

流式输出 assistant 消息期间发出。包含增量事件，没有累计消息快照。

```json
{
  "type": "message_update",
  "usage": {
    "input": 100,
    "output": 1,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 101,
    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}
  },
  "assistantMessageEvent": {
    "type": "text_delta",
    "contentIndex": 0,
    "delta": "Hello "
  }
}
```

`assistantMessageEvent` 字段包含以下增量类型之一：

| 类型 | 描述 |
|------|-------------|
| `text_start` | 文本内容块开始 |
| `text_delta` | 文本内容块 |
| `text_end` | 文本内容块结束 |
| `thinking_start` | 思考块开始 |
| `thinking_delta` | 思考内容块 |
| `thinking_end` | 思考块结束 |
| `toolcall_start` | 工具调用开始 |
| `toolcall_delta` | 工具调用参数块 |
| `toolcall_end` | 工具调用结束（包含完整 `toolCall` 对象） |

流式输出文本响应的示例：
```json
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_start","contentIndex":0}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":" world"}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"Hello world"}}
```

顶层 `usage` 字段包含最新的累计 provider 报告用量。如果 provider 在流式期间不报告用量，它可能直到完成才为零。

`message_update` 有意省略了以前的累计 `message` 字段和 `assistantMessageEvent.partial`。需要实时部分消息的客户端必须用 `contentIndex` 从 `message_start` 和后续事件组装。把 `message_end.message` 作为权威。对工具调用，缓冲 `toolcall_delta.delta`；`toolcall_end.toolCall` 包含完成的调用。

### bash_execution_update

直接 `bash` 命令的每个输出块发出一条。`id` 与命令的 `id` 匹配，客户端可把输出关联到正确的命令。

事件在命令运行期间流式所有输出，即使最终 `bash` 响应的 `output` 被截断。

```json
{
  "type": "bash_execution_update",
  "id": "req-1",
  "delta": "total 48\n"
}
```

### tool_execution_start / tool_execution_update / tool_execution_end

工具开始、流式进度和完成执行时发出。

```json
{
  "type": "tool_execution_start",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"}
}
```

执行期间，`tool_execution_update` 事件流式部分结果（如 bash 输出随到随发）：

```json
{
  "type": "tool_execution_update",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"},
  "partialResult": {
    "content": [{"type": "text", "text": "partial output so far..."}],
    "details": {"truncation": null, "fullOutputPath": null}
  }
}
```

完成时：

```json
{
  "type": "tool_execution_end",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "result": {
    "content": [{"type": "text", "text": "total 48\n..."}],
    "details": {...}
  },
  "isError": false
}
```

用 `toolCallId` 关联事件。`tool_execution_update` 中的 `partialResult` 包含到目前为止的累计输出（不只是增量），客户端可简单地在每次更新时替换显示。

### queue_update

待处理的转向或后续队列变化时发出。

```json
{
  "type": "queue_update",
  "steering": ["Focus on error handling"],
  "followUp": ["After that, summarize the result"]
}
```

### compaction_start / compaction_end

压缩运行时发出，无论是手动还是自动。

```json
{"type": "compaction_start", "reason": "threshold"}
```

`reason` 字段是 `"manual"`、`"threshold"` 或 `"overflow"`。

```json
{
  "type": "compaction_end",
  "reason": "threshold",
  "result": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "estimatedTokensAfter": 32000,
    "usage": {
      "input": 32000,
      "output": 1200,
      "cacheRead": 0,
      "cacheWrite": 0,
      "totalTokens": 33200,
      "cost": {"input": 0.01, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.03}
    },
    "details": {}
  },
  "aborted": false,
  "willRetry": false
}
```

如果 `reason` 是 `"overflow"` 且压缩成功，`willRetry` 为 `true`，agent 会自动重试提示。

如果压缩被中止，`result` 为 `null`，`aborted` 为 `true`。

如果压缩失败（如 API 配额超限），`result` 为 `null`，`aborted` 为 `false`，`errorMessage` 包含错误描述。

### auto_retry_start / auto_retry_end

瞬态错误（过载、限流、5xx）后触发自动重试时发出。

```json
{
  "type": "auto_retry_start",
  "attempt": 1,
  "maxAttempts": 3,
  "delayMs": 2000,
  "errorMessage": "529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"
}
```

```json
{
  "type": "auto_retry_end",
  "success": true,
  "attempt": 2
}
```

最终失败（超过最大重试次数）时：
```json
{
  "type": "auto_retry_end",
  "success": false,
  "attempt": 3,
  "finalError": "529 overloaded_error: Overloaded"
}
```

### summarization_retry_scheduled / summarization_retry_attempt_start / summarization_retry_finished

压缩或分支摘要总结在瞬态 provider 错误后重试时发出。这些事件使用与自动 assistant 回合重试相同的重试设置。

```json
{
  "type": "summarization_retry_scheduled",
  "attempt": 1,
  "maxAttempts": 3,
  "delayMs": 2000,
  "errorMessage": "terminated"
}
```

```json
{
  "type": "summarization_retry_attempt_start",
  "source": "compaction",
  "reason": "threshold"
}
```

对分支摘要，`source` 是 `"branchSummary"` 且没有 `reason`。

```json
{
  "type": "summarization_retry_finished"
}
```

### extension_error

扩展抛出错误时发出。

```json
{
  "type": "extension_error",
  "extensionPath": "/path/to/extension.ts",
  "event": "tool_call",
  "error": "Error message..."
}
```

## 扩展 UI 协议

扩展可通过 `ctx.ui.select()`、`ctx.ui.confirm()` 等请求用户交互。在 RPC 模式下，这些被翻译为基于基础命令/事件流之上的请求/响应子协议。

扩展 UI 方法有两类：

- **对话框方法**（`select`、`confirm`、`input`、`editor`）：在 stdout 发出 `extension_ui_request`，并阻塞直到客户端在 stdin 回发带匹配 `id` 的 `extension_ui_response`。
- **发后即忘方法**（`notify`、`setStatus`、`setWidget`、`setTitle`、`set_editor_text`）：在 stdout 发出 `extension_ui_request`，但不期望响应。客户端可显示信息或忽略。

如果对话框方法包含 `timeout` 字段，agent 端会在超时到期时用默认值自动解决。客户端无需跟踪超时。

一些 `ExtensionUIContext` 方法在 RPC 模式下不受支持或降级，因为它们需要直接 TUI 访问：
- `custom()` 返回 `undefined`
- `setWorkingMessage()`、`setWorkingIndicator()`、`setFooter()`、`setHeader()`、`setEditorComponent()`、`setToolsExpanded()` 是空操作
- `getEditorText()` 返回 `""`
- `getToolsExpanded()` 返回 `false`
- `pasteToEditor()` 委托给 `setEditorText()`（无粘贴/折叠处理）
- `getAllThemes()` 返回 `[]`
- `getTheme()` 返回 `undefined`
- `setTheme()` 返回 `{ success: false, error: "..." }`

注意：RPC 模式下 `ctx.mode` 是 `"rpc"`，`ctx.hasUI` 是 `true`，因为对话框和发后即忘方法通过扩展 UI 子协议可用。用 `ctx.mode === "tui"` 保护 `custom()` 这类需要真实终端的 TUI 特定功能。

### 扩展 UI 请求（stdout）

所有请求都有 `type: "extension_ui_request"`、唯一 `id` 和 `method` 字段。

#### select

提示用户从列表中选择。带 `timeout` 字段的对话框方法包含毫秒超时；客户端未按时响应时 agent 用 `undefined` 自动解决。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-1",
  "method": "select",
  "title": "Allow dangerous command?",
  "options": ["Allow", "Block"],
  "timeout": 10000
}
```

期望响应：带 `value`（选中的选项字符串）或 `cancelled: true` 的 `extension_ui_response`。

#### confirm

提示用户是/否确认。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-2",
  "method": "confirm",
  "title": "Clear session?",
  "message": "All messages will be lost.",
  "timeout": 5000
}
```

期望响应：带 `confirmed: true/false` 或 `cancelled: true` 的 `extension_ui_response`。

#### input

提示用户输入自由文本。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-3",
  "method": "input",
  "title": "Enter a value",
  "placeholder": "type something..."
}
```

期望响应：带 `value`（输入的文本）或 `cancelled: true` 的 `extension_ui_response`。

#### editor

打开多行文本编辑器，可选预填内容。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-4",
  "method": "editor",
  "title": "Edit some text",
  "prefill": "Line 1\nLine 2\nLine 3"
}
```

期望响应：带 `value`（编辑后的文本）或 `cancelled: true` 的 `extension_ui_response`。

#### notify

显示通知。发后即忘，不期望响应。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-5",
  "method": "notify",
  "message": "Command blocked by user",
  "notifyType": "warning"
}
```

`notifyType` 字段是 `"info"`、`"warning"` 或 `"error"`。省略时默认 `"info"`。

#### setStatus

设置或清除页脚/状态栏中的状态项。发后即忘。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-6",
  "method": "setStatus",
  "statusKey": "my-ext",
  "statusText": "Turn 3 running..."
}
```

发送 `statusText: undefined`（或省略）可清除该 key 的状态项。

#### setWidget

设置或清除显示在编辑器上方或下方的 widget（文本行块）。发后即忘。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-7",
  "method": "setWidget",
  "widgetKey": "my-ext",
  "widgetLines": ["--- My Widget ---", "Line 1", "Line 2"],
  "widgetPlacement": "aboveEditor"
}
```

发送 `widgetLines: undefined`（或省略）可清除 widget。`widgetPlacement` 字段是 `"aboveEditor"`（默认）或 `"belowEditor"`。RPC 模式只支持字符串数组；组件工厂被忽略。

#### setTitle

设置终端窗口/标签标题。发后即忘。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-8",
  "method": "setTitle",
  "title": "pi - my project"
}
```

#### set_editor_text

设置输入编辑器中的文本。发后即忘。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-9",
  "method": "set_editor_text",
  "text": "prefilled text for the user"
}
```

### 扩展 UI 响应（stdin）

响应只针对对话框方法（`select`、`confirm`、`input`、`editor`）。`id` 必须与请求匹配。

#### 值响应（select、input、editor）

```json
{"type": "extension_ui_response", "id": "uuid-1", "value": "Allow"}
```

#### 确认响应（confirm）

```json
{"type": "extension_ui_response", "id": "uuid-2", "confirmed": true}
```

#### 取消响应（任意对话框）

关闭任意对话框方法。扩展收到 `undefined`（select/input/editor）或 `false`（confirm）。

```json
{"type": "extension_ui_response", "id": "uuid-3", "cancelled": true}
```

## 错误处理

失败的命令返回 `success: false` 的响应：

```json
{
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: invalid/model"
}
```

解析错误：

```json
{
  "type": "response",
  "command": "parse",
  "success": false,
  "error": "Failed to parse command: Unexpected token..."
}
```

## 类型

源文件：
- [`packages/ai/src/types.ts`](../../ai/src/types.ts) - `Model`、`UserMessage`、`AssistantMessage`、`ToolResultMessage`
- [`packages/agent/src/types.ts`](../../agent/src/types.ts) - `AgentMessage`、`AgentEvent`
- [`src/core/messages.ts`](../src/core/messages.ts) - `BashExecutionMessage`
- [`src/modes/json-event.ts`](../src/modes/json-event.ts) - `JsonAgentSessionEvent`
- [`src/modes/rpc/rpc-types.ts`](../src/modes/rpc/rpc-types.ts) - RPC 命令/响应类型、扩展 UI 请求/响应类型

### Model

```json
{
  "id": "claude-sonnet-4-20250514",
  "name": "Claude Sonnet 4",
  "api": "anthropic-messages",
  "provider": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "reasoning": true,
  "input": ["text", "image"],
  "contextWindow": 200000,
  "maxTokens": 16384,
  "cost": {
    "input": 3.0,
    "output": 15.0,
    "cacheRead": 0.3,
    "cacheWrite": 3.75
  }
}
```

### UserMessage

```json
{
  "role": "user",
  "content": "Hello!",
  "timestamp": 1733234567890,
  "attachments": []
}
```

`content` 字段可以是字符串或 `TextContent`/`ImageContent` 块数组。

### AssistantMessage

```json
{
  "role": "assistant",
  "content": [
    {"type": "text", "text": "Hello! How can I help?"},
    {"type": "thinking", "thinking": "User is greeting me..."},
    {"type": "toolCall", "id": "call_123", "name": "bash", "arguments": {"command": "ls"}}
  ],
  "api": "anthropic-messages",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "usage": {
    "input": 100,
    "output": 50,
    "cacheRead": 0,
    "cacheWrite": 0,
    "cost": {"input": 0.0003, "output": 0.00075, "cacheRead": 0, "cacheWrite": 0, "total": 0.00105}
  },
  "stopReason": "stop",
  "timestamp": 1733234567890
}
```

停止原因：`"stop"`、`"length"`、`"toolUse"`、`"error"`、`"aborted"`

### ToolResultMessage

```json
{
  "role": "toolResult",
  "toolCallId": "call_123",
  "toolName": "bash",
  "content": [{"type": "text", "text": "total 48\ndrwxr-xr-x ..."}],
  "usage": {
    "input": 100,
    "output": 50,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 150,
    "cost": {"input": 0.0003, "output": 0.00075, "cacheRead": 0, "cacheWrite": 0, "total": 0.00105}
  },
  "isError": false,
  "timestamp": 1733234567890
}
```

`usage` 可选，报告工具执行的嵌套 LLM 工作。存在时会计入会话 token 和成本总计。

### BashExecutionMessage

由 `bash` RPC 命令创建（不是 LLM 工具调用）：

```json
{
  "role": "bashExecution",
  "command": "ls -la",
  "output": "total 48\ndrwxr-xr-x ...",
  "exitCode": 0,
  "cancelled": false,
  "truncated": false,
  "fullOutputPath": null,
  "timestamp": 1733234567890
}
```

### Attachment

```json
{
  "id": "img1",
  "type": "image",
  "fileName": "photo.jpg",
  "mimeType": "image/jpeg",
  "size": 102400,
  "content": "base64-encoded-data...",
  "extractedText": null,
  "preview": null
}
```

## 示例：基础客户端（Python）

```python
import subprocess
import json

proc = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True
)

def send(cmd):
    proc.stdin.write(json.dumps(cmd) + "\n")
    proc.stdin.flush()

def read_events():
    for line in proc.stdout:
        yield json.loads(line)

# Send prompt
send({"type": "prompt", "message": "Hello!"})

# Process events
for event in read_events():
    if event.get("type") == "message_update":
        delta = event.get("assistantMessageEvent", {})
        if delta.get("type") == "text_delta":
            print(delta["delta"], end="", flush=True)
    
    if event.get("type") == "agent_end":
        print()
        break
```

## 示例：交互客户端（Node.js）

完整交互示例见 [`test/rpc-example.ts`](../test/rpc-example.ts)，带类型的客户端实现见 [`src/modes/rpc/rpc-client.ts`](../src/modes/rpc/rpc-client.ts)。

处理扩展 UI 协议的完整示例见 [`examples/rpc-extension-ui.ts`](../examples/rpc-extension-ui.ts)，它与 [`examples/extensions/rpc-demo.ts`](../examples/extensions/rpc-demo.ts) 扩展配对。

```javascript
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");

const agent = spawn("pi", ["--mode", "rpc", "--no-session"]);

function attachJsonlReader(stream, onLine) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";

    stream.on("data", (chunk) => {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

        while (true) {
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex === -1) break;

            let line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            onLine(line);
        }
    });

    stream.on("end", () => {
        buffer += decoder.end();
        if (buffer.length > 0) {
            onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
        }
    });
}

attachJsonlReader(agent.stdout, (line) => {
    const event = JSON.parse(line);

    if (event.type === "message_update") {
        const { assistantMessageEvent } = event;
        if (assistantMessageEvent.type === "text_delta") {
            process.stdout.write(assistantMessageEvent.delta);
        }
    }
});

// Send prompt
agent.stdin.write(JSON.stringify({ type: "prompt", message: "Hello" }) + "\n");

// Abort on Ctrl+C
process.on("SIGINT", () => {
    agent.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
});
```
