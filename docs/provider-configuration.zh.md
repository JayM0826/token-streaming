# 模型 Provider 接入指南

Token Streaming 通过统一的 `ModelProvider` 中间层接入 API 模型和本机 Codex。Core 与 Agent Loop 只依赖统一请求、响应和 token usage；认证、端点、原生协议及响应解析由 `packages/providers` 内的 Adapter 负责。

| Provider | 传输方式 | 凭据 | 默认模型 |
| --- | --- | --- | --- |
| OpenAI | Responses / Chat Completions API | `OPENAI_API_KEY` | `gpt-5.5` |
| Anthropic | Messages API | `ANTHROPIC_API_KEY` | `claude-sonnet-5` |
| Gemini | Interactions API | `GEMINI_API_KEY` | `gemini-3.6-flash` |
| Codex | 本机 `codex exec` | Codex 已有登录态 | `gpt-5.5` |
| Stub | 本地确定性实现 | 无 | `stub` |

## 默认路由

不传 `--provider` 时默认选择 `codex`，CLI 会自动检测本机 Codex 并使用已有登录态。

`--provider auto` 是显式的 API 自动路由模式：

1. 模型名以 `claude-`、`gemini-`/`gemma-`、`gpt-` 等已知前缀开头时，优先匹配对应 API Provider。
2. 没有模型族提示时，按 OpenAI、Anthropic、Gemini 的固定顺序选择已配置 Key 的 Provider。
3. 没有任何 API Key 时回退 Stub，保证离线开发和测试不产生费用。
4. 即使电脑安装了 Codex，显式 `auto` 也不会启动它，便于 CI 或用户强制要求 API-only 行为。

## API Provider

Windows PowerShell 必须在启动 CLI 的同一终端设置环境变量：

```powershell
$env:OPENAI_API_KEY="your-key"
$env:OPENAI_MODEL="gpt-5.5"
pnpm cli -- --provider openai doctor models --probe --json

$env:ANTHROPIC_API_KEY="your-key"
$env:ANTHROPIC_MODEL="claude-sonnet-5"
pnpm cli -- --provider anthropic doctor models --probe --json

$env:GEMINI_API_KEY="your-key"
$env:GEMINI_MODEL="gemini-3.6-flash"
pnpm cli -- --provider gemini doctor models --probe --json
```

配置矩阵：

```text
OPENAI_API_KEY       OPENAI_BASE_URL       OPENAI_MODEL       OPENAI_TIMEOUT_MS
ANTHROPIC_API_KEY    ANTHROPIC_BASE_URL    ANTHROPIC_MODEL    ANTHROPIC_TIMEOUT_MS
GEMINI_API_KEY       GEMINI_BASE_URL       GEMINI_MODEL       GEMINI_TIMEOUT_MS
OPENAI_API_PROTOCOL=responses|chat-completions
```

API 超时默认 30,000 ms，允许范围为 1 到 600,000 ms。CLI `--model` 的优先级高于环境变量和 manifest。

第三方 OpenAI-compatible 中转站示例：

```powershell
$env:OPENAI_API_KEY="relay-key"
$env:OPENAI_BASE_URL="https://relay.example/v1"
$env:OPENAI_API_PROTOCOL="chat-completions"
$env:OPENAI_MODEL="relay-model-name"
$env:OPENAI_TIMEOUT_MS="120000"
pnpm cli -- --provider openai doctor models --probe --json
```

Anthropic 与 Gemini Adapter 使用各自原生协议。原生网关应分别兼容 `<ANTHROPIC_BASE_URL>/messages` 或 `<GEMINI_BASE_URL>/interactions`，而不是伪装成 OpenAI 请求。

## 本机 Codex

只检查配置和可执行文件，不调用模型：

```powershell
pnpm cli -- config inspect --json
pnpm cli -- doctor models --json
```

发起最小真实请求：

```powershell
pnpm cli -- doctor models --probe --json
pnpm smoke:codex
```

CLI 按以下顺序检测 Codex：

1. `CODEX_EXEC_PATH` 指定的文件。
2. Windows Codex Desktop 的 `%LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe`。
3. `PATH` 中的 `codex.exe`、`codex.cmd` 或类 Unix 系统的 `codex`。

可选配置：

```powershell
$env:CODEX_EXEC_PATH="C:\path\to\codex.exe"
$env:CODEX_EXEC_MODEL="gpt-model-supported-by-your-codex"
$env:CODEX_EXEC_SERVICE_TIER="fast"
$env:CODEX_EXEC_TIMEOUT_MS="300000"
```

未设置 `CODEX_EXEC_MODEL` 时使用兼容默认值 `gpt-5.5`，避免本机 Codex 配置指向当前 CLI 不支持的过新模型；仍可用环境变量或 CLI `--model` 覆盖。`CODEX_EXEC_SERVICE_TIER` 支持 `fast` 或 `flex`，默认 `fast`，并会覆盖旧版配置中的无效 `default` 值。`doctor models` 会执行只读的 `codex --version` 并校验 Codex CLI 标识；只有 `--probe` 或真实任务才会产生模型用量。

每次调用都使用 stdin、临时输出文件以及 `codex exec --ephemeral --sandbox read-only --json`。同时限制提示和输出大小、设置超时、清理临时目录，并通过 `CODEX_EXEC_PROVIDER_DEPTH` 阻止递归调用。Codex 只负责生成结果，实际写入仍经过 Permission System、Patch Engine、Checkpoint 和 Test Feedback。

参数定义参考 [Codex CLI 官方命令文档](https://learn.chatgpt.com/docs/developer-commands?surface=cli)。

## 诊断与验收

```powershell
pnpm cli -- doctor models --json
pnpm cli -- doctor repo --json
pnpm smoke:openai
pnpm smoke:anthropic
pnpm smoke:gemini
pnpm smoke:codex
pnpm acceptance:check -- --provider codex --json
```

`doctor` 默认不发送模型请求。JSON 只公开 Key 是否存在、环境变量名、模型、端点、超时或 Codex 可执行文件信息，不返回 Key 值。真实 smoke 和 acceptance 会产生对应账户用量。

## 安全要求

- 不要把 Key 写入 `.ai/`、源码、提交记录或共享 `.env`。
- 不要把完整 Key 作为 CLI 参数，避免进入 shell history 或进程列表。
- 使用 `[Environment]::SetEnvironmentVariable(..., "User")` 后，已运行的终端不会自动收到新值；重新打开终端，或同时设置当前 `$env:`。
- 仓库只保存变量名和模型策略，每位使用者在自己的环境中配置凭据或 Codex 登录态。
