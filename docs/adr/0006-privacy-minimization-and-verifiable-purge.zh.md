# ADR 0006：共享算力的隐私边界、最小留存与可验证清除

- 状态：Accepted
- 日期：2026-08-26

## 背景

共享算力不是端到端密文计算。当前普通模型 API 和文件处理都要求匹配供应节点及其上游 Provider 在执行时取得明文；传输加密和静态加密不能阻止设备所有者观察自己机器的内存。若把“平台加密”宣传成“供应方不可见”，会制造错误的安全承诺。

此前实现还存在四类可收紧点：供应方控制台曾可读取其所执行客户任务的文件名与结果；过期输出、终态指令和文件清单摘要未全部进入物理清除；可重放内容与凭据共用密钥且缺少记录绑定 AAD；原始 SHA-256 对低熵提示词或已知文件存在离线猜测风险。

## 决策

### 明示处理边界

协议增加 `standard` 与 `strict` 两种隐私模式。购买方提交普通请求或文件任务前必须显式确认：内容会发送给匹配供应节点及其上游 Provider。Web 隐私页和提交表单必须持续展示该事实，不使用“端到端加密”或“供应方不可见”等表述。

封闭试运营继续只接受 P0/P1。密码、API Key、Cookie、身份、医疗、金融账户、精确位置、商业绝密等 P2/P3 内容失败关闭。

### 留存与主动清除

- `strict` 为 UI 默认值：普通结果和文件结果的到期时间为 60 分钟；原始文件名不上传；文件等待执行窗口为 60 分钟，活动任务以短租约锁定输入，终态后安排删除 R2 对象和分块 metadata。每个已领取的 artifact task attempt 另有 6 小时绝对执行期限，租约续期不能越过该期限，过期结果不能完成或结算。物理删除由终态清理、流量 sweep 或独立 scheduler 执行，scheduler 延迟不构成硬删除 SLA。
- `standard`：结果保留 24 小时，文件最长保留 48 小时，用于需要较长重试窗口的公开或一般资料。
- 购买方可按普通推理任务、artifact 或 artifact task 主动清除。内容清除会 tombstone 资源、阻止后续下载、清空指令和结果并删除对象；artifact task 取消遵守 ADR 0007 的两阶段规则，已租约任务在 worker 观察取消、租约到期或绝对执行期限到达前保留租约与资金预留，防止与结算竞态。Agent 收到取消状态后删除本地加密检查点。
- `artifact_tasks.content_purged_at` 同时承担“到期输出已擦除”的标记，不能单独证明 task 内容已经完整清除。完整清除必须同时验证该标记存在、指令密文/IV 为空、输出密文/IV/到期字段为空、关联 artifact 已 `deleted` 且有清除时间、并且不存在任何 chunk generation。标准模式结果在 24 小时到期后，48 小时输入的主动清除入口必须继续显示和可调用，直到上述完整条件成立。完整状态成立后，artifact 或 artifact-task 的任意后续显式清除重试都会使用由 action 与 resource 构成的稳定 audit ID 幂等补写缺失的完成审计，并按 tenant/action/resource 查重，不产生第二条同义事件。
- 金额、用量、审计事件和不含可重放正文的执行凭证保持追加且不可覆盖。清除使用补充状态和时间戳，不改写财务历史。

R2 删除使用独立于分块 metadata 的 `artifact_object_deletions` 墓碑。上传在写对象前登记墓碑，成功提交为 `ready` 后才撤销；artifact 清除在触碰 R2 前以同一 D1 batch 登记墓碑，并把精确不可变 generation 标为 `deleting`。墓碑以不可变 `storage_key` 标识对象，其他活跃的 `pending`/`ready` 代不会被清理，已确认删除的代仍保留 24 小时并每 10 分钟重复删除，覆盖对象存储失败、迟到写入和最终一致性窗口。清理转换保持小批次有界：每次只推进一个 artifact 的四个 generation，删除队列每轮也只处理四个 key；最多 64 个 generation 的文件可在 16 次调用中续跑。该边界用于续跑和限制单步影响，不代表完整 maintenance 能在更低 D1 查询上限内运行；maintenance 还包含 schema bootstrap，生产部署硬性要求 Workers Paid 的每 invocation 1,000 query 配额。购买方显式清除在仍有 generation metadata 或 R2 删除未确认时返回可重试 503，只有全部 generation metadata 消失后才把 artifact 标为 `deleted` 并记录完整清除审计。只有墓碑保留期结束且再次删除成功后才移除墓碑，因此删除失败不会退化为不可发现的孤儿密文。

### 租户隔离与最小披露

客户任务、文件名和结果只出现在购买方视图，供应方控制台仅得到聚合任务数、用量和收入。供应 Agent 只能凭已审核网关令牌、签名请求、匹配供应租户及有效任务租约取得当前任务分块。所有购买方读取、重放与清除 SQL 同时绑定资源 ID 和购买方 tenant ID。

