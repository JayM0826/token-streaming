# ADR 0007：跨工作负载原子预留、两阶段取消与独立留存清理

- 状态：Accepted
- 日期：2026-08-27

## 背景

实时推理与大文件任务原先分别读取余额、容量和并发后再写入，两个并发请求可能同时通过旧快照；结算也可能在取消、租约过期或另一笔预留改变余额后继续落账。R2 分块先写对象再写 D1，会在并发、清除或失败补偿时留下元数据与密文不一致。仅靠业务流量触发过期清理也无法覆盖低流量时段。

## 决策

1. 实时推理和大文件任务共享一个可用余额定义：追加账本余额减去两类活动预留。创建通过单条条件写入同时校验余额、授权、报价、并发和租户配额；幂等键必须绑定完整请求承诺。
2. 完成操作必须在条件更新中再次验证未过期租约/预留、artifact 最终 checkpoint 快照、实际费用不超过预留、取消未开始及跨工作负载余额。状态更新、不可变执行证据、用量与平衡账本分录放入同一 D1 batch，只有状态条件命中时后续写入才可发生。`ledger_entries(job_id, entry_type)` 对三类结算 effect 具有唯一索引，重放使用幂等插入，避免同一任务重复扣款、入账或收取平台费。
3. 买方取消采用领域层两阶段规则。`queued` 立即变为 `cancelled` 并释放预留；`claimed`/`running` 对外显示 `cancelling`，保留租约与预留，worker 下次交互、租约到期或绝对执行期限到达后进入终态。平台先原子绑定 `(tenant, artifact-task.cancel, commandId)` 到唯一 task，再取得该 task 的唯一操作标记；同一命令指向其他 task 必须冲突，竞争失败者不能修改第二个 task，也不写重复审计。
4. 浏览器/控制平面的 `gongsuanyun.artifact.v1` 保持版本号不变；`cancelling` 是由持久化 `claimed`/`running` 加取消标记投影出的新增非终态。v1 客户端必须把 `cancelling` 及未来未知的非终态值按“仍在处理、预留仍持有”展示并继续轮询，不能误判为 `cancelled` 或释放余额；对旧状态枚举做穷举的客户端须先升级。Supplier Agent 的破坏性变更已使用 `gongsuanyun.artifact-worker.v2`，v1 worker 不再领取新任务，服务端不做含糊降级。
5. 分块先以唯一不可变 R2 key 在 D1 取得 `pending` 所有权并登记独立删除墓碑，再写 R2，最后切换为 `ready` 并撤销该墓碑。artifact 清除在触碰 R2 前，以同一个 D1 batch 把每个 `storage_key` 写入 `artifact_object_deletions`，并把由 `(artifact_id, tenant_id, part_number, storage_key, uploaded_at)` 精确标识的不可变 generation 从 `pending`/`ready` 标为 `deleting`；持久重试队列因此不会被遗留的 `ready` 行永久过滤。清理转换保持小批次有界：每次 invocation 最多选择一个 artifact、推进四个 generation，删除队列每轮最多处理四个 key；64-generation 上限文件可由最多 16 次调用续跑。这是续跑和单步影响边界，不是更低 D1 查询上限的兼容承诺；完整 maintenance 还执行 schema bootstrap，生产部署硬性要求 Workers Paid 的每 invocation 1,000 query 配额。购买方显式清除只要仍有 generation metadata 或 R2 删除未确认就返回可重试 503，只有所有 generation metadata 已删除才把 artifact 标为 `deleted`。确认删除后才精确移除该 generation 的 metadata；墓碑仍保留 24 小时、每 10 分钟重复删除，保留期结束且再次成功后才移除。`deleting` 行与独立墓碑共同覆盖上传代竞争、对象存储失败及 metadata 已删后的重复删除，迟到上传不能复活已清除内容。
6. 每个 artifact task attempt 在领取时写入 6 小时绝对 `execution_deadline_at`。5 分钟租约可以由单调 checkpoint 续期，但新的租约到期时间取正常续期与绝对期限的较早值；checkpoint、失败和完成 SQL 均使用数据库时钟拒绝越界写入。短租约过期允许同一 worker 从有效本地 checkpoint 续跑；`resume_from_segment > 0` 却不存在任务身份、认证包络及已完成段数完全匹配的 checkpoint 时，Agent 在下载输入或 Provider 调用前以不可重试的 `ARTIFACT_CHECKPOINT_REQUIRED` 终止。绝对期限耗尽后的重试会清除 worker 绑定并从第 0 段开始，Agent 收到 `resume_from_segment = 0` 时先删除旧 checkpoint，再建立新的固定六小时本地期限。平台已接受终态完成后若 Agent 无法删除本地 checkpoint，它返回 `CHECKPOINT_CLEANUP_FAILED` 而不再发送矛盾的任务失败，并在当前进程记录待删除 task；所有其他不可重试终态也通过同一路径删除 checkpoint，失败时同样加入待删除集合。所有后续 claim 前都先重试，成功前不领取新任务。该集合不跨重启持久化，但 checkpoint 中经过认证且不顺延的到期时间继续把可恢复有效期限制为最多六小时；到期后的 claim 前清扫若仍无法物理删除则继续阻止领取。空 checkpoint 不能无限占用买方预留和报价并发。
7. 过期清理由平台流量与 bearer-authenticated 维护端点共同驱动。GitHub Actions 每 10 分钟请求一次维护端点并重试；端点同时释放陈旧推理预留、清除过期输出和凭据、删除过期 nonce/限流/worker 心跳，并执行有界 artifact sweep。它先验证全部 256 位生产密钥分域、Gateway credential/lookup keyring、持久 canary 及仍被 D1 引用的 key id，再进行清理和最多四条 credential CAS 重包；除了 rotation backlog 和 R2 删除墓碑超过 24 小时重试期限，维护结果还报告 `unclaimedExpiredArtifacts` 与 `pendingArtifactTombstones`，分别监控过期后 24 小时仍未取得清除所有权、以及开始清除后 24 小时仍未完成 generation tombstone 的 breach。任一 retention breach 都使计划监控失败。计划任务可能延迟，因此该频率是运行目标而不是硬删除 SLA。
8. `artifact_tasks.content_purged_at` 可能只表示 24 小时输出已到期清空；task 完整清除必须同时证明该标记存在、指令和输出字段为空、关联 artifact 已 `deleted` 且有清除时间、并且不存在任何 generation。接口与 UI 不能因该复用标记而隐藏仍处于 48 小时输入窗口的主动清除入口。完整状态之后的任意 artifact/artifact-task 显式重试都会以稳定 action/resource audit ID 幂等补齐缺失完成审计，并按 tenant/action/resource 抑制重复事件。
9. Marketplace 事件持久化真实 `schema_version`；供应凭据查找使用独立 HMAC 承诺，校验有效期并兼容懒升级旧摘要；网关调用禁止 HTTP redirect，防止允许的公网地址跳转到私网。ADR 0008 进一步把 Gateway lookup 从长期 commitment 生命周期拆为有界 keyring，并让 nonce claim 覆盖所有可读摘要命名空间。
10. D1 的权威升级链现为 0000–0015，共 24 张表。0008 增加独立 R2 删除墓碑，0009 增加每任务/结算 effect 唯一索引，0010 增加绝对执行期限并把无法安全继承该约束的旧活动 artifact task 终止为 `EXECUTION_MIGRATED`；0011 增加 Gateway credential/lookup key id、查询索引和持久 cryptographic canary；0012 增加 authorization revision、撤销/换发元数据和两类任务的授权快照；0013 增加密码配置单调状态与追加生命周期事件；0014 为按授权清理推理/文件任务增加索引；0015 增加一次性 fresh-bootstrap provenance 并把 lifecycle command 升级为跨域/跨操作全局唯一。真实临时 D1 测试必须覆盖完整迁移链和旧行升级，不能只检查 SQL 文本；runtime bootstrap 还必须事务升级旧三状态 authorization CHECK。

