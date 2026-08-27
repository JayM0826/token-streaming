# ADR 0008：网关凭据可轮换 keyring、持久 canary 与审核职责分离

- 状态：Accepted
- 日期：2026-08-28

## 背景

网关 bearer token 原先由单一 `MARKETPLACE_CREDENTIAL_KEY` 加密，查询摘要则复用长期 `MARKETPLACE_COMMITMENT_KEY`。数据库里的 `encryption_key_version` 和 `gateway_token_digest_version` 表示密文/AAD 或摘要格式，不是实际密钥 epoch。直接替换任一 secret 会让仍在最长 90 天授权期内的凭据失读，或让所有版本 2 Agent 查询摘要立即失配。维护端点只验证当前配置的长度和分域，无法识别“沿用同一个标识却配置了另一把密钥”的错误。

Agent nonce 又以凭据摘要分区。轮换后若只在新摘要命名空间登记 nonce，轮换前已接受、仍在五分钟时间窗内的相同签名可从旧摘要命名空间跨到新命名空间重放。

授权审核还有独立职责缺口：管理员身份可以同时注册供应方、提交自己的节点授权并批准该申请。管理员权限本身不是独立审核证据。

## 决策

### 有界双读 keyring

运行时新增两个 JSON secret：

- `MARKETPLACE_CREDENTIAL_KEYRING`：网关 token 的 AES-256-GCM 加密 keyring。
- `MARKETPLACE_CREDENTIAL_LOOKUP_KEYRING`：Agent token 查询的独立 HMAC-SHA256 keyring。

格式固定为 `{"active":"key-id","keys":{"key-id":"base64-32-byte-key"}}`。key id 只能使用小写字母、数字、点、下划线和连字符；每个 ring 连同自动合并的 legacy key 最多八把，key material 不能在两个 id 下重复。旧单值 secret 仍被自动映射为 `legacy-credential-v2` 和 `legacy-commitment-v2`，使发布可以先进入双读阶段，再切换 active key。lookup 从通用 commitment 生命周期中拆出；历史证据不需要跟随每次 Agent 凭据轮换被扫描。

新 credential key id 使用密文格式 3，AAD 绑定格式、key id、tenant 和 authorization request。旧格式 1/2 只允许 legacy credential id。新 lookup key id 使用摘要格式 3，HMAC payload 绑定 key id；旧版本 2 保持原 payload 并映射 legacy commitment id。`authorization_requests` 新增 `credential_key_id` 和 `gateway_token_lookup_key_id`，格式版本与 key id 分开保存。未知格式、未知 key id 或错误组合全部失败关闭。

### 无停机迁移与退役门禁

维护任务每轮最多选择四条非 active credential 密文，按记录中的精确 key id 和 AAD 解密，再用 active key 重包。更新带原密文、IV、格式和 key id 的完整 CAS；如果并发过期、拒绝或清除已擦掉凭据，重包必须失败且不能复活 secret。

lookup 摘要不能在没有原 token 的情况下离线迁移。Agent 合法签名验证成功并取得对应授权后，平台才把所有命中的旧/raw 摘要以 CAS 懒迁到 active lookup key。每个请求会在一个 SQL statement 中同时占用 active、全部可读 previous lookup digest 以及 legacy raw SHA 命名空间；任一命名空间已有相同 nonce 时，整次 claim 写入零行并拒绝请求。

maintenance 在任何留存变更前扫描仍有密文/摘要的授权行，确认其 key id 全部仍存在。credential legacy 退役扫描同时覆盖 `content_key_version = 1` 的历史 inference output 和 artifact instruction/output，因为这些早期内容也曾由 credential key 加密。维护结果公开 active key id、可读 key 数和两类迁移 backlog，但不公开 key material。

### 持久 cryptographic canary

新增 `cryptographic_key_canaries`。每个可读 credential AES key 保存一份随机 IV、固定明文、domain/key-id AAD 的 canary 密文；每个 lookup HMAC key保存一份对固定 domain/key-id payload 的 canary。首次双读部署以 `INSERT OR IGNORE` 建立，之后每次 maintenance 都必须重新验证。运维若在不改变 key id 的情况下误换 key material，维护端点在处理客户数据前返回可重试 503。canary 不包含 key material、客户标识或客户内容，历史 canary 保留以支持恢复验证。

### 审核职责分离

管理员不得审核 `request.tenant_id === reviewer.tenantId` 的供应授权。服务层返回稳定的 `REVIEWER_CONFLICT` 403，底层全局 review-target claim SQL 也要求 target tenant 与 reviewer tenant 不同。失败不能发起节点 attestation、占用幂等命令、改变 supplier 状态或写审核事件。该规则是最低双主体约束；它不等价于完整的双人审批工作流。

## 发布顺序

1. 部署 0011 和双读代码，保留旧单值 secrets；等待旧 Worker isolate 排空并成功运行 maintenance，建立 legacy canary。
2. 为 credential 与 lookup 分别生成新 key，配置包含新 active 的 keyring；旧单值 secret 继续自动作为 legacy read key。
3. maintenance 有界重包 credential；Agent 成功鉴权时懒迁 lookup。观察两类 rotation backlog，并把 `legacyCredentialContentReferences` 归零作为移除 legacy credential key 的额外条件，因为格式 v1 的历史推理/文件内容也由它加密。
4. 只有对应引用为零、canary 持续有效并完成恢复演练后，才从 keyring 移除旧 key。lookup ring 仍配置新 key 时，将 `MARKETPLACE_CREDENTIAL_LOOKUP_LEGACY_ENABLED` 精确设为 `false` 可停止把旧 commitment secret 映射为 lookup legacy key；maintenance 会在有残余引用时失败关闭，而长期 evidence 的 `MARKETPLACE_COMMITMENT_KEY` 继续保留。缺省值和 `true` 均保持兼容双读，其他值拒绝启动该密码路径。

任何跳过双读直接替换旧 secret 的操作仍然不受支持。

## 后果与剩余边界

- Gateway credential 加密与 Agent lookup 已具备有界、可观察、失败关闭的轮换路径；格式版本不再被当作 key id。
- 单个 Gateway token 的 Agent 有效授权投影上限为 100。查询读取第 101 行时明确失败；经签名验证的批量 lookup CAS 会迁移该 token 所有可读旧命名空间（包括响应上限之外和非活动行），避免旧 key 被永久钉住或静默少返回权限。
- `MARKETPLACE_CONTENT_KEY`、`MARKETPLACE_ARTIFACT_KEY` 和通用 `MARKETPLACE_COMMITMENT_KEY` 仍是单值生命周期。它们必须保持稳定并备份，直到各内容/分块/证据表增加独立 key id；artifact chunk keyring 和长期 commitment verification 是下一阶段。
- 平台仍缺少供应方自助撤销单条授权和换 token 的完整状态机。泄露的客户网关 token 当前应先关闭供给并由管理员拒绝/失效相关授权；正式商业运营前应增加按 authorization 的 revoke、凭据清除和报价失效原子流程。
- KMS/HSM、每租户或每 artifact envelope key、双人审批及合规级恢复演练仍是商业发布依赖。
