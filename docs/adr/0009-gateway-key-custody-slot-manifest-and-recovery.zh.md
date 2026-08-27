# ADR 0009：Gateway 密钥托管、slot manifest 与恢复门禁

- 状态：Accepted
- 日期：2026-08-28
- 扩展：[ADR 0008](0008-gateway-credential-keyring-and-review-separation.zh.md)
- 运维流程：[Gateway 密钥灾备、再次轮换与回滚 Runbook](../runbooks/gateway-key-disaster-recovery-and-rotation.zh.md)

> 本 ADR 已由 TypeScript 运行时、D1 migration 0013、内部生命周期接口和定时预检契约实现。生产仍可在 manifest 缺失时继续读取 ADR 0008 的整包 JSON keyring；“代码已支持”不代表 slot secret 已完成独立 KMS/HSM 备份或生产 manifest 已启用。

## 背景

ADR 0008 为 Gateway credential AES 与独立 Agent lookup HMAC 增加了 key id、双读、CAS/懒迁移、D1 引用门禁和持久 canary，解决了直接替换单值 secret 会立即失读的问题。然而 Sites 对 secret 只提供 write-only 更新语义，读取环境清单时不返回 secret 明文。当前 keyring 又把 active 与全部 previous key material 放在一个 JSON secret 中，因此下一次轮换若没有独立完整副本，就无法在保留旧材料的同时追加新 key。

现有 canary 只能验证候选材料，不能恢复材料；缺失 canary 时 maintenance 会用当前材料首次登记。该 trust-on-first-use 行为在正常首次部署可建立基线，但在 D1 恢复、canary 丢失或错误 slot 场景中不能证明材料来自已批准的恢复副本。完整检查又与会清理留存并重包 credential 的 maintenance 共用，无法安全执行只读恢复演练。

实时 D1 引用归零也不等于可以销毁 key。D1/R2、事故快照或旧部署备份可能仍包含旧密文和 lookup digest；如果最终恢复副本过早销毁，历史恢复点永久不可读。

## 决策

### 1. 每把 key 使用独立 write-only slot

新增非秘密 manifest 和固定八个 secret slot：

```text
MARKETPLACE_CREDENTIAL_KEYRING_MANIFEST
MARKETPLACE_CREDENTIAL_KEY_SLOT_01 ... MARKETPLACE_CREDENTIAL_KEY_SLOT_08

MARKETPLACE_CREDENTIAL_LOOKUP_KEYRING_MANIFEST
MARKETPLACE_CREDENTIAL_LOOKUP_KEY_SLOT_01 ... MARKETPLACE_CREDENTIAL_LOOKUP_KEY_SLOT_08
```

旧 `MARKETPLACE_CREDENTIAL_KEYRING`、`MARKETPLACE_CREDENTIAL_LOOKUP_KEYRING`、`MARKETPLACE_CREDENTIAL_KEY` 和 lookup legacy commitment alias 仍可作为迁移来源，但 manifest 可以在不读取或覆盖这些 secret 的情况下新增 slot key。所有 secret slot 必须由独立 KMS/HSM 生成和备份，仓库只维护非秘密契约。

### 2. Manifest 是严格、单调、非秘密的控制平面

```json
{
  "schema": "gongsuanyun.keyring-manifest.v1",
  "generation": 17,
  "active": "legacy-credential-v2",
  "sources": {
    "composite": true,
    "legacyAlias": true
  },
  "keys": {
    "credential-2026-09-01": {
      "slot": "01",
      "state": "staged",
      "verifier": "<64-lowercase-hex-verifier>"
    }
  }
}
```

解析器拒绝额外字段、非法 key id、重复 slot、缺少 secret、非 canonical 32-byte base64、非法状态、active staged key、同 ID 异材料、异 ID 同材料及合并后超过八把。Manifest generation 只能递增；同 generation 不同 canonical hash 失败。回滚是一个更高 generation 的前向变更，不能恢复旧 generation。

`staged` key 只参与配置和 canary 登记，不参与普通 encrypt/decrypt/lookup/nonce。`readable` key 才能进入读取命名空间；active 必须 readable。Manifest 不存在时保持 ADR 0008 的现有行为，以支持先部署兼容 reader。

Material verifier 定义为：

```text
HMAC-SHA256(keyBytes, "gongsuanyun.key-custody.v1\n<domain>\n<keyId>")
```

它只用于判断 KMS 记录、slot 和 key id 是否一致，不是恢复材料，也不能替代 canary。

### 3. Canary 从自动 TOFU 改为显式登记

普通 maintenance、customer path 和只读 preflight 不再创建 canary。

- active/readable key 缺 canary 一律失败关闭。
- staged key 缺 canary 只报告 `staging_required`。
- 只有单独的幂等内部动作可以登记 staged、非 active、零引用 key。
- 登记同时校验 manifest generation、slot verifier、key id 未复用和非秘密 backup reference，并把 canary 与 append-only `KEY_REGISTERED` 生命周期事件写入同一 D1 batch。
- 全新且零引用的数据库有一个严格的一次性基线路径：0015 migration/runtime bootstrap 仅在完整持久业务历史与所有 crypto lifecycle 状态均为空时，为每个域写入 fail-closed eligibility。仅当该资格仍存在且未消费、目标域从未应用 manifest、完整持久历史仍为空、没有任何 credential/lookup/legacy-content 引用、目标是当前配置中的 readable key、canary 缺失且外部恢复记录提供的 material verifier 精确匹配时，独立内部动作才可把首个 canary、`KEY_REGISTERED` 事件和资格消费写入同一 batch。它既支持兼容源，也支持全新的 slot-only 安装，但不能用于 D1 恢复、已有引用或 canary 丢失后的“修复”。
- 历史 canary 永不因运行时退役而删除；D1 恢复丢失 canary 时恢复原记录，不重新祝福当前材料。

