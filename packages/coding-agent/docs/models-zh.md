# 自定义模型

通过 `~/.pi/agent/models.json` 添加自定义 provider 和模型（Ollama、vLLM、LM Studio、代理）。

## 目录

- [最小示例](#minimal-example)
- [完整示例](#full-example)
- [受支持的 API](#supported-apis)
- [Provider 配置](#provider-configuration)
- [模型配置](#model-configuration)
- [覆盖内置 Provider](#overriding-built-in-providers)
- [每模型覆盖](#per-model-overrides)
- [Anthropic Messages 兼容性](#anthropic-messages-compatibility)
- [OpenAI 兼容性](#openai-compatibility)

## 最小示例

对于本地模型（Ollama、LM Studio、vLLM），每个模型只需要 `id`：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

`apiKey` 值是个占位符，因为 Ollama 会忽略它。pi 仍把模型视为需要认证后才会出现在 `/model` 中，所以无需密钥的本地服务器应保留一个 dummy 值，用 `/login` 为该 provider 保存一个 key，或在选择模型时传 `--api-key`。

有些 OpenAI 兼容服务器不理解用于支持推理模型的 `developer` role。对这些 provider，把 `compat.supportsDeveloperRole` 设为 `false`，让 pi 把系统提示作为 `system` 消息发送。如果服务器也不支持 `reasoning_effort`，也把 `compat.supportsReasoningEffort` 设为 `false`。

你可以把 `compat` 设在 provider 级以应用于所有模型，或设在模型级以覆盖特定模型。这通常适用于 Ollama、vLLM、SGLang 和类似的 OpenAI 兼容服务器。

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "gpt-oss:20b",
          "reasoning": true
        }
      ]
    }
  }
}
```

## 完整示例

需要特定值时覆盖默认值：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        {
          "id": "llama3.1:8b",
          "name": "Llama 3.1 8B (Local)",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 32000,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

文件每次打开 `/model` 时重新加载。会话中编辑即可；无需重启。

## Google AI Studio 示例

用 `google-generative-ai` 加 `baseUrl` 添加来自 Google AI Studio 的模型，包括自定义 Gemma 4 条目：

```json
{
  "providers": {
    "my-google": {
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
      "api": "google-generative-ai",
      "apiKey": "$GEMINI_API_KEY",
      "models": [
        {
          "id": "gemma-4-31b-it",
          "name": "Gemma 4 31B",
          "input": ["text", "image"],
          "contextWindow": 262144,
          "reasoning": true
        }
      ]
    }
  }
}
```

为 `google-generative-ai` API 类型添加自定义模型时，`baseUrl` 必填。

## 受支持的 API

| API | 说明 |
|-----|-------------|
| `openai-completions` | OpenAI Chat Completions（兼容性最好） |
| `openai-responses` | OpenAI Responses API |
| `anthropic-messages` | Anthropic Messages API |
| `google-generative-ai` | Google Generative AI |

`api` 设在 provider 级（所有模型的默认值）或模型级（按模型覆盖）。

## Provider 配置

| 字段 | 说明 |
|-------|-------------|
| `baseUrl` | API 端点 URL |
| `api` | API 类型（见上） |
| `apiKey` | 可选 API key 配置（见下方值解析）。当认证由 `/login`/`auth.json` 或 CLI `--api-key` 提供时省略它。 |
| `oauth` | 动态 OAuth provider 类型。目前支持 `"radius"`；需要 gateway `baseUrl`。 |
| `headers` | 自定义头（见下方值解析） |
| `authHeader` | 设为 `true` 自动添加 `Authorization: Bearer <apiKey>` |
| `models` | 模型配置数组 |
| `modelOverrides` | 该 provider 上内置或扩展注册模型的每模型覆盖 |

对有 `models` 的 provider，非内置 provider 配置需要在 provider 或模型级提供 `baseUrl` 和 `api` 值。加载文件不需要 `apiKey`：当认证通过 `/login`/`auth.json`、CLI `--api-key` 或 provider `apiKey` 配置时，模型变为可用。如果没有配置认证，模型会加载但在 `/model` 和 `--list-models` 中保持不可用。

### 值解析

`apiKey` 和 `headers` 字段支持命令执行、环境变量插值和字面量：

- **Shell 命令：** 开头的 `"!command"` 把整个值作为命令执行并使用 stdout
  ```json
  "apiKey": "!security find-generic-password -ws 'anthropic'"
  "apiKey": "!op read 'op://vault/item/credential'"
  ```
- **环境变量插值：** `"$ENV_VAR"` 或 `"${ENV_VAR}"` 使用命名变量的值。插值可以在更大的字面量内部工作。
  ```json
  "apiKey": "$MY_API_KEY"
  "apiKey": "${KEY_PREFIX}_${KEY_SUFFIX}"
  ```
  `$FOO_BAR` 是变量 `FOO_BAR`；当 `BAR` 是字面文本时用 `${FOO}_BAR`。缺失的环境变量使值无法解析。
- **转义：** `"$$"` 输出字面 `"$"`；`"$!"` 输出字面 `"!"` 而不触发命令执行。
  ```json
  "apiKey": "$$literal-dollar-prefix"
  "apiKey": "$!literal-bang-prefix"
  ```
- **字面量值：** 直接使用。`MY_API_KEY` 这类纯大写字符串是字面量；环境变量用 `$MY_API_KEY`。
  ```json
  "apiKey": "sk-..."
  ```

对 `models.json`，shell 命令在请求时解析。pi 有意不对任意命令应用内置 TTL、过期复用或恢复逻辑。不同命令需要不同的缓存和失败策略，pi 无法推断出正确的那个。

如果你的命令慢、昂贵、有限流，或在瞬态失败时应继续使用上一个值，把它包在你自己的脚本或命令中，实现你想要的缓存或 TTL 行为。

`/model` 可用性检查使用已配置认证的存在性，不执行 shell 命令。

### 自定义头

```json
{
  "providers": {
    "custom-proxy": {
      "baseUrl": "https://proxy.example.com/v1",
      "apiKey": "$MY_API_KEY",
      "api": "anthropic-messages",
      "headers": {
        "x-portkey-api-key": "$PORTKEY_API_KEY",
        "x-secret": "!op read 'op://vault/item/secret'"
      },
      "models": [...]
    }
  }
}
```

## 模型配置

| 字段 | 必填 | 默认 | 说明 |
|-------|----------|---------|-------------|
| `id` | 是 | — | 模型标识符（传给 API） |
| `name` | 否 | `id` | 人类可读的模型标签。用于匹配（`--model` 模式）并显示为次要模型详情文本。 |
| `api` | 否 | provider 的 `api` | 为该模型覆盖 provider 的 API |
| `reasoning` | 否 | `false` | 支持扩展思考 |
| `thinkingLevelMap` | 否 | 省略 | 把 pi 思考级别映射到 provider 值并标记不支持的级别（见下） |
| `input` | 否 | `["text"]` | 输入类型：`["text"]` 或 `["text", "image"]` |
| `contextWindow` | 否 | `128000` | 上下文窗口大小（token） |
| `maxTokens` | 否 | `16384` | 最大输出 token |
| `samplingParams` | 否 | 省略 | 原样合并进每个请求体的采样参数（见下） |
| `cost` | 否 | 全零 | 每百万 token 费率，可选全请求输入计价阶梯 |
| `compat` | 否 | provider `compat` | Provider 兼容性覆盖。两者都设置时与 provider 级 `compat` 合并。 |

成本阶梯提供一套完整的替代费率，当总输入用量（`input + cacheRead + cacheWrite`）超过 `inputTokensAbove` 时应用于整个请求。多个阶梯匹配时，最高阈值胜出。

```json
{
  "cost": {
    "input": 5,
    "output": 30,
    "cacheRead": 0.5,
    "cacheWrite": 6.25,
    "tiers": [
      {
        "inputTokensAbove": 272000,
        "input": 10,
        "output": 45,
        "cacheRead": 1,
        "cacheWrite": 12.5
      }
    ]
  }
}
```

当前行为：
- `/model`、`--list-models` 和交互页脚按模型 `id` 显示条目。
- 配置的 `name` 用于模型匹配和次要模型详情文本。它不替换页脚/状态栏的模型 id。

### 采样参数

`samplingParams` 是一个自由对象，在 pi 自己设置的字段之后原样合并进该模型的每个请求体，所以它的键胜出。用它发送 pi 未建模的采样参数——包括服务器特定的，如 llama.cpp 的 `min_p` 或 vLLM 的 `top_k`：

```json
{
  "id": "deepseek-v4-flash",
  "samplingParams": {
    "temperature": 1.0,
    "top_p": 0.95,
    "top_k": 0,
    "min_p": 0.0
  }
}
```

只有 OpenAI 兼容 API 应用它（`openai-completions`、`openai-responses`、`azure-openai-responses`）；其他 API 忽略它。键覆盖 pi 的命名请求字段（例如这里的 `temperature` 键胜过请求级 temperature），所以优先把它作为该模型采样的唯一事实来源。在 `modelOverrides` 中，`samplingParams` 按键与基础模型的值合并。

### 思考级别映射

用模型上的 `thinkingLevelMap` 描述模型特定的思考控制。键是 pi 思考级别：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。映射可以有空洞；例如，模型可以暴露 `high` 和 `max` 而不暴露 `xhigh`。

值是三态的：

| 值 | 含义 |
|-------|---------|
| 省略 | 到 `high` 的标准级别使用 provider 的默认映射；扩展的 `xhigh` 和 `max` 级别不支持 |
| 字符串 | 级别受支持，且该值被发送给 provider |
| `null` | 级别不受支持并被隐藏/跳过/钳制 |

只支持 off、high 和 max 推理的模型示例：

```json
{
  "id": "deepseek-v4-pro",
  "reasoning": true,
  "thinkingLevelMap": {
    "minimal": null,
    "low": null,
    "medium": null,
    "high": "high",
    "xhigh": null,
    "max": "max"
  }
}
```

思考无法禁用的模型示例：

```json
{
  "id": "always-thinking-model",
  "reasoning": true,
  "thinkingLevelMap": {
    "off": null
  }
}
```

迁移：使用 `compat.reasoningEffortMap` 的旧配置应把该映射移到模型级 `thinkingLevelMap`。对不应出现在 UI 中的级别用 `null`。

## 覆盖内置 Provider

通过代理路由内置 provider 而不重新定义模型：

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1"
    }
  }
}
```

所有内置 Anthropic 模型保持可用。已有的 OAuth 或 API key 认证继续工作。

要把自定义模型合并进内置 provider，包含 `models` 数组：

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1",
      "apiKey": "$ANTHROPIC_API_KEY",
      "api": "anthropic-messages",
      "models": [...]
    }
  }
}
```

合并语义：
- 内置模型保留。
- 自定义模型在 provider 内按 `id` upsert。
- 如果自定义模型 `id` 匹配内置模型 `id`，自定义模型替换该内置模型。
- 如果自定义模型 `id` 是新的，它与内置模型一起添加。

## 每模型覆盖

用 `modelOverrides` 定制内置模型和匹配的扩展注册模型，而不替换 provider 的完整模型列表。

```json
{
  "providers": {
    "openrouter": {
      "modelOverrides": {
        "anthropic/claude-sonnet-4": {
          "name": "Claude Sonnet 4 (Bedrock Route)",
          "compat": {
            "openRouterRouting": {
              "only": ["amazon-bedrock"]
            }
          }
        }
      }
    }
  }
}
```

`modelOverrides` 每个模型支持这些字段：`name`、`reasoning`、`thinkingLevelMap`、`input`、`cost`（部分）、`contextWindow`、`maxTokens`、`samplingParams`（按键合并）、`headers`、`compat`。

直连 OpenAI 的 GPT-5.6 Sol、Terra 和 Luna 默认使用 `272000` 上下文窗口，使请求保持在 OpenAI 短上下文计价阶梯内。要使用 OpenAI 的 1.05M 上下文窗口，为你使用的每个模型调大它：

```json
{
  "providers": {
    "openai": {
      "modelOverrides": {
        "gpt-5.6-sol": {
          "contextWindow": 1050000
        }
      }
    }
  }
}
```

覆盖保留内置的计价元数据。总输入 token 超过 272K 的请求对整个请求使用 GPT-5.6 的长上下文费率。需要时对 `gpt-5.6-terra` 或 `gpt-5.6-luna` 应用相同覆盖。

行为说明：
- `modelOverrides` 应用于内置 provider 模型和匹配的扩展注册 provider 模型。
- 未知模型 ID 被忽略。
- 你可以把 provider 级 `baseUrl`/`headers` 与 `modelOverrides` 组合。
- 覆盖 `name` 只改变模型匹配和次要详情文本；页脚和主模型列表继续显示模型 `id`。
- 如果 provider 也定义了 `models`，自定义模型在内置覆盖之后合并。相同 `id` 的自定义模型替换被覆盖的内置模型条目。

## Anthropic Messages 兼容性

对使用 `api: "anthropic-messages"` 的 provider 或代理，用 `compat` 控制 Anthropic 特定的请求兼容性。

默认 pi 发送每工具 `eager_input_streaming: true`。如果代理或 Anthropic 兼容后端拒绝该字段，把 `supportsEagerToolInputStreaming` 设为 `false`。Pi 会省略 `tools[].eager_input_streaming`，改为对启用工具发送旧版 `fine-grained-tool-streaming-2025-05-14` beta 头。

某些 Anthropic 模型需要自适应思考（`thinking.type: "adaptive"` 加 `output_config.effort`），而不是旧版基于预算的思考 payload。内置模型自动设置。对于路由到这些模型的自定义 provider 或别名，把 `forceAdaptiveThinking` 设为 `true`。

某些 Anthropic 兼容 provider 发出带空签名的思考块，并仍期望重放时保留它们。只为这些 provider 把 `allowEmptySignature` 设为 `true`；真实 Anthropic 拒绝空思考签名。

内置 Anthropic 模型在其模型元数据中启用 `supportsStrictTools`。自定义 Anthropic 兼容模型在其端点接受严格 JSON-schema 工具定义时必须设为 `true`。

```json
{
  "providers": {
    "anthropic-proxy": {
      "baseUrl": "https://proxy.example.com",
      "api": "anthropic-messages",
      "apiKey": "$ANTHROPIC_PROXY_KEY",
      "compat": {
        "supportsEagerToolInputStreaming": false,
        "supportsLongCacheRetention": true,
        "forceAdaptiveThinking": true,
        "allowEmptySignature": true
      },
      "models": [
        {
          "id": "claude-opus-4-7",
          "reasoning": true,
          "input": ["text", "image"]
        }
      ]
    }
  }
}
```

| 字段 | 说明 |
|-------|-------------|
| `supportsEagerToolInputStreaming` | provider 是否接受每工具 `eager_input_streaming`。默认：`true`。设为 `false` 省略该字段并在启用工具的请求上使用旧版细粒度工具流式 beta 头。 |
| `supportsLongCacheRetention` | provider 是否在缓存保留为 `long` 时接受 Anthropic 长缓存保留（`cache_control.ttl: "1h"`）。默认：`true`。 |
| `sendSessionAffinityHeaders` | 启用缓存时是否从会话 id 发送 `x-session-affinity`。默认：对已知 provider 自动检测。 |
| `supportsCacheControlOnTools` | provider 是否接受工具定义上的 Anthropic 风格 `cache_control` 标记。默认：`true`。 |
| `forceAdaptiveThinking` | 是否为该模型发送自适应思考（`thinking.type: "adaptive"` 加 `output_config.effort`）。内置自适应模型自动设置。默认：`false`。 |
| `allowEmptySignature` | 是否把空思考签名重放为 `signature: ""` 而不是把思考转为文本。默认：`false`。 |
| `supportsStrictTools` | provider 是否接受严格 JSON-schema 工具定义。默认：`false`；内置 Anthropic 模型在生成的元数据中启用。 |

## OpenAI 兼容性

对部分 OpenAI 兼容的 provider，使用 `compat` 字段。

- Provider 级 `compat` 为该 provider 下所有模型应用默认值。
- 模型级 `compat` 为该模型覆盖 provider 级值。

```json
{
  "providers": {
    "local-llm": {
      "baseUrl": "http://localhost:8080/v1",
      "api": "openai-completions",
      "compat": {
        "supportsUsageInStreaming": false,
        "maxTokensField": "max_tokens"
      },
      "models": [...]
    }
  }
}
```

| 字段 | 说明 |
|-------|-------------|
| `supportsStore` | Provider 支持 `store` 字段 |
| `supportsDeveloperRole` | 使用 `developer` 还是 `system` role |
| `supportsReasoningEffort` | `reasoning_effort` 参数支持 |
| `supportsUsageInStreaming` | 支持 `stream_options: { include_usage: true }`（默认：`true`） |
| `supportsFinishReason` | 流式响应是否包含 `finish_reason`。为 `false` 时，pi 在流结束时推断 `stop` 或 `toolUse`。默认：`true`。 |
| `maxTokensField` | 使用 `max_completion_tokens` 还是 `max_tokens` |
| `requiresToolResultName` | 工具结果消息包含 `name` |
| `requiresAssistantAfterToolResult` | 在工具结果后的用户消息前插入一条 assistant 消息 |
| `requiresThinkingAsText` | 把思考块转为纯文本 |
| `requiresReasoningContentOnAssistantMessages` | 启用推理时在所有重放的 assistant 消息上包含空 `reasoning_content` |
| `thinkingFormat` | 使用 `reasoning_effort`、`openrouter`、`deepseek`、`together`、`baseten`、`zai`、`qwen`、`chat-template` 或 `qwen-chat-template` 思考参数 |
| `chatTemplateKwargs` | `thinkingFormat: "chat-template"` 的 `chat_template_kwargs` 值；对 pi 控制的思考值用 `{ "$var": "thinking.enabled" }` 或 `{ "$var": "thinking.effort" }` |
| `chatTemplateArgs` | `thinkingFormat: "baseten"` 的 `chat_template_args` 值；对 pi 控制的思考值用 `{ "$var": "thinking.enabled" }` 或 `{ "$var": "thinking.effort" }` |
| `cacheControlFormat` | 在系统提示、最后一个工具定义以及最后的用户、assistant 或工具结果文本内容上使用 Anthropic 风格 `cache_control` 标记。目前只支持 `anthropic`。 |
| `sendSessionAffinityHeaders` | 对 `openai-completions`，启用缓存时从会话 id 发送会话亲和头。默认：`false`。 |
| `sessionAffinityFormat` | 对 `openai-completions` 和 `openai-responses`，会话亲和头格式：`openai` 发送 `session_id`/`x-client-request-id`（completions 还发 `x-session-affinity`），`openai-nosession` 省略含下划线的 `session_id` 头，`openrouter` 发送 `x-session-id`。不影响 `prompt_cache_key` 体参数。默认：自动检测。 |
| `supportsStrictMode` | provider 是否接受严格 JSON-schema 函数工具定义。默认取决于 API；内置 OpenAI 模型携带显式能力元数据。 |
| `supportsOpenAIGrammarTools` | OpenAI 兼容 API 是否发出自定义 Lark/正则语法工具。为 `false` 时，语法约束工具回退为普通函数工具。默认：`false`；内置模型目录为 OpenAI、OpenAI Codex、Azure OpenAI、GitHub Copilot、opencode 和 Cloudflare AI Gateway 上的 GPT-5+ 模型启用。 |
| `deferredToolsMode` | 使用 provider 特定的延迟工具序列化。目前只支持 `"kimi"`，用于 Kimi 的 OpenAI 兼容 Chat Completions 格式。 |
| `supportsLongCacheRetention` | provider 是否在缓存保留为 `long` 时接受长缓存保留：OpenAI 提示缓存的 `prompt_cache_retention: "24h"`，或 `cacheControlFormat` 为 `anthropic` 时的 `cache_control.ttl: "1h"`。默认：`true`。 |
| `openRouterRouting` | OpenRouter provider 路由偏好。该对象原样发送在 [OpenRouter API 请求](https://openrouter.ai/docs/guides/routing/provider-selection)的 `provider` 字段中。 |
| `vercelGatewayRouting` | Vercel AI Gateway 的 provider 选择路由配置（`only`、`order`） |

`openrouter` 使用 `reasoning: { effort }`。`together` 使用 `reasoning: { enabled }`，且在 `supportsReasoningEffort` 启用时也使用 `reasoning_effort`。`qwen` 使用顶层 `enable_thinking`。对需要 `chat_template_kwargs.enable_thinking` 和 `preserve_thinking` 的本地 Qwen 兼容服务器，使用 `qwen-chat-template`。对需要可配置 `chat_template_kwargs` 的 vLLM/Hugging Face 聊天模板，使用 `chat-template`，如 DeepSeek V3.x 模板的 `chatTemplateKwargs: { "thinking": { "$var": "thinking.enabled" } }`。对通过 `chat_template_args` 暴露开关控制且可选支持顶层 `reasoning_effort` 的 provider，使用 `thinkingFormat: "baseten"` 加 `chatTemplateArgs`。

`cacheControlFormat: "anthropic"` 用于通过文本内容和工具定义上的 `cache_control` 标记暴露 Anthropic 风格提示缓存的 OpenAI 兼容 provider。

示例：

```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "$OPENROUTER_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "openrouter/anthropic/claude-3.5-sonnet",
          "name": "OpenRouter Claude 3.5 Sonnet",
          "compat": {
            "openRouterRouting": {
              "allow_fallbacks": true,
              "require_parameters": false,
              "data_collection": "deny",
              "zdr": true,
              "enforce_distillable_text": false,
              "order": ["anthropic", "amazon-bedrock", "google-vertex"],
              "only": ["anthropic", "amazon-bedrock"],
              "ignore": ["gmicloud", "friendli"],
              "quantizations": ["fp16", "bf16"],
              "sort": {
                "by": "price",
                "partition": "model"
              },
              "max_price": {
                "prompt": 10,
                "completion": 20
              },
              "preferred_min_throughput": {
                "p50": 100,
                "p90": 50
              },
              "preferred_max_latency": {
                "p50": 1,
                "p90": 3,
                "p99": 5
              }
            }
          }
        }
      ]
    }
  }
}
```

Vercel AI Gateway 示例：

```json
{
  "providers": {
    "vercel-ai-gateway": {
      "baseUrl": "https://ai-gateway.vercel.sh/v1",
      "apiKey": "$AI_GATEWAY_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "moonshotai/kimi-k2.5",
          "name": "Kimi K2.5 (Fireworks via Vercel)",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0.6, "output": 3, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 262144,
          "maxTokens": 262144,
          "compat": {
            "vercelGatewayRouting": {
              "only": ["fireworks", "novita"],
              "order": ["fireworks", "novita"]
            }
          }
        }
      ]
    }
  }
}
```
