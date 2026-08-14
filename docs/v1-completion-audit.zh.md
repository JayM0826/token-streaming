# Token Streaming V1 完成审计

审计日期：2026-08-14

本文件以 `docs/codex-build-brief.zh.md` 为需求事实来源，以当前源码、行为测试、打包产物和 CLI 实际输出为证据。`docs/v1-acceptance-matrix.md` 提供更细的行为映射，最终权威门禁是：

```bash
pnpm acceptance:check -- --json
```

## 当前结论

- V1 `7.1` 的 22 项必须能力：21 项已证明完成，1 项等待外部商业 API 成功响应，完成度 95.5%。
- V1 `9` 的 13 条行为验收：13/13 已由本地行为测试证明。
- 完整开发 Prompt 的 15 个模块组：实现均已落地；其中 Model Providers 的代码、模拟中转和错误路径已通过，真实中转成功响应仍待最终验收。
- 明确非目标仍保持未实现：Desktop App、多套生产策略、分布式 Agent、向量数据库、企业权限后台、插件市场、云同步。
- 最新本地质量证据：197/197 tests、lint、7 个包发布检查、7 个包加 CLI/headless core 隔离安装均通过。

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
| 19 | OpenAI provider adapter | 实现完成，外部验收待完成 | Responses/Chat Completions、模拟中转、超时、重试、脱敏 HTTP/网络诊断均通过；真实中转尚未返回成功内容 |
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
commercial live smoke: pending successful upstream response
```

## 唯一剩余条件

第三方中转配置已被证明能正确同步到验收子进程。无凭据复核确认 `/v1/models`、`/v1/responses` 和 `/v1/chat/completions` 当前均可达，并按预期返回 `401 API_KEY_REQUIRED`，因此 DNS、TLS 和网关路由不是阻塞项。此前真实 `/v1/responses` 请求到达中转站，但返回 `Upstream request failed`；离线门禁保持全绿，临时凭据已安全清除。当前代码已经兼容嵌套及顶层错误格式，保留 HTTP status、上游 type/code/request ID，并对正文限长、对 API key 脱敏，因此下一次调用可以明确区分模型权限、账号、协议兼容和中转上游故障。

最终完成条件是一次完整门禁返回：

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

在该证据出现前，本项目不声明 V1 全部完成。