## 后果

- 并发创建和完成不再依赖应用层 read-then-write 判断；跨实时/异步负载不能重复花费同一余额或容量。
- 活动任务取消可能短暂显示 `cancelling`，这是为避免提前释放资金后仍产生可结算工作。严格模式文件会安排清除，标准模式文件保留到其既定到期时间。
- 对象删除失败会留下可查询的 `deleting` 行或独立墓碑；队列登记与精确 generation 的 `deleting` 转换属于同一 D1 batch，因此重试不会被遗留 `ready` 状态永久屏蔽。即使 chunk metadata 已删除，墓碑仍会在 24 小时窗口内重复发出幂等删除，而不是留下不可发现的孤儿对象。
- 有界清除可能向显式请求返回多次可重试 503；这是安全的续跑信号，不代表对象已经全部删除。`deleted` 状态和完整清除审计只在 generation metadata 清零后出现。
- 即使状态转换已成功而先前审计写入中断，后续显式重试仍能补齐 artifact 与 artifact-task 完整清除审计；补写是幂等效果，不会制造重复审计。
- 任何单次 artifact task attempt 最多占用 6 小时，租约续期只提供故障恢复活性，不再构成无限续租能力。
- GitHub 托管计划任务不是合规级定时器。商业发布若需要可证明的删除时限，仍需迁移到受监控的专用 scheduler，增加删除失败告警、清除收据以及 KMS/HSM envelope key 生命周期管理。
