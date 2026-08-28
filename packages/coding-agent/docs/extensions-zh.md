> pi 可以创建扩展。让它为你的使用场景构建一个。

# 扩展（Extensions）

扩展是 TypeScript 模块，用于扩展 pi 的行为。它们可以订阅生命周期事件、注册 LLM 可调用的自定义工具、添加命令等。

> **为 /reload 放置位置**：把扩展放在 `~/.pi/agent/extensions/`（全局）或 `.pi/extensions/`（项目本地）以自动发现。`pi -e ./path.ts` 只用于快速测试。自动发现位置中的扩展可以用 `/reload` 热重载。

**关键能力：**
- **自定义工具** - 通过 `pi.registerTool()` 注册 LLM 可调用的工具
- **事件拦截** - 阻止或修改工具调用、注入上下文、自定义压缩
- **用户交互** - 通过 `ctx.ui` 提示用户（select、confirm、input、notify）
- **自定义 UI 组件** - 通过 `ctx.ui.custom()` 提供带键盘输入的完整 TUI 组件，用于复杂交互
- **自定义命令** - 通过 `pi.registerCommand()` 注册 `/mycommand` 这样的命令
- **会话持久化** - 通过 `pi.appendEntry()` 存储重启后仍存在的状态
- **自定义渲染** - 控制工具调用/结果和消息在 TUI 中的显示方式

**用例示例：**
- 权限门（`rm -rf`、`sudo` 等执行前确认）
- Git 检查点（每回合 stash，分支时恢复）
- 路径保护（阻止写入 `.env`、`node_modules/`）
- 自定义压缩（按你的方式总结对话）
- 对话摘要（见 `summarize.ts` 示例）
- 交互式工具（提问、向导、自定义对话框）
- 有状态工具（待办列表、连接池）
- 外部集成（文件监视器、webhooks、CI 触发）
- 等待时的小游戏（见 `snake.ts` 示例）

可运行的实现见 [examples/extensions/](../examples/extensions/)。

## 目录