### 4. 增加完全只读的 cryptographic preflight

新增 maintenance-bearer-authenticated 的内部 preflight。认证和预认证限流不依赖 credential lookup keyring，使 lookup 配置损坏时仍能获得经过认证的安全诊断。Preflight 仅以 `sqlite_master` 只读探测升级前尚不存在的 keyring state/bootstrap 表，把缺表解释为 unavailable/null persisted state，不触发 schema bootstrap 或任何写入。

Preflight 不 bootstrap schema、不写 D1、不登记 canary、不重包、不清理、不占 nonce。它校验 manifest、generation/hash、verifier、跨域唯一性、canary、非法持久格式和逐 key 实时引用，并返回 `runtimeRetirementEligible`。它不得声称某 key 可以最终销毁，因为备份目录不属于应用数据面。

### 5. 密钥生命周期分为三个不可合并的门禁

1. **运行时退役**：实时引用为零、canary/preflight 有效、旧 isolate 排空后，manifest 不再把 key 设为 readable；secret 暂留。
2. **Sites secret 删除**：运行时退役经过观察窗口且从独立恢复系统重新投递演练成功后，删除 Sites 副本；KMS/HSM 副本保留。
3. **最终恢复副本销毁**：所有可能含旧引用的备份超过保留期、恢复演练成功并经双人审批后，才可销毁最后副本。

Live backlog 为零只支持第一步。备份保留期、法务保留和事故快照必须参与第三步判断。

### 6. v3 reader 形成不可向后兼容的恢复边界

一旦 D1 或仍在保留期的备份含有 credential/digest format 3，部署版本必须支持 v1/v2/v3 和持久 key id。回滚到只支持 v1/v2 的版本不受支持；应发布兼容 reader 的修复版本。最低 crypto reader version 的保留时间至少覆盖最老可恢复备份。

## 发布与迁移顺序

1. 实现 slot/manifest parser、严格合并、staged/readable 状态、material verifier 和兼容旧 composite reader；manifest 缺失时行为不变。
2. 增加 append-only key lifecycle metadata、显式 canary 登记、只读 preflight、逐 key 引用和 generation/hash 门禁。
3. 添加恢复、并发、未知 key、canary 缺失/替换、Sites secret 不可回读及 v1/v2/v3 真实 crypto 测试。
4. 对真正全新的零引用数据库，先用独立恢复记录的 verifier 显式建立 configured-readable-key 基线；已有生产 canary 不执行此步。随后部署 reader，再在新 slot 中加入 staged key并登记 canary。
5. 单独部署 readable 预热阶段并等待旧 isolate 排空，再用更高 generation 切 active。
6. 按 Runbook 排空并依次执行运行时退役、Sites 删除和最终恢复副本销毁。

## 实现落点

- 严格 parser、slot 合并、staged/readable 隔离和 material verifier：`apps/web/server/keyring.ts`
- 运行时 verifier、跨域材料隔离和已应用 manifest 门禁：`apps/web/server/security.ts`
- 只读预检：`POST /api/internal/cryptography/preflight`
- 单调应用 manifest：`POST /api/internal/cryptography/manifest/apply`
- 登记 staged canary：`POST /api/internal/cryptography/keys/register`
- 仅为全新零引用数据库建立 configured-readable-key 初始基线：`POST /api/internal/cryptography/keys/baseline`
- D1 单调状态与追加式生命周期事件：`cryptographic_keyring_states`、`cryptographic_key_lifecycle_events`，由 migration 0013 建立；一次性 fresh-bootstrap eligibility 与全局 lifecycle command 唯一性由 0015 建立
- 普通 maintenance 只验证 canary，不再创建；定时 workflow 必须先通过只读 preflight 才能执行清理

数据面每次解析 slot ring 都验证 material verifier，并要求运行时 manifest 的 generation/hash 与 D1 已应用状态完全一致。已存在 D1 状态时移除 manifest 也属于回退并失败关闭。Manifest apply、staged register 与 fresh-database baseline 使用不同的 maintenance-authenticated 动作；command ID 在两个域及三类动作之间全局唯一，同一 command 的精确重放返回原结果，同 command 绑定不同事件、verifier 或 backup reference 以稳定 409 失败且不得留下首个副作用。

## 后果

- 下一次轮换不再要求读取或重写旧整包 secret。
- slot secret 可以先逻辑退役、保留回滚能力，再物理删除。
- 错误首次材料不能通过自动创建 canary 被静默接受。
- 恢复检查与客户数据清理/重包分离。
- 配置需要更多环境变量、部署阶段和审计记录；这是换取可恢复性、单调回滚和更小爆炸半径的有意成本。
- 独立 KMS/HSM、备份目录和双人审批仍是外部运维依赖；slot 与 canary 本身不构成灾备。

## 非目标

- 本 ADR 不把 key material 写入 D1、Git、日志、提示词或构建产物。
- 本 ADR 不为 content、artifact 或通用 commitment 单值 key 自动提供轮换；它们需要独立的 key-id/envelope 设计。
- 本 ADR 不允许通过公开 API 导出、包装或恢复 key material。
- 本 ADR 不把 Sites 当作唯一恢复系统。
