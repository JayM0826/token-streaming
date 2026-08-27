# Token Streaming V1 完成审计

审计日期：2026-08-14

范围说明（2026-08-24）：下述数字是继承的 Token Streaming 运行时在审计日的历史证据，不包含后来新增的算力市场领域包；市场扩展以当前仓库门禁结果为准。

本文件以 `docs/codex-build-brief.zh.md` 为需求事实来源，以当前源码、行为测试、打包产物和 CLI 实际输出为证据。`docs/v1-acceptance-matrix.md` 提供更细的行为映射，最终权威门禁是：

```bash
pnpm acceptance:check -- --json
```

## 当前结论

- V1 `7.1` 的 22 项必须能力：22/22 已证明完成，完成度 100%。
- V1 `9` 的 13 条行为验收：13/13 已由本地行为测试证明。
- 完整开发 Prompt 的 15 个模块组：实现均已落地；Model Providers 的代码、模拟中转、错误路径及真实商业中转均已通过验收。
- 明确非目标仍保持未实现：Desktop App、多套生产策略、分布式 Agent、向量数据库、企业权限后台、插件市场、云同步。
- 最新本地质量证据：197/197 tests、lint、7 个包发布检查、7 个包加 CLI/headless core 隔离安装均通过。

## 算力市场扩展审计（2026-08-26）

继承运行时之外的“共算云”扩展已经通过当前仓库门禁：292/292 tests、Web typecheck/lint/production build、10 个包发布检查、10 个包及 CLI/supplier-node/supplier-agent/headless core/marketplace-domain 隔离安装均通过，生产依赖审计为 0 个已知漏洞。数据库 0000–0005 迁移由自动化测试在真实临时 D1 中顺序执行：测试会先写入旧版推理、文件和文件任务，再验证 19 张业务表、旧行保留、`gateway_token_digest`、隐私模式、内容密钥版本、摘要版本和持久化限流索引；运行时增量引导与全部 13 条历史列迁移保持一致，并在 Worker isolate 竞争后重新读取 schema。

本轮新增的大文件数据面实现了：256 MiB 上限、4 MiB SHA-256 分块、浏览器刷新后断点续传、R2 AES-256-GCM 加密、租户/AAD/明密文摘要校验、独立 artifact 密钥、供应 Agent 出站能力心跳、精确授权/Provider/模型/媒体/大小匹配、五分钟租约、加密本地检查点、最多三次执行、30 分钟队列超时、UTF-8 非执行处理、分段 map/reduce、全任务 token 预算、聚合签名执行证据、最高费用预留、受条件保护的原子结算和过期密文清理。详细信任边界见 ADR 0005。

隐私安全增量实现了：严格模式默认与明文处理确认、购买方专属内容视图和主动清除、登录资料不复制、四类密钥分域、记录绑定 AES-GCM AAD、租户/资源绑定 HMAC 内容承诺、持久化限流与配额、全客户写接口同源校验、安全响应头，以及 Supplier Agent v0.3 的 HttpOnly 回环会话、令牌重认证/自动隐藏和口令失败节流。普通共享节点及其上游仍会在执行时取得明文，不宣传为端到端加密；详细决策见 ADR 0006。

当前明确格式边界为纯文本、Markdown、CSV/TSV、JSON/NDJSON 与 XML。PDF、Office、图片、音视频、压缩包和代码沙箱未伪装为已支持能力，提交时 fail closed；公开商业发布仍依赖持牌支付、真实 KYC/KYB/税务/出款、Provider 转售许可和独立上游回执等级。

## 公开技术 Beta 发布证据（2026-08-27）

- `pnpm launch:check` 已通过：292/292 tests、固定 pnpm 版本的 workspace lint、10 个包发布检查、10 个包与 CLI/supplier-node/supplier-agent/headless core/marketplace-domain 隔离安装、Web production build，以及生产依赖高危审计。
- Sites 公开版本已升级到包含 0000–0005 迁移、持久化限流、主动内容清除和四类分域密钥的版本；线上 D1 已核验为 19 张业务表，部署后 Worker 错误日志为空。
- 该发布是使用赠送测试余额、P0/P1 和失败关闭策略的公开技术 Beta，不代表支付、KYC/KYB、税务、出款、Provider 商业授权或地区合规已经完成。未进入生产白名单的供应节点仍不能被批准。

## 22 项范围审计