- [快速开始](#quick-start)
- [扩展位置](#extension-locations)
- [可用导入](#available-imports)
- [编写扩展](#writing-an-extension)
  - [扩展样式](#extension-styles)
- [事件](#events)
  - [生命周期概览](#lifecycle-overview)
  - [资源事件](#resource-events)
  - [会话事件](#session-events)
  - [Agent 事件](#agent-events)
  - [模型事件](#model-events)
  - [工具事件](#tool-events)
- [ExtensionContext](#extensioncontext)
- [ExtensionCommandContext](#extensioncommandcontext)
- [ExtensionAPI 方法](#extensionapi-methods)
- [状态管理](#state-management)
- [自定义工具](#custom-tools)
  - [动态工具加载](#dynamic-tool-loading)
- [自定义 UI](#custom-ui)
- [错误处理](#error-handling)
- [模式行为](#mode-behavior)
- [示例参考](#examples-reference)

## 快速开始

创建 `~/.pi/agent/extensions/my-extension.ts`：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // 响应事件
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Extension loaded!", "info");
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });

  // 注册自定义工具
  pi.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greet someone by name",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });

  // 注册命令
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello ${args || "world"}!`, "info");
    },
  });
}
```

用 `--extension`（或 `-e`）标志测试：

```bash
pi -e ./my-extension.ts
```

## 扩展位置

> **安全**：扩展以你完整的系统权限运行，可执行任意代码。只从你信任的来源安装。

扩展从受信位置自动发现。项目本地的 `.pi/extensions` 条目只在项目被信任后才加载。

| 位置 | 作用域 |
|----------|-------|
| `~/.pi/agent/extensions/*.ts` | 全局（所有项目） |
| `~/.pi/agent/extensions/*/index.ts` | 全局（子目录） |
| `.pi/extensions/*.ts` | 项目本地 |
| `.pi/extensions/*/index.ts` | 项目本地（子目录） |

通过 `settings.json` 指定额外路径：

```json
{
  "packages": [
    "npm:@foo/bar@1.0.0",
    "git:github.com/user/repo@v1"
  ],
  "extensions": [
    "/path/to/local/extension.ts",
    "/path/to/local/extension/dir"
  ]
}
```

要把扩展作为 pi 包通过 npm 或 git 分发，见 [packages.md](packages.md)。

## 可用导入

| 包 | 用途 |
|---------|---------|
| `@earendil-works/pi-coding-agent` | 扩展类型（`ExtensionAPI`、`ExtensionContext`、事件） |
| `typebox` | 工具参数的 schema 定义 |
| `@earendil-works/pi-ai` | AI 工具（用于 Google 兼容枚举的 `StringEnum`） |
| `@earendil-works/pi-tui` | 用于自定义渲染的 TUI 组件 |

npm 依赖也可用。在扩展旁边（或父目录中）放一个 `package.json`，运行 `npm install`，`node_modules/` 中的导入会自动解析。

对于用 `pi install` 安装（npm 或 git）的分发 pi 包，运行时依赖必须在 `dependencies` 中。包安装默认使用生产安装（`npm install --omit=dev`），所以运行时不可用 `devDependencies`；配置了 `npmCommand` 时，git 包为兼容包装器使用普通 `install`。

Node.js 内置模块（`node:fs`、`node:path` 等）也可用。

## 编写扩展

扩展导出一个默认工厂函数，接收 `ExtensionAPI`。工厂可以是同步或异步的：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 订阅事件
  pi.on("event_name", async (event, ctx) => {
    // ctx.ui 用于用户交互
    const ok = await ctx.ui.confirm("Title", "Are you sure?");
    ctx.ui.notify("Done!", "info");
    ctx.ui.setStatus("my-ext", "Processing...");  // 页脚状态
    ctx.ui.setWidget("my-ext", ["Line 1", "Line 2"]);  // 编辑器上方的 widget（默认）
  });

  // 注册工具、命令、快捷键、标志
  pi.registerTool({ ... });
  pi.registerCommand("name", { ... });
  pi.registerShortcut("ctrl+x", { ... });
  pi.registerFlag("my-flag", { ... });
}
```

扩展通过 [jiti](https://github.com/unjs/jiti) 加载，所以 TypeScript 无需编译即可工作。

如果工厂返回 `Promise`，pi 会在继续启动前等待它。这意味着异步初始化在 `session_start` 之前、`resources_discover` 之前、以及通过 `pi.registerProvider()` 排队的 provider 注册刷新之前完成。

### 异步工厂函数

对一次性启动工作（如获取远程配置或动态发现可用模型）使用异步工厂。

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
  const response = await fetch("http://localhost:1234/v1/models");
  const payload = (await response.json()) as {
    data: Array<{
      id: string;
      name?: string;
      context_window?: number;
      max_tokens?: number;
    }>;
  };

  pi.registerProvider("local-openai", {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "$LOCAL_OPENAI_API_KEY",
    api: "openai-completions",
    models: payload.data.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.context_window ?? 128000,
      maxTokens: model.max_tokens ?? 4096,
    })),
  });
}
```

这个模式让获取到的模型在正常启动和 `pi --list-models` 中可用。

### 长生命资源与关闭

扩展工厂可能运行在从不启动会话的调用中。不要从工厂启动后台资源，如进程、socket、文件监视器或定时器。

把后台资源启动推迟到 `session_start` 或需要该资源的命令/工具/事件。注册幂等的 `session_shutdown` 处理器来关闭你启动的任何会话级资源。

### 扩展样式

**单文件** - 最简单，适合小扩展：

```
~/.pi/agent/extensions/
└── my-extension.ts
```

**带 index.ts 的目录** - 适合多文件扩展：

```
~/.pi/agent/extensions/
└── my-extension/
    ├── index.ts        # 入口（导出默认函数）
    ├── tools.ts        # 辅助模块
    └── utils.ts        # 辅助模块
```

**带依赖的包** - 适合需要 npm 包的扩展：

```
~/.pi/agent/extensions/
└── my-extension/
    ├── package.json    # 声明依赖和入口
    ├── package-lock.json
    ├── node_modules/   # npm install 之后
    └── src/
        └── index.ts
```

```json
// package.json
{
  "name": "my-extension",
  "dependencies": {
    "zod": "^3.0.0",
    "chalk": "^5.0.0"
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

在扩展目录运行 `npm install`，之后 `node_modules/` 中的导入自动可用。

## 事件（Events）

### 生命周期概览

```
pi starts
  │
  ├─► project_trust (仅用户/全局和 CLI 扩展，在项目资源加载前)
  ├─► session_start { reason: "startup" }
  └─► resources_discover { reason: "startup" }
      │
      ▼
user sends prompt ─────────────────────────────────────┐
  │                                                        │
  ├─► (先检查扩展命令，找到则跳过)  │
  ├─► input (可拦截、转换或处理)          │
  ├─► (未处理时展开 skill/template)            │
  ├─► before_agent_start (可注入消息、修改系统提示)
  ├─► agent_start                                          │
  ├─► message_start / message_update / message_end         │
  │                                                        │
  │   ┌─── turn（LLM 调用工具时重复） ───┐       │
  │   │                                            │       │
  │   ├─► turn_start                               │       │
  │   ├─► context (可修改消息)            │       │
  │   ├─► before_provider_headers (可修改 headers)     |
  │   ├─► before_provider_request (可检查或替换 payload)
  │   ├─► after_provider_response (status + headers，在消费流之前)
  │   │                                            │       │
  │   │   LLM 响应，可能调用工具:            │       │
  │   │     ├─► tool_execution_start               │       │
  │   │     ├─► tool_call (可阻止)              │       │
  │   │     ├─► tool_execution_update              │       │
  │   │     ├─► tool_result (可修改)           │       │
  │   │     └─► tool_execution_end                 │       │
  │   │                                            │       │
  │   └─► turn_end                                 │       │
  │                                                        │
  ├─► agent_end                                            │
  └─► agent_settled (没有剩余重试/压缩/后续)   │
                                                           │
user sends another prompt ◄────────────────────────────────┘

/new（新会话）或 /resume（切换会话）
  ├─► session_before_switch (可取消)
  ├─► session_shutdown
  ├─► session_start { reason: "new" | "resume", previousSessionFile? }
  └─► resources_discover { reason: "startup" }

/fork 或 /clone
  ├─► session_before_fork (可取消)
  ├─► session_shutdown
  ├─► session_start { reason: "fork", previousSessionFile }
  └─► resources_discover { reason: "startup" }

/name 或 pi.setSessionName()
  └─► session_info_changed

/compact 或自动压缩
  ├─► session_before_compact (可取消或自定义)
  └─► session_compact

/tree 导航
  ├─► session_before_tree (可取消或自定义)
  └─► session_tree

/model 或 Ctrl+P（模型选择/循环）
  ├─► thinking_level_select（如果模型变更改变/钳制了思考等级）
  └─► model_select

思考等级变更（设置、键位绑定、pi.setThinkingLevel()）
  └─► thinking_level_select

退出（Ctrl+C、Ctrl+D、SIGHUP、SIGTERM）
  └─► session_shutdown
```

### 启动事件

#### project_trust

在 pi 决定是否信任带动态配置（`.pi` 或 `.agents/skills`）的项目之前触发。它在启动时以及会话替换（例如 `/resume`）进入当前进程中信任未解析的 cwd 时运行。只有用户/全局扩展和 CLI `-e` 扩展参与；项目本地扩展在信任解析之前不会加载。

```typescript
pi.on("project_trust", async (event, ctx) => {
  // event.cwd - 当前工作目录
  // ctx 有受限的信任上下文：cwd、mode、hasUI，以及 select/confirm/input/notify UI 帮助方法
  if (await ctx.ui.confirm("Trust project?", event.cwd)) {
    return { trusted: "yes", remember: true };
  }
  return { trusted: "undecided" };
});
```

`project_trust` 处理器必须返回 `{ trusted: "yes" | "no" | "undecided" }`。返回 `"yes"` 或 `"no"` 的用户/全局或 CLI 扩展拥有决定权；第一个 yes/no 决定胜出并抑制内置信任提示。用 `remember: true` 持久化 yes/no 决定；否则只应用于当前进程。返回 `"undecided"` 让后续处理器或内置信任流程决定。提示前检查 `ctx.hasUI`。如果没有任何处理器返回 yes/no，正常信任解析继续：先应用已保存的 `trust.json` 决定，然后 `defaultProjectTrust` 控制 pi 默认是询问、信任还是拒绝。

### 资源事件

#### resources_discover

在 `session_start` 后触发，让扩展提供额外的 skill、prompt 和 theme 路径。
启动路径使用 `reason: "startup"`。重载使用 `reason: "reload"`。

```typescript
pi.on("resources_discover", async (event, _ctx) => {
  // event.cwd - 当前工作目录
  // event.reason - "startup" | "reload"
  return {
    skillPaths: ["/path/to/skills"],
    promptPaths: ["/path/to/prompts"],
    themePaths: ["/path/to/themes"],
  };
});
```

### 会话事件

会话存储内部机制和 SessionManager API 见 [Session Format](session-format.md)。

#### session_start

会话启动、加载或重载时触发。

```typescript
pi.on("session_start", async (event, ctx) => {
  // event.reason - "startup" | "reload" | "new" | "resume" | "fork"
  // event.previousSessionFile - "new"、"resume" 和 "fork" 时存在
  ctx.ui.notify(`Session: ${ctx.sessionManager.getSessionFile() ?? "ephemeral"}`, "info");
});
```

#### session_info_changed

当前会话显示名通过 `/name`、RPC 或 `pi.setSessionName()` 设置时触发。

```typescript
pi.on("session_info_changed", async (event, ctx) => {
  // event.name - 当前规范化名字，清除时为 undefined
  ctx.ui.notify(`Session renamed: ${event.name ?? "(none)"}`, "info");
});
```

#### session_before_switch

开始新会话（`/new`）或切换会话（`/resume`）前触发。

```typescript
pi.on("session_before_switch", async (event, ctx) => {
  // event.reason - "new" 或 "resume"
  // event.targetSessionFile - 要切换到的会话（仅 "resume"）

  if (event.reason === "new") {
    const ok = await ctx.ui.confirm("Clear?", "Delete all messages?");
    if (!ok) return { cancel: true };
  }
});
```

成功切换或新会话操作后，pi 为旧扩展实例发出 `session_shutdown`，为新会话重新加载并重新绑定扩展，然后发出带 `reason: "new" | "resume"` 和 `previousSessionFile` 的 `session_start`。
在 `session_shutdown` 中做清理工作，然后在 `session_start` 中重建任何内存状态。

#### session_before_fork

通过 `/fork` 分叉或 `/clone` 克隆时触发。

```typescript
pi.on("session_before_fork", async (event, ctx) => {
  // event.entryId - 选中条目的 ID
  // event.position - /fork 为 "before"，/clone 为 "at"
  return { cancel: true }; // 取消分叉/克隆
  // 或者
  return { skipConversationRestore: true }; // 保留给未来的对话恢复控制
});
```

成功分叉或克隆后，pi 为旧扩展实例发出 `session_shutdown`，为新会话重新加载并重新绑定扩展，然后发出带 `reason: "fork"` 和 `previousSessionFile` 的 `session_start`。
在 `session_shutdown` 中做清理工作，然后在 `session_start` 中重建任何内存状态。

#### session_before_compact / session_compact

压缩时触发。详见 [compaction.md](compaction.md)。

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, reason, willRetry, signal } = event;

  // reason - "manual" (/compact)、"threshold" 或 "overflow"
  // willRetry - 被中止的回合在压缩后是否重试（溢出恢复）

  // 取消：
  return { cancel: true };

  // 自定义摘要：
  return {
    compaction: {
      summary: "...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      // usage: summaryResponse.usage, // 可选；计入会话总计
    }
  };
});

pi.on("session_compact", async (event, ctx) => {
  // event.compactionEntry - 保存的压缩
  // event.fromExtension - 是否由扩展提供
  // event.reason - "manual" (/compact)、"threshold" 或 "overflow"
  // event.willRetry - 被中止的回合在压缩后是否重试（溢出恢复）
});
```

#### session_before_tree / session_tree

`/tree` 导航时触发。树导航概念见 [Sessions](sessions.md)。

```typescript
pi.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;
  return { cancel: true };
  // 或提供自定义摘要：
  return {
    summary: {
      summary: "...",
      // usage: summaryResponse.usage, // 可选；计入会话总计
      details: {},
    },
  };
});

pi.on("session_tree", async (event, ctx) => {
  // event.newLeafId, oldLeafId, summaryEntry, fromExtension
});
```

#### session_shutdown

已启动的会话运行时被拆除前触发。用它清理从 `session_start` 或其他会话级钩子打开的资源。

```typescript
pi.on("session_shutdown", async (event, ctx) => {
  // event.reason - "quit" | "reload" | "new" | "resume" | "fork"
  // event.targetSessionFile - 会话替换流程的目标会话
  // 清理、保存状态等。
});
```

### Agent 事件

#### before_agent_start

用户提交提示后、agent 循环前触发。可注入消息和/或修改系统提示。

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // event.prompt - 用户的提示文本
  // event.images - 附带图片（如果有）
  // event.systemPrompt - 当前处理器链上的系统提示
  //   （包含前面 before_agent_start 处理器的修改）
  // event.systemPromptOptions - 用于构建系统提示的结构化选项
  //   .customPrompt - 自定义系统提示（来自 --system-prompt、SYSTEM.md 或自定义模板）
  //   .selectedTools - 当前提示中激活的工具
  //   .toolSnippets - 每个工具的一行描述
  //   .promptGuidelines - 自定义准则条目
  //   .appendSystemPrompt - --append-system-prompt 标志的文本
  //   .cwd - 工作目录
  //   .contextFiles - AGENTS.md 文件和其他已加载的上下文文件
  //   .skills - 已加载的技能

  return {
    // 注入持久消息（存入会话，发给 LLM）
    message: {
      customType: "my-extension",
      content: "Additional context for the LLM",
      display: true,
    },
    // 替换本回合的系统提示（跨扩展链接）
    systemPrompt: event.systemPrompt + "\n\nExtra instructions for this turn...",
  };
});
```

`systemPromptOptions` 字段让扩展访问 Pi 用来构建系统提示的相同结构化数据。这让你可以检查 Pi 已加载的内容——自定义提示、准则、工具片段、上下文文件、技能——而无需重新发现资源或重新解析标志。当你的扩展需要在尊重用户配置的前提下对系统提示做深入、有依据的修改时，使用它。

在 `before_agent_start` 内，`event.systemPrompt` 和 `ctx.getSystemPrompt()` 都反映截至当前处理器的链式系统提示。后面的 `before_agent_start` 处理器仍可再次修改它。

#### agent_start / agent_end / agent_settled

`agent_start` 在底层 agent 运行开始时触发。`agent_end` 在该运行结束时触发，但 Pi 仍可能自动重试、自动压缩后重试、或继续处理排队的后续消息。对于需要知道 Pi 不会自动继续运行的状态集成，使用 `agent_settled`。

```typescript
pi.on("agent_start", async (_event, ctx) => {});

pi.on("agent_end", async (event, ctx) => {
  // event.messages - 本次底层运行生成的消息
});

pi.on("agent_settled", async (_event, ctx) => {
  // 除非另一个扩展启动了新运行，否则这里 ctx.isIdle() 为 true。
});
```

#### turn_start / turn_end

每个回合（一次 LLM 响应 + 工具调用）触发。

```typescript
pi.on("turn_start", async (event, ctx) => {
  // event.turnIndex, event.timestamp
});

pi.on("turn_end", async (event, ctx) => {
  // event.turnIndex, event.message, event.toolResults
});
```

#### message_start / message_update / message_end

消息生命周期更新时触发。

- `message_start` 和 `message_end` 对 user、assistant 和 toolResult 消息触发。
- `message_update` 对 assistant 流式更新触发。
- `message_end` 处理器可返回 `{ message }` 替换已定稿的消息。替换必须保持相同的 `role`。

```typescript
pi.on("message_start", async (event, ctx) => {
  // event.message
});

pi.on("message_update", async (event, ctx) => {
  // event.message
  // event.assistantMessageEvent（逐 token 的流事件）
});

pi.on("message_end", async (event, ctx) => {
  if (event.message.role !== "assistant") return;

  return {
    message: {
      ...event.message,
      usage: {
        ...event.message.usage,
        cost: {
          ...event.message.usage.cost,
          total: 0.123,
        },
      },
    },
  };
});
```

#### tool_execution_start / tool_execution_update / tool_execution_end

工具执行生命周期更新时触发。

并行工具模式下：
- `tool_execution_start` 在预检阶段按 assistant 源顺序发出
- `tool_execution_update` 事件可能跨工具交错
- `tool_execution_end` 在每个工具定稿后按工具完成顺序发出
- 最终 `toolResult` 消息事件仍稍后按 assistant 源顺序发出

```typescript
pi.on("tool_execution_start", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.args
});

pi.on("tool_execution_update", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.args, event.partialResult
});

pi.on("tool_execution_end", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.result, event.isError
});
```

#### context

每次 LLM 调用前触发。非破坏性地修改消息。消息类型见 [Session Format](session-format.md)。

```typescript
pi.on("context", async (event, ctx) => {
  // event.messages - 深拷贝，可安全修改
  const filtered = event.messages.filter(m => !shouldPrune(m));
  return { messages: filtered };
});
```

#### before_provider_headers

出站 HTTP headers 组装完成后触发。用它添加、覆盖或删除请求头。

处理器就地修改 `event.headers`。把 key 设为字符串以添加或覆盖，设为 `null` 以删除。

```typescript
pi.on("before_provider_headers", (event, ctx) => {
  // 添加或覆盖——例如网关追踪/归属的会话 id
  event.headers["x-session-id"] = ctx.sessionManager.getSessionId();

  // 丢弃 pi 为此调用添加的追踪头
  event.headers["X-OpenRouter-Title"] = null;
});
```

每个 provider 请求运行一次；重试复用相同 headers 而不是重新触发钩子。

#### before_provider_request

provider 特定 payload 构建后、请求发出前触发。处理器按扩展加载顺序运行。返回 `undefined` 保持 payload 不变。返回其他任何值会为后续处理器和实际请求替换 payload。

这个钩子可以重写 provider 级系统指令或完全移除它们。这些 payload 级变更不会反映在 `ctx.getSystemPrompt()` 中，后者报告的是 Pi 的系统提示字符串，而不是最终序列化的 provider payload。

```typescript
pi.on("before_provider_request", (event, ctx) => {
  console.log(JSON.stringify(event.payload, null, 2));

  // 可选：替换 payload
  // return { ...event.payload, temperature: 0 };
});
```

这主要用于调试 provider 序列化和缓存行为。

#### after_provider_response

收到 HTTP 响应后、消费其流式正文前触发。处理器按扩展加载顺序运行。

```typescript
pi.on("after_provider_response", (event, ctx) => {
  // event.status - HTTP 状态码
  // event.headers - 规范化后的响应头
  if (event.status === 429) {
    console.log("rate limited", event.headers["retry-after"]);
  }
});
```

头可用性取决于 provider 和传输。抽象 HTTP 响应的 provider 可能不暴露头。

### 模型事件

#### model_select

模型通过 `/model` 命令、模型循环（`Ctrl+P`）或会话恢复变更时触发。

```typescript
pi.on("model_select", async (event, ctx) => {
  // event.model - 新选中的模型
  // event.previousModel - 之前的模型（首次选择时为 undefined）
  // event.source - "set" | "cycle" | "restore"

  const prev = event.previousModel
    ? `${event.previousModel.provider}/${event.previousModel.id}`
    : "none";
  const next = `${event.model.provider}/${event.model.id}`;

  ctx.ui.notify(`Model changed (${event.source}): ${prev} -> ${next}`, "info");
});
```

在活跃模型变更时，用它更新 UI 元素（状态栏、页脚）或执行模型特定初始化。

#### thinking_level_select

思考等级变更时触发。这是仅通知；处理器返回值被忽略。

```typescript
pi.on("thinking_level_select", async (event, ctx) => {
  // event.level - 新选中的思考等级
  // event.previousLevel - 之前的思考等级

  ctx.ui.setStatus("thinking", `thinking: ${event.level}`);
});
```

在 `pi.setThinkingLevel()`、模型变更或内置思考等级控件变更活跃思考等级时，用它更新扩展 UI。

### 工具事件

#### tool_call

在 `tool_execution_start` 之后、工具执行前触发。**可阻止。**用 `isToolCallEventType` 窄化并获取带类型的输入。

`tool_call` 运行前，pi 等待之前发出的 Agent 事件通过 `AgentSession` 排空完毕。这意味着 `ctx.sessionManager` 已同步到当前 assistant 工具调用消息。

在默认并行工具执行模式下，同一 assistant 消息的兄弟工具调用依次预检，然后并发执行。`tool_call` 不保证能在 `ctx.sessionManager` 中看到同一 assistant 消息的兄弟工具结果。

`event.input` 可变。就地修改它，在执行前修补工具参数。

行为保证：
- 对 `event.input` 的修改影响实际工具执行
- 后面的 `tool_call` 处理器能看到前面处理器做的修改
- 你的修改之后不做重新验证
- `tool_call` 的返回值通过 `{ block: true, reason?: string, terminate?: boolean }` 控制阻止
- `terminate` 只适用于被阻止的调用；只有当批中所有已定稿结果都是终止性的时，agent 才提前停止

```typescript
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

pi.on("tool_call", async (event, ctx) => {
  // event.toolName - "bash"、"read"、"write"、"edit" 等
  // event.toolCallId
  // event.input - 工具参数（可变）

  // 内置工具：不需要类型参数
  if (isToolCallEventType("bash", event)) {
    // event.input 是 { command: string; timeout?: number }
    event.input.command = `source ~/.profile\n${event.input.command}`;

    if (event.input.command.includes("rm -rf")) {
      return { block: true, reason: "Dangerous command", terminate: true };
    }
  }

  if (isToolCallEventType("read", event)) {
    // event.input 是 { path: string; offset?: number; limit?: number }
    console.log(`Reading: ${event.input.path}`);
  }
});
```

#### 自定义工具输入的 typing

自定义工具应导出其输入类型：

```typescript
// my-extension.ts
export type MyToolInput = Static<typeof myToolSchema>;
```

用显式类型参数使用 `isToolCallEventType`：

```typescript
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { MyToolInput } from "my-extension";

pi.on("tool_call", (event) => {
  if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
    event.input.action;  // 带类型
  }
});
```

#### tool_result

工具执行完成后、`tool_execution_end` 和最终工具结果消息事件发出前触发。**可修改结果。**

并行工具模式下，`tool_result` 和 `tool_execution_end` 可能按工具完成顺序交错，而最终 `toolResult` 消息事件仍稍后按 assistant 源顺序发出。

`tool_result` 处理器像中间件一样链接：
- 处理器按扩展加载顺序运行
- 每个处理器看到前面处理器修改后的最新结果
- 处理器可返回部分补丁（`content`、`details`、`isError` 或 `usage`）；省略的字段保持当前值

在处理器内的嵌套异步工作使用 `ctx.signal`。这让 Esc 能取消扩展启动的模型调用、`fetch()` 和其他支持中止的操作。

```typescript
import { isBashToolResult } from "@earendil-works/pi-coding-agent";

pi.on("tool_result", async (event, ctx) => {
  // event.toolName, event.toolCallId, event.input
  // event.content, event.details, event.isError, event.usage

  if (isBashToolResult(event)) {
    // event.details 带类型，为 BashToolDetails
  }

  const response = await fetch("https://example.com/summarize", {
    method: "POST",
    body: JSON.stringify({ content: event.content }),
    signal: ctx.signal,
  });

  // 修改结果：
  return { content: [...], details: {...}, isError: false, usage: nestedModelUsage };
});
```

### 用户 Bash 事件

#### user_bash

用户执行 `!` 或 `!!` 命令时触发。**可拦截。**

```typescript
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

pi.on("user_bash", (event, ctx) => {
  // event.command - bash 命令
  // event.excludeFromContext - !! 前缀时为 true
  // event.cwd - 工作目录

  // 选项 1：提供自定义 operations（如 SSH）
  return { operations: remoteBashOps };

  // 选项 2：包装 pi 内置的本地 bash 后端
  const local = createLocalBashOperations();
  return {
    operations: {
      exec(command, cwd, options) {
        return local.exec(`source ~/.profile\n${command}`, cwd, options);
      }
    }
  };

  // 选项 3：完全替换 - 直接返回结果
  return { result: { output: "...", exitCode: 0, cancelled: false, truncated: false } };
});
```

### 输入事件

#### input

收到用户输入时触发，在扩展命令检查之后、skill 和模板展开之前。事件看到的是原始输入文本，所以 `/skill:foo` 和 `/template` 尚未展开。

**处理顺序：**
1. 先检查扩展命令（`/cmd`）- 找到则运行处理器并跳过 input 事件
2. 触发 `input` 事件 - 可拦截、转换或处理
3. 未处理：技能命令（`/skill:name`）展开为技能内容
4. 未处理：提示模板（`/template`）展开为模板内容
5. 开始 agent 处理（`before_agent_start` 等）

```typescript
pi.on("input", async (event, ctx) => {
  // event.text - 原始输入（skill/模板展开前）
  // event.images - 附带图片（如果有）
  // event.source - "interactive"（键入）、"rpc"（API）或 "extension"（通过 sendUserMessage）
  // event.streamingBehavior - "steer" | "followUp" | undefined
  //   空闲时为 undefined，流中断为 "steer"，
  //   排队到 agent 完成的消息为 "followUp"

  // 转换：展开前重写输入
  if (event.text.startsWith("?quick "))
    return { action: "transform", text: `Respond briefly: ${event.text.slice(7)}` };

  // 处理：不用 LLM 响应（扩展显示自己的反馈）
  if (event.text === "ping") {
    ctx.ui.notify("pong", "info");
    return { action: "handled" };
  }

  // 按来源路由：跳过扩展注入消息的处理
  if (event.source === "extension") return { action: "continue" };

  // 在展开前拦截技能命令
  if (event.text.startsWith("/skill:")) {
    // 可转换、阻止或放行
  }

  return { action: "continue" };  // 默认：放行到展开
});
```

**结果：**
- `continue` - 原样放行（处理器无返回时的默认）
- `transform` - 修改文本/图片，然后继续到展开
- `handled` - 完全跳过 agent（第一个返回它的处理器胜出）

转换跨处理器链接。`streamingBehavior` 感知的路由见 [input-transform.ts](../examples/extensions/input-transform.ts) 和 [input-transform-streaming.ts](../examples/extensions/input-transform-streaming.ts)。

## ExtensionContext

所有处理器接收 `ctx: ExtensionContext`。

### ctx.ui

用于用户交互的 UI 方法。完整细节见 [自定义 UI](#custom-ui)。

### ctx.mode

当前运行模式：`"tui"`、`"rpc"`、`"json"` 或 `"print"`。用 `ctx.mode === "tui"` 保护仅限终端的功能，如 `custom()`、组件工厂、终端输入和直接 TUI 渲染。

### ctx.hasUI

TUI 和 RPC 模式下为 `true`。print 模式（`-p`）和 JSON 模式下为 `false`。用它保护在 TUI 和 RPC 模式下都可用的对话框方法（`select`、`confirm`、`input`、`editor`）和发后即忘方法（`notify`、`setStatus`、`setWidget`、`setTitle`、`setEditorText`）。RPC 模式下，一些 TUI 特定方法是空操作或返回默认值（见 [rpc.md](rpc.md#extension-ui-protocol)）。

### ctx.cwd

当前工作目录。

构造项目本地配置路径时用 `CONFIG_DIR_NAME` 而不是硬编码 `.pi`。重品牌发行版可能使用不同的配置目录名。

```typescript
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const projectConfigPath = join(ctx.cwd, CONFIG_DIR_NAME, "my-extension.json");
    // ...
  });
}
```

### ctx.isProjectTrusted()

返回当前会话上下文中项目本地信任是否激活。这包括临时信任决定和 CLI 信任覆盖，不只是全局信任存储中的已保存决定。

在读取只应在受信任项目中生效的项目本地扩展配置前使用它。

### ctx.sessionManager

会话状态的只读访问。完整 SessionManager API 和条目类型见 [Session Format](session-format.md)。

对 `tool_call`，该状态在处理器运行前已同步到当前 assistant 消息。并行工具执行模式下仍不保证包含同一 assistant 消息的兄弟工具结果。

```typescript
ctx.sessionManager.getEntries()             // 所有条目
ctx.sessionManager.getBranch()              // 当前分支
ctx.sessionManager.buildContextEntries()    // 应用压缩后的活动分支条目
ctx.sessionManager.getLeafId()              // 当前叶条目 ID
```

### ctx.modelRegistry / ctx.model / ctx.thinkingLevel / ctx.scopedModels

访问模型、provider 和已解析的认证。`ctx.modelRegistry.getProvider(id)` 返回有效的 pi-ai provider，而 `getProviderAuth(id)` 在不要求已加载模型的情况下解析其当前 API key、headers、base URL 和 provider 范围环境变量。`ctx.model` 是活跃模型，`ctx.thinkingLevel` 是其当前有效思考等级。

`ctx.scopedModels` 是作用域限定到当前会话的模型只读列表——与 `/scoped-models` 命令显示的集合相同。它在会话启动时从 `--models` CLI 标志和 `enabledModels` 设置解析（用 minimatch 对 `provider/modelId` 或裸 `modelId` 与可用目录匹配）。未配置作用域时为空，意味着每个可用模型都可用。每个条目是 `{ model, thinkingLevel? }`，`thinkingLevel` 只在模式固定了它时设置（如 `anthropic/*:high`）。用它填充一个镜像内置选择器的模型选择器，而不是通过 `ctx.modelRegistry.getAvailable()` 枚举整个目录。

### ctx.signal

当前 agent 中止信号；无活跃 agent 回合时为 `undefined`。

用它于扩展处理器启动的中止感知嵌套工作，例如：
- `fetch(..., { signal: ctx.signal })`
- 接受 `signal` 的模型调用
- 接受 `AbortSignal` 的文件或进程帮助函数

`ctx.signal` 通常在 `tool_call`、`tool_result`、`message_update`、`turn_end` 等活跃回合事件中定义。
在空闲或非回合上下文（会话事件、扩展命令、pi 空闲时触发的快捷键）中通常为 `undefined`。

```typescript
pi.on("tool_result", async (event, ctx) => {
  const response = await fetch("https://example.com/api", {
    method: "POST",
    body: JSON.stringify(event),
    signal: ctx.signal,
  });

  const data = await response.json();
  return { details: data };
});
```

### ctx.isIdle() / ctx.abort() / ctx.hasPendingMessages()

控制流帮助函数。Pi 正在处理 agent 运行、自动重试、自动压缩重试或排队续接时 `ctx.isIdle()` 为 false。

### ctx.shutdown()

请求 pi 优雅关闭。

- **交互模式**：推迟到 agent 空闲（处理完所有排队的转向和后续消息后）。
- **RPC 模式**：推迟到下一个空闲状态（完成当前命令响应、等待下一个命令时）。
- **Print 模式**：空操作。所有提示处理完后进程自动退出。

退出前向所有扩展发出 `session_shutdown` 事件。在所有上下文（事件处理器、工具、命令、快捷键）中可用。

```typescript
pi.on("tool_call", (event, ctx) => {
  if (isFatal(event.input)) {
    ctx.shutdown();
  }
});
```

### ctx.getContextUsage()

返回活跃模型的当前上下文用量。可用时使用最后一个 assistant 用量，然后估算尾部消息的 token。

```typescript
const usage = ctx.getContextUsage();
if (usage && usage.tokens > 100_000) {
  // ...
}
```

### ctx.compact()

触发压缩而不等待完成。用 `onComplete` 和 `onError` 做后续动作。

```typescript
ctx.compact({
  customInstructions: "Focus on recent changes",
  onComplete: (result) => {
    ctx.ui.notify("Compaction completed", "info");
  },
  onError: (error) => {
    ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
  },
});
```

### ctx.getSystemPrompt()

返回 Pi 当前的系统提示字符串。

- 在 `before_agent_start` 期间，它反映当前回合到目前为止的链式系统提示修改。
- 它不包含后面的 `context` 消息修改。
- 它不包含 `before_provider_request` 的 payload 重写。
- 如果更晚加载的扩展在你的之后运行，它们仍可能改变最终发送的内容。

```typescript
pi.on("before_agent_start", (event, ctx) => {
  const prompt = ctx.getSystemPrompt();
  console.log(`System prompt length: ${prompt.length}`);
});
```

## ExtensionCommandContext

命令处理器接收 `ExtensionCommandContext`，它在 `ExtensionContext` 基础上扩展了会话控制方法。这些只在命令中可用，因为从事件处理器调用会导致死锁。

### ctx.getSystemPromptOptions()

返回 Pi 当前用来构建系统提示的基础输入。

```typescript
const options = ctx.getSystemPromptOptions();
const contextPaths = options.contextFiles?.map((file) => file.path) ?? [];
```

它与 `before_agent_start` 的 `event.systemPromptOptions` 形状和可变性相同：自定义提示、活跃工具、工具片段、提示准则、附加系统提示文本、cwd、已加载的上下文文件和已加载的技能。它可能包含完整上下文文件内容，所以把它当作敏感的扩展本地数据处理，避免通过命令列表、日志或自动补全元数据暴露它。

它报告当前的基础提示输入。它不包含每回合 `before_agent_start` 链式系统提示修改、后面的 `context` 事件消息修改或 `before_provider_request` payload 重写。

### ctx.waitForIdle()

等待 agent 完全结束，包括自动重试、自动压缩重试和排队续接：

```typescript
pi.registerCommand("my-cmd", {
  handler: async (args, ctx) => {
    await ctx.waitForIdle();
    // agent 现在空闲，可安全修改会话
  },
});
```

### ctx.newSession(options?)

创建新会话：

```typescript
const parentSession = ctx.sessionManager.getSessionFile();
const kickoff = "Continue in the replacement session";

const result = await ctx.newSession({
  parentSession,
  setup: async (sm) => {
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Context from previous session..." }],
      timestamp: Date.now(),
    });
  },
  withSession: async (ctx) => {
    // 这里只使用替换会话的 ctx。
    await ctx.sendUserMessage(kickoff);
  },
});

if (result.cancelled) {
  // 某个扩展取消了新会话
}
```

选项：
- `parentSession`：记录在新会话头中的父会话文件
- `setup`：在 `withSession` 运行前修改新会话的 `SessionManager`
- `withSession`：针对新鲜的替换会话上下文运行切换后工作。不要使用捕获的旧 `pi` / 命令 `ctx`；见 [会话替换生命周期与陷阱](#session-replacement-lifecycle-and-footguns)。

### ctx.fork(entryId, options?)

从特定条目分叉，创建新会话文件：

```typescript
const result = await ctx.fork("entry-id-123", {
  withSession: async (ctx) => {
    // 这里只使用替换会话的 ctx。
    ctx.ui.notify("Now in the forked session", "info");
  },
});
if (result.cancelled) {
  // 某个扩展取消了分叉
}

const cloneResult = await ctx.fork("entry-id-456", { position: "at" });
if (cloneResult.cancelled) {
  // 某个扩展取消了克隆
}
```

选项：
- `position`：`"before"`（默认）在选中的用户消息前分叉，并把该提示恢复到编辑器
- `position`：`"at"` 复制经过选中条目的活动路径，不恢复编辑器文本
- `withSession`：针对新鲜的替换会话上下文运行切换后工作。不要使用捕获的旧 `pi` / 命令 `ctx`；见 [会话替换生命周期与陷阱](#session-replacement-lifecycle-and-footguns)。

### ctx.navigateTree(targetId, options?)

导航到会话树的另一个点：

```typescript
const result = await ctx.navigateTree("entry-id-456", {
  summarize: true,
  customInstructions: "Focus on error handling changes",
  replaceInstructions: false, // true = 完全替换默认提示
  label: "review-checkpoint",
});
```

选项：
- `summarize`：是否生成废弃分支的摘要
- `customInstructions`：给摘要器的自定义指令
- `replaceInstructions`：为 true 时，`customInstructions` 替换默认提示而不是附加
- `label`：附加到分支摘要条目（或不摘要时目标条目）的标签

### ctx.switchSession(sessionPath, options?)

切换到另一个会话文件：

```typescript
const result = await ctx.switchSession("/path/to/session.jsonl", {
  withSession: async (ctx) => {
    await ctx.sendUserMessage("Resume work in the replacement session");
  },
});
if (result.cancelled) {
  // 某个扩展通过 session_before_switch 取消了切换
}
```

选项：
- `withSession`：针对新鲜的替换会话上下文运行切换后工作。不要使用捕获的旧 `pi` / 命令 `ctx`；见 [会话替换生命周期与陷阱](#session-replacement-lifecycle-and-footguns)。

要发现可用会话，使用静态 `SessionManager.list()` 或 `SessionManager.listAll()` 方法：

```typescript
import { SessionManager } from "@earendil-works/pi-coding-agent";

pi.registerCommand("switch", {
  description: "Switch to another session",
  handler: async (args, ctx) => {
    const sessions = await SessionManager.list(ctx.cwd);
    if (sessions.length === 0) return;
    const choice = await ctx.ui.select(
      "Pick session:",
      sessions.map(s => s.file),
    );
    if (choice) {
      await ctx.switchSession(choice, {
        withSession: async (ctx) => {
          ctx.ui.notify("Switched session", "info");
        },
      });
    }
  },
});
```

### 会话替换生命周期与陷阱

`withSession` 接收新鲜的 `ReplacedSessionContext`，它在 `ExtensionCommandContext` 基础上扩展了绑定到替换会话的异步 `sendMessage()` 和 `sendUserMessage()` 帮助函数。

生命周期与陷阱：
- `withSession` 只在旧会话发出 `session_shutdown`、旧运行时被拆除、替换会话重新绑定、新扩展实例已收到 `session_start` 之后运行。
- 回调仍在原始闭包中执行，不在新扩展实例内。这意味着你的旧扩展实例可能在 `withSession` 开始前已运行了关闭清理。
- 捕获的旧 `pi` / 旧命令 `ctx` 的会话绑定对象在替换后已过期，使用会抛出。会话绑定工作只使用传给 `withSession` 的 `ctx`。
- 之前提取的原始对象仍由你负责。例如，如果替换前捕获了 `const sm = ctx.sessionManager`，`sm` 仍是旧 `SessionManager` 对象。替换后不要重用。
- `withSession` 中的代码应假设你的 `session_shutdown` 处理器已失效的任何状态都已消失。只捕获能干净跨越关闭的纯数据，如字符串、id 和序列化配置。

安全模式：

```typescript
pi.registerCommand("handoff", {
  handler: async (_args, ctx) => {
    const kickoff = "Continue from the replacement session";
    await ctx.newSession({
      withSession: async (ctx) => {
        await ctx.sendUserMessage(kickoff);
      },
    });
  },
});
```

不安全模式：

```typescript
pi.registerCommand("handoff", {
  handler: async (_args, ctx) => {
    const oldSessionManager = ctx.sessionManager;
    await ctx.newSession({
      withSession: async (_ctx) => {
        // 过期的旧对象：不要这样做
        oldSessionManager.getSessionFile();
        pi.sendUserMessage("wrong");
      },
    });
  },
});
```

### ctx.reload()

运行与 `/reload` 相同的重载流程。

```typescript
pi.registerCommand("reload-runtime", {
  description: "Reload extensions, skills, prompts, themes, and context files",
  handler: async (_args, ctx) => {
    await ctx.reload();
    return;
  },
});
```

重要行为：
- `await ctx.reload()` 为当前扩展运行时发出 `session_shutdown`
- 然后重新加载资源，发出带 `reason: "reload"` 的 `session_start` 和带 reason `"reload"` 的 `resources_discover`
- 当前正在运行的命令处理器仍在旧调用帧中继续
- `await ctx.reload()` 之后的代码仍从重载前版本运行
- `await ctx.reload()` 之后的代码不得假设旧的内存扩展状态仍有效
- 处理器返回后，未来的命令/事件/工具调用使用新扩展版本

为了可预测的行为，把重载当作该处理器的终结（`await ctx.reload(); return;`）。

工具以 `ExtensionContext` 运行，所以不能直接调用 `ctx.reload()`。用命令作为重载入口，然后暴露一个把该命令作为后续用户消息排队的工具。

LLM 可调用来触发重载的示例工具：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("reload-runtime", {
    description: "Reload extensions, skills, prompts, themes, and context files",
    handler: async (_args, ctx) => {
      await ctx.reload();
      return;
    },
  });

  pi.registerTool({
    name: "reload_runtime",
    label: "Reload Runtime",
    description: "Reload extensions, skills, prompts, themes, and context files",
    parameters: Type.Object({}),
    async execute() {
      pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
      return {
        content: [{ type: "text", text: "Queued /reload-runtime as a follow-up command." }],
      };
    },
  });
}
```

## ExtensionAPI 方法

### pi.on(event, handler)

订阅事件。事件类型和返回值见 [事件](#events)。

### pi.registerTool(definition)

注册 LLM 可调用的自定义工具。完整细节见 [自定义工具](#custom-tools)。

`pi.registerTool()` 在扩展加载期间和启动后都可用。你可以在 `session_start`、命令处理器或其他事件处理器中调用它。新工具在同一会话中立即刷新，所以它们出现在 `pi.getAllTools()` 中且可被 LLM 调用，无需 `/reload`。

用 `pi.setActiveTools()` 在运行时启用或禁用工具（包括动态添加的工具）。

用 `promptSnippet` 让自定义工具在 `Available tools` 中获得一行条目，用 `promptGuidelines` 在工具激活时向默认 `Guidelines` 部分追加工具特定条目。

**重要**：`promptGuidelines` 条目以平面方式追加到 `Guidelines` 部分，没有工具名前缀。每条准则必须写明它所指的工具——避免 "Use this tool when..."，因为 LLM 无法分辨 "this" 指哪个工具。写 "Use my_tool when..."。

完整示例见 [dynamic-tools.ts](../examples/extensions/dynamic-tools.ts)。

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does",
  promptSnippet: "Summarize or transform text according to action",
  promptGuidelines: ["Use my_tool when the user asks to summarize previously generated text."],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) {
    // 可选的兼容垫片。在 schema 验证前运行。
    // 返回当前 schema 形状，例如把遗留字段
    // 折叠到现代参数对象中。
    return args;
  },

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // 流式进度
    onUpdate?.({ content: [{ type: "text", text: "Working..." }] });

    return {
      content: [{ type: "text", text: "Done" }],
      details: { result: "..." },
    };
  },

  // 可选：自定义渲染
  renderCall(args, theme, context) { ... },
  renderResult(result, options, theme, context) { ... },
});
```

### pi.sendMessage(message, options?)

向会话注入自定义消息。自定义消息参与 LLM 上下文。对于不应发给 LLM 的持久 TUI 专用内容，用 [`pi.appendEntry()`](#piappendentrycustomtype-data) 配合 [`pi.registerEntryRenderer()`](#piregisterentryrenderercustomtype-renderer)。

```typescript
pi.sendMessage({
  customType: "my-extension",
  content: "Message text",
  display: true,
  details: { ... },
}, {
  triggerTurn: true,
  deliverAs: "steer",
});
```

**选项：**
- `deliverAs` - 投递模式：
  - `"steer"`（默认）- 流式期间排队消息。在当前 assistant 回合执行完其工具调用后、下一次 LLM 调用前投递。
  - `"followUp"` - 等 agent 完成。只在 agent 没有更多工具调用时投递。
  - `"nextTurn"` - 排队到下一个用户提示。不打断也不触发任何东西。
- `triggerTurn: true` - 如果 agent 空闲，立即触发 LLM 响应。只适用于 `"steer"` 和 `"followUp"` 模式（`"nextTurn"` 忽略）。

### pi.sendUserMessage(content, options?)

向 agent 发送用户消息。与发送自定义消息的 `sendMessage()` 不同，这发送一个真实用户消息，看起来像用户键入的。总是触发回合。

```typescript
// 简单文本消息
pi.sendUserMessage("What is 2+2?");

// 带内容数组（文本 + 图片）
pi.sendUserMessage([
  { type: "text", text: "Describe this image:" },
  { type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } },
]);

// 流式期间 - 必须指定投递模式
pi.sendUserMessage("Focus on error handling", { deliverAs: "steer" });
pi.sendUserMessage("And then summarize", { deliverAs: "followUp" });

// 选择启用扩展命令分派和 skill/提示模板展开
pi.sendUserMessage("/review src/index.ts", { expandPromptTemplates: true });
```

**选项：**
- `deliverAs` - agent 流式时必填：
  - `"steer"` - 排队消息，在当前 assistant 回合执行完其工具调用后投递
  - `"followUp"` - 等 agent 完成所有工具
- `expandPromptTemplates` - 分派扩展命令并展开技能命令和提示模板。默认 `false`。

未流式时，消息立即发送并触发新回合。流式时未带 `deliverAs` 会抛出错误。

完整示例见 [send-user-message.ts](../examples/extensions/send-user-message.ts)。

### pi.appendEntry(customType, data?)

持久化扩展数据。自定义条目不参与 LLM 上下文。交互模式下，配合 `pi.registerEntryRenderer()` 它们也可以渲染在聊天记录中。

```typescript
pi.appendEntry("my-state", { count: 42 });
pi.appendEntry("status-card", { title: "Indexed files", count: 17 });

// 重载时恢复
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "my-state") {
      // 从 entry.data 重建
    }
  }
});
```

### pi.setSessionName(name)

设置会话显示名（在会话选择器中代替首条消息显示）。

```typescript
pi.setSessionName("Refactor auth module");
```

### pi.getSessionName()

获取当前会话名（如果已设置）。

```typescript
const name = pi.getSessionName();
if (name) {
  console.log(`Session: ${name}`);
}
```

### pi.setLabel(entryId, label)

设置或清除条目标签。标签是用户定义的书签和导航标记（在 `/tree` 选择器中显示）。

```typescript
// 设置标签
pi.setLabel(entryId, "checkpoint-before-refactor");

// 清除标签
pi.setLabel(entryId, undefined);

// 通过 sessionManager 读取标签
const label = ctx.sessionManager.getLabel(entryId);
```

标签持久化在会话中，重启后仍保留。用它们标记对话树中的重要点（回合、检查点）。

### pi.registerCommand(name, options)

注册命令。

如果多个扩展注册了相同命令名，pi 保留它们全部并按加载顺序分配数字调用后缀，如 `/review:1` 和 `/review:2`。

```typescript
pi.registerCommand("stats", {
  description: "Show session statistics",
  handler: async (args, ctx) => {
    const count = ctx.sessionManager.getEntries().length;
    ctx.ui.notify(`${count} entries`, "info");
  }
});
```

可选：为 `/command ...` 添加参数自动补全：

```typescript
import type { AutocompleteItem } from "@earendil-works/pi-tui";

pi.registerCommand("deploy", {
  description: "Deploy to an environment",
  getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
    const envs = ["dev", "staging", "prod"];
    const items = envs.map((e) => ({ value: e, label: e }));
    const filtered = items.filter((i) => i.value.startsWith(prefix));
    return filtered.length > 0 ? filtered : null;
  },
  handler: async (args, ctx) => {
    ctx.ui.notify(`Deploying: ${args}`, "info");
  },
});
```

### pi.getCommands()

获取当前会话中可通过 `prompt` 调用的斜杠命令。包括扩展命令、提示模板和技能命令。
列表与 RPC `get_commands` 顺序一致：先扩展，然后模板，最后技能。

```typescript
const commands = pi.getCommands();
const bySource = commands.filter((command) => command.source === "extension");
const userScoped = commands.filter((command) => command.sourceInfo.scope === "user");
```

每个条目形状如下：

```typescript
{
  name: string; // 可调用命令名，不带前导斜杠。可能带 "review:1" 这样的后缀
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}
```

把 `sourceInfo` 当作规范的来源字段。不要从命令名或临时路径解析推断所有权。

内置交互命令（如 `/model` 和 `/settings`）不包含在内。它们只在交互模式下处理，通过 `prompt` 发送不会执行。

### pi.registerMessageRenderer(customType, renderer)

为你的 `customType` 自定义消息注册自定义 TUI 渲染器。自定义消息由 `pi.sendMessage()` 创建并参与 LLM 上下文。见 [自定义 UI](#custom-ui)。

### pi.registerMarkdownTransformer(transformer)

为普通用户文本、assistant 文本和思考块中的 Markdown 注册转换器。转换器按扩展加载顺序运行，每个转换器接收上一个转换器返回的 Markdown。链完成后，Pi 用内置渲染器渲染转换后的内容。

转换器接收 Markdown 字符串和一个上下文，包含：

- `messageType` — `"user"`、`"assistant"` 或 `"assistant-thinking"`
- `isStreaming` — 部分 assistant 更新为 `true`；user、已定稿 assistant 和恢复的消息为 `false`
- `availableWidth` — 转换后 Markdown 内容可用的精确终端列数

返回转换后的 Markdown：

```typescript
pi.registerMarkdownTransformer((markdown, { messageType, isStreaming }) => {
  if (isStreaming || messageType === "assistant-thinking") return markdown;
  return markdown.replaceAll("-->", "→");
});
```

如果转换器抛出，Pi 保留到目前为止产生的 Markdown 并继续下一个转换器。钩子是仅显示的：会话和模型上下文中的原始消息不变。它对新用户消息、assistant 流式更新、恢复的会话消息和终端宽度变化都运行，所以转换器应保持同步且开销小。

### pi.registerEntryRenderer(customType, renderer)

为你的 `customType` 自定义条目注册自定义 TUI 渲染器。自定义条目由 `pi.appendEntry()` 创建，不参与 LLM 上下文。

```typescript
import { Box, Text } from "@earendil-works/pi-tui";

pi.registerEntryRenderer("status-card", (entry, { expanded }, theme) => {
  const data = entry.data as { title: string; count: number };
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(`${theme.bold(data.title)}: ${data.count}`));
  if (expanded) {
    box.addChild(new Text(theme.fg("dim", JSON.stringify(data, null, 2))));
  }
  return box;
});

pi.appendEntry("status-card", { title: "Indexed files", count: 17 });
```

### pi.registerShortcut(shortcut, options)

注册键盘快捷键。快捷键格式和内置键位绑定见 [keybindings.md](keybindings.md)。

```typescript
pi.registerShortcut("ctrl+shift+p", {
  description: "Toggle plan mode",
  handler: async (ctx) => {
    ctx.ui.notify("Toggled!");
  },
});
```

### pi.registerFlag(name, options)

注册 CLI 标志。

```typescript
pi.registerFlag("plan", {
  description: "Start in plan mode",
  type: "boolean",
  default: false,
});

// 检查值
if (pi.getFlag("plan")) {
  // 启用 plan 模式
}
```

### pi.exec(command, args, options?)

执行 shell 命令。

```typescript
const result = await pi.exec("git", ["status"], { signal, timeout: 5000 });
// result.stdout, result.stderr, result.code, result.killed
```

### pi.getActiveTools() / pi.getAllTools() / pi.setActiveTools(names)

管理活跃工具。对内置工具和动态注册的工具都可用。`pi.getActiveTools()` 返回 `string[]` 形式的活跃工具名；`pi.getAllTools()` 返回所有已配置工具的元数据。

```typescript
const active = pi.getActiveTools(); // ["read", "bash", ...]
const all = pi.getAllTools();
// all = [{
//   name: "read",
//   description: "Read file contents...",
//   parameters: ...,
//   promptGuidelines: ["Use read to examine files instead of cat or sed."],
//   sourceInfo: { path: "<builtin:read>", source: "builtin", scope: "temporary", origin: "top-level" }
// }, ...]
const builtinTools = all.filter((t) => t.sourceInfo.source === "builtin");
const extensionTools = all.filter((t) => t.sourceInfo.source !== "builtin" && t.sourceInfo.source !== "sdk");
pi.setActiveTools([...new Set([...active, "my_custom_tool"])]); // 保留当前工具并启用 my_custom_tool
pi.setActiveTools(["read", "bash"]); // 切换到只读
```

`pi.getAllTools()` 返回 `name`、`description`、`parameters`、`promptGuidelines` 和 `sourceInfo`。

典型的 `sourceInfo.source` 值：
- 内置工具为 `builtin`
- 通过 `createAgentSession({ customTools })` 传入的工具为 `sdk`
- 扩展注册的工具为扩展来源元数据

### pi.setModel(model)

设置当前模型。模型无可用 API key 时返回 `false`。自定义模型配置见 [models.md](models.md)。

```typescript
const model = ctx.modelRegistry.find("anthropic", "claude-sonnet-4-5");
if (model) {
  const success = await pi.setModel(model);
  if (!success) {
    ctx.ui.notify("No API key for this model", "error");
  }
}
```

### pi.getThinkingLevel() / pi.setThinkingLevel(level)

获取或设置思考等级。等级被钳制到模型能力（非推理模型始终用 "off"）。变更发出 `thinking_level_select`。

```typescript
const current = pi.getThinkingLevel();  // "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
pi.setThinkingLevel("high");
```

### pi.events

扩展间通信的共享事件总线：

```typescript
pi.events.on("my:event", (data) => { ... });
pi.events.emit("my:event", { ... });
```

### pi.registerProvider(name, config)

动态注册或覆盖模型 provider。适合代理、自定义端点或团队级模型配置。

在扩展工厂函数中进行的调用会被排队，在 runner 初始化后应用。在那之后进行的调用——例如从用户设置流程后的命令处理器——立即生效，无需 `/reload`。

动态 provider 可实现 `refreshModels`。Pi 在模型刷新时调用它，通过 provider 同步发布返回的列表，并传入规范的凭据/存储目录/网络/信号上下文。扩展决定是否通过带 generation 检查的 `context.publish({ persist: entry })` 持久化目录元数据；llama.cpp 这类实时服务器可以返回模型而不持久化。

`context.signal` 始终是具体信号，provider 回调必须把它传给阻塞 I/O。公共的 `ModelRuntime.refresh()` 和 `ModelRegistry.refresh()` 调用接受可选 signal，省略时无界；扩展和应用自己选择截止。取消会停止调用方的等待，即使 provider 忽略信号；但要停止底层工作仍需配合。

需要原生 provider 认证、过滤、刷新或流行为的扩展可以注册来自 `@earendil-works/pi-ai` 的完整 `Provider`。该 provider 成为组合基座，`models.json` 覆盖仍在其上生效。

```typescript
import { createProvider, openAICompletionsApi } from "@earendil-works/pi-ai";

const provider = createProvider({
  id: "local-server",
  name: "Local Server",
  baseUrl: "http://localhost:8080/v1",
  auth: {
    apiKey: {
      name: "Local server setup",
      async login(interaction) {
        return {
          type: "api_key",
          key: await interaction.prompt({ type: "secret", message: "API key" }),
        };
      },
      async resolve({ credential }) {
        return credential?.key
          ? { auth: { apiKey: credential.key }, source: "stored API key" }
          : undefined;
      },
    },
  },
  models: [],
  api: openAICompletionsApi(),
});

pi.registerProvider(provider);

// 注册带自定义模型的新 provider
pi.registerProvider("my-proxy", {
  name: "My Proxy",
  baseUrl: "https://proxy.example.com",
  apiKey: "$PROXY_API_KEY",  // 环境变量引用
  api: "anthropic-messages",
  models: [
    {
      id: "claude-sonnet-4-20250514",
      name: "Claude 4 Sonnet (proxy)",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384
    }
  ]
});

// 注册不持久化发现模型的实时 llama.cpp 目录
pi.registerProvider("llama.cpp", {
  baseUrl: "http://localhost:8080/v1",
  apiKey: "local",
  api: "openai-completions",
  async refreshModels({ signal }) {
    const response = await fetch("http://localhost:8080/v1/models", { signal });
    const { data } = await response.json();
    return data.map(({ id }) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384
    }));
  }
});

// 覆盖现有 provider 的 baseUrl（保留所有模型）
pi.registerProvider("anthropic", {
  baseUrl: "https://proxy.example.com"
});

// 注册支持 /login 的 OAuth provider
pi.registerProvider("corporate-ai", {
  baseUrl: "https://ai.corp.com",
  api: "openai-responses",
  models: [...],
  oauth: {
    name: "Corporate AI (SSO)",
    async login(callbacks) {
      // 自定义 OAuth 流程
      callbacks.onAuth({ url: "https://sso.corp.com/..." });
      const code = await callbacks.onPrompt({ message: "Enter code:" });
      return { refresh: code, access: code, expires: Date.now() + 3600000 };
    },
    async refreshToken(credentials, signal) {
      signal.throwIfAborted();
      // 刷新逻辑
      return credentials;
    },
    getApiKey(credentials) {
      return credentials.access;
    }
  }
});
```

对象形式接受完整的 pi-ai `Provider`，包括原生 `auth`、`getModels`、`refreshModels`、`filterModels`、`stream` 和 `streamSimple` 行为。

**遗留配置选项：**
- `name` - provider 在 `/login` 等 UI 中的显示名。
- `baseUrl` - API 端点 URL。定义模型时必填。
- `apiKey` - API key 字面量、环境变量插值（`$ENV_VAR` 或 `${ENV_VAR}`）或前导 `!command`。定义模型时必填（提供 `oauth` 时除外）。`$$` 转义 `$`，`$!` 转义字面 `!` 且不触发命令执行。
- `api` - API 类型：`"anthropic-messages"`、`"openai-completions"`、`"openai-responses"` 等。
- `headers` - 请求中包含的自定义头。
- `authHeader` - 为 true 时自动添加 `Authorization: Bearer` 头。
- `models` - 模型定义数组。提供时替换该 provider 的所有现有模型。模型定义可设 `baseUrl` 为该模型覆盖 provider 端点。
- `refreshModels` - 异步动态发现回调。其返回的模型替换扩展提供的模型。`context.stored` 包含持久化的 provider 快照；只在更新的目录数据应持久化时使用带 generation 检查的 `context.publish({ persist: entry })`。用 `persist: null` 删除该快照。
- `oauth` - 支持 `/login` 的 OAuth provider 配置。提供时 provider 出现在登录菜单。
- `streamSimple` - 非标准 API 的自定义流实现。

高级主题见 [custom-provider.md](custom-provider.md)：自定义流 API、OAuth 细节、模型定义参考。

### pi.unregisterProvider(name)

移除之前注册的 provider 及其模型。被该 provider 覆盖的内置模型会被恢复。如果 provider 未注册则无效果。

与 `registerProvider` 一样，在初始加载阶段之后调用时立即生效，无需 `/reload`。

```typescript
pi.registerCommand("my-setup-teardown", {
  description: "Remove the custom proxy provider",
  handler: async (_args, _ctx) => {
    pi.unregisterProvider("my-proxy");
  },
});
```

## 状态管理（State Management）

有状态的扩展应把状态存到工具结果的 `details` 中，以正确支持分支：

```typescript
export default function (pi: ExtensionAPI) {
  let items: string[] = [];

  // 从会话重建状态
  pi.on("session_start", async (_event, ctx) => {
    items = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        if (entry.message.toolName === "my_tool") {
          items = entry.message.details?.items ?? [];
        }
      }
    }
  });

  pi.registerTool({
    name: "my_tool",
    // ...
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      items.push("new item");
      return {
        content: [{ type: "text", text: "Added" }],
        details: { items: [...items] },  // 存储以便重建
      };
    },
  });
}
```

## 自定义工具（Custom Tools）

通过 `pi.registerTool()` 注册 LLM 可调用的工具。工具出现在系统提示中，并可有自定义渲染。

用 `promptSnippet` 在默认系统提示的 `Available tools` 部分获得简短的一行条目。省略时，自定义工具不会出现在该部分。

用 `promptGuidelines` 向默认系统提示的 `Guidelines` 部分添加工具特定条目。这些条目只在工具激活时包含（例如 `pi.setActiveTools([...])` 之后）。

**重要**：`promptGuidelines` 条目以平面方式追加到 `Guidelines` 部分，没有工具名前缀或分组。每条准则必须写明它所指的工具——避免 "Use this tool when..."，因为 LLM 无法分辨 "this" 指哪个工具。写 "Use my_tool when..."。

注意：一些模型会在工具路径参数中包含 @ 前缀。内置工具在解析路径前会剥离前导 @。如果你的自定义工具接受路径，也要规范化前导 @。

如果你的自定义工具修改文件，使用 `withFileMutationQueue()` 让它参与与内置 `edit` 和 `write` 相同的每文件队列。这很重要，因为工具调用默认并行运行。没有队列，两个工具可能读到相同的旧文件内容，计算出不同的更新，然后最后落盘的写入覆盖另一个。

失败示例：你的自定义工具编辑 `foo.ts`，同时内置 `edit` 在同一 assistant 回合也修改 `foo.ts`。如果你的工具不参与队列，两者都可能读取原始 `foo.ts`，应用各自的修改，其中一个修改丢失。

传给 `withFileMutationQueue()` 的是真实目标文件路径，而不是原始用户参数。先把它解析为绝对路径（相对 `ctx.cwd` 或你的工具工作目录）。对已存在的文件，帮助函数通过 `realpath()` 规范化，所以同一文件的符号链接别名共享一个队列。对新文件，由于还没有可 `realpath()` 的东西，回退到解析后的绝对路径。

对该目标路径排队整个修改窗口。这包括读-改-写逻辑，不只是最终写入。

```typescript
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
  const absolutePath = resolve(ctx.cwd, params.path);

  return withFileMutationQueue(absolutePath, async () => {
    await mkdir(dirname(absolutePath), { recursive: true });
    const current = await readFile(absolutePath, "utf8");
    const next = current.replace(params.oldText, params.newText);
    await writeFile(absolutePath, next, "utf8");

    return {
      content: [{ type: "text", text: `Updated ${params.path}` }],
      details: {},
    };
  });
}
```

### 工具定义（Tool Definition）

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does (shown to LLM)",
  promptSnippet: "List or add items in the project todo list",
  promptGuidelines: [
    "Use my_tool for todo planning instead of direct file edits when the user asks for a task list."
  ],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),  // Google 兼容用 StringEnum
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) {
    if (!args || typeof args !== "object") return args;
    const input = args as { action?: string; oldAction?: string };
    if (typeof input.oldAction === "string" && input.action === undefined) {
      return { ...input, action: input.oldAction };
    }
    return args;
  },

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // 检查取消
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
    }

    // 流式进度更新
    onUpdate?.({
      content: [{ type: "text", text: "Working..." }],
      details: { progress: 50 },
    });

    // 通过 pi.exec 运行命令（从扩展闭包捕获）
    const result = await pi.exec("some-command", [], { signal });

    // 返回结果
    return {
      content: [{ type: "text", text: "Done" }],  // 发给 LLM
      details: { data: result },                   // 用于渲染和状态
      // usage: nestedModelResponse.usage,          // 可选的嵌套 LLM 用量
      // 可选：当前工具批中所有已定稿工具结果
      // 也都返回 terminate: true 时，在此工具批后停止。
      terminate: true,
    };
  },

  // 可选：自定义渲染
  renderCall(args, theme, context) { ... },
  renderResult(result, options, theme, context) { ... },
});
```

**用量核算**：如果工具发起嵌套 LLM 调用，把它们合并的 `Usage` 作为 `usage` 返回。Pi 会把它持久化在工具结果上，并计入页脚、`/session` 和 RPC 会话总计。`tool_result` 处理器可以检查或替换该值。

**错误信号**：要把工具执行标记为失败（在结果上设置 `isError: true` 并报告给 LLM），从 `execute` 抛出错误。返回一个值绝不会设置错误标志，无论你的返回对象包含什么属性。

**提前终止**：从 `execute()` 返回 `terminate: true`，提示在当前工具批之后跳过自动后续 LLM 调用。这只在批中所有已定稿工具结果都是终止性时生效。最小示例见 [examples/extensions/structured-output.ts](../examples/extensions/structured-output.ts)，其中 agent 在最终的结构化输出工具调用处结束。

```typescript
// 正确：抛出以信号错误
async execute(toolCallId, params) {
  if (!isValid(params.input)) {
    throw new Error(`Invalid input: ${params.input}`);
  }
  return { content: [{ type: "text", text: "OK" }], details: {} };
}
```

**重要**：字符串枚举用 `@earendil-works/pi-ai` 的 `StringEnum`。`Type.Union`/`Type.Literal` 在 Google API 上不工作。

**参数准备**：`prepareArguments(args)` 可选。如果定义，它在 schema 验证之前、`execute()` 之前运行。用它来模仿旧的接受输入形状——当 pi 恢复一个存储的工具调用参数不再匹配当前 schema 的旧会话时。返回你想对 `parameters` 验证的对象。保持公共 schema 严格。不要为了维持旧的恢复会话可用而向 `parameters` 添加弃用的兼容字段。

示例：旧会话可能包含顶层 `oldText` 和 `newText` 的 `edit` 工具调用，而当前 schema 只接受 `edits: [{ oldText, newText }]`。

```typescript
pi.registerTool({
  name: "edit",
  label: "Edit",
  description: "Edit a single file using exact text replacement",
  parameters: Type.Object({
    path: Type.String(),
    edits: Type.Array(
      Type.Object({
        oldText: Type.String(),
        newText: Type.String(),
      }),
    ),
  }),
  prepareArguments(args) {
    if (!args || typeof args !== "object") return args;

    const input = args as {
      path?: string;
      edits?: Array<{ oldText: string; newText: string }>;
      oldText?: unknown;
      newText?: unknown;
    };

    if (typeof input.oldText !== "string" || typeof input.newText !== "string") {
      return args;
    }

    return {
      ...input,
      edits: [...(input.edits ?? []), { oldText: input.oldText, newText: input.newText }],
    };
  },
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // params 现在匹配当前 schema
    return {
      content: [{ type: "text", text: `Applying ${params.edits.length} edit block(s)` }],
      details: {},
    };
  },
});
```

### 覆盖内置工具（Overriding Built-in Tools）

扩展可以注册同名工具来覆盖内置工具（`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`）。交互模式发生这种情况时会显示警告。

```bash
# 扩展的 read 工具替换内置 read
pi -e ./tool-override.ts
```

或者，用 `--no-builtin-tools` 在不加载任何内置工具的情况下启动，同时保留扩展工具启用：
```bash
# 无内置工具，只有扩展工具
pi --no-builtin-tools -e ./my-extension.ts
```

完整示例见 [examples/extensions/tool-override.ts](../examples/extensions/tool-override.ts)，它用日志和访问控制覆盖 `read`。

**渲染**：内置渲染器继承按槽位解析。执行覆盖和渲染覆盖相互独立。如果你的覆盖省略 `renderCall`，使用内置 `renderCall`。如果省略 `renderResult`，使用内置 `renderResult`。如果两者都省略，自动使用内置渲染器（语法高亮、diff 等）。这让你可以在不重新实现 UI 的情况下包装内置工具做日志或访问控制。

**提示元数据**：`promptSnippet` 和 `promptGuidelines` 不从内置工具继承。如果你的覆盖应保留这些提示指令，在覆盖上显式定义。

**你的实现必须匹配精确的结果形状**，包括 `details` 类型。UI 和会话逻辑依赖这些形状做渲染和状态跟踪。

内置工具实现：
- [read.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/read.ts) - `ReadToolDetails`
- [bash.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/bash.ts) - `BashToolDetails`
- [edit.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts)
- [write.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/write.ts)
- [grep.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/grep.ts) - `GrepToolDetails`
- [find.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/find.ts) - `FindToolDetails`
- [ls.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/tools/ls.ts) - `LsToolDetails`

### 远程执行（Remote Execution）

内置工具支持可插拔 operations，用于委托给远程系统（SSH、容器等）：

```typescript
import { createReadTool, createBashTool, type ReadOperations } from "@earendil-works/pi-coding-agent";

// 用自定义 operations 创建工具
const remoteRead = createReadTool(cwd, {
  operations: {
    readFile: (path) => sshExec(remote, `cat ${path}`),
    access: (path) => sshExec(remote, `test -r ${path}`).then(() => {}),
  }
});

// 注册，执行时检查标志
pi.registerTool({
  ...remoteRead,
  async execute(id, params, signal, onUpdate, _ctx) {
    const ssh = getSshConfig();
    if (ssh) {
      const tool = createReadTool(cwd, { operations: createRemoteOps(ssh) });
      return tool.execute(id, params, signal, onUpdate);
    }
    return localRead.execute(id, params, signal, onUpdate);
  },
});
```

**Operations 接口**：`ReadOperations`、`WriteOperations`、`EditOperations`、`BashOperations`、`LsOperations`、`GrepOperations`、`FindOperations`

对 `user_bash`，扩展可以通过 `createLocalBashOperations()` 复用 pi 的本地 shell 后端，而不是重新实现本地进程派生、shell 解析和进程树终止。

bash 工具还支持 spawn 钩子，在执行前调整命令、cwd 或 env：

```typescript
import { createBashTool } from "@earendil-works/pi-coding-agent";

const bashTool = createBashTool(cwd, {
  spawnHook: ({ command, cwd, env }) => ({
    command: `source ~/.profile\n${command}`,
    cwd: `/mnt/sandbox${cwd}`,
    env: { ...env, CI: "1" },
  }),
});
```

`createBashTool()` 通过 `PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL` 和 `PI_REASONING_LEVEL` 向命令暴露当前会话。注入发生在 `spawnHook` 之前，所以钩子会在 `env` 中收到这些值，并在像上面那样展开现有环境时保留它们。设 `exposeSessionEnvironment: false` 禁用它们：

```typescript
const bashTool = createBashTool(cwd, {
  exposeSessionEnvironment: false,
});
```

变量语义见 [Bash 工具会话环境](environment-variables.md#bash-tool-session-environment)。带 `--ssh` 标志的完整 SSH 示例见 [examples/extensions/ssh.ts](../examples/extensions/ssh.ts)。

### 输出截断（Output Truncation）

**工具必须截断其输出**，以免压垮 LLM 上下文。大输出可能导致：
- 上下文溢出错误（提示过长）
- 压缩失败
- 模型性能下降

内置限制是 **50KB**（约 10k token）和 **2000 行**，以先到达者为准。使用导出的截断工具：

```typescript
import {
  truncateHead,      // 保留前 N 行/字节（适合文件读取、搜索结果）
  truncateTail,      // 保留最后 N 行/字节（适合日志、命令输出）
  truncateLine,      // 把单行截断到 maxBytes，带省略号
  formatSize,        // 人类可读大小（如 "50KB"、"1.5MB"）
  DEFAULT_MAX_BYTES, // 50KB
  DEFAULT_MAX_LINES, // 2000
} from "@earendil-works/pi-coding-agent";

async execute(toolCallId, params, signal, onUpdate, ctx) {
  const output = await runCommand();

  // 应用截断
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  let result = truncation.content;

  if (truncation.truncated) {
    // 把完整输出写入临时文件
    const tempFile = writeTempFile(output);

    // 告知 LLM 完整输出在哪里
    result += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
    result += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
    result += ` Full output saved to: ${tempFile}]`;
  }

  return { content: [{ type: "text", text: result }] };
}
```

**要点：**
- 开头重要的内容用 `truncateHead`（搜索结果、文件读取）
- 结尾重要的内容用 `truncateTail`（日志、命令输出）
- 输出被截断时始终告知 LLM，并说明完整版在哪里
- 在工具描述中文档化截断限制

完整示例见 [examples/extensions/truncated-tool.ts](../examples/extensions/truncated-tool.ts)，它用适当的截断包装 `rg`（ripgrep）。

### 多个工具（Multiple Tools）

一个扩展可以注册多个共享状态的工具：

```typescript
export default function (pi: ExtensionAPI) {
  let connection = null;

  pi.registerTool({ name: "db_connect", ... });
  pi.registerTool({ name: "db_query", ... });
  pi.registerTool({ name: "db_close", ... });

  pi.on("session_shutdown", async () => {
    connection?.close();
  });
}
```

### 自定义渲染（Custom Rendering）

工具可以提供 `renderCall` 和 `renderResult` 做自定义 TUI 显示。完整组件 API 见 [tui.md](tui.md)，工具行的组装配方式见 [tool-execution.ts](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/modes/interactive/components/tool-execution.ts)。

默认情况下，工具输出被包装在处理内边距和背景的 `Box` 中。定义的 `renderCall` 或 `renderResult` 必须返回 `Component`。如果某个槽位的渲染器未定义，`tool-execution.ts` 对该槽位使用回退渲染。

当工具应渲染自己的外壳而不是使用默认 `Box` 时，设置 `renderShell: "self"`。这对需要完全控制框架或背景行为的工具有用，例如必须在工具稳定后保持视觉稳定的大型预览。

```typescript
pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "Custom shell example",
  parameters: Type.Object({}),
  renderShell: "self",
  async execute() {
    return { content: [{ type: "text", text: "ok" }], details: undefined };
  },
  renderCall(args, theme, context) {
    return new Text(theme.fg("accent", "my custom shell"), 0, 0);
  },
});
```

`renderCall` 和 `renderResult` 各接收一个 `context` 对象，包含：
- `args` - 当前工具调用参数
- `state` - 跨 `renderCall` 和 `renderResult` 的共享行本地状态
- `lastComponent` - 该槽位之前返回的组件（如果有）
- `invalidate()` - 请求重新渲染该工具行
- `toolCallId`、`cwd`、`executionStarted`、`argsComplete`、`isPartial`、`expanded`、`showImages`、`isError`

跨槽位共享状态用 `context.state`。当你想跨渲染复用并修改同一组件时，把槽位本地缓存放在返回的组件实例上。

#### renderCall

渲染工具调用或标题：

```typescript
import { Text } from "@earendil-works/pi-tui";

renderCall(args, theme, context) {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  let content = theme.fg("toolTitle", theme.bold("my_tool "));
  content += theme.fg("muted", args.action);
  if (args.text) {
    content += " " + theme.fg("dim", `"${args.text}"`);
  }
  text.setText(content);
  return text;
}
```

#### renderResult

渲染工具结果或输出：

```typescript
renderResult(result, { expanded, isPartial }, theme, context) {
  if (isPartial) {
    return new Text(theme.fg("warning", "Processing..."), 0, 0);
  }

  if (result.details?.error) {
    return new Text(theme.fg("error", `Error: ${result.details.error}`), 0, 0);
  }

  let text = theme.fg("success", "✓ Done");
  if (expanded && result.details?.items) {
    for (const item of result.details.items) {
      text += "\n  " + theme.fg("dim", item);
    }
  }
  return new Text(text, 0, 0);
}
```

如果某槽位有意没有可见内容，返回空 `Component`，如空 `Container`。

#### 键位提示（Keybinding Hints）

用 `keyHint()` 显示尊重当前键位配置的关键绑定提示：

```typescript
import { keyHint } from "@earendil-works/pi-coding-agent";

renderResult(result, { expanded }, theme, context) {
  let text = theme.fg("success", "✓ Done");
  if (!expanded) {
    text += ` (${keyHint("app.tools.expand", "to expand")})`;
  }
  return new Text(text, 0, 0);
}
```

可用函数：
- `keyHint(keybinding, description)` - 格式化已配置的键位 id，如 `"app.tools.expand"` 或 `"tui.select.confirm"`
- `keyText(keybinding)` - 返回键位 id 的原始配置键文本
- `rawKeyHint(key, description)` - 格式化原始键字符串

使用带命名空间的键位 id：
- Coding-agent id 使用 `app.*` 命名空间，如 `app.tools.expand`、`app.editor.external`、`app.session.rename`
- 共享 TUI id 使用 `tui.*` 命名空间，如 `tui.select.confirm`、`tui.select.cancel`、`tui.input.tab`

键位 id 和默认值的完整列表见 [keybindings.md](keybindings.md)。`keybindings.json` 使用相同的带命名空间 id。

自定义编辑器和 `ctx.ui.custom()` 组件接收 `keybindings: KeybindingsManager` 作为注入参数。它们应直接使用注入的 manager，而不是调用 `getKeybindings()` 或 `setKeybindings()`。

#### 最佳实践

- 用 padding `(0, 0)` 的 `Text`。默认 Box 处理内边距。
- 多行内容用 `\n`。
- 处理 `isPartial` 以支持流式进度。
- 支持 `expanded` 以按需显示细节。
- 保持默认视图紧凑。
- 在 `renderResult` 中读 `context.args`，而不是把 args 复制到 `context.state`。
- `context.state` 只用于必须在 call 和 result 槽位间共享的数据。
- 同一组件实例可就地更新时，复用 `context.lastComponent`。
- 只在默认带框外壳碍事时用 `renderShell: "self"`。自壳模式下，工具负责自己的框架、内边距和背景。

#### 回退

如果某槽位渲染器未定义或抛出：
- `renderCall`：显示工具名
- `renderResult`：显示来自 `content` 的原始文本

### 动态工具加载（Dynamic Tool Loading）

扩展可以注册许多工具，同时只让一小部分初始集合保持活跃。然后工具可以在执行期间用 `pi.setActiveTools()` 添加更多工具。Pi 检测纯增量变更，在新可用的工具名上记录在该工具结果上，并在下一个模型请求前应用更新后的活跃集合。

这对所有模型都可用。支持原生延迟加载的模型保留稳定的提示前缀，并在工具结果位置加载新定义。其他模型使用下面的回退。

生命周期是：

1. 用 `pi.registerTool()` 注册每个工具，使其出现在 `pi.getAllTools()` 中。
2. 保持加载器工具（如 `search_tools`）活跃，可搜索工具保持不活跃。
3. 加载器执行期间，调用 `pi.setActiveTools([...currentTools, ...matchingTools])`。变更必须是增量的：同一次调用中不要移除当前活跃工具。
4. Pi 在加载器的工具结果上记录添加了哪些工具。
5. 在下一个模型响应前，Pi 用原生延迟加载（受支持时）或普通活跃工具列表暴露新增定义。

你不需要返回 provider 特定的工具引用，也不需要把加载器标记为特殊搜索工具。活跃工具变更就是信号。传给 `pi.setActiveTools()` 的名字必须已注册；未知名字被忽略。

#### 支持原生延迟加载的模型

- **Anthropic**
  - **模型**：Sonnet、Opus、Fable 4.5 或更新（不含 Haiku）
  - **原生表示**：延迟定义使用 `defer_loading`；加载点使用 `tool_reference` 内容。
- **OpenAI**
  - **模型**：`gpt-5.4` 及更新的家族
  - **原生表示**：Pi 在加载点添加完成的客户端 `tool_search_call` 和 `tool_search_output` 条目。

对已验证的自定义模型或代理，可以为 `anthropic-messages` 启用 `compat.supportsToolReferences: true`，或为 `openai-responses` 和 `openai-codex-responses` 启用 `compat.supportsToolSearch: true` 来启用原生处理。除非端点和模型接受对应的原生协议，否则保持这些禁用。

#### 回退行为

对所有其他模型和 provider，动态激活仍然可用：Pi 在下一个请求中正常发送完整的当前活跃工具列表。模型可以调用新激活的工具，但添加它们的定义可能使 provider 的缓存提示前缀失效。

当活跃集合不是纯增量时，例如用一组工具替换另一组，Pi 也使用这个安全回退。因此工具移除可用，但不使用延迟加载。

为了最佳缓存行为，整个会话保持加载器工具活跃，并添加工具而不是替换活跃集合。还请注意，激活带 `promptSnippet` 或 `promptGuidelines` 的工具会重建系统提示；即使 provider 支持延迟 schema，该系统提示变更也可能使前缀失效。延迟加载的工具通常应依赖其工具 `description` 并省略仅激活时的提示元数据。

#### 搜索工具示例

以下扩展注册两个可搜索工具，把它们从初始活跃集合移除，只保留 `search_tools` 作为它们的加载器。示例使用简单的关键词匹配，但搜索实现可以用 BM25、嵌入、远程目录或项目特定路由。

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SEARCHABLE_TOOL_NAMES = new Set(["lookup_weather", "search_issues"]);

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "lookup_weather",
    label: "Lookup Weather",
    description: "Look up the current weather for a city",
    parameters: Type.Object({ city: Type.String() }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: `Weather for ${params.city}: sunny` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "search_issues",
    label: "Search Issues",
    description: "Search project issues by keyword",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: `No open issues matching ${params.query}` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "search_tools",
    label: "Search Tools",
    description: "Search for and enable tools relevant to a task",
    promptSnippet: "Search for additional tools when the active tools cannot perform the task",
    promptGuidelines: [
      "Use search_tools when a task requires a capability that is not currently available.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Capability or task to search for" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    }),
    async execute(_toolCallId, params) {
      const terms = params.query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const matches = pi.getAllTools()
        .filter((tool) => SEARCHABLE_TOOL_NAMES.has(tool.name))
        .map((tool) => ({
          tool,
          score: terms.reduce(
            (score, term) =>
              score + (`${tool.name} ${tool.description}`.toLowerCase().includes(term) ? 1 : 0),
            0,
          ),
        }))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, params.limit ?? 3)
        .map((match) => match.tool.name);

      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: `No tools found for: ${params.query}` }],
          details: { matches: [] },
        };
      }

      const active = pi.getActiveTools();
      const added = matches.filter((name) => !active.includes(name));
      pi.setActiveTools([...new Set([...active, ...added])]);

      return {
        content: [{
          type: "text",
          text: added.length > 0
            ? `Loaded tools: ${added.join(", ")}`
            : `Matching tools already active: ${matches.join(", ")}`,
        }],
        details: { matches, added },
      };
    },
  });

  pi.on("session_start", () => {
    // 保持可搜索工具已注册但初始不活跃。保留内置
    // 和其他扩展拥有的工具，并保持加载器本身活跃。
    const initialTools = pi.getActiveTools().filter(
      (name) => !SEARCHABLE_TOOL_NAMES.has(name),
    );
    pi.setActiveTools([...new Set([...initialTools, "search_tools"])]);
  });
}
```

当 `search_tools` 添加一个匹配项时，模型在紧接的下一个请求中收到该定义。在支持原生的模型上，定义锚定在搜索结果之后，不改变初始工具 schema 前缀。在其他模型上，它出现在同一下一个请求的普通工具列表中。

## 自定义 UI（Custom UI）

扩展可以通过 `ctx.ui` 方法与用户交互，并自定义消息/工具的渲染方式。

**自定义组件见 [tui.md](tui.md)**，其中有以下模式的复制粘贴示例：
- 选择对话框（SelectList）
- 带取消的异步操作（BorderedLoader）
- 设置开关（SettingsList）
- 状态指示（setStatus）
- 流式期间的工作消息、可见性和指示（`setWorkingMessage`、`setWorkingVisible`、`setWorkingIndicator`）
- 编辑器上/下方的 widget（setWidget）
- 叠加在内置斜杠/路径补全之上的自动补全 provider（addAutocompleteProvider）
- 自定义页脚（setFooter）

### 对话框

```typescript
// 从选项中选择
const choice = await ctx.ui.select("Pick one:", ["A", "B", "C"]);

// 确认对话框
const ok = await ctx.ui.confirm("Delete?", "This cannot be undone");

// 文本输入
const name = await ctx.ui.input("Name:", "placeholder");

// 多行编辑器
const text = await ctx.ui.editor("Edit:", "prefilled text");

// 通知（非阻塞）
ctx.ui.notify("Done!", "info");  // "info" | "warning" | "error"
```

#### 带倒计时的对话框

对话框支持 `timeout` 选项，带实时倒计时显示自动关闭：

```typescript
// 对话框显示 "Title (5s)" → "Title (4s)" → ... → 在 0 时自动关闭
const confirmed = await ctx.ui.confirm(
  "Timed Confirmation",
  "This dialog will auto-cancel in 5 seconds. Confirm?",
  { timeout: 5000 }
);

if (confirmed) {
  // 用户确认
} else {
  // 用户取消或超时
}
```

**超时时的返回值：**
- `select()` 返回 `undefined`
- `confirm()` 返回 `false`
- `input()` 返回 `undefined`

#### 用 AbortSignal 手动关闭

要获得更多控制（例如区分超时和用户取消），使用 `AbortSignal`：

```typescript
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 5000);

const confirmed = await ctx.ui.confirm(
  "Timed Confirmation",
  "This dialog will auto-cancel in 5 seconds. Confirm?",
  { signal: controller.signal }
);

clearTimeout(timeoutId);

if (confirmed) {
  // 用户确认
} else if (controller.signal.aborted) {
  // 对话框超时
} else {
  // 用户取消（按了 Escape 或选择了 "No"）
}
```

完整示例见 [examples/extensions/timed-confirm.ts](../examples/extensions/timed-confirm.ts)。

### Widget、状态和页脚

```typescript
// 页脚状态（清除前持久）
ctx.ui.setStatus("my-ext", "Processing...");
ctx.ui.setStatus("my-ext", undefined);  // 清除

// 工作加载器（流式期间显示）
ctx.ui.setWorkingMessage("Thinking deeply...");
ctx.ui.setWorkingMessage();  // 恢复默认
ctx.ui.setWorkingVisible(false);  // 完全隐藏内置工作加载器行
ctx.ui.setWorkingVisible(true);   // 显示内置工作加载器行

// 工作指示（流式期间显示）
ctx.ui.setWorkingIndicator({ frames: [ctx.ui.theme.fg("accent", "●")] });  // 静态点
ctx.ui.setWorkingIndicator({
  frames: [
    ctx.ui.theme.fg("dim", "·"),
    ctx.ui.theme.fg("muted", "•"),
    ctx.ui.theme.fg("accent", "●"),
    ctx.ui.theme.fg("muted", "•"),
  ],
  intervalMs: 120,
});
ctx.ui.setWorkingIndicator({ frames: [] });  // 隐藏指示
ctx.ui.setWorkingIndicator();  // 恢复默认 spinner

// 编辑器上方的 widget（默认）
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"]);
// 编辑器下方的 widget
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"], { placement: "belowEditor" });
ctx.ui.setWidget("my-widget", (tui, theme) => new Text(theme.fg("accent", "Custom"), 0, 0));
ctx.ui.setWidget("my-widget", undefined);  // 清除

// 自定义页脚（完全替换内置页脚）
ctx.ui.setFooter((tui, theme) => ({
  render(width) { return [theme.fg("dim", "Custom footer")]; },
  invalidate() {},
}));
ctx.ui.setFooter(undefined);  // 恢复内置页脚

// 终端标题
ctx.ui.setTitle("pi - my-project");

// 编辑器文本
ctx.ui.setEditorText("Prefill text");
const current = ctx.ui.getEditorText();

// 粘贴到编辑器（触发粘贴处理，包括大内容折叠）
ctx.ui.pasteToEditor("pasted content");

// 在内置 provider 上叠加自定义自动补全行为
ctx.ui.addAutocompleteProvider((current) => ({
  triggerCharacters: ["#"],
  async getSuggestions(lines, line, col, options) {
    const beforeCursor = (lines[line] ?? "").slice(0, col);
    const match = beforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
    if (!match) {
      return current.getSuggestions(lines, line, col, options);
    }

    return {
      prefix: `#${match[1] ?? ""}`,
      items: [{ value: "#2983", label: "#2983", description: "Extension API for autocomplete" }],
    };
  },
  applyCompletion(lines, line, col, item, prefix) {
    return current.applyCompletion(lines, line, col, item, prefix);
  },
  shouldTriggerFileCompletion(lines, line, col) {
    return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
  },
}));

// 工具输出展开
const wasExpanded = ctx.ui.getToolsExpanded();
ctx.ui.setToolsExpanded(true);
ctx.ui.setToolsExpanded(wasExpanded);

// 自定义编辑器（vim 模式、emacs 模式等）
ctx.ui.setEditorComponent((tui, theme, keybindings) => new VimEditor(tui, theme, keybindings));
const currentEditor = ctx.ui.getEditorComponent();
ctx.ui.setEditorComponent((tui, theme, keybindings) =>
  new WrappedEditor(tui, theme, keybindings, currentEditor?.(tui, theme, keybindings))
);
ctx.ui.setEditorComponent(undefined);  // 恢复默认编辑器

// 主题管理（创建主题见 themes.md）
const themes = ctx.ui.getAllThemes();  // [{ name: "dark", path: "/..." | undefined }, ...]
const lightTheme = ctx.ui.getTheme("light");  // 加载但不切换
const result = ctx.ui.setTheme("light");  // 按名字切换
if (!result.success) {
  ctx.ui.notify(`Failed: ${result.error}`, "error");
}
ctx.ui.setTheme(lightTheme!);  // 或用 Theme 对象切换
ctx.ui.theme.fg("accent", "styled text");  // 访问当前主题
```

自定义工作指示帧按原样渲染。如果要带颜色，自己往帧字符串里加，例如用 `ctx.ui.theme.fg(...)`。

### 自动补全 Provider

用 `ctx.ui.addAutocompleteProvider()` 在内置斜杠命令和路径 provider 上叠加自定义自动补全逻辑。为 `$` 这类自定义自然触发器设置 `triggerCharacters`。

典型模式：

- 检查光标前的文本
- 你的扩展特定语法匹配时返回你自己的建议
- 否则委托给 `current.getSuggestions(...)`
- 除非需要自定义插入行为，否则委托 `applyCompletion(...)`

```typescript
pi.on("session_start", (_event, ctx) => {
  ctx.ui.addAutocompleteProvider((current) => ({
    triggerCharacters: ["#"],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const line = lines[cursorLine] ?? "";
      const beforeCursor = line.slice(0, cursorCol);
      const match = beforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
      if (!match) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      return {
        prefix: `#${match[1] ?? ""}`,
        items: [
          { value: "#2983", label: "#2983", description: "Extension API for registering custom @ autocomplete providers" },
          { value: "#2753", label: "#2753", description: "Reload stale resource settings" },
        ],
      };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  }));
});
```

完整示例见 [github-issue-autocomplete.ts](../examples/extensions/github-issue-autocomplete.ts)，它用 `gh issue list` 预加载最近的未关闭 GitHub issue 并在本地过滤，实现快速的 `#...` 补全。它需要 GitHub CLI（`gh`）和 GitHub 仓库 checkout。

### 自定义组件

复杂 UI 用 `ctx.ui.custom()`。它会临时用你的组件替换编辑器，直到调用 `done()`：

```typescript
import { Text, Component } from "@earendil-works/pi-tui";

const result = await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
  const text = new Text("Press Enter to confirm, Escape to cancel", 1, 1);

  text.onKey = (key) => {
    if (key === "return") done(true);
    if (key === "escape") done(false);
    return true;
  };

  return text;
});

if (result) {
  // 用户按了 Enter
}
```

回调接收：
- `tui` - TUI 实例（用于屏幕尺寸、焦点管理）
- `theme` - 当前主题，用于样式
- `keybindings` - 应用键位 manager（用于检查快捷键）
- `done(value)` - 调用以关闭组件并返回值

完整组件 API 见 [tui.md](tui.md)。

#### 覆盖模式（实验性）

传 `{ overlay: true }` 把组件渲染为浮在现有内容之上的浮动模态，不清屏：

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyOverlayComponent({ onClose: done }),
  { overlay: true }
);
```

高级定位（锚点、边距、百分比、响应式可见性）传 `overlayOptions`。用 `onHandle` 编程控制焦点或可见性：

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyOverlayComponent({ onClose: done }),
  {
    overlay: true,
    overlayOptions: { anchor: "top-right", width: "50%", margin: 2 },
    onHandle: (handle) => {
      handle.focus(); // 聚焦此覆盖并提到视觉最前
      // handle.unfocus({ target: editorComponent }); // 把输入释放给特定组件
      // handle.setHidden(true/false); // 切换可见性
      // handle.hide(); // 永久移除
    }
  }
);
```

聚焦的可见覆盖可以在临时的非覆盖自定义 UI 关闭后重新夺回输入。如果你有意让另一个组件在覆盖保持可见时保留输入，调用 `handle.unfocus({ target })`。传 `{ target: null }` 释放覆盖而不聚焦其他组件。

完整 `OverlayOptions` 和 `OverlayHandle` API 见 [tui.md](tui.md)，示例见 [overlay-qa-tests.ts](../examples/extensions/overlay-qa-tests.ts)。

### 自定义编辑器

用自定义实现替换主输入编辑器（vim 模式、emacs 模式等）：

```typescript
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

class VimEditor extends CustomEditor {
  private mode: "normal" | "insert" = "insert";

  handleInput(data: string): void {
    if (matchesKey(data, "escape") && this.mode === "insert") {
      this.mode = "normal";
      return;
    }
    if (this.mode === "normal" && data === "i") {
      this.mode = "insert";
      return;
    }
    super.handleInput(data);  // 应用键位 + 文本编辑
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new VimEditor(tui, theme, keybindings)
    );
  });
}
```

**要点：**
- 继承 `CustomEditor`（不是基础 `Editor`）以获得应用键位（escape 中止、ctrl+d、模型切换）
- 对你不处理的键调用 `super.handleInput(data)`
- 工厂从应用接收 `tui`、`theme` 和 `keybindings`
- 在 `setEditorComponent()` 前用 `ctx.ui.getEditorComponent()` 包装之前配置的自定义编辑器
- 传 `undefined` 恢复默认：`ctx.ui.setEditorComponent(undefined)`

要与已经替换了编辑器的另一个扩展组合，在设置你的之前捕获之前的工厂：

```typescript
const previous = ctx.ui.getEditorComponent();
ctx.ui.setEditorComponent((tui, theme, keybindings) =>
  new MyEditor(tui, theme, keybindings, { base: previous?.(tui, theme, keybindings) })
);
```

带模式指示的完整示例见 [tui.md](tui.md) 模式 7。

### 消息和条目渲染

为你的 `customType` 消息注册自定义渲染器。应参与 LLM 上下文的内容用消息渲染器：

```typescript
import { Text } from "@earendil-works/pi-tui";

pi.registerMessageRenderer("my-extension", (message, options, theme) => {
  const { expanded, outputPad } = options;
  let text = theme.fg("accent", `[${message.customType}] `);
  text += message.content;

  if (expanded && message.details) {
    text += "\n" + theme.fg("dim", JSON.stringify(message.details, null, 2));
  }

  return new Text(text, outputPad, 0);
});
```

消息通过 `pi.sendMessage()` 发送：

```typescript
pi.sendMessage({
  customType: "my-extension",  // 与 registerMessageRenderer 匹配
  content: "Status update",
  display: true,               // 在 TUI 显示
  details: { ... },            // 渲染器中可用
});
```

对于不应发给 LLM 的 TUI 专用内容，改用自定义条目渲染：

```typescript
pi.registerEntryRenderer("my-card", (entry, options, theme) => {
  return new Text(theme.fg("accent", JSON.stringify(entry.data)));
});

pi.appendEntry("my-card", { status: "done" });
```

### 主题颜色

所有渲染函数接收 `theme` 对象。创建自定义主题和完整色板见 [themes.md](themes.md)。

```typescript
// 前景色
theme.fg("toolTitle", text)   // 工具名
theme.fg("accent", text)      // 高亮
theme.fg("success", text)     // 成功（绿）
theme.fg("error", text)       // 错误（红）
theme.fg("warning", text)     // 警告（黄）
theme.fg("muted", text)       // 次要文本
theme.fg("dim", text)         // 第三级文本

// 文本样式
theme.bold(text)
theme.italic(text)
theme.strikethrough(text)
```

自定义工具渲染器中的语法高亮：

```typescript
import { highlightCode, getLanguageFromPath } from "@earendil-works/pi-coding-agent";

// 用显式语言高亮代码
const highlighted = highlightCode("const x = 1;", "typescript", theme);

// 从文件路径自动检测语言
const lang = getLanguageFromPath("/path/to/file.rs");  // "rust"
const highlighted = highlightCode(code, lang, theme);
```

## 错误处理（Error Handling）

- 扩展错误被记录，agent 继续
- `tool_call` 错误阻止该工具（安全失效）
- 工具 `execute` 错误必须通过抛出信号；抛出的错误被捕获，以 `isError: true` 报告给 LLM，执行继续

## 模式行为（Mode Behavior）

| 模式 | `ctx.mode` | `ctx.hasUI` | 说明 |
|------|------------|-------------|-------|
| 交互 | `"tui"` | `true` | 带终端渲染的完整 TUI |
| RPC（`--mode rpc`） | `"rpc"` | `true` | 对话框和通知通过 JSON 协议；`custom()` 返回 `undefined`。见 [rpc.md](rpc.md) |
| JSON（`--mode json`） | `"json"` | `false` | 事件流到 stdout；UI 方法是空操作 |
| Print（`-p`） | `"print"` | `false` | 扩展运行但不能提示 |

在 TUI 特定功能（`custom()`、组件工厂、终端输入）前使用 `ctx.mode === "tui"`。在 TUI 和 RPC 模式下都可用的对话框和通知方法前使用 `ctx.hasUI`。

## 示例参考（Examples Reference）

所有示例在 [examples/extensions/](../examples/extensions/)。

| 示例 | 描述 | 关键 API |
|---------|-------------|----------|
| **工具** |||
| `hello.ts` | 最小工具注册 | `registerTool` |
| `question.ts` | 带用户交互的工具 | `registerTool`、`ui.select` |
| `questionnaire.ts` | 多步向导工具 | `registerTool`、`ui.custom` |
| `todo.ts` | 带持久化的有状态工具 | `registerTool`、`appendEntry`、`renderResult`、会话事件 |
| `dynamic-tools.ts` | 启动后和命令中注册工具 | `registerTool`、`session_start`、`registerCommand` |
| `structured-output.ts` | 带 `terminate: true` 的最终结构化输出工具 | `registerTool`、终止性工具结果 |
| `truncated-tool.ts` | 输出截断示例 | `registerTool`、`truncateHead` |
| `tool-override.ts` | 覆盖内置 read 工具 | `registerTool`（与内置同名） |
| **命令** |||
| `pirate.ts` | 每回合修改系统提示 | `registerCommand`、`before_agent_start` |
| `summarize.ts` | 对话摘要命令 | `registerCommand`、`ui.custom` |
| `handoff.ts` | 跨 provider 模型交接 | `registerCommand`、`ui.editor`、`ui.custom` |
| `qna.ts` | 带自定义 UI 的问答 | `registerCommand`、`ui.custom`、`setEditorText` |
| `send-user-message.ts` | 注入用户消息 | `registerCommand`、`sendUserMessage` |
| `reload-runtime.ts` | 重载命令和 LLM 工具交接 | `registerCommand`、`ctx.reload()`、`sendUserMessage` |
| `shutdown-command.ts` | 优雅关闭命令 | `registerCommand`、`shutdown()` |
| **事件与门** |||
| `permission-gate.ts` | 阻止危险命令 | `on("tool_call")`、`ui.confirm` |
| `project-trust.ts` | 从用户/全局或 CLI 扩展决定或推迟项目信任 | `on("project_trust")`、信任 UI、必需的信任结果 |
| `protected-paths.ts` | 阻止写入特定路径 | `on("tool_call")` |
| `confirm-destructive.ts` | 确认会话变更 | `on("session_before_switch")`、`on("session_before_fork")` |
| `dirty-repo-guard.ts` | 脏 git 仓库警告 | `on("session_before_*")`、`exec` |
| `input-transform.ts` | 转换用户输入 | `on("input")` |
| `input-transform-streaming.ts` | 流感知的输入转换 | `on("input")`、`streamingBehavior` |
| `model-status.ts` | 响应模型变更 | `on("model_select")`、`setStatus` |
| `provider-payload.ts` | 检查 payload 和 provider 响应头 | `on("before_provider_request")`、`on("after_provider_response")` |
| `system-prompt-header.ts` | 显示系统提示信息 | `on("agent_start")`、`getSystemPrompt` |
| `claude-rules.ts` | 从文件加载规则 | `on("session_start")`、`on("before_agent_start")` |
| `prompt-customizer.ts` | 用 `systemPromptOptions` 添加上下文感知的工具指导 | `on("before_agent_start")`、`BuildSystemPromptOptions` |
| `file-trigger.ts` | 文件监视器触发消息 | `sendMessage` |
| **压缩与会话** |||
| `custom-compaction.ts` | 自定义压缩摘要 | `on("session_before_compact")` |
| `trigger-compact.ts` | 手动触发压缩 | `compact()` |
| `git-checkpoint.ts` | 回合上 git stash | `on("turn_start")`、`on("session_before_fork")`、`exec` |
| `git-merge-and-resolve.ts` | 拉取、合并并解决冲突 | `on("agent_end")`、`exec`、`sendUserMessage` |
| `auto-commit-on-exit.ts` | 关闭时提交 | `on("session_shutdown")`、`exec` |
| **UI 组件** |||
| `status-line.ts` | 页脚状态指示 | `setStatus`、会话事件 |
| `working-indicator.ts` | 自定义流式工作指示 | `setWorkingIndicator`、`registerCommand` |
| `github-issue-autocomplete.ts` | 用 `gh issue list` 预加载最近未关闭 issue，在内置自动补全上叠加 `#1234` issue 补全 | `addAutocompleteProvider`、`on("session_start")`、`exec` |
| `custom-footer.ts` | 完全替换页脚 | `registerCommand`、`setFooter` |
| `custom-header.ts` | 替换启动头 | `on("session_start")`、`setHeader` |
| `modal-editor.ts` | vim 风格模态编辑器 | `setEditorComponent`、`CustomEditor` |
| `rainbow-editor.ts` | 自定义编辑器样式 | `setEditorComponent` |
| `widget-placement.ts` | 编辑器上/下方的 widget | `setWidget` |
| `overlay-test.ts` | 覆盖组件 | 带覆盖选项的 `ui.custom` |
| `overlay-qa-tests.ts` | 综合覆盖测试 | `ui.custom`、所有覆盖选项 |
| `notify.ts` | 简单通知 | `ui.notify` |
| `timed-confirm.ts` | 带超时的对话框 | 带 timeout/signal 的 `ui.confirm` |
| `mac-system-theme.ts` | 自动切换主题 | `setTheme`、`exec` |
| **复杂扩展** |||
| `plan-mode/` | 完整 plan 模式实现 | 所有事件类型、`registerCommand`、`registerShortcut`、`registerFlag`、`setStatus`、`setWidget`、`sendMessage`、`setActiveTools` |
| `preset.ts` | 可保存预设（模型、工具、思考） | `registerCommand`、`registerShortcut`、`registerFlag`、`setModel`、`setActiveTools`、`setThinkingLevel`、`appendEntry` |
| `tools.ts` | 工具开关 UI | `registerCommand`、`setActiveTools`、`SettingsList`、会话事件 |
| **远程与沙箱** |||
| `ssh.ts` | SSH 远程执行 | `registerFlag`、`on("user_bash")`、`on("before_agent_start")`、工具 operations |
| `interactive-shell.ts` | 持久 shell 会话 | `on("user_bash")` |
| `sandbox/` | 沙箱工具执行 | 工具 operations |
| `gondolin/` | 把内置工具和 `!` 命令路由到 Gondolin 微型 VM | 工具 operations、内置工具覆盖、`on("user_bash")` |
| `subagent/` | 派生子 agent | `registerTool`、`exec` |
| **游戏** |||
| `snake.ts` | 贪吃蛇游戏 | `registerCommand`、`ui.custom`、键盘处理 |
| `space-invaders.ts` | 小行星入侵者游戏 | `registerCommand`、`ui.custom` |
| `doom-overlay/` | 覆盖中的 Doom | 带覆盖的 `ui.custom` |
| **Provider** |||
| `custom-provider-anthropic/` | 自定义 Anthropic 代理 | `registerProvider` |
| `custom-provider-gitlab-duo/` | GitLab Duo 集成 | 带 OAuth 的 `registerProvider` |
| **消息与通信** |||
| `message-renderer.ts` | 自定义消息渲染 | `registerMessageRenderer`、`sendMessage` |
| `entry-renderer.ts` | 仅 TUI 的自定义条目渲染 | `registerEntryRenderer`、`appendEntry` |
| `event-bus.ts` | 扩展间事件 | `pi.events` |
| **会话元数据** |||
| `session-name.ts` | 为选择器命名会话 | `setSessionName`、`getSessionName` |
| `bookmark.ts` | 为 /tree 书签条目 | `setLabel` |
| **其他** |||
| `inline-bash.ts` | 工具调用中的内联 bash | `on("tool_call")` |
| `bash-spawn-hook.ts` | 执行前调整 bash 命令、cwd 和 env | `createBashTool`、`spawnHook` |
| `with-deps/` | 带 npm 依赖的扩展 | 带 `package.json` 的包结构 |
