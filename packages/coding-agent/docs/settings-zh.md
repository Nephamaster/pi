# 设置（Settings）

Pi 使用 JSON 设置文件，项目设置覆盖全局设置。

| 位置 | 作用域 |
|----------|-------|
| `~/.pi/agent/settings.json` | 全局（所有项目） |
| `.pi/settings.json` | 项目（当前目录） |

直接编辑，或对常用选项使用 `/settings`。

## 项目信任

交互启动时，如果项目文件夹包含项目本地设置、资源或项目 `.agents/skills`，且 `~/.pi/agent/trust.json` 中没有该文件夹或父文件夹的已保存决定，pi 在信任该文件夹前会询问。信任项目允许 pi 加载 `.pi/settings.json` 和 `.pi` 资源、安装缺失的项目包、并执行项目扩展。

非交互模式（`-p`、`--mode json` 和 `--mode rpc`）不显示信任提示。在没有适用的已保存信任决定时，它们使用全局设置中的 `defaultProjectTrust`：`ask`（默认）和 `never` 忽略那些项目资源，而 `always` 信任它们。传 `--approve`/`-a` 或 `--no-approve`/`-na` 在单次运行中覆盖项目信任。

如果没有扩展或已保存决定适用，`defaultProjectTrust` 控制回退行为。在 `~/.pi/agent/settings.json` 中设为 `"ask"`、`"always"` 或 `"never"`，或用 `/settings` 修改。

`pi config` 和包命令使用相同的项目信任流程，只是 `pi update` 从不提示。传 `--approve` 为单个命令信任项目本地设置，或 `--no-approve` 忽略它们。

交互模式下用 `/trust` 为未来的会话保存项目信任决定，包括对直接父文件夹的信任。它只写 `~/.pi/agent/trust.json`；当前会话不会重新加载，所以要重启 pi 更改才生效。

## 全部设置

### 模型和思考

| 设置 | 类型 | 默认 | 说明 |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | 默认 provider（如 `"anthropic"`、`"openai"`） |
| `defaultModel` | string | - | 默认模型 ID |
| `defaultThinkingLevel` | string | - | `"off"`、`"minimal"`、`"low"`、`"medium"`、`"high"`、`"xhigh"`、`"max"` |
| `hideThinkingBlock` | boolean | `false` | 在输出中隐藏思考块 |
| `showCacheMissNotices` | boolean | `false` | 对显著的提示缓存未命中显示转录通知 |
| `thinkingBudgets` | object | - | 每个思考级别的自定义 token 预算 |

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### UI 和显示

| 设置 | 类型 | 默认 | 说明 |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | 主题名（`"dark"`、`"light"` 或自定义） |
| `externalEditor` | string | `$VISUAL`，然后 `$EDITOR`，然后 Windows 上是 Notepad 其他系统是 `nano` | Ctrl+G 外部编辑器命令；优先于环境变量 |
| `quietStartup` | boolean | `false` | 隐藏启动头 |
| `defaultProjectTrust` | string | `"ask"` | 回退项目信任行为：`"ask"`、`"always"` 或 `"never"`。仅全局设置 |
| `collapseChangelog` | boolean | `false` | 更新后显示精简 changelog |
| `enableInstallTelemetry` | boolean | `true` | 在首次安装或 changelog 检测到的更新后发送匿名安装/更新版本 ping。这不控制更新检查 |
| `enableAnalytics` | boolean | `false` | 选择性加入的分析数据共享。目前只在实验性首次设置（`PI_EXPERIMENTAL=1`）期间询问 |
| `trackingId` | string | - | 分析跟踪标识符，在 `enableAnalytics` 打开时生成 |
| `doubleEscapeAction` | string | `"tree"` | 双击 Escape 的动作：`"tree"`、`"fork"` 或 `"none"` |
| `treeFilterMode` | string | `"default"` | `/tree` 的默认过滤：`"default"`、`"no-tools"`、`"user-only"`、`"labeled-only"`、`"all"` |
| `editorPaddingX` | number | `0` | 输入编辑器的水平内边距（0-3） |
| `outputPad` | number | `1` | 用户消息、assistant 消息和思考的水平内边距（0 或 1） |
| `autocompleteMaxVisible` | number | `5` | 自动补全下拉框中最大可见项数（3-20） |
| `showHardwareCursor` | boolean | `false` | TUI 为 IME 支持定位光标时显示终端光标 |
| `tuiMode` | string | `"regular"` | 交互 TUI 模式：`"regular"` 或实验性 `"fullscreen"`。来自 `/settings` 的更改立即生效；`--tui-mode` 在启动时覆盖该设置 |
| `fullscreenExitOutput` | string | `"transcript"` | 全屏退出输出：`"transcript"` 打印最终转录和恢复提示，`"resume-hint"` 恢复之前的屏幕并只打印恢复提示。在常规 TUI 模式下无效 |
| `fullscreenScrollbar` | string | `"auto"` | 全屏转录滚动条：`"auto"` 滚动时临时显示，`"always"` 保留最右列并保持可见，`"hidden"` 隐藏。在常规 TUI 模式下无效 |

