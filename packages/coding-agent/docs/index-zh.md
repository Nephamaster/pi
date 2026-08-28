# Pi 文档

Pi 是一个极简的终端 coding harness。它的设计是让内核保持小巧，同时通过 TypeScript 扩展、技能、提示模板、主题和 pi 包进行扩展。

## 快速开始

用 npm 安装 Pi：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` 在安装期间禁用依赖的生命周期脚本。正常的 npm 安装不需要安装脚本即可运行 Pi。

在 Linux 或 macOS 上，你也可以使用安装器：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

要卸载 pi 本身，对 curl 和 npm 安装都使用 npm：

```bash
npm uninstall -g @earendil-works/pi-coding-agent
```

对于 pnpm、Yarn 或 Bun 安装，使用对应的全局移除命令：`pnpm remove -g @earendil-works/pi-coding-agent`、`yarn global remove @earendil-works/pi-coding-agent` 或 `bun uninstall -g @earendil-works/pi-coding-agent`。

然后在项目目录中运行：

```bash
pi
```

订阅制 provider 用 `/login` 认证，或在启动 pi 之前设置 `ANTHROPIC_API_KEY` 之类的 API key。

完整的初次运行流程见 [Quickstart](quickstart.md)。

## 从这里开始

- [Quickstart](quickstart.md) - 安装、认证并运行第一个会话。
- [Using Pi](usage.md) - 交互模式、斜杠命令、上下文文件和 CLI 参考。
- [Providers](providers.md) - 内置 provider 的订阅和 API-key 设置。
- [llama.cpp](llama-cpp.md) - 运行本地 router 并用 `/llama` 管理模型。
- [Security](security.md) - 项目信任、沙箱边界和漏洞报告。
- [Containerization](containerization.md) - 用 Gondolin、Docker 或 OpenShell 为 pi 提供沙箱。
- [Settings](settings.md) - 全局和项目设置。
- [Keybindings](keybindings.md) - 默认快捷键和自定义键位。
- [Sessions](sessions.md) - 会话管理、分支和树导航。
- [Compaction](compaction.md) - 上下文压缩和分支摘要。

## 自定义

- [Extensions](extensions.md) - 用于工具、命令、事件和自定义 UI 的 TypeScript 模块。
- [Skills](skills.md) - 用于可复用按需能力的 Agent Skills。
- [Prompt templates](prompt-templates.md) - 从斜杠命令展开的可复用提示。
- [Themes](themes.md) - 内置和自定义终端主题。
- [Pi packages](packages.md) - 打包和分享扩展、技能、提示和主题。
- [Custom models](models.md) - 为受支持的 provider API 添加模型条目。
- [Custom providers](custom-provider.md) - 实现自定义 API 和 OAuth 流程。

## 编程式使用

- [SDK](sdk.md) - 在 Node.js 应用中嵌入 pi。
- [RPC mode](rpc.md) - 通过 stdin/stdout JSONL 集成。
- [JSON event stream mode](json.md) - 带结构化事件的 print 模式。
- [TUI components](tui.md) - 为扩展构建自定义终端 UI。

## 参考

- [Environment variables](environment-variables.md) - Pi 进程配置以及 bash 工具可获取的会话元数据。
- [Session format](session-format.md) - JSONL 会话文件格式、条目类型和 SessionManager API。

## 平台设置

- [Windows](windows.md)
- [Termux on Android](termux.md)
- [tmux](tmux.md)
- [Terminal setup](terminal-setup.md)
- [Shell aliases](shell-aliases.md)

## 开发

- [Development](development.md) - 本地环境搭建、项目结构和调试。
