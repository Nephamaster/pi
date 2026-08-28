> pi 可以帮助你使用 SDK。让它为你的使用场景构建一个集成。

# SDK

SDK 提供对 pi agent 能力的编程式访问。用它把 pi 嵌入其他应用、构建自定义界面，或集成到自动化工作流。

**用例示例：**
- 构建自定义 UI（Web、桌面、移动）
- 把 agent 能力集成到现有应用
- 创建带 agent 推理的自动化流水线
- 构建会派生子 agent 的自定义工具
- 编程式测试 agent 行为

从最小到完全控制的可用示例见 [examples/sdk/](../examples/sdk/)。

## 快速开始

```typescript
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("What files are in the current directory?");
```

## 安装

```bash
npm install @earendil-works/pi-coding-agent
```

SDK 包含在主包中。无需单独安装。

## 核心概念

### createAgentSession()

单个 `AgentSession` 的主工厂函数。

`createAgentSession()` 使用 `ResourceLoader` 提供扩展、技能、提示模板、主题和上下文文件。不提供时，它使用带标准发现的 `DefaultResourceLoader`。

```typescript
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

// Minimal: defaults with DefaultResourceLoader
const { session } = await createAgentSession();

// Custom: override specific options
const { session } = await createAgentSession({
  model: myModel,
  tools: ["read", "bash"],
  sessionManager: SessionManager.inMemory(),
});
```

### AgentSession

会话管理 agent 生命周期、消息历史、模型状态、压缩和事件流。

```typescript
interface AgentSession {
  // Send a prompt and wait for completion
  prompt(text: string, options?: PromptOptions): Promise<void>;

  // Queue messages during streaming
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;

  // Subscribe to events (returns unsubscribe function)
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;

  // Session info
  sessionFile: string | undefined;
  sessionId: string;

  // Model control
  setModel(model: Model): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  cycleModel(): Promise<ModelCycleResult | undefined>;
  cycleThinkingLevel(): ThinkingLevel | undefined;

  // State access
  agent: Agent;
  model: Model | undefined;
  thinkingLevel: ThinkingLevel;
  messages: AgentMessage[];
  isStreaming: boolean;

  // In-place tree navigation within the current session file
  navigateTree(targetId: string, options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }): Promise<{ editorText?: string; cancelled: boolean }>;

  // Compaction
  compact(customInstructions?: string): Promise<CompactionResult>;
  abortCompaction(): void;

  // Abort current operation
  abort(): Promise<void>;

  // Cleanup
  dispose(): void;
}
```

新会话、恢复、分叉和导入这类会话替换 API 位于 `AgentSessionRuntime` 上，不在 `AgentSession` 上。

### createAgentSessionRuntime() 和 AgentSessionRuntime

需要替换活动会话并重建 cwd 绑定的运行时状态时，使用 runtime API。
这是内置交互、print 和 RPC 模式使用的同一层。

`createAgentSessionRuntime()` 接收一个 runtime 工厂加初始 cwd/会话目标。工厂闭包进程全局固定输入，为有效 cwd 重建 cwd 绑定的服务，针对这些服务解析会话选项，并返回完整的 runtime 结果。

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});
```

`AgentSessionRuntime` 拥有跨以下操作的活动 runtime 替换：

- `newSession()`
- `switchSession()`
- `fork()`
- 通过 `fork(entryId, { position: "at" })` 的克隆流程
- `importFromJsonl()`

重要行为：

- 这些操作后 `runtime.session` 会变化
- 事件订阅附着在特定 `AgentSession` 上，所以替换后要重新订阅
- 如果你使用扩展，为新会话再次调用 `runtime.session.bindExtensions(...)`
- 创建在 `runtime.diagnostics` 上返回诊断
- runtime 创建或替换失败时，方法抛出异常，由调用方决定如何处理

```typescript
let session = runtime.session;
let unsubscribe = session.subscribe(() => {});

await runtime.newSession();