对 VS Code，包含 `--wait` 使 pi 在编辑器退出后恢复：

```json
{
  "externalEditor": "code --wait"
}
```

### 遥测和更新检查

`enableInstallTelemetry` 只控制发往 `https://pi.dev/api/report-install` 的匿名安装/更新 ping。退出遥测不会禁用更新检查；Pi 仍可以获取 `https://pi.dev/api/latest-version` 查找最新版本。

设置 `PI_SKIP_VERSION_CHECK=1` 禁用 Pi 版本更新检查。使用 `--offline` 或 `PI_OFFLINE=1` 禁用此处描述的所有启动网络操作，包括更新检查、包更新检查和安装/更新遥测。

### 网络

| 设置 | 类型 | 默认 | 说明 |
|---------|------|---------|-------------|
| `httpProxy` | string | - | 作为 `HTTP_PROXY` 和 `HTTPS_PROXY` 应用的 HTTP 代理 URL。仅全局设置。 |

```json
{
  "httpProxy": "http://127.0.0.1:7890"
}
```

### 警告

| 设置 | 类型 | 默认 | 说明 |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | 当 Anthropic 订阅认证可能使用付费额外用量时显示警告 |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### 压缩（Compaction）

| 设置 | 类型 | 默认 | 说明 |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | 启用自动压缩 |
| `compaction.reserveTokens` | number | `16384` | 为 LLM 响应保留的 token |
| `compaction.keepRecentTokens` | number | `20000` | 保留的近期 token（不摘要） |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

### 分支摘要

| 设置 | 类型 | 默认 | 说明 |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | 为分支摘要保留的 token |
| `branchSummary.skipPrompt` | boolean | `false` | 跳过 `/tree` 导航时的 "Summarize branch?" 提示（默认不摘要） |

### 重试

| 设置 | 类型 | 默认 | 说明 |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | 启用瞬态错误时的 agent 级自动重试 |
| `retry.maxRetries` | number | `3` | agent 级最大重试次数 |
| `retry.baseDelayMs` | number | `2000` | agent 级指数退避的基础延迟（2s、4s、8s） |
| `retry.provider.timeoutMs` | number | SDK 默认 | Provider/SDK 请求超时（毫秒） |
| `retry.provider.maxRetries` | number | `0` | Provider/SDK 重试次数 |
| `retry.provider.maxRetryDelayMs` | number | `60000` | 失败前的最大服务器请求延迟（60s） |

当 provider 请求的重试延迟长于 `retry.provider.maxRetryDelayMs` 时，请求会立即失败并给出说明性错误，而不是静默等待。设为 `0` 禁用该限制。

除非明确需要 provider 级重试，否则把 `retry.provider.maxRetries` 保持在 `0`。把它设为 `0` 以上可能使 SDK/provider 重试在 Pi 看到之前处理超出用量限制的错误，在某些情况下这可能阻塞 agent 直到 provider 配额重置。

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### 消息投递

