# ADR 0005：加密、可续传的大文件异步任务

- 状态：Accepted
- 日期：2026-08-26

## 背景

实时推理接口只适合有明确请求体和超时上限的短任务。把数十或数百 MiB 文件编码成 JSON/Base64 会放大内存、带宽和日志泄露风险，也无法在浏览器刷新、网络抖动、供应节点重启或长时间模型处理后可靠恢复。让平台直接连接个人电脑还会扩大入站端口、SSRF 与家庭网络暴露面。

## 决策

引入独立的 `gongsuanyun.artifact.v1` 与 `gongsuanyun.artifact-worker.v1` 协议，不扩大实时 `gongsuanyun.gateway.v3` 请求体。ADR 0006 后续将 worker 升级为 `gongsuanyun.artifact-worker.v2`，增加显式隐私模式与清除语义；v1 worker 不再领取新任务。

购买端把最多 256 MiB 的受支持 UTF-8 文件切为固定 4 MiB 分块，逐块计算 SHA-256。平台验证租户、编号、精确大小和摘要后，使用独立的 32-byte `MARKETPLACE_ARTIFACT_KEY` 做 AES-256-GCM 加密；AAD 绑定租户、artifact、分块编号和明文摘要。密文写入 R2，D1 只保存清单、密文/明文摘要、IV、状态和到期时间。浏览器在本地保存不含文件内容的上传断点，恢复时重新计算每个已完成分块的摘要。

Supplier Agent 通过出站 HTTPS 每五秒发送签名 claim，同时写入两分钟有效的能力心跳。调度只选择满足以下全部条件的报价：供应主体与报价有效、授权令牌摘要匹配、Provider 和精确模型匹配、授权 ID 匹配、Agent 最近在线、媒体类型与文件大小在 Agent 声明范围内。任务领取后获得五分钟租约；检查点只能单调增加，租约到期可由同一 worker 从本地加密检查点恢复，最多三次。`resume_from_segment > 0` 时必须存在任务身份、认证包络及已完成段数完全匹配的本地 checkpoint，否则 Agent 在下载输入或调用 Provider 前以不可重试的 `ARTIFACT_CHECKPOINT_REQUIRED` 终止。任务排队超过 30 分钟失败并释放预算。

供应内核只按顺序读取平台返回的分块，重新验证每块摘要、完整字节数、UTF-8 和整文件摘要；不解压、不执行、不读写普通工作目录、不跟随文件 URL、不开放工具或 Shell。文件段被明确包裹为不可信数据，先 map 后分层 reduce；每次 Provider 调用仍执行精确响应模型与用量校验，并使用确定性 idempotency key。最终证据绑定任务、Provider、购买/实际模型、artifact 与 manifest、整文件摘要、输出摘要、Provider 请求 ID 聚合摘要、分段数、总用量和完成时间，再由 Agent 网关令牌签名。

创建任务时按购买方明确的 `max_total_tokens` 和已接受费率预留最高费用。完成时只有在租约、完整最终检查点、总预算、证据字段、HMAC 和最终实际费用全部通过后，才在一个受条件保护的 D1 batch 中写入完成状态、不可变证据、用量、买方扣款、供应方收入与平台费。普通推理也必须扣除活动文件任务预留额。任何不一致均不产生财务分录。

文件输入在无活动任务且到期后由有界流量触发清理器删除 R2 密文并标记 metadata 为 deleted；终态后保留窗口为 48 小时。结果密文保留 24 小时后清空。执行凭证、审计和追加账本继续保留。

## 首版格式边界

首版执行只接受 `text/plain`、Markdown、CSV/TSV、JSON/NDJSON 与 XML，并要求有效 UTF-8。PDF、Office、图片、音视频、压缩包和可执行文件不做“猜格式”降级；要支持这些格式，必须新增经过沙箱、解压炸弹/宏/恶意对象防护和独立容量计量的版本化提取适配器。

## 后果

- 大文件不进入 JSON、D1、普通日志或工程 Codex 会话，上传和执行都可恢复。
- 个人供应端不因大文件能力新增公网入站接口；实时短请求的已审核 HTTPS 网关边界保持不变。
- 当前加密使用平台级独立 artifact key，而非每 artifact 的 KMS envelope key；公开商业发布前应迁移到 KMS/HSM 管理的每租户或每 artifact DEK，并提供定时触发器作为流量触发清理的补充。
- 节点签名能证明 hardened Agent 观察到的上游模型与用量，但不是 Provider 独立签名。更高保证档位仍需官方回执、平台托管 Provider 项目或可信执行环境。
