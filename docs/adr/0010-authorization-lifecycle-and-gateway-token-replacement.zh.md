# ADR 0010：单条授权生命周期与 Gateway token 替换

- 状态：Accepted
- 日期：2026-08-28

## 背景

供应方原先只能提交授权，管理员只能批准或拒绝。已经提交的 pending 申请不能自助撤回，active 授权也不能在 token 泄露、Provider 收回授权或网关退役时立即撤销。ADR 0008 的 keyring 重包只更换平台 AES/HMAC key，不会替换供应节点实际接受的 bearer token，因此不能作为 token 换发机制。

授权同时参与同步推理 reserve、文件任务 reserve/claim、Agent heartbeat、报价可见性和供应开关。若只修改一个展示状态，旧请求仍可能在读后写竞态中取得任务；若直接删除历史行，又会破坏追加审计、幂等重放和结算取证。

## 决策

### 版本化状态转换

`authorization_requests` 增加单调 `authorization_revision`、`credential_rotated_at`、`revoked_at` 和结构化 `revocation_reason_code`。允许的供应方转换为：

```text
pending  --withdraw--> withdrawn
approved --revoke----> revoked
approved --rotate token--> approved (revision + 1)
```

`withdrawn` 和 `revoked` 都是终态，不得重新批准或恢复凭据。自然过期仍以 `approved + valid_until <= now` 持久化，并向 API 投影为 `expired`；维护任务继续擦除过期凭据。历史 runtime bootstrap 的旧 status CHECK 在启动时通过事务式表重建升级，避免新状态在旧库上失败。

每次转换必须清空或替换密文、IV 和 lookup digest，并使用当前 status、revision、supplier version 以及精确旧密文 generation 的写侧 CAS。`commandId` 同时绑定供应方 tenant、操作和规范化 payload；全局 target claim 以 `requestId:revision` 串行化管理员审核、撤回、撤销和 token 替换。只有写入当前 command binding 的赢家或同一命令重放可以返回成功。

### 立即且面向未来的撤销

撤销在提交后立即阻止新 reserve、claim 和 heartbeat，不因存在在途任务而拒绝撤销：

- 尚未启动的同步推理 reservation 原子失败并释放余额；已经 running 的调用允许完成既有结算，不产生新的 reservation。
- queued 文件任务原子失败并释放 reservation。
- claimed/running 文件任务进入两阶段取消，清除可重放 instruction，保持 reservation，直到节点观察取消或 lease/deadline 到期。最终 `error_code` 从 `AUTHORIZATION_REVOKED_PENDING` 变为 `AUTHORIZATION_REVOKED`，不得误写为购买方取消。
- 删除该供应 tenant 的 Agent heartbeat。若没有其他当前有效授权，关闭 `supply_enabled`；数据库报价历史不删除，但 API 投影为暂停，所有写侧调度门禁继续拒绝。

这些 effect 与授权状态、supplier aggregate version、`supplier.provider-authorization-revoked` 事件和非秘密 audit 在同一个 D1 batch 中受成功状态与 command binding 保护。事件和审计只追加，不修改历史。

### Gateway token 替换

换发由供应方提交一枚新的高熵 token；平台不读取、重发或返回旧 token。只有当前有效的 approved 授权可以换发，新 token 必须不同于当前 token，并先对原网关完成与批准相同的签名 inventory attestation。提交时原子写入新密文、lookup digest/key id、加密 key id并递增 revision，失败并释放仍绑定旧 revision 的同步推理 reservation（稳定记录 `GATEWAY_CREDENTIAL_ROTATED`），随后删除旧 heartbeat。

换发 target claim 和最终 UPDATE 都重复校验精确旧密文 generation、新 token 的跨 tenant/supplier 唯一性以及每 token 最多 100 条当前有效授权的上限，因此失败的 lookup/cap CAS 不会留下孤儿 claim。旧 token 已经鉴权但尚未最终 claim 的请求会因 revision 或 heartbeat 变化失败；新 token 可以领取换发前已经合法排队、仍绑定同一 authorization request 的文件任务。

同步推理在换发提交前只完成 reserve、尚未原子进入 running 的请求会在轮换 batch 中失败并释放余额；已经进入 running 的请求视为在途调用，可以使用该请求内存中的旧 credential generation 完成。供应方若已同时使旧 token 失效，网关调用会失败且不结算。换发提交后的新 reserve 只会选择新 revision 和新密文。若未来产品要求“换发提交点后零次旧 token 调用”，必须引入跨网络调用的 drain/epoch 协议，不能仅靠一次 D1 重读声称消除了最后一个调用窗口。

### 调度与隔离

推理和文件 reserve 记录 authorization request/revision 快照。写侧 EXISTS 必须同时校验 offer、authorization、provider、supplier tenant、buyer 与 supplier 不同、有效期、供应状态和精确当前 revision。文件任务最终 claim 再校验当前 Agent identity 的 request/revision、offer 关联和未过期 heartbeat。撤销清理使用 `authorization_request_id + status` 索引，避免安全转换在大表上全表扫描。

客户路由不接受 tenant 或 supplier id；服务端身份决定所有范围。跨 tenant/supplier 的授权查询统一返回 `NOT_FOUND`，状态/CAS 冲突使用 `AUTHORIZATION_STATE_CONFLICT`，token 重用、同 token 或换发 CAS 冲突使用 `GATEWAY_CREDENTIAL_CONFLICT`。

## 后果

- 供应方现在可以撤回 pending、撤销 active，并以新 secret 替换节点 token；任何响应、事件、审计、日志和浏览器投影都不包含 token。
- nonce 历史保持至原有 TTL，不因撤销或换发删除；旧 lookup 命名空间仍由 Agent 防重放逻辑覆盖。
- 取消中的 leased 文件任务会暂时占用余额，这是避免撤销与合法完成双花的有意选择。
- keyring 托管、slot manifest、账户隐私生命周期和密钥销毁不在本 ADR 范围，分别继续由 ADR 0008/0009 及后续隐私设计处理。

## 验证

测试必须覆盖撤回/撤销的凭据擦除、同命令重放与不同 payload 冲突、跨 tenant/supplier 拒绝、并发 revision/CAS、token 跨主体重用与 101 条上限、heartbeat 删除、最后/非最后授权的供应开关、撤销与换发各自的 reserved/queued/leased/running 分流、换发时旧 revision reservation 失败而 running 不受影响、撤销/换发与报价 INSERT 的竞争、旧 revision reserve/claim 失败、新 token 接续旧 queued task，以及 0012–0015 migration 与旧 runtime status CHECK 升级。