unsubscribe();
session = runtime.session;
unsubscribe = session.subscribe(() => {});
```

### 提示和消息排队

`PromptOptions` 控制提示展开、流式期间的排队行为和提示 preflight 通知：

```typescript
interface PromptOptions {
  expandPromptTemplates?: boolean;
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";
  source?: InputSource;
  preflightResult?: (success: boolean) => void;
}
```

`preflightResult` 每次 `prompt()` 调用调用一次：

- `true` 当提示被接受、排队或立即处理
- `false` 当提示 preflight 在接受前被拒绝

它在 `prompt()` 解析之前触发。`prompt()` 仍只在完整的已接受运行（包括重试）结束后解析。接受之后的失败通过正常的事件和消息流报告，而不是通过 `preflightResult(false)`。

`prompt()` 方法处理提示模板、扩展命令和消息发送：

```typescript
// Basic prompt (when not streaming)
await session.prompt("What files are here?");

// With images
await session.prompt("What's in this image?", {
  images: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } }]
});

// During streaming: must specify how to queue the message
await session.prompt("Stop and do this instead", { streamingBehavior: "steer" });
await session.prompt("After you're done, also check X", { streamingBehavior: "followUp" });
```

**行为：**
- **扩展命令**（如 `/mycommand`）：立即执行，即使在流式期间。它们通过 `pi.sendMessage()` 管理自己的 LLM 交互。
- **基于文件的提示模板**（来自 `.md` 文件）：在发送或排队前展开为其内容。
- **流式期间不带 `streamingBehavior`**：抛出错误。直接用 `steer()` 或 `followUp()`，或指定该选项。
- **`preflightResult(true)`**：表示提示被接受、排队或立即处理。
- **`preflightResult(false)`**：表示 preflight 在接受前被拒绝。

流式期间显式排队：

```typescript
// Queue a steering message for delivery after the current assistant turn finishes its tool calls
await session.steer("New instruction");

// Wait for agent to finish (delivered only when agent stops)
await session.followUp("After you're done, also do this");
```

`steer()` 和 `followUp()` 都展开基于文件的提示模板，但对扩展命令报错（扩展命令不能排队）。

### Agent 和 AgentState

`Agent` 类（来自 `@earendil-works/pi-agent-core`）处理核心 LLM 交互。通过 `session.agent` 访问。

```typescript
// Access current state
const state = session.agent.state;

// state.messages: AgentMessage[] - conversation history
// state.model: Model - current model
// state.thinkingLevel: ThinkingLevel - current thinking level
// state.systemPrompt: string - system prompt
// state.tools: AgentTool[] - available tools
// state.streamingMessage?: AgentMessage - current partial assistant message
// state.errorMessage?: string - latest assistant error

// Replace messages (useful for branching or restoration)
session.agent.state.messages = messages; // copies the top-level array

// Replace tools
session.agent.state.tools = tools; // copies the top-level array

// Wait for agent to finish processing
await session.agent.waitForIdle();
```

### 事件

订阅事件以接收流式输出和生命周期通知。

```typescript
session.subscribe((event) => {
  switch (event.type) {
    // Streaming text from assistant
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      if (event.assistantMessageEvent.type === "thinking_delta") {
        // Thinking output (if thinking enabled)
      }
      break;
    
    // Tool execution
    case "tool_execution_start":
      console.log(`Tool: ${event.toolName}`);
      break;
    case "tool_execution_update":
      // Streaming tool output
      break;
    case "tool_execution_end":
      console.log(`Result: ${event.isError ? "error" : "success"}`);
      break;
    
    // Message lifecycle
    case "message_start":
      // New message starting
      break;
    case "message_end":
      // Message complete
      break;
    
    // Agent lifecycle
    case "agent_start":
      // Agent started processing prompt
      break;
    case "agent_end":
      // Agent finished (event.messages contains new messages)
      break;
    
    // Turn lifecycle (one LLM response + tool calls)
    case "turn_start":
      break;
    case "turn_end":
      // event.message: assistant response
      // event.toolResults: tool results from this turn
      break;
    
    // Session events (queue, compaction, retry)
    case "queue_update":
      console.log(event.steering, event.followUp);
      break;
    case "compaction_start":
    case "compaction_end":
    case "auto_retry_start":
    case "auto_retry_end":
    case "summarization_retry_scheduled":
    case "summarization_retry_attempt_start":
    case "summarization_retry_finished":
      break;
  }
});
```

## 选项参考

### 目录

```typescript
const { session } = await createAgentSession({
  // Working directory for DefaultResourceLoader discovery
  cwd: process.cwd(), // default
  
  // Global config directory
  agentDir: "~/.pi/agent", // default (expands ~)
});
```

`cwd` 被 `DefaultResourceLoader` 用于：
- 项目扩展（`.pi/extensions/`）
- 项目技能：
  - `.pi/skills/`
  - `cwd` 和祖先目录中的 `.agents/skills/`（直到 git 仓库根，不在仓库中时直到文件系统根）
- 项目提示（`.pi/prompts/`）
- 上下文文件（从 cwd 向上遍历的 `AGENTS.md`）
- 会话目录命名

`agentDir` 被 `DefaultResourceLoader` 用于：
- 全局扩展（`extensions/`）
- 全局技能：
  - `agentDir` 下的 `skills/`（例如 `~/.pi/agent/skills/`）
  - `~/.agents/skills/`
- 全局提示（`prompts/`）
- 全局上下文文件（`AGENTS.md`）
- 设置（`settings.json`）
- 自定义模型（`models.json`）
- 凭据（`auth.json`）
- 会话（`sessions/`）

当你传入自定义 `ResourceLoader` 时，`cwd` 和 `agentDir` 不再控制资源发现。它们仍影响会话命名和工具路径解析。

### 模型

```typescript
import { getModel } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();

