# Providers

Pi 通过 OAuth 支持订阅制 provider，通过环境变量或 auth 文件支持 API key provider。内置目录随 pi 发布；已配置的 provider 可以刷新更新目录并缓存到 `~/.pi/agent/models-store.json` 供离线使用。

## 目录

- [订阅](#subscriptions)
- [API Key](#api-keys)
- [Auth 文件](#auth-file)
- [云 Provider](#cloud-providers)
- [llama.cpp](#llamacpp)
- [自定义 Provider](#custom-providers)
- [解析顺序](#resolution-order)

## 订阅

交互模式下使用 `/login`，然后选择一个 provider：

- ChatGPT Plus/Pro（Codex）
- Claude Pro/Max
- GitHub Copilot
- xAI（Grok/X 订阅）
- OpenRouter（通过 OAuth 签发的 API key，从 OpenRouter 额度扣费）
- Radius

用 `/logout` 清除凭据。token 存储在 `~/.pi/agent/auth.json` 并在过期时自动刷新。OpenRouter 则签发一个用户控制的 API key，它不会自动过期。

### OpenAI Codex

- 需要 ChatGPT Plus 或 Pro 订阅
- 获 OpenAI 官方认可：[Codex for OSS](https://developers.openai.com/community/codex-for-oss)

### Claude Pro/Max

Anthropic 订阅认证对 Claude Pro/Max 账号生效。第三方 harness 使用会消耗[额外用量](https://claude.ai/settings/usage)，按 token 计费，而不是占用 Claude 套餐限额。

### GitHub Copilot

- 按 Enter 选择 github.com，或输入你的 GitHub Enterprise Server 域名
- 如果提示 "model not supported"，在 VS Code 中启用：Copilot Chat → 模型选择器 → 选择模型 → "Enable"

### xAI（Grok/X 订阅）

- 运行 `/login xai`，然后选择 **Use a subscription**
- `XAI_API_KEY` 仍可通过 **Use an API key** 使用

### OpenRouter

- 运行 `/login openrouter`，然后选择 **Sign in with OpenRouter** 打开 OpenRouter PKCE 授权流程
- 授权会创建一个用户控制的 OpenRouter API key，从你的 OpenRouter 额度扣费
- 在远程/无头机器上（例如通过 SSH），浏览器无法到达回环回调；改为把最终重定向 URL（或授权码）粘贴到登录提示中
- `OPENROUTER_API_KEY` 仍可通过 **Use an API key** 使用

### Radius

Radius 是一个动态 `pi-messages` gateway。`/login radius` 把 OAuth token 存入 `auth.json`；gateway 目录独立刷新并缓存到 `models-store.json`。自定义 Radius gateway 可以在 `models.json` 中用 `"oauth": "radius"` 和 gateway `baseUrl` 声明。

## API Key

### 环境变量或 Auth 文件

交互模式下使用 `/login` 并选择一个 provider，把 API key 存入 `auth.json`，或通过环境变量设置凭据：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

| Provider | 环境变量 | `auth.json` 键 |
|----------|----------------------|------------------|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
| Ant Ling | `ANT_LING_API_KEY` | `ant-ling` |
| Azure OpenAI Responses | `AZURE_OPENAI_API_KEY` | `azure-openai-responses` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek` |
| NVIDIA NIM | `NVIDIA_API_KEY` | `nvidia` |
| Google Gemini | `GEMINI_API_KEY` | `google` |
| Amazon Bedrock | `AWS_BEARER_TOKEN_BEDROCK` | `amazon-bedrock` |
| Mistral | `MISTRAL_API_KEY` | `mistral` |
| Groq | `GROQ_API_KEY` | `groq` |
| Cerebras | `CEREBRAS_API_KEY` | `cerebras` |
| Cloudflare AI Gateway | `CLOUDFLARE_API_KEY`（+ `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_GATEWAY_ID`） | `cloudflare-ai-gateway` |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY`（+ `CLOUDFLARE_ACCOUNT_ID`） | `cloudflare-workers-ai` |
| xAI | `XAI_API_KEY` | `xai` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `vercel-ai-gateway` |
| ZAI Coding Plan (Global) | `ZAI_API_KEY` | `zai` |
| ZAI Coding Plan (China) | `ZAI_CODING_CN_API_KEY` | `zai-coding-cn` |
| OpenCode Zen | `OPENCODE_API_KEY` | `opencode` |
| OpenCode Go | `OPENCODE_API_KEY` | `opencode-go` |
| Radius | `RADIUS_API_KEY` | `radius` |
| Hugging Face | `HF_TOKEN` | `huggingface` |
| Fireworks | `FIREWORKS_API_KEY` | `fireworks` |
| Together AI | `TOGETHER_API_KEY` | `together` |
| Baseten | `BASETEN_API_KEY` | `baseten` |
| Kimi For Coding | `KIMI_API_KEY` | `kimi-coding` |
| MiniMax | `MINIMAX_API_KEY` | `minimax` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` | `minimax-cn` |
| Qwen Token Plan（现有目录） | `QWEN_TOKEN_PLAN_API_KEY` | `qwen-token-plan` |
| Qwen Token Plan (Individual) | `QWEN_TOKEN_PLAN_API_KEY` | `qwen-token-plan-individual` |
| Qwen Token Plan (China) | `QWEN_TOKEN_PLAN_CN_API_KEY` | `qwen-token-plan-cn` |
| Xiaomi MiMo | `XIAOMI_API_KEY` | `xiaomi` |
| Xiaomi MiMo Token Plan (China) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` | `xiaomi-token-plan-cn` |
| Xiaomi MiMo Token Plan (Amsterdam) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | `xiaomi-token-plan-ams` |
| Xiaomi MiMo Token Plan (Singapore) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | `xiaomi-token-plan-sgp` |

环境变量和 `auth.json` 键的参考：[`packages/ai/src/env-api-keys.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/env-api-keys.ts) 中的 [`const envMap`](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/env-api-keys.ts)。

#### Auth 文件

把凭据存入 `~/.pi/agent/auth.json`：

```json
{
  "anthropic": { "type": "api_key", "key": "sk-ant-..." },
  "ant-ling": { "type": "api_key", "key": "..." },
  "openai": { "type": "api_key", "key": "sk-..." },
  "deepseek": { "type": "api_key", "key": "sk-..." },
  "nvidia": { "type": "api_key", "key": "nvapi-..." },
  "google": { "type": "api_key", "key": "..." },
  "opencode": { "type": "api_key", "key": "..." },
  "opencode-go": { "type": "api_key", "key": "..." },
  "together": { "type": "api_key", "key": "..." },
  "qwen-token-plan":  { "type": "api_key", "key": "sk-sp-..." },
  "qwen-token-plan-individual": { "type": "api_key", "key": "sk-sp-..." },
  "qwen-token-plan-cn": { "type": "api_key", "key": "sk-sp-..." },
  "xiaomi": { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-cn":  { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-ams": { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-sgp": { "type": "api_key", "key": "..." }
}
```

`qwen-token-plan-individual` 与
`qwen-token-plan` 使用相同的国际端点和 `QWEN_TOKEN_PLAN_API_KEY`，
但把选择器限制为 Individual 订阅文档中列出的模型。现有
provider 保留更宽的目录以向后兼容。使用 `auth.json` 时，把
凭据存在你选择的 provider 下；一个环境变量由两个国际 provider 共享。

该文件以 `0600` 权限创建（仅用户读写）。Auth 文件凭据优先于环境变量。

API key 凭据还可以包含 provider 作用域的环境值。在解析凭据 key、provider/模型头以及 provider 配置（如 Cloudflare 账号 ID、Azure OpenAI 设置、Vertex 项目/区域、Bedrock 设置、`PI_CACHE_RETENTION` 和 `HTTP_PROXY`/`HTTPS_PROXY`）时，这些值优先于进程环境变量。

```json
{
  "cloudflare-ai-gateway": {
    "type": "api_key",
    "key": "$CLOUDFLARE_API_KEY",
    "env": {
      "CLOUDFLARE_API_KEY": "...",
      "CLOUDFLARE_ACCOUNT_ID": "account-id",
      "CLOUDFLARE_GATEWAY_ID": "gateway-id"
    }
  }
}
```

当 pi 应使用与项目 shell 环境不同的 provider 设置时，使用这种方式。

### Key 解析

`key` 字段支持命令执行、环境变量插值和字面量：

- **Shell 命令：** 开头的 `"!command"` 把整个值作为命令执行并使用 stdout（缓存整个进程生命周期）
  ```json
  { "type": "api_key", "key": "!security find-generic-password -ws 'anthropic'" }
  { "type": "api_key", "key": "!op read 'op://vault/item/credential'" }
  ```
- **环境变量插值：** `"$ENV_VAR"` 或 `"${ENV_VAR}"` 使用命名变量的值。插值可以在更大的字面量内部工作。
  ```json
  { "type": "api_key", "key": "$MY_ANTHROPIC_KEY" }
  { "type": "api_key", "key": "${KEY_PREFIX}_${KEY_SUFFIX}" }
  ```
  `$FOO_BAR` 是变量 `FOO_BAR`；当 `BAR` 是字面文本时用 `${FOO}_BAR`。缺失的环境变量使值无法解析。
- **转义：** `"$$"` 输出字面 `"$"`；`"$!"` 输出字面 `"!"` 而不触发命令执行。
  ```json
  { "type": "api_key", "key": "$$literal-dollar-prefix" }
  { "type": "api_key", "key": "$!literal-bang-prefix" }
  ```
- **字面量值：** 直接使用。`MY_API_KEY` 这类纯大写字符串是字面量；环境变量用 `$MY_API_KEY`。
  ```json
  { "type": "api_key", "key": "sk-ant-..." }
  { "type": "api_key", "key": "public" }
  ```

OAuth 凭据在 `/login` 后也存储在这里，并自动管理。

## 云 Provider

### Azure OpenAI

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://your-resource.ai.azure.com
# also supported: https://your-resource.cognitiveservices.azure.com
# also supported: https://your-resource.openai.azure.com
# root endpoints are auto-normalized to /openai/v1
# or use resource name instead of base URL
export AZURE_OPENAI_RESOURCE_NAME=your-resource

# Optional
export AZURE_OPENAI_API_VERSION=2024-02-01
export AZURE_OPENAI_DEPLOYMENT_NAME_MAP=gpt-4=my-gpt4,gpt-4o=my-gpt4o
```

### Amazon Bedrock

使用 `/login amazon-bedrock` 存储 Bedrock API key，或配置以下任一环境 AWS 凭据来源：

```bash
# Option 1: AWS Profile
export AWS_PROFILE=your-profile

# Option 2: IAM Keys
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...

# Option 3: Bearer Token
export AWS_BEARER_TOKEN_BEDROCK=...

# Optional region (defaults to us-east-1)
export AWS_REGION=us-west-2
```

还支持 ECS 任务角色（`AWS_CONTAINER_CREDENTIALS_*`）和 IRSA（`AWS_WEB_IDENTITY_TOKEN_FILE`）。

```bash
pi --provider amazon-bedrock --model us.anthropic.claude-sonnet-4-20250514-v1:0
```

对于 ID 中包含可识别模型名的 Claude 模型（基础模型和系统定义的推理配置文件），提示缓存自动启用。对于应用推理配置文件（其 ARN 不含模型名），设置 `AWS_BEDROCK_FORCE_CACHE=1` 以启用缓存点：

```bash
export AWS_BEDROCK_FORCE_CACHE=1
pi --provider amazon-bedrock --model arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123
```

如果你连接到 Bedrock API 代理，可以使用以下环境变量：

```bash
# Set the URL for the Bedrock proxy (standard AWS SDK env var)
export AWS_ENDPOINT_URL_BEDROCK_RUNTIME=https://my.corp.proxy/bedrock

# Set if your proxy does not require authentication
export AWS_BEDROCK_SKIP_AUTH=1

# Set if your proxy only supports HTTP/1.1
export AWS_BEDROCK_FORCE_HTTP1=1
```

### Cloudflare AI Gateway

`CLOUDFLARE_API_KEY` 可以通过 `/login` 设置。账号 ID 和 gateway slug 可以作为环境变量设置，或设置在 `auth.json` 中 API key 凭据的 `env` 对象里。

```bash
export CLOUDFLARE_API_KEY=...           # or use /login
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_GATEWAY_ID=...        # create at dash.cloudflare.com → AI → AI Gateway
pi --provider cloudflare-ai-gateway --model "claude-sonnet-4-5"
```

通过 Cloudflare AI Gateway 路由到 OpenAI、Anthropic 和 Workers AI。Workers AI 使用统一 API（`/compat`）和带前缀的模型 ID（`workers-ai/@cf/...`）。OpenAI 使用 OpenAI 直通路由（`/openai`）和原生 OpenAI 模型 ID，如 `gpt-5.1`。Anthropic 使用 Anthropic 直通路由（`/anthropic`）和原生 Anthropic 模型 ID，如 `claude-sonnet-4-5`。

AI Gateway 认证把 `CLOUDFLARE_API_KEY` 用作 `cf-aig-authorization`。上游认证可以是以下之一：

| 模式 | 请求认证 | 上游认证 |
|------|--------------|---------------|
| Workers AI | 仅 Cloudflare token | Cloudflare 原生 |
| 统一计费 | 仅 Cloudflare token | Cloudflare 处理上游认证并扣减额度 |
| 存储的 BYOK | 仅 Cloudflare token | Cloudflare 注入存储在 AI Gateway 仪表盘中的 provider key |
| 内联 BYOK | Cloudflare token 加上游 `Authorization` 头 | 请求提供上游 provider key |

普通 pi 使用建议用统一计费或存储的 BYOK。内联 BYOK 需要为 Cloudflare AI Gateway provider 配置额外的上游 `Authorization` 头，例如通过 `models.json` 的 provider/模型覆盖。

### Cloudflare Workers AI

`CLOUDFLARE_API_KEY` 可以通过 `/login` 设置。`CLOUDFLARE_ACCOUNT_ID` 可以作为环境变量设置，或设置在 `auth.json` 中 API key 凭据的 `env` 对象里。

```bash
export CLOUDFLARE_API_KEY=...           # or use /login
export CLOUDFLARE_ACCOUNT_ID=...
pi --provider cloudflare-workers-ai --model "@cf/moonshotai/kimi-k2.6"
```

Pi 自动为[前缀缓存](https://developers.cloudflare.com/workers-ai/features/prompt-caching/)折扣设置 `x-session-affinity`。

### Google Vertex AI

使用 Application Default Credentials：

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=your-project
export GOOGLE_CLOUD_LOCATION=us-central1
```

或把 `GOOGLE_APPLICATION_CREDENTIALS` 设置为服务账号 key 文件。

## llama.cpp

Pi 支持 llama.cpp router 服务器。用 `/login llama.cpp` 配置，用 `/llama` 管理已加载模型，用 `/model` 选择已加载模型。

服务器设置、模型目录布局、环境变量和命令用法见 [llama.cpp](llama-cpp.md)。

## 自定义 Provider

**通过 models.json：** 添加 Ollama、LM Studio、vLLM，或任何讲受支持 API（OpenAI Completions、OpenAI Responses、Anthropic Messages、Google Generative AI）的 provider。见 [models.md](models.md)。

**通过扩展：** 对需要自定义 API 实现或 OAuth 流程的 provider，创建扩展。见 [custom-provider.md](custom-provider.md) 和 [examples/extensions/custom-provider-gitlab-duo](../examples/extensions/custom-provider-gitlab-duo/)。

## 解析顺序

解析某个 provider 的凭据时：

1. CLI `--api-key` 标志
2. `auth.json` 条目（API key 或 OAuth token）
3. 环境变量
4. `models.json` 中的自定义 provider key
