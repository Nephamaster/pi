pi 的工具体系可以分为五层：内置工具、工具定义结构、自定义/扩展工具、执行与事件流、工具选择与动态加载。以下基于 `packages/coding-agent` 的文档和源码。

## 1. 内置工具（`src/core/tools/`）

共 7 个内置工具，统一由 `createAllTools(cwd, options)` 等工厂函数构造：

| 工具 | 作用 | 是否默认启用 |
|------|------|------------|
| `read` | 读文件（支持文本和图片，超长时截断） | 是 |
| `bash` | 执行 shell 命令 | 是 |
| `edit` | 精确文本替换编辑（返回 `details.diff` 供 TUI 显示、`details.patch` 供 SDK 消费） | 是 |
| `write` | 创建/覆盖文件 | 是 |
| `grep` | 搜索内容 | 否（按需启用） |
| `find` | 查找文件 | 否 |
| `ls` | 列目录 | 否 |

默认集是 `read`/`bash`/`edit`/`write`（`createCodingTools`）；只读场景用 `read`/`grep`/`find`/`ls`（`createReadOnlyTools`）。

## 2. 工具定义结构

每个工具是 `ToolDefinition`，核心字段：

- `name` / `label` / `description` — description 直接给 LLM 看
- `parameters` — TypeBox schema（枚举要用 `pi-ai` 的 `StringEnum`，Google API 不认 `Type.Union`/`Type.Literal`）
- `execute(toolCallId, params, signal, onUpdate, ctx)` — 返回：
  - `content`：发给 LLM 的文本/图片
  - `details`：仅用于渲染和状态，不发给 LLM
  - `usage`（可选）：嵌套 LLM 调用的用量，会计入 session 统计
  - `terminate: true`（可选）：本批所有工具都 terminate 时，跳过后续自动 LLM 调用
- `renderCall` / `renderResult`（可选）— 自定义 TUI 渲染
- `promptSnippet` / `promptGuidelines`（可选）— 注入默认系统提示词的 `Available tools` 和 `Guidelines` 段，仅工具激活时生效
- `prepareArguments`（可选）— 在 schema 校验前规范化参数，用于旧会话 resume 时的兼容性

错误语义：`execute` 里 **throw** 才标记 `isError: true`；正常 return 永远不会被视为失败。

## 3. 自定义工具与扩展

两种注册途径：

- **扩展**：`pi.registerTool({...})`（TS 扩展，放在 `~/.pi/agent/extensions/`、`.pi/extensions/` 或 `-e` 加载）
- **SDK**：`defineTool({...})` + `createAgentSession({ customTools: [myTool] })`

关键机制：

- **覆盖内置工具**：扩展注册同名工具即替换内置实现（交互模式会警告）；`--no-builtin-tools` 可只留扩展工具
- **文件变更队列**：工具调用默认**并行执行**。自定义工具若修改文件，必须用 `withFileMutationQueue(absPath, fn)` 参与和内置 `edit`/`write` 相同的按文件队列，否则两个并行写可能互相覆盖
- **取消与流式进度**：`execute` 收到 `AbortSignal`，可通过 `onUpdate()` 流式推送中间进度

## 4. 执行流与事件

每个工具调用经过（`docs/extensions.md` 的事件图）：

```
tool_execution_start → tool_call(可拦截) → tool_execution_update
  → tool_result(可修改) → tool_execution_end
```

- 同一 assistant 消息里的多个工具调用：先**顺序 preflight**，再**并发执行**
- `tool_call` 事件可以返回 `{ block: true, reason?, terminate? }` 阻止执行——这就是做权限门禁/危险命令确认的基础（如 `examples/extensions/permission-gate.ts`）
- `tool_result` 事件可以改写结果再喂给 LLM

## 5. 工具选择与动态加载

**静态选择**：
- CLI：`--tools/-t`（白名单）、`--exclude-tools/-xt`、`--no-builtin-tools`、`--no-tools`
- SDK：`tools` / `noTools: "all"|"builtin"` / `excludeTools`
- 扩展运行时：`pi.getActiveTools()` / `pi.setActiveTools(names)`

**动态加载**（`docs/extensions.md` "Dynamic Tool Loading"）：注册大量工具但只激活一个 loader（如 `search_tools`），loader 执行中用 `setActiveTools()` **纯增量**地激活匹配的工具：

- Anthropic（Sonnet/Opus 4.5+）用原生 `defer_loading` + `tool_reference`，OpenAI（gpt-5.4+）用 `tool_search_call`/`tool_search_output`，保持前缀缓存稳定
- 其他模型回退为：下次请求直接发完整激活列表（可能破坏前缀缓存）
- 带 `promptSnippet`/`promptGuidelines` 的工具被激活会重建系统提示词，所以懒加载工具应只靠 `description`

## 设计取向

pi 刻意保持内核小：不内置 MCP、子代理、权限弹窗、plan mode、后台 bash 这类功能，这些都通过扩展/技能/包实现（`usage.md` "Design Principles"）。内置工具只覆盖"读-改-跑"的最小闭环，其余能力靠 `registerTool` 和事件钩子扩展。