// create() restores cached catalogs but does not refresh them from pi.dev by default.
// Opt in to a create-time network refresh and bound how long it may take:
const refreshedRuntime = await ModelRuntime.create({
  allowModelNetwork: true,
  modelRefreshTimeoutMs: 15_000,
});

// Find specific built-in model (doesn't check if API key exists)
const opus = getModel("anthropic", "claude-opus-4-5");
if (!opus) throw new Error("Model not found");

// Find any model by provider/id, including custom models from models.json
// (doesn't check if API key exists)
const customModel = modelRuntime.getModel("my-provider", "my-model");

// Get only models that have valid authentication configured
const available = await modelRuntime.getAvailable();

const { session } = await createAgentSession({
  model: opus,
  thinkingLevel: "medium", // off, minimal, low, medium, high, xhigh, max
  
  // Models for cycling (Ctrl+P in interactive mode)
  scopedModels: [
    { model: opus, thinkingLevel: "high" },
    { model: haiku, thinkingLevel: "off" },
  ],
  
  modelRuntime,
});
```

未提供模型时：
1. 尝试从会话恢复（如果是继续）
2. 使用设置中的默认值
3. 回退到第一个可用模型

远程目录持久化在本地，使后续 runtime 无需网络请求即可恢复它们。默认文件是 `~/.pi/agent/models-store.json`；设置 `modelsStorePath` 选择其他位置，或注入 `modelsStore` 控制持久化。网络刷新默认每个 provider 每四小时节流一次，除非强制。要强制立即刷新，调用 `await modelRuntime.refresh({ allowNetwork: true, force: true, signal })`。设置 `PI_OFFLINE` 禁用模型网络访问。

要匹配 CLI 模型解析，使用导出的解析器帮助函数：

```typescript
import {
  resolveCliModel,
  resolveModelScopeWithDiagnostics,
} from "@earendil-works/pi-coding-agent";

const cliModel = resolveCliModel({
  cliModel: "anthropic/claude-opus-4-5:high",
  modelRuntime,
});
if (cliModel.error) throw new Error(cliModel.error);
if (cliModel.warning) console.warn(cliModel.warning);

const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(
  ["anthropic/*:high", "gpt-5"],
  modelRuntime,
);
for (const diagnostic of diagnostics) {
  console.warn(diagnostic.message);
}
```

`resolveCliModel()` 使用所有已注册模型，使 `--api-key` 式的首次设置能在存储认证存在之前解析模型。`resolveModelScopeWithDiagnostics()` 匹配 `--models` 和 `enabledModels` 语义，同时返回警告而不是打印它们。

> 见 [examples/sdk/02-custom-model.ts](../examples/sdk/02-custom-model.ts)

### API Key 和 OAuth

认证解析优先级（由 `ModelRuntime` 处理）：
1. Runtime 覆盖（通过 `setRuntimeApiKey`，不持久化）
2. `auth.json` 中存储的凭据（API key 或 OAuth token）
3. 环境变量（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 等）
4. 回退解析器（用于 `models.json` 中的自定义 provider key）

```typescript
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";