| 设置 | 类型 | 默认 | 说明 |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | steering 消息的发送方式：`"all"` 或 `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | follow-up 消息的发送方式：`"all"` 或 `"one-at-a-time"` |
| `transport` | string | `"auto"` | 支持多种传输的 provider 的优先传输：`"sse"`、`"websocket"`、`"websocket-cached"` 或 `"auto"` |
| `httpIdleTimeoutMs` | number | `300000` | HTTP 头/体空闲超时（毫秒），也用于有显式流空闲超时的 provider。设为 `0` 禁用。 |
| `websocketConnectTimeoutMs` | number | `15000` | 支持 WebSocket 传输的 provider 的 WebSocket 连接/打开握手超时（毫秒）。设为 `0` 禁用。 |

### 终端和图片

| 设置 | 类型 | 默认 | 说明 |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | 在终端中显示图片（受支持时） |
| `terminal.imageWidthCells` | number | `60` | 内联图片的首选宽度（终端字符格） |
| `terminal.clearOnShrink` | boolean | `false` | 内容缩小时清除空行（可能导致闪烁） |
| `images.autoResize` | boolean | `true` | 把图片缩放到最大 2000x2000。适用于 `@file` 附件、`read` 和工具返回的图片 |
| `images.blockImages` | boolean | `false` | 阻止所有图片发送给 LLM |

### Shell

| 设置 | 类型 | 默认 | 说明 |
|---------|------|---------|-------------|
| `shellPath` | string | - | 自定义 shell 路径（如 Windows 上的 Cygwin）；支持以 `~` 开头表示主目录 |
| `shellCommandPrefix` | string | - | 每条 bash 命令的前缀（如 `"shopt -s expand_aliases"`） |
| `npmCommand` | string[] | - | 用于 npm 包查找/安装操作的命令 argv（如 `["mise", "exec", "node@20", "--", "npm"]`） |

JSON 中的 Windows 路径必须使用正斜杠或转义反斜杠：

```json
{
  "shellPath": "C:/Program Files/Git/bin/bash.exe"
}
```

```json
{
  "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
}
```

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` 用于所有 npm 包管理器操作，包括安装、卸载和 git 包内的依赖安装。用户作用域的 npm 包安装在 `~/.pi/agent/npm/` 下；项目作用域的 npm 包安装在 `.pi/npm/` 下。按进程应启动的方式原样使用 argv 风格条目。配置了 `npmCommand` 时，git 包依赖安装使用普通 `install`，以避免包装器或替代包管理器中的 npm 专属标志。

### 工具

| 设置 | 类型 | 默认 | 说明 |
|---------|------|---------|-------------|
| `defaultTools` | string[] | - | 初始启用的内置工具。省略时，Pi 使用其标准默认值 |

`defaultTools` 选择启动时启用的内置工具。扩展和 SDK 自定义工具保持启用：

```json
{
  "defaultTools": ["bash", "edit", "write"]
}
```

空数组表示不启用任何内置工具，同时保留扩展和 SDK 自定义工具。`--tools` 用严格白名单替换该行为作用于所有工具，`--no-tools` 禁用所有工具，`--no-builtin-tools` 禁用内置默认值。`--exclude-tools` 过滤结果列表。项目的 `defaultTools` 数组替换全局数组。

### 会话

| 设置 | 类型 | 默认 | 说明 |
|---------|------|---------|-------------|
| `sessionDir` | string | - | 会话文件的存储目录。接受绝对或相对路径，以及 `~`。 |

```json
{ "sessionDir": ".pi/sessions" }
```

多个来源指定会话目录时，优先级是 `--session-dir`、`PI_CODING_AGENT_SESSION_DIR`，然后设置中的 `sessionDir`。

### 模型循环

| 设置 | 类型 | 默认 | 说明 |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Ctrl+P 循环的模型模式（与 `--models` CLI 标志相同格式） |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| 设置 | 类型 | 默认 | 说明 |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | 代码块缩进 |
| `markdown.mermaid` | string | `"streaming"` | Mermaid 渲染模式：`"off"`、`"final"` 或 `"streaming"` |

### 资源

这些设置定义从哪里加载扩展、技能、提示和主题。

`~/.pi/agent/settings.json` 中的路径相对于 `~/.pi/agent` 解析。`.pi/settings.json` 中的路径相对于 `.pi` 解析。支持绝对路径和 `~`。

| 设置 | 类型 | 默认 | 说明 |
|---------|------|---------|-------------|
| `packages` | array | `[]` | 要从中加载资源的 npm/git 包 |
| `extensions` | string[] | `[]` | 本地扩展文件路径或目录 |
| `skills` | string[] | `[]` | 本地技能文件路径或目录 |
| `prompts` | string[] | `[]` | 本地提示模板路径或目录 |
| `themes` | string[] | `[]` | 本地主题文件路径或目录 |
| `enableSkillCommands` | boolean | `true` | 把技能注册为 `/skill:name` 命令 |

数组支持 glob 模式和排除。用 `!pattern` 排除。用 `+path` 强制包含一个精确路径，`-path` 强制排除一个精确路径。

#### packages

字符串形式加载包的所有资源：

```json
{
  "packages": ["pi-skills", "@org/my-extension"]
}
```

对象形式过滤要加载哪些资源：

```json
{
  "packages": [
    {
      "source": "pi-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

包管理细节见 [packages.md](packages.md)。

## 示例

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["pi-skills"]
}
```

## 项目覆盖

项目设置（`.pi/settings.json`）覆盖全局设置。嵌套对象会合并：

```json
// ~/.pi/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .pi/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
