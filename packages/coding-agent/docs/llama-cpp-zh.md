# llama.cpp

Pi 支持 [llama.cpp](https://github.com/ggml-org/llama.cpp) router 服务器。router 可以发现多个 GGUF 模型并按需加载或卸载它们。

使用支持 router 的当前 llama.cpp 构建版本。遵循[构建说明](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md)或为你的平台安装[预构建发行版](https://github.com/ggml-org/llama.cpp/releases)。

## 启动 router

不带 `--model` 或 `-m` 启动 `llama-server`。传入模型会启动单模型模式而不是 router 模式。

```bash
llama-server \
  --models-dir ~/models \
  --no-models-autoload \
  --jinja \
  --host 127.0.0.1 \
  --port 8080 \
  -ngl 999 \
  -c 32768
```

重要选项：

- `--models-dir ~/models` 发现本地 GGUF 文件。
- `--no-models-autoload` 保持通过 `/llama` 显式加载。
- `--jinja` 启用兼容的聊天模板和工具调用。
- `-ngl 999` 尽可能多地把层卸载到 GPU。
- `-c 32768` 为每个加载的模型设置上下文窗口。省略它以使用模型的原始上下文，这可能需要多得多的内存。

单文件模型可以直接放在模型目录中。多模态和多分片模型放在单独的子目录中：

```text
~/models/
├── llama-3.2-1b-Q4_K_M.gguf
├── gemma-3-4b-it-Q4_K_M/
│   ├── gemma-3-4b-it-Q4_K_M.gguf
│   └── mmproj-F16.gguf
└── large-model-Q4_K_M/
    ├── large-model-Q4_K_M-00001-of-00003.gguf
    ├── large-model-Q4_K_M-00002-of-00003.gguf
    └── large-model-Q4_K_M-00003-of-00003.gguf
```

手动添加文件后重启 router。每个模型的上下文大小和其他选项见 [llama.cpp model presets](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#model-presets)。

## 配置 Pi

启动 Pi 并配置 provider：

```text
/login llama.cpp
```

输入 router URL 和可选 API key。默认 URL 是 `http://127.0.0.1:8080`。

环境变量可以在不用 `/login` 的情况下配置相同的值：

```bash
export LLAMA_BASE_URL=http://127.0.0.1:8080
export LLAMA_API_KEY=optional-secret
pi
```

如果服务器使用 API key，用匹配的 `--api-key` 值启动 `llama-server`。保持 `--host 127.0.0.1` 以仅限本地访问。

## 管理模型

运行：

```text
/llama
```

- 选择一个未加载的模型来加载它。
- 选择一个已加载的模型来卸载它。
- 选择 **Download model…**，搜索 Hugging Face，然后选择仓库和量化。精确的 `owner/repository[:quant]` 值也可以。
- 在加载或下载过程中按 Escape 确认取消。

Hugging Face 搜索在设置 `HF_TOKEN` 时使用它，然后检查 `$HF_TOKEN_PATH`、`$HF_HOME/token`、`$XDG_CACHE_HOME/huggingface/token` 和 `~/.cache/huggingface/token`。未认证时搜索也可用，但受更低的速率限制。下载受门控仓库前 Pi 会警告并链接到其访问页面。下载由 llama.cpp 服务器执行，因此当所选仓库需要访问权限时，其进程也必须拥有 `HF_TOKEN`。

如果其他模型已加载，Pi 会询问是先卸载它们还是保持加载。Pi 不会悄悄卸载模型，也从不删除模型文件。router 可能与其他客户端共享，所以 `/llama` 始终显示 router 的当前状态。

只有已加载的模型会出现在 `/model` 中。加载模型后，运行 `/model` 为当前 Pi 会话选择它。

如果 router 断开连接，`/llama` 显示 **Retry** 和 **Close**。Retry 会重连并刷新模型状态，而不会重放被中断的操作。

## 故障排查

检查 router 是否可达：

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/models
```

- **`/llama` 中没有模型：** 检查 `--models-dir`、目录布局，并重启 router。
- **`/model` 中缺少模型：** 先用 `/llama` 加载它。
- **加载失败或内存占用过多：** 调低 `-c` 或卸载其他模型。
- **服务器不在 router 模式：** 不带 `--model`、`-m` 或 `-hf` 启动。