// Default: uses ~/.pi/agent/auth.json and ~/.pi/agent/models.json
const modelRuntime = await ModelRuntime.create();

// Provider-owned auth methods and current status
for (const provider of modelRuntime.getProviders()) {
  const status = await modelRuntime.checkAuth(provider.id);
  console.log(provider.name, provider.auth, status);
}

// Runtime API key override (not persisted to disk)
await modelRuntime.setRuntimeApiKey("anthropic", "sk-my-temp-key");

// Custom credential and model locations
const customRuntime = await ModelRuntime.create({
  authPath: "/my/app/auth.json",
  modelsPath: "/my/app/models.json",
});

// Or inject any pi-ai CredentialStore
const credentials = new InMemoryCredentialStore();
const inMemoryRuntime = await ModelRuntime.create({ credentials });

const { session } = await createAgentSession({
  modelRuntime: customRuntime,
});
```

`login()`、`logout()`、`setRuntimeApiKey()` 和 `removeRuntimeApiKey()` 在受影响 provider 的缓存/内置目录、组合和可用性快照本地一致后解析。它们不等待远程目录的新鲜度。如果凭据已提交但本地同步失败，它们以导出的 `CredentialSynchronizationError` 拒绝；检查其 `providerId`、`operation`、`credential` 和 `cause` 字段，而不是盲目重试凭据变更。

公共模型/认证操作和 `ModelRuntime.create({ signal })` 接受可选的 abort signal，省略时无界。SDK 应用拥有远程目录新鲜度的截止策略：

```typescript
const signal = AbortSignal.timeout(15_000);
const result = await modelRuntime.refresh({
  providers: ["anthropic"],
  signal,
});
if (result.aborted) console.warn("Catalog refresh timed out; using cached models");
for (const [providerId, error] of result.errors) {
  console.warn(`Could not refresh ${providerId}:`, error);
}
```

失败或超时的网络刷新不会撤销成功的凭据操作。`refresh()` 启动新的 provider 代，所以它不会排在更旧卡住的刷新后面，陈旧的代之后也不能发布。

> 见 [examples/sdk/09-api-keys-and-oauth.ts](../examples/sdk/09-api-keys-and-oauth.ts)

### 系统提示

用 `ResourceLoader` 覆盖系统提示：

```typescript
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const loader = new DefaultResourceLoader({
  systemPromptOverride: () => "You are a helpful assistant.",
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> 见 [examples/sdk/03-custom-prompt.ts](../examples/sdk/03-custom-prompt.ts)

### 工具

指定启用哪些内置工具：

- 内置工具名：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`
- 默认内置：`read`、`bash`、`edit`、`write`
- `noTools: "all"` 禁用所有工具
- `noTools: "builtin"` 禁用默认内置，同时保留扩展和自定义工具启用
- `excludeTools` 在应用任何 `tools` 白名单后禁用特定的内置、扩展或自定义工具名

`edit` 工具为 Pi 的 TUI 显示返回 `details.diff`，为 SDK 消费者返回标准 unified patch 的 `details.patch`。

```typescript
import { createAgentSession } from "@earendil-works/pi-coding-agent";

// Read-only mode
const { session } = await createAgentSession({
  tools: ["read", "grep", "find", "ls"],
});

// Pick specific tools
const { session } = await createAgentSession({
  tools: ["read", "bash", "grep"],
});

// Disable one tool while keeping the rest available
const { session } = await createAgentSession({
  excludeTools: ["ask_question"],
});
```

#### 自定义 cwd 的工具

传入自定义 `cwd` 时，`createAgentSession()` 为该 cwd 构建选中的内置工具。

```typescript
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const cwd = "/path/to/project";

// Use default tools for custom cwd
const { session } = await createAgentSession({
  cwd,
  sessionManager: SessionManager.inMemory(cwd),
});

// Or pick specific tools for custom cwd
const { session } = await createAgentSession({
  cwd,
  tools: ["read", "bash", "grep"],
  sessionManager: SessionManager.inMemory(cwd),
});
```

> 见 [examples/sdk/05-tools.ts](../examples/sdk/05-tools.ts)

### 自定义工具

```typescript
import { Type } from "typebox";
import { createAgentSession, defineTool } from "@earendil-works/pi-coding-agent";

// Inline custom tool
const myTool = defineTool({
  name: "my_tool",
  label: "My Tool",
  description: "Does something useful",
  parameters: Type.Object({
    input: Type.String({ description: "Input value" }),
  }),
  execute: async (_toolCallId, params) => ({
    content: [{ type: "text", text: `Result: ${params.input}` }],
    details: {},
  }),
});

// Pass custom tools directly
const { session } = await createAgentSession({
  customTools: [myTool],
});
```

独立定义和 `customTools: [myTool]` 这类数组用 `defineTool()`。内联 `pi.registerTool({ ... })` 已能正确推断参数类型。

通过 `customTools` 传入的自定义工具与扩展注册的工具合并。ResourceLoader 加载的扩展也可以通过 `pi.registerTool()` 注册工具。

如果传了 `tools`，包含你想启用的每个自定义或扩展工具名，例如 `tools: ["read", "bash", "my_tool"]`。

> 见 [examples/sdk/05-tools.ts](../examples/sdk/05-tools.ts)

### 扩展

扩展由 `ResourceLoader` 加载。`DefaultResourceLoader` 从 `~/.pi/agent/extensions/`、`.pi/extensions/` 和 settings.json 扩展来源发现扩展。

```typescript
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const loader = new DefaultResourceLoader({
  additionalExtensionPaths: ["/path/to/my-extension.ts"],
  extensionFactories: [
    (pi) => {
      pi.on("agent_start", () => {
        console.log("[Inline Extension] Agent starting");
      });
    },
  ],
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

扩展可以注册工具、订阅事件、添加命令等。完整 API 见 [extensions.md](extensions.md)。

**命名内联扩展：** 默认情况下，内联工厂在启动 Extensions 列表中显示为 `<inline:1>`、`<inline:2>` 等。要显示描述性名称，包装工厂：

```typescript
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

const myProvider: InlineExtension = {
  name: "my-provider",
  factory: (pi) => {
    pi.on("agent_start", () => {
      console.log("[my-provider] Agent starting");
    });
  },
};

const loader = new DefaultResourceLoader({
  extensionFactories: [myProvider],
});
```

这显示为 `<inline:my-provider>` 而不是 `<inline:1>`。为向后兼容，裸工厂函数仍被接受。

**事件总线：** 扩展可以通过 `pi.events` 通信。需要从外部发出或监听时，把共享 `eventBus` 传给 `DefaultResourceLoader`：

```typescript
import { createEventBus, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const eventBus = createEventBus();
const loader = new DefaultResourceLoader({
  eventBus,
});
await loader.reload();

eventBus.on("my-extension:status", (data) => console.log(data));
```

> 见 [examples/sdk/06-extensions.ts](../examples/sdk/06-extensions.ts) 和 [docs/extensions.md](extensions.md)

### 技能

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  type Skill,
} from "@earendil-works/pi-coding-agent";

const customSkill: Skill = {
  name: "my-skill",
  description: "Custom instructions",
  filePath: "/path/to/SKILL.md",
  baseDir: "/path/to",
  source: "custom",
};

const loader = new DefaultResourceLoader({
  skillsOverride: (current) => ({
    skills: [...current.skills, customSkill],
    diagnostics: current.diagnostics,
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> 见 [examples/sdk/04-skills.ts](../examples/sdk/04-skills.ts)

### 上下文文件

```typescript
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const loader = new DefaultResourceLoader({
  agentsFilesOverride: (current) => ({
    agentsFiles: [
      ...current.agentsFiles,
      { path: "/virtual/AGENTS.md", content: "# Guidelines\n\n- Be concise" },
    ],
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> 见 [examples/sdk/07-context-files.ts](../examples/sdk/07-context-files.ts)

### 斜杠命令

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  type PromptTemplate,
} from "@earendil-works/pi-coding-agent";

const customCommand: PromptTemplate = {
  name: "deploy",
  description: "Deploy the application",
  source: "(custom)",
  content: "# Deploy\n\n1. Build\n2. Test\n3. Deploy",
};

const loader = new DefaultResourceLoader({
  promptsOverride: (current) => ({
    prompts: [...current.prompts, customCommand],
    diagnostics: current.diagnostics,
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> 见 [examples/sdk/08-prompt-templates.ts](../examples/sdk/08-prompt-templates.ts)

### 会话管理

会话使用带 `id`/`parentId` 链接的树结构，支持就地分支。

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

// In-memory (no persistence)
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});

// New persistent session
const { session: persisted } = await createAgentSession({
  sessionManager: SessionManager.create(process.cwd()),
});

// Continue most recent
const { session: continued, modelFallbackMessage } = await createAgentSession({
  sessionManager: SessionManager.continueRecent(process.cwd()),
});
if (modelFallbackMessage) {
  console.log("Note:", modelFallbackMessage);
}

// Open specific file
const { session: opened } = await createAgentSession({
  sessionManager: SessionManager.open("/path/to/session.jsonl"),
});

// List sessions
const currentProjectSessions = await SessionManager.list(process.cwd());
const allSessions = await SessionManager.listAll(process.cwd());

// Session replacement API for /new, /resume, /fork, /clone, and import flows.
const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

// Replace the active session with a fresh one
await runtime.newSession();

// Replace the active session with another saved session
await runtime.switchSession("/path/to/session.jsonl");

// Replace the active session with a fork from a specific user entry
await runtime.fork("entry-id");

// Clone the active path through a specific entry
await runtime.fork("entry-id", { position: "at" });
```

**SessionManager 树 API：**

```typescript
const sm = SessionManager.open("/path/to/session.jsonl");

// Session listing
const currentProjectSessions = await SessionManager.list(process.cwd());
const allSessions = await SessionManager.listAll(process.cwd());

// Tree traversal
const entries = sm.getEntries();        // All entries (excludes header)
const tree = sm.getTree();              // Full tree structure
const path = sm.getPath();              // Path from root to current leaf
const leaf = sm.getLeafEntry();         // Current leaf entry
const entry = sm.getEntry(id);          // Get entry by ID
const children = sm.getChildren(id);    // Direct children of entry

// Labels
const label = sm.getLabel(id);          // Get label for entry
sm.appendLabelChange(id, "checkpoint"); // Set label

// Branching
sm.branch(entryId);                     // Move leaf to earlier entry
sm.branchWithSummary(id, "Summary...");  // Branch with context summary
sm.createBranchedSession(leafId);       // Extract path to new file
```

> 见 [examples/sdk/11-sessions.ts](../examples/sdk/11-sessions.ts) 和 [Session Format](session-format.md)

### 设置管理

```typescript
import { createAgentSession, SettingsManager, SessionManager } from "@earendil-works/pi-coding-agent";

// Default: loads from files (global + project merged)
const { session } = await createAgentSession({
  settingsManager: SettingsManager.create(),
});

// With overrides
const settingsManager = SettingsManager.create();
settingsManager.applyOverrides({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 5 },
});
const { session } = await createAgentSession({ settingsManager });

// In-memory (no file I/O, for testing)
const { session } = await createAgentSession({
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  sessionManager: SessionManager.inMemory(),
});

// Custom directories
const { session } = await createAgentSession({
  settingsManager: SettingsManager.create("/custom/cwd", "/custom/agent"),
});
```

**静态工厂：**
- `SettingsManager.create(cwd?, agentDir?)` - 从文件加载
- `SettingsManager.inMemory(settings?)` - 无文件 I/O

**项目特定设置：**

设置从两个位置加载并合并：
1. 全局：`~/.pi/agent/settings.json`
2. 项目：`<cwd>/.pi/settings.json`

项目覆盖全局。嵌套对象按键合并。Setter 默认修改全局设置。

**持久化和错误处理语义：**

- 设置的 getter/setter 对内存状态是同步的。
- Setter 异步排队持久化写入。
- 需要持久性边界时（例如进程退出前或测试中断言文件内容前）调用 `await settingsManager.flush()`。
- `SettingsManager` 不打印设置 I/O 错误。用 `settingsManager.drainErrors()` 并在你的应用层报告。

> 见 [examples/sdk/10-settings.ts](../examples/sdk/10-settings.ts)

## ResourceLoader

用 `DefaultResourceLoader` 发现扩展、技能、提示、主题和上下文文件。

```typescript
import {
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

const loader = new DefaultResourceLoader({
  cwd,
  agentDir: getAgentDir(),
});
await loader.reload();

const extensions = loader.getExtensions();
const skills = loader.getSkills();
const prompts = loader.getPrompts();
const themes = loader.getThemes();
const contextFiles = loader.getAgentsFiles().agentsFiles;
```

## 返回值

`createAgentSession()` 返回：

```typescript
interface CreateAgentSessionResult {
  // The session
  session: AgentSession;
  
  // Extensions result (for runner setup)
  extensionsResult: LoadExtensionsResult;
  
  // Warning if session model couldn't be restored
  modelFallbackMessage?: string;
}

interface LoadExtensionsResult {
  extensions: Extension[];
  errors: Array<{ path: string; error: string }>;
  runtime: ExtensionRuntime;
}
```

## 完整示例

```typescript
import { getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create({
  authPath: "/custom/agent/auth.json",
  modelsPath: "/custom/agent/models.json",
});
if (process.env.MY_KEY) {
  await modelRuntime.setRuntimeApiKey("anthropic", process.env.MY_KEY);
}

// Inline tool
const statusTool = defineTool({
  name: "status",
  label: "Status",
  description: "Get system status",
  parameters: Type.Object({}),
  execute: async () => ({
    content: [{ type: "text", text: `Uptime: ${process.uptime()}s` }],
    details: {},
  }),
});

const model = getModel("anthropic", "claude-opus-4-5");
if (!model) throw new Error("Model not found");

// In-memory settings with overrides
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 2 },
});

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: "/custom/agent",
  settingsManager,
  systemPromptOverride: () => "You are a minimal assistant. Be concise.",
});
await loader.reload();

const { session } = await createAgentSession({
  cwd: process.cwd(),
  agentDir: "/custom/agent",

  model,
  thinkingLevel: "off",
  modelRuntime,

  tools: ["read", "bash", "status"],
  customTools: [statusTool],
  resourceLoader: loader,

  sessionManager: SessionManager.inMemory(),
  settingsManager,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Get status and list files.");
```

## 运行模式

SDK 导出运行模式工具，在 `createAgentSession()` 之上构建自定义界面：

### InteractiveMode

完整的 TUI 交互模式，带编辑器、聊天历史和所有内置命令：

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

const mode = new InteractiveMode(runtime, {
  migratedProviders: [],
  modelFallbackMessage: undefined,
  initialMessage: "Hello",
  initialImages: [],
  initialMessages: [],
});

await mode.run();
```

### runPrintMode

单次模式：发送提示、输出结果、退出：

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  runPrintMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

await runPrintMode(runtime, {
  mode: "text",
  initialMessage: "Hello",
  initialImages: [],
  messages: ["Follow up"],
});
```

### runRpcMode

用于子进程集成的 JSON-RPC 模式：

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  runRpcMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

await runRpcMode(runtime);
```

JSON 协议见 [RPC 文档](rpc.md)。

## RPC 模式替代

不通过 SDK 构建、基于子进程的集成，直接使用 CLI：

```bash
pi --mode rpc --no-session
```

JSON 协议见 [RPC 文档](rpc.md)。

以下情况优先使用 SDK：
- 想要类型安全
- 在同一个 Node.js 进程中
- 需要直接访问 agent 状态
- 想编程式定制工具/扩展

以下情况优先使用 RPC 模式：
- 从其他语言集成
- 想要进程隔离
- 构建语言无关的客户端

## 导出

主入口导出：

```typescript
// Factory
createAgentSession
createAgentSessionRuntime
AgentSessionRuntime

// Auth and Models
ModelRuntime // implements pi-ai Models and owns credential storage
ModelRegistry // synchronous extension compatibility facade
CredentialSynchronizationError
resolveCliModel
resolveModelScopeWithDiagnostics

// Resource loading
DefaultResourceLoader
type ResourceLoader
createEventBus

// Constants and helpers
CONFIG_DIR_NAME
defineTool
getAgentDir
getPackageDir
getReadmePath
getDocsPath
getExamplesPath

// Session management
SessionManager
SettingsManager

// Tool factories
createCodingTools
createReadOnlyTools
createReadTool, createBashTool, createEditTool, createWriteTool
createGrepTool, createFindTool, createLsTool

// Types
type CreateAgentSessionOptions
type CreateAgentSessionResult
type ExtensionFactory
type InlineExtension
type ExtensionAPI
type ToolDefinition
type Skill
type PromptTemplate
type Tool
```

扩展类型见 [extensions.md](extensions.md) 的完整 API。
