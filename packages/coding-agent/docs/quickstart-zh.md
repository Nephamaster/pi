# 快速开始

本页带你从安装走到一次有用的 pi 首次会话。

## 安装

Pi 以 npm 包分发：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` 在安装期间禁用依赖的生命周期脚本。正常的 npm 安装不需要安装脚本即可运行 Pi。

### 卸载

使用安装 pi 的包管理器。curl 安装器全局使用 npm，因此 curl 和 npm 安装都用 npm 移除：

```bash
# curl installer or npm install -g
npm uninstall -g @earendil-works/pi-coding-agent

# pnpm
pnpm remove -g @earendil-works/pi-coding-agent

# Yarn
yarn global remove @earendil-works/pi-coding-agent

# Bun
bun uninstall -g @earendil-works/pi-coding-agent
```

卸载 pi 会保留 `~/.pi/agent/` 中的设置、凭据、会话和已安装的 pi 包。

然后在希望 pi 处理的项目目录中启动 pi：

```bash
cd /path/to/project
pi
```

## 认证

Pi 可以通过 `/login` 使用订阅制 provider，或通过环境变量或 auth 文件使用 API-key provider。

### 方式 1：订阅登录

启动 pi 并运行：

```text
/login
```

然后选择一个 provider。内置订阅登录包括 Claude Pro/Max、ChatGPT Plus/Pro（Codex）和 GitHub Copilot。

### 方式 2：API key

启动 pi 前设置 API key：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

你也可以运行 `/login` 并选择 API-key provider，把 key 存入 `~/.pi/agent/auth.json`。

所有受支持的 provider、环境变量和云 provider 设置见 [Providers](providers.md)。

## 第一次会话

pi 启动后，输入请求并按 Enter：

```text
Summarize this repository and tell me how to run its checks.
```

默认情况下，pi 给模型四个工具：

- `read` - 读文件
- `write` - 创建或覆盖文件
- `edit` - 修补文件
- `bash` - 运行 shell 命令

附加的内置只读工具（`grep`、`find`、`ls`）通过工具选项可用。Pi 在你的当前工作目录中运行，可以修改那里的文件。想要轻松回滚就用 git 或其他检查点工作流。

## 给 pi 项目指令

Pi 在启动时加载上下文文件。添加一个 `AGENTS.md` 文件告诉它如何在项目中工作：

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Pi 加载：

- `~/.pi/agent/AGENTS.md` 作为全局指令
- 父目录和当前目录中的 `AGENTS.md` 或 `CLAUDE.md`

如果某目录包含 `AGENTS.override.md`，Pi 加载它而不是该目录的 `AGENTS.md` 或 `CLAUDE.md`。

修改上下文文件后重启 pi，或运行 `/reload`。

## 常见尝试

### 引用文件

在编辑器中输入 `@` 模糊搜索文件，或在命令行传入文件：

```bash
pi @README.md "Summarize this"
pi @src/app.ts @src/app.test.ts "Review these together"
```

图片或文本可以用 Ctrl+V 粘贴（Windows 上是 Alt+V）；图片也可以拖入受支持的终端。

### 运行 shell 命令

交互模式下：

```text
!npm run lint
```

命令输出会发送给模型。用 `!!command` 运行命令但不把其输出加入模型上下文。

### 切换模型

用 `/model` 或 Ctrl+L 选择模型。用 Shift+Tab 循环切换思考级别。用 Ctrl+P / Shift+Ctrl+P 在作用域内的模型间循环。

### 稍后继续

会话自动保存：

```bash
pi -c                  # 继续最近的会话
pi -r                  # 浏览之前的会话
pi --name "my task"    # 启动时设置会话显示名
pi --session <path|id> # 打开特定会话
```

在 pi 内部，用 `/resume`、`/new`、`/tree`、`/fork` 和 `/clone` 管理会话。

### 非交互模式

一次性提示：

```bash
pi -p "Summarize this codebase"
cat README.md | pi -p "Summarize this text"
pi -p @screenshot.png "What's in this image?"
```

JSON 事件输出用 `--mode json`，进程集成用 `--mode rpc`。

## 下一步

- [Using Pi](usage.md) - 交互模式、斜杠命令、会话、上下文文件和 CLI 参考。
- [Providers](providers.md) - 认证和模型设置。
- [Settings](settings.md) - 全局和项目配置。
- [Keybindings](keybindings.md) - 快捷键和自定义。
- [Pi Packages](packages.md) - 安装共享的扩展、技能、提示和主题。

平台说明：[Windows](windows.md)、[Termux](termux.md)、[tmux](tmux.md)、[Terminal setup](terminal-setup.md)、[Shell aliases](shell-aliases.md)。
