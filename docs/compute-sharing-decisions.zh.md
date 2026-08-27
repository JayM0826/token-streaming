# 算力共享平台架构决策记录

- 状态：Proposed（ADR-001 已接受，其余逐项确认）
- 日期：2026-08-24
- 关联设计：`docs/compute-sharing-platform-design.zh.md`

本文件记录进入实现前必须确认的高影响决策。`Accepted` 后如果要改变结论，应新增替代 ADR，而不是静默修改历史理由。

## ADR-001：只交易经授权且可计量的容量

- 状态：Accepted
- 决策：企业和个人都是 V1 一等供应方，但不得提交账号密码、Cookie、可复用登录态、共享 API Key 或私有接口中继。消费级订阅在上游明确允许第三方服务/转售并提供正式授权与计量连接器时逐 Provider 开启。
- 理由：供应方身份不决定风险；授权、隔离、可计量性和数据处理边界才决定能否接入。
- 代价：个人供应方带来更多 KYC、税务、payout、设备可信度和小额结算工作；具体消费订阅仍可能因上游规则无法接入。
- 验证：每个 `CapacityOffer` 必须引用有效授权，且模型、地区、数据等级、有效期和容量均不得超出授权；KYC/KYB 或授权过期后停止新报价与调度。

## ADR-002：本地 Codex 只属于研发执行面

- 状态：Proposed
- 决策：规划、编码、评审和文档等 AI 辅助研发统一使用本地 Codex。客户推理走版本化 Provider SPI，并由已接受的容量报价选择具体上游；开发者 Codex 会话不是市场 Provider。
- 理由：研发身份、客户数据、供应凭据和生产 SLA 必须彼此隔离；产品也不能被锁定为单一模型供应商。
- 代价：需要分别维护研发工具链和生产 Provider Adapter/契约测试。
- 验证：生产部署依赖图不包含开发者 Codex 登录态；端到端测试证明客户请求只能命中已授权 offer 对应的 Adapter。

## ADR-003：本地 Codex 研发配置为 Sol/xhigh/Fast

- 状态：Proposed
- 决策：仓库 `.codex/config.toml` 使用 `gpt-5.6-sol`、`model_reasoning_effort=xhigh`、`service_tier=fast`。该配置不传播到产品报价或 Provider 默认值。
- 理由：准确表达“本地 Codex、极高、极速”的研发要求；Codex 的 Fast 配置名是 `fast`，不是产品 API 的 `ultrafast`。
- 代价：Fast 可用性取决于研发账号；本地开发成本需要单独治理。
- 验证：Codex `/status` 或等价诊断显示预期模型、推理强度和 Fast；架构测试确保产品层不读取 `.codex/config.toml`。

## ADR-004：首发只在供应商支持地区

- 状态：Proposed
- 决策：地区资格绑定 `provider + model + tier + offer`。每条路由必须同时满足上游支持地区、合同授权和当地 AI/数据/支付要求；不得代理绕过。
- 理由：供应商限制必须严格执行，但一个 Provider 的地区范围不能错误地变成整个平台的地区范围。
- 代价：同一地区的可售模型和供应池可能不同，路由与合规配置更复杂。
- 验证：租户、支付资料、IP/设备风险信号、合同地区和 offer 共同决定 eligibility；每个新地区有独立 ADR。

## ADR-005：协议优先，UI 不嵌入领域内核

- 状态：Proposed
- 决策：TUI、桌面、移动端和第三方 SDK 都通过版本化 API/事件协议访问内核；只共享 `client-core`，不共享数据库或 Provider 代码。
- 理由：保证多端一致、可独立发布、可替换 UI，并减少安全敏感逻辑复制。
- 代价：需要协议兼容、SDK 生成和网络错误处理。
- 验证：依赖规则阻止 `apps/*` UI import server domain/storage/provider 包。

## ADR-006：模块化单体先行

- 状态：Proposed
- 决策：控制面先以 TypeScript 模块化单体部署，PostgreSQL 为真相，transactional outbox 发布事件；供应代理单独使用 Rust。
- 理由：当前团队和交易量未知，微服务会提前引入分布式事务和运维成本。供应代理暴露于不可信终端，使用内存安全语言并做最小权限隔离。
- 代价：服务端需要严格包边界；未来热点模块拆分要维护事件契约。
- 验证：架构测试检查跨模块 import 和数据库所有权；任何拆服务决策以容量/故障数据为依据。

## ADR-007：双重账本和持牌支付机构

- 状态：Proposed
- 决策：金额使用整数最小单位或 decimal，账本只追加分录；真实资金由持牌 PSP 托管、分账和 payout。平台不自建可提现储值钱包。
- 理由：防止重复扣费、余额漂移和无牌资金沉淀。
- 代价：依赖 PSP 能力、结算周期和渠道费。
- 验证：每个 transaction 借贷平衡；每日对账不平衡自动停止 payout。

## ADR-008：不宣称默认端到端加密

- 状态：Proposed
- 决策：默认提供 TLS/mTLS、静态 envelope encryption 和最小日志；只有远程证明的机密计算路径才能称为 client-to-worker confidential payload。
- 理由：普通网关或供应代理需要看到明文才能构造 Provider 请求；错误宣传会制造安全和合规风险。
- 代价：高敏客户需要更昂贵的专属/机密供应池。
- 验证：产品文案和安全白皮书区分默认、agent-bound、confidential 三种信任等级。

## ADR-009：移动端首期只做购买方

- 状态：Proposed
- 决策：iOS/Android 首期不提供后台供应节点；供应能力先在企业服务器和桌面 Rust Agent 上实现。
- 理由：移动系统后台、散热、电量、网络和应用商店政策不适合稳定 SLA。
- 代价：个人供给侧扩张较慢。
- 验证：移动客户端没有 Provider 凭据导入、后台 worker 或供应 offer 发布权限。

## ADR-010：商业许可证是研发闸门

- 状态：Proposed
- 决策：在分发或商业部署前，由仓库版权所有者添加明确许可证，或取得覆盖修改、部署和分发的书面授权。
- 理由：当前仓库根目录和 package metadata 没有发现许可证声明。
- 代价：如果版权关系不清，后续商业发布会暂停。
- 验证：release pipeline 检查许可证文件、第三方 notice 和 SBOM license policy。

## 待业务负责人确认

- [ ] 首发国家/地区和签约公司主体。
- [ ] 首发 Provider、模型、服务档位及允许的显式替代策略。
- [ ] 首发 Provider 是否已书面允许该终端用户和容量供应模式。
- [ ] 目标毛利和会员价格区间。
- [ ] 仓库版权归属和计划采用的商业/开源许可证。
