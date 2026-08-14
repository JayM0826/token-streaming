# 商业模型 Provider 接入指南

Token Streaming 通过统一的 `ModelProvider` 中间层接入商业模型。Core 和 Agent Loop 只理解统一请求、统一响应与 token usage；认证头、URL、请求体和响应解析由 `packages/providers` 内的 Adapter 负责。

当前支持：

| Provider | 原生协议 | API Key | 默认 Base URL | 默认模型 |
| --- | --- | --- | --- | --- |
| OpenAI | Responses / Chat Completions | `OPENAI_API_KEY` | `https://api.openai.com/v1` | `gpt-5.5` |
| Anthropic | Messages | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1` | `claude-sonnet-5` |
| Gemini | Interactions | `GEMINI_API_KEY` | `https://generativelanguage.googleapis.com/v1` | `gemini-3.6-flash` |
| Stub | 本地确定性实现 | 无 | 无 | `stub` |

官方协议参考：[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)、[Gemini Interactions](https://ai.google.dev/api/interactions-api)。

## Windows PowerShell 配置

`$env:NAME="value"` 只写入当前 PowerShell 进程及其后续子进程。因此必须在同一个终端里配置并启动 CLI：

```powershell
$env:ANTHROPIC_API_KEY="your-key"
$env:ANTHROPIC_MODEL="claude-sonnet-5"
pnpm cli -- --provider anthropic doctor models --probe --json
```

Gemini：

```powershell
$env:GEMINI_API_KEY="your-key"
$env:GEMINI_MODEL="gemini-3.6-flash"
pnpm cli -- --provider gemini doctor models --probe --json
```

OpenAI：

```powershell
$env:OPENAI_API_KEY="your-key"
$env:OPENAI_MODEL="gpt-5.5"
pnpm cli -- --provider openai doctor models --probe --json
```

如果使用 `[Environment]::SetEnvironmentVariable(..., "User")` 持久化变量，已经运行的终端和 Codex 进程不会自动收到新值。关闭并重新打开终端后再运行 CLI，或同时给当前终端设置 `$env:` 值。

## 配置矩阵

每个 provider 都支持 Key、Base URL、Model、Timeout 四类变量：

```text
OPENAI_API_KEY       OPENAI_BASE_URL       OPENAI_MODEL       OPENAI_TIMEOUT_MS
ANTHROPIC_API_KEY    ANTHROPIC_BASE_URL    ANTHROPIC_MODEL    ANTHROPIC_TIMEOUT_MS
GEMINI_API_KEY       GEMINI_BASE_URL       GEMINI_MODEL       GEMINI_TIMEOUT_MS
```

只有 OpenAI Adapter 还支持：

```text
OPENAI_API_PROTOCOL=responses|chat-completions
```

超时默认 30,000 ms，允许范围为 1 到 600,000 ms。CLI `--model` 的优先级高于环境变量和 manifest。

## 原生 API 与中转站

Anthropic 和 Gemini Adapter 使用各自原生协议，并不是把它们伪装成 OpenAI 请求：

- Anthropic 请求 `<ANTHROPIC_BASE_URL>/messages`，使用 `x-api-key` 和 `anthropic-version`。
- Gemini 请求 `<GEMINI_BASE_URL>/interactions`，使用 `x-goog-api-key`。
- OpenAI-compatible 中转站继续通过 OpenAI Adapter 接入，并根据中转站能力选择 Responses 或 Chat Completions。

OpenAI-compatible 中转示例：

```powershell
$env:OPENAI_API_KEY="relay-key"
$env:OPENAI_BASE_URL="https://relay.example/v1"
$env:OPENAI_API_PROTOCOL="chat-completions"
$env:OPENAI_MODEL="relay-model-name"
pnpm cli -- --provider openai doctor models --probe --json
```

若某个中转站暴露的是自定义 Anthropic 或 Gemini 原生网关，则设置对应 provider 的 `*_BASE_URL`，网关必须保持该原生协议的端点、认证头与响应结构。

## Auto 路由

`--provider auto` 是默认值：

1. 已选择的模型名以 `claude-`、`gemini-`/`gemma-`、`gpt-` 等已知前缀开头时，优先匹配对应 provider。
2. 没有模型族提示时，按 OpenAI、Anthropic、Gemini 的固定顺序选择已配置 Key 的 provider。
3. 没有任何商业 Key 时使用 Stub，保证离线开发和测试不产生费用。
4. manifest 有多家候选时，只在当前可执行的商业 provider 候选中路由；若没有商业 Key，仍可用 `models select` 查看完整评分，但不会误发请求。

多模型候选示例：

```yaml
default_provider: auto
model_candidates:
  - gpt-5.5;provider=openai;quality=0.94;cost=0.75;latency=0.55;tags=balanced,max
  - claude-sonnet-5;provider=anthropic;quality=0.94;cost=0.75;latency=0.55;tags=balanced,max
  - gemini-3.6-flash;provider=gemini;quality=0.86;cost=0.35;latency=0.25;tags=economy,fast
```

## 诊断与验收

只检查配置，不发送请求：

```powershell
pnpm cli -- config inspect --json
pnpm cli -- doctor models --json
pnpm cli -- doctor repo --json
```

发送最小探针请求：

```powershell
pnpm smoke:openai
pnpm smoke:anthropic
pnpm smoke:gemini
```

运行离线门禁并验收指定商业 provider：

```powershell
pnpm acceptance:check -- --provider anthropic --json
pnpm acceptance:check -- --provider gemini --json
```

JSON 诊断只公开 `hasApiKey`、Key 的环境变量名、模型、Base URL、最终端点、协议和超时，不返回 Key 值。HTTP 与网络错误也会对已配置 Key 做精确脱敏。

## 安全要求

- 不要把 Key 写入 `.ai/`、源码、提交记录或共享的 `.env`。
- 不要把完整 Key 作为 CLI 参数，因为参数可能出现在 shell history 或进程列表。
- 每位使用者在自己的环境中配置 Key；仓库只保存变量名和模型策略。
- `.ai/safety.yaml` 和新项目生成模板会保护 OpenAI、Anthropic、Gemini Key 赋值模式。