| # | 必须能力 | 结论 | 主要证据 |
| --- | --- | --- | --- |
| 1 | CLI host | 完成 | CLI 主任务、完整命令目录、文本/JSON/JSONL 行为测试 |
| 2 | Headless core | 完成 | `TokenStreamingRuntime` 公共 API、打包消费测试、实时 `onEvent` 流 |
| 3 | Session Manager | 完成 | session 创建、append-only JSONL、历史读取与流式输出 |
| 4 | Repo Scanner | 完成 | package/scripts/source/test/manifest 扫描及 Python fallback 测试 |
| 5 | `.ai/` manifest loader | 完成 | 官方 manifest 优先加载、字段映射及 validator 测试 |
| 6 | 外部项目 fallback generator | 完成 | JS/Python 推断、`.ai/generated/`、默认不覆盖及 force 测试 |
| 7 | Context Builder | 完成 | 模块/流程/公共 API/测试映射、选择理由和上下文预算测试 |
| 8 | Default Strategy | 完成 | 唯一真实策略、任务分类、风险、phase、handoff、验证计划测试 |
| 9 | Tool Runtime | 完成 | 8 个稳定工具、schema、风险等级、read-only 直通边界测试 |
| 10 | Permission System | 完成 | sensitive path、protected pattern、forbidden/approval command 测试 |
| 11 | Patch Engine | 完成 | structured proposal、预览、路径/符号链接安全、完整文件写入测试 |
| 12 | Command Runner | 完成 | 120 秒默认超时、1 MB 输出上限、结构化超时/截断测试 |
| 13 | Test Feedback | 完成 | 声明命令、顺序执行、首错停止、结果摘要和 repair 上下文测试 |
| 14 | Checkpoint / Rollback | 完成 | 写前 checkpoint、存在状态、dry-run、真实恢复及防逃逸测试 |
| 15 | Event Log | 完成 | 生命周期事件、唯一终止事件、review-before-terminal、host observer 测试 |
| 16 | Run Report | 完成 | 成功、运行失败、初始化失败、权限、工具、review 和变更报告测试 |
| 17 | Model Provider interface | 完成 | protocol contract 与 provider factory |
| 18 | Stub provider | 完成 | 确定性单测及权威验收中的真实端到端 stub smoke |
| 19 | OpenAI provider adapter | 完成 | Responses/Chat Completions、模拟中转、超时、重试、脱敏 HTTP/网络诊断均通过；WellAU + `gpt-5.5` 的 Chat Completions 真实中转验收通过 |
| 20 | Strategy extension point | 完成 | `OrchestrationStrategy`、registry、注入 custom strategy 测试 |
| 21 | Mode extension point | 完成 | economy/max/auto 类型、上下文/推理/验证/review 最小差异测试 |
| 22 | Module/workflow manifests | 完成 | 7 个模块均有 README + `module.yaml`，workflow 有 README + `flow.yaml` |

## 关键不变量

以下要求不是“存在文件”即可通过，而是由行为测试验证：

- 模型文本不能直接写盘；只有解析成功的 structured patch proposal 能进入写流程。
- patch 必须先 permission check，再 checkpoint，最后 apply。
- 并发 advisory agents 不能写文件、运行命令或绕过主 runtime。
- `test.run` 只能执行 manifest 声明且通过安全策略的命令。
- 敏感写入支持 deny、allow 和真实 stdin prompt；`--json` stdout 保持纯 JSON，提示走 stderr。
- 每个成功或失败 run 都有 review，且只有一个最终 `run.completed` 或 `run.failed`。
- headless host 的 `onEvent` 只接收已持久化事件；observer 失败不会破坏运行历史。
- shell 命令受到时间和输出内存边界约束；超时或超量输出会让验证失败。
- 所有发布包要求 Node.js `>=22`、dist JS/types、合法 exports；CLI 保留 shebang 和 bin shim。

## 验收证据

```text
lint: passed
tests: 197 passed, 0 failed
package readiness: 7 packages passed
packed install: 7 packages + CLI + headless core passed
manifest validation: 0 errors, 0 warnings
stub smoke: provider=stub, strategy=default, review/event-log/report verified
repository doctor: passed offline
commercial live smoke: verified with WellAU, gpt-5.5, chat-completions
```

## 商业中转验收

2026-08-14 使用 `https://api.wellau.com/v1` 和账户实际列出的 `gpt-5.5` 完成真实验收：鉴权 `/models` 返回 HTTP 200 且精确包含目标模型。Responses 探测正确诊断出中转站自身的 `HTTP 400 upstream_error: unknown provider for model gpt-5.5`，随后按 provider 已实现的兼容能力切换到 Chat Completions，完整权威门禁进程成功退出。根据 `scripts/check-acceptance.mjs` 的退出条件，这同时证明 `offlineOk === true` 且 `liveSmoke.verified === true`；该轮仍包含 lint、197 项测试、包就绪、隔离安装、manifest、stub smoke 和 repository doctor，而不是仅运行网络探针。

最终完成证据满足：

```json
{
  "ok": true,
  "offlineOk": true,
  "liveSmoke": {
    "status": "verified",
    "verified": true
  }
}
```

WellAU 当前应使用 `OPENAI_API_PROTOCOL=chat-completions`；其 Responses 路由限制属于中转站配置，不是本项目 adapter 缺陷。验收完成后五项临时 User/Process 环境变量及桌面同步脚本均已清除。
