# 环境变量

Pi 以三种方式使用环境变量：

- `PI_OFFLINE` 等变量用于配置 Pi 进程。
- Pi 设置进程标记，让子进程能够识别 Pi 是启动它们的 agent。
- LLM 可调用的 bash 工具运行的命令会收到描述当前会话的 `PI_*` 变量。

Provider API-key 变量在 [Providers](providers.md#environment-variables-or-auth-file) 中单独说明。

## 进程标记

CLI 和 RPC 入口点会设置两个进程标记：

- `AI_AGENT=pi` 是通用标记，让工具能够识别 Pi 是启动该进程的 agent。
- `PI_CODING_AGENT=true` 是 Pi 专属标记，让子进程能够检测到自己运行在 Pi 内部。

子进程会继承这两个标记。它们与会话无关，通过 SDK 嵌入 Pi 时也不会自动设置。

## Bash 工具的会话环境

bash 工具运行的命令会收到当前 Pi 会话状态：

| 变量 | 说明 |
|----------|-------------|
| `PI_SESSION_ID` | 当前会话 ID |
| `PI_SESSION_FILE` | 当前会话 JSONL 文件的绝对路径；临时会话未设置 |
| `PI_PROVIDER` | 当前选中的模型 provider |
| `PI_MODEL` | 当前选中的模型 ID |
| `PI_REASONING_LEVEL` | 当前生效的推理级别：`off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max` |

这些值在每条命令启动时解析。因此切换模型或修改推理级别会影响下一条 bash 命令，无需重启 Pi。`PI_PROVIDER` 和 `PI_MODEL` 标识的是选中的 Pi 模型，而不是 router 内部可能选择的另一个上游模型。

被问到当前运行的是哪个模型或 provider 时，应检查这些变量，而不是从系统提示推断答案：

```bash
printf '%s/%s\n' "$PI_PROVIDER" "$PI_MODEL"
printf 'reasoning=%s session=%s\n' "$PI_REASONING_LEVEL" "$PI_SESSION_ID"
```

当会话是持久化时，可以直接检查会话文件：

```bash
if [ -n "$PI_SESSION_FILE" ]; then
  tail -n 1 "$PI_SESSION_FILE"
fi
```

这些变量注入到 LLM 可调用的 bash 工具。它们不会注入用户输入的 `!` 或 `!!` 命令。

### 自定义 Bash 工具

用 `createBashTool()` 创建的 bash 工具在注册到 Pi 时默认暴露会话环境。注入发生在 `spawnHook` 之前，因此 hook 能在 `ctx.env` 中收到这些变量：

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

可以独立于 spawn hook 禁用会话元数据：

```typescript
const bashTool = createBashTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

禁用后，Pi 会移除这些变量的继承值，使嵌套的 Pi 进程不会暴露过时的父会话元数据。

## Pi 进程配置

以下变量由 Pi 本身读取：

| 变量 | 说明 |
|----------|-------------|
| `PI_CODING_AGENT_DIR` | 覆盖配置目录；默认是 `~/.pi/agent` |
| `PI_CODING_AGENT_SESSION_DIR` | 覆盖会话存储；被 `--session-dir` 覆盖 |
| `PI_PACKAGE_DIR` | 覆盖包目录，对 Nix/Guix store 路径有用 |
| `PI_OFFLINE` | 禁用启动时的网络操作，包括更新检查、包更新和安装/更新遥测 |
| `PI_SKIP_VERSION_CHECK` | 禁用 `pi.dev` 最新版本请求 |
| `PI_TELEMETRY` | 覆盖安装/更新遥测和 provider 归属头：`1`/`true`/`yes` 或 `0`/`false`/`no` |
| `PI_CACHE_RETENTION` | 设为 `long` 以启用延长 provider 提示缓存（受支持时） |
| `PI_SHARE_VIEWER_URL` | 覆盖 `/share` 使用的基础 URL |
| `PI_HARDWARE_CURSOR` | 设为 `1` 以显示硬件光标；见 [Terminal setup](terminal-setup.md) |
| `PI_TUI_ESC_TIMEOUT` | 单独的 ESC 之后等待多久才将其视为 Escape，单位为毫秒；SSH 下默认 `100`，其他情况默认 `10`。如果 Alt 键输入被误读为 Escape 就调大 |
| `VISUAL`、`EDITOR` | `externalEditor` 未设置时的外部编辑器回退 |
| `HTTP_PROXY`、`HTTPS_PROXY` | 为出站 HTTP 请求设置代理 |

`ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 等 provider 凭据以及云 provider 配置列在 [Providers](providers.md#environment-variables-or-auth-file) 中。