登录邮箱和昵称由身份服务按请求显示，不复制到市场 D1；旧用户行在再次登录时写入脱敏占位值。供应方实名或企业资料因审核、结算和法定义务仍需单独保存。严格模式的浏览器上传断点只放在 `sessionStorage`，且不记录原文件名。

### 密钥分域、记录绑定与内容承诺

生产运行时的基础加密材料分为凭据、可重放内容、artifact 分块和摘要承诺四个独立的 256 位域；ADR 0008 又把 Gateway token lookup 从长期摘要承诺生命周期中拆成独立 HMAC keyring，同时仅以 legacy id 兼容旧 commitment HMAC。凭据及内容使用 AES-256-GCM；AAD 绑定版本、用途、tenant 和资源 ID，artifact AAD 额外绑定分块编号和明文摘要。密文或 IV 被移动到另一租户、资源、用途或新格式 key id 时必须解密失败。

数据库不再为新任务保存可直接离线枚举的原始内容 SHA-256。节点仍返回原始摘要供当次执行校验，控制平面验证签名后，使用独立 HMAC-SHA256 承诺密钥将摘要绑定用途、tenant 和资源 ID，再只保存版本 2 承诺。旧记录标记版本 1；旧密文保持可读直到过期，迁移为只增加字段，不重写账本或证据历史。文件物理清除同时清空活动 manifest 摘要。

0000–0011 全迁移链必须通过真实临时 D1 自动化测试：测试先应用 0000–0003 并写入旧版推理、文件和文件任务，再应用 0004–0011，验证 21 张表、旧行保留、默认模式与版本/key-id 字段、cryptographic canary、独立 R2 删除墓碑、结算分录唯一索引、取消/预留字段及 6 小时执行期限字段正确。迁移会把无法安全继承新租约约束的旧 `reserved`/`running` 推理和 `claimed`/`running` artifact task 终止并释放预留，而不是让无上限的旧执行继续。生产冷启动还要逐列检查并补齐全部增量迁移；多个 Worker isolate 同时迁移时，失败方必须重新读取 schema，只有目标列已存在才能把竞争视为成功。只检查 SQL 文本不作为迁移成功证据。

### 接口与本地客户端防护

客户写接口要求平台身份和严格同源校验；JSON 响应 `no-store`，页面设置 CSP、禁止嵌入、MIME 嗅探、引用来源及不必要设备权限。D1 对推理、上传、任务、审核、注册和清除实施持久化租户限流与容量/并发配额；Agent 签名调用使用独立凭据作用域限流和一次性 nonce。

Supplier Agent 管理服务只监听 `127.0.0.1`，严格校验 Host 与 Origin。每个进程生成一次性 256 位启动秘密，只放在 URL fragment；fragment 不进入 HTTP 或 Referer，页面读取后立即清除浏览器历史，并通过同源 `POST /api/bootstrap` 一次性兑换 `HttpOnly; SameSite=Strict` Cookie。普通 GET 不创建会话。每次显示网关令牌都要重新验证本地口令，显示 60 秒后清空；口令解密限制串行并对连续失败实施短时封锁。Provider API Key 永不显示或提交平台。vault v2 使用完整规范化 profile 的摘要作为 AES-GCM AAD，配置被单独替换时解锁失败；旧 v1 vault 不做不安全的静默迁移。

## 后果与剩余边界

- 供应节点或 Provider 仍可在执行时看到明文。真正的执行方不可见需要平台管理的可信执行环境、远程证明、内存加密和可审计镜像，或客户自有节点。
- 自动到期由有界流量清理和 bearer-authenticated 独立计划任务共同触发，严格任务终态也会发起清理。维护结果除对象删除队列外，还暴露 `unclaimedExpiredArtifacts` 和 `pendingArtifactTombstones`，并分别对“过期后 24 小时仍未取得清除所有权”和“开始清除后 24 小时仍有未 tombstone generation”计数；任一 breach 都使计划监控失败。GitHub 托管计划任务不是合规级定时器；公开商业发布前仍应增加受监控的专用 scheduler、KMS/HSM envelope key、删除失败告警和可导出的清除证明。
- 节点签名证明 hardened Agent 观察到的模型、摘要和用量，不是 Provider 的独立签名。高保证档位仍需 Provider 官方回执或可信执行环境。
- 生产部署缺少任一密钥、密钥不是 32 字节或非迁移别名的分域重复时失败关闭。ADR 0008 已为 Gateway credential AES 和独立 lookup HMAC 增加版本化 keyring、持久 canary、引用退役门禁与有界迁移；旧单值 secret 只能作为 dual-read legacy alias，不能原地覆盖。`MARKETPLACE_CONTENT_KEY`、`MARKETPLACE_ARTIFACT_KEY` 与通用 `MARKETPLACE_COMMITMENT_KEY` 仍须保持稳定并单独备份，直到各自的 key-id 迁移完成。
