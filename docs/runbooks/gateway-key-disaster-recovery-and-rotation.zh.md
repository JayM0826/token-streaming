# Gateway 密钥灾备、再次轮换与回滚 Runbook

- 适用范围：`apps/web` 的 Gateway credential AES-256-GCM keyring 与 Agent credential-lookup HMAC-SHA256 keyring
- 责任方：`marketplace-web`（运行时）、`product-architecture`（架构与恢复约束）、生产值班人员（变更执行与证据留存）
- 最后更新：2026-08-28
- 关联决策：[ADR 0008](../adr/0008-gateway-credential-keyring-and-review-separation.zh.md)、[ADR 0009](../adr/0009-gateway-key-custody-slot-manifest-and-recovery.zh.md)

本 Runbook 不包含、生成、打印或保存任何真实 key material。所有密钥必须在独立 KMS/HSM 或等价的受控恢复系统中生成和托管；Sites 只保存运行时投递副本，仓库、工单、聊天、命令行参数、日志、临时文件和构建产物都不得成为密钥副本。

## 1. 先确认当前实现边界

| 能力 | 当前生产代码 | 执行含义 |
| --- | --- | --- |
| 整包 JSON credential/lookup keyring | 已实现 | `MARKETPLACE_CREDENTIAL_KEYRING` 和 `MARKETPLACE_CREDENTIAL_LOOKUP_KEYRING` 包含 active 及所有 previous key material |
| legacy 双读、v3 key id、CAS 重包、lookup 懒迁移 | 已实现 | 可以在已知全部旧材料时无停机轮换 |
| D1 canary | 已实现 | 能检测已经登记的同 ID 材料替换；不能恢复材料 |
| 缺失 canary 自动登记 | 已移除 | readable/active 缺失立即失败；只有 staged slot 可通过显式动作登记 |
| 独立 secret slot + 非秘密 manifest | 已实现，生产需显式启用 | 固定八个 write-only slot 可叠加旧 composite/alias，不需要回读旧 secret |
| 只读 cryptographic preflight | 已实现 | 独立 HMAC 预认证限流与 maintenance bearer；不 bootstrap schema、不写 D1 |
| manifest generation/回退门禁 | 已实现 | D1 保存已应用 generation/canonical hash；降代、同代异 hash 和移除 manifest 均失败关闭 |
| canary 显式登记 | 已实现 | 普通 maintenance 不再创建 canary；staged 登记要求 slot、非 active、零引用和 backup reference；全新零引用库另有 verifier 绑定的一次性兼容基线 |

代码兼容层已经落地，但在生产第一次启用 manifest 前仍须满足：

1. 不得覆盖一个没有独立恢复副本的整包 keyring secret。
2. 不得删除 `cryptographic_key_canaries` 行来“修复”不匹配。
3. 不得把 maintenance 成功等同于完整恢复演练；恢复演练使用只读 preflight，普通 maintenance 不登记缺失 canary。
4. 如果不知道现有整包 secret 的完整值，必须保持它原样；有实时引用时不要尝试重建或替换。
5. 当前生产已有旧 key canary 才能进入首次 manifest apply；新 staged key 必须先由独立 KMS/HSM 备份，再按第 6 节登记和切换。

## 2. 三种不同的“退役”

这三个动作不能合并审批，也不能用同一个“backlog 为零”结论代替：

### 2.1 运行时退役

含义：Worker 不再把旧 key 作为 readable material，但 Sites 中的旧 secret 仍保留，可通过更高 generation 的 manifest 重新引用。

必要条件：

- 旧 key 不是 active；
- 对该 key 的实时 D1 引用为零；
- credential legacy key 还必须满足 `legacyCredentialContentReferences === 0`；
- canary 有效；
- 新 active/readable key 已在所有新部署中可用；
- 已等待旧 Worker isolate 排空；
- 已完成只读 preflight；
- lookup key 的 dormant authorization 已迁移、撤销或超过最长 90 天有效期。

### 2.2 删除 Sites secret

含义：删除 Sites 中某个已经不被 manifest 引用的 slot secret 或旧整包 secret。独立 KMS/HSM 恢复副本仍必须保留。

必要条件：

- 已先完成运行时退役并经过观察窗口；
- 当前部署的环境 revision 与已批准 revision 一致；
- 回滚不再需要从 Sites 直接恢复该值，或已验证可以从 KMS/HSM 重新投递；
- 旧版本部署、preview 和仍可能接收请求的 isolate 都已排空；
- 删除动作由第二名审核人核对 key id、domain、slot 和 backup reference；
- 删除后再次部署并完成只读 preflight。

### 2.3 销毁最终恢复副本

含义：在 KMS/HSM/离线恢复库中销毁最后一份可恢复材料。此操作不可逆，应用的实时 D1 扫描无权证明它安全。

必要条件：

- 所有包含旧密文或旧 lookup digest 的 D1/R2/部署备份均已超过保留期或被验证不再含引用；
- 法务保留、事故快照、取证副本和灾备副本均已纳入盘点；
- 已从旧备份执行一次完整恢复演练并证明新恢复点不再需要旧 key；
- canary、非秘密 material verifier、backup reference 和销毁证据已归档；
- 至少双人审批；
- 销毁时间晚于“最后可能含旧引用的备份创建时间 + 最长备份保留期”。

实时 `credentialEncryptionRotationBacklog === 0` 或 `credentialLookupRotationBacklog === 0` 只能支持运行时退役，不能单独批准后两步。

## 3. Slot manifest 契约

### 3.1 环境变量

Credential encryption：

```text
MARKETPLACE_CREDENTIAL_KEYRING_MANIFEST
MARKETPLACE_CREDENTIAL_KEY_SLOT_01 ... MARKETPLACE_CREDENTIAL_KEY_SLOT_08
```

Credential lookup：

```text
MARKETPLACE_CREDENTIAL_LOOKUP_KEYRING_MANIFEST
MARKETPLACE_CREDENTIAL_LOOKUP_KEY_SLOT_01 ... MARKETPLACE_CREDENTIAL_LOOKUP_KEY_SLOT_08
```

Manifest 是非秘密 env var；每个 slot 必须标记为 secret。旧整包 secret 和 legacy alias 在迁移期间保持不变，Sites 环境更新只新增或更新本次列出的键，不能为了拼装新 ring 而读取或重写旧 secret。

### 3.2 严格 JSON 形状

以下仅是结构示例；`verifier` 不是 key material：

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

约束：

- 顶层只能有 `schema`、`generation`、`active`、`sources`、`keys`；key entry 只能有 `slot`、`state`、`verifier`。
- `generation` 是正整数且严格递增。同 generation 只允许完全相同的 canonical manifest hash；合法回滚也必须使用更高 generation。
- `slot` 只能是 `01` 至 `08`，不能重复；对应 secret 必须是 canonical padded base64 的 32 字节随机值。
- `state` 只能是 `staged` 或 `readable`。staged key 不得参与加密、解密、lookup digest 或 nonce namespace。
- `active` 必须指向 readable slot key 或仍启用的兼容来源，不能指向 staged key。
- `sources.composite` 控制旧整包 keyring；`sources.legacyAlias` 在 credential 域控制 `MARKETPLACE_CREDENTIAL_KEY`，在 lookup 域控制 `MARKETPLACE_COMMITMENT_KEY` 的 legacy lookup alias。
- slot、composite 与 alias 合计最多八把，包括 staged key。
- material verifier 为 `HMAC-SHA256(keyBytes, "gongsuanyun.key-custody.v1\n<domain>\n<keyId>")` 的 64 位小写十六进制结果。它可以保存在非秘密元数据中，但不能用于恢复 key。

### 3.3 合并和 active 规则

1. 解析 manifest 启用的 composite source。
2. 合并启用的 legacy alias。
3. 合并 slot keys，并校验 verifier。
4. 同一 key id、相同材料可以去重；同一 key id、不同材料失败关闭。
5. 不同 key id 使用相同材料失败关闭。
6. manifest 存在时只有 manifest 的 `active` 生效；manifest 不存在时保持 ADR 0008 的现有 composite/legacy 行为。
7. staged key 只可被显式 canary 登记流程访问，不能出现在普通 readable inventory 中。

## 4. 禁止 TOFU 的 canary 规则

普通 maintenance 和只读 preflight 都不得自动创建 canary。

- active/readable key 缺 canary：失败关闭并触发事故响应。
- staged、零引用 key 缺 canary：返回 `staging_required`，不写 D1。
- canary 只能通过独立、幂等的登记动作创建；登记必须同时校验 domain、key id、manifest generation、slot、material verifier、零实时引用和非 active 状态。
- 登记请求只携带非秘密 metadata 与 backup reference，不携带 key material。
- canary 和 `KEY_REGISTERED` 生命周期记录在同一 D1 batch 中持久化。
- 已登记或已退役的 key id 永不复用；canary 不因运行时退役而删除。
- D1 恢复后缺 canary 时必须恢复 canary/生命周期备份，不能用当前运行时材料重新登记。

当前代码已禁止自动 TOFU。任何 readable/active canary 缺失都会返回稳定的 `CRYPTO_CANARY_MISSING` 并停止 maintenance；必须调查 D1 恢复链，不能删除 canary 或把 key 临时改回 staged 来绕过。

唯一例外是尚未承载任何数据的全新数据库。0015 migration 或首次 runtime bootstrap 只有在完整持久业务/审计历史、canary、manifest state 和 lifecycle event 均为空时，才为两个域各建立一条 `migration-empty-history-v1` eligibility；缺行或已消费一律失败关闭。此时可调用 `POST /api/internal/cryptography/keys/baseline`，但必须同时满足：目标域没有 `cryptographic_keyring_states`、完整持久历史仍为空、没有 credential/lookup/legacy-content 引用、目标是当前配置中的 readable key、canary 缺失，并提交独立 KMS/HSM 目录中的 material verifier 与 backup reference。兼容源请求使用 baseline generation 1；带 manifest 的全新 slot-only 安装使用 manifest 当前 generation。Canary、`KEY_REGISTERED` 事件与 eligibility 的一次性消费在同一 D1 batch 中完成。任一域产生过引用、应用过 manifest、已有 canary 或 verifier 不匹配后，该入口永久不能用于补洞。D1 恢复缺 canary 仍必须恢复原记录；不得补建 eligibility。

## 5. 只读 cryptographic preflight

内部接口：

```text
POST /api/internal/cryptography/preflight
```

它使用 maintenance bearer，但预认证限流必须由 maintenance 专属 secret 对 edge 地址做 HMAC，不能调用 credential lookup keyring。接口必须满足：

- 不调用会写 schema 的 bootstrap；
- 不创建 canary；
- 不重包 credential；
- 不清理留存数据；
- 不占用 nonce；
- 不写 D1；
- 校验 manifest exact shape、generation、canonical hash、slot verifier、跨域材料重复和所有 readable canary；
- 按 key id 返回 credential、lookup、legacy content 实时引用数和最晚 authorization expiry；
- 只返回 `runtimeRetirementEligible`，不返回或推断 `safeToDestroy`；
- 错误和日志只含稳定错误码、domain、key id、generation 和 request id，不含 secret、密文或 token digest。

应用一个已经通过 preflight 的新 generation：

```text
POST /api/internal/cryptography/manifest/apply
Content-Type: application/json

{
  "domain": "credential-encryption",
  "generation": 17,
  "commandId": "crypto-apply-2026-09-01-01"
}
```

登记 staged key 的 canary：

```text
POST /api/internal/cryptography/keys/register
Content-Type: application/json

{
  "domain": "credential-encryption",
  "generation": 17,
  "commandId": "crypto-register-2026-09-01-01",
  "keyId": "credential-2026-09-01",
  "backupReference": "kms:production/credential-2026-09-01"
}
```

只在全新零引用数据库建立 configured-readable-key 初始基线：

```text
POST /api/internal/cryptography/keys/baseline
Content-Type: application/json

{
  "domain": "credential-encryption",
  "generation": 1,
  "commandId": "crypto-baseline-2026-09-01-01",
  "keyId": "legacy-credential-v2",
  "backupReference": "kms:production/legacy-credential-v2",
  "materialVerifier": "<64-lowercase-hex-verifier-from-recovery-catalog>"
}
```

四个接口都只接受 maintenance bearer。`manifest/apply`、`keys/register` 和 fresh-only `keys/baseline` 是写动作，会留下 `cryptographic_key_lifecycle_events`；只有 `preflight` 是 D1 零写入。Apply 之前 `readyForApply` 必须为 true；apply 后 `ready` 才能为 true。普通客户和 Agent 数据面要求 manifest 与已应用状态完全相同。

至少使用以下稳定内部状态：

```text
CRYPTO_CONFIG_INVALID
CRYPTO_CONFIG_ROLLBACK
CRYPTO_CANARY_MISSING
CRYPTO_CANARY_MISMATCH
CRYPTO_REFERENCED_KEY_MISSING
CRYPTO_KEYRING_CAPACITY_EXHAUSTED
```

定时 workflow 会先要求 preflight HTTP 200、`ready=true`、reader version 3、零非法引用和所有 readable canary valid，再执行 maintenance。Workflow 成功仍不替代独立 KMS/HSM 恢复演练。

## 6. 标准再次轮换流程

每一步都必须记录：操作者、审核者、UTC 时间、Sites environment revision、部署 ID、manifest generation/hash、domain、active key id、staged/readable key ids、KMS backup reference 和 preflight request ID。记录不得包含 secret。

### 阶段 A：准备与冻结

1. 宣布单写者变更窗口；记录当前 Sites environment revision 和当前部署使用的 env revision。
2. 确认 maintenance 连续成功，并保存以下非秘密字段：
   - `credentialActiveKeyId`
   - `credentialReadableKeyCount`
   - `credentialLookupActiveKeyId`
   - `credentialLookupReadableKeyCount`
   - `credentialEncryptionRotationBacklog`
   - `legacyCredentialContentReferences`
   - `credentialLookupRotationBacklog`
   - `cryptographicCanaries`
3. 确认当前 key 的独立恢复副本、canary 和备份目录均存在。任一缺失即停止。
4. 生成新 key id；不得复用历史 ID。
5. 让 KMS/HSM 生成新材料并建立独立恢复副本，输出非秘密 verifier 和 backup reference。不得先在本地生成再复制到多个系统。

### 阶段 B：staged

1. 在一个 Sites 环境更新中写入新的 slot secret 和 generation `N` 的 staged manifest；旧 composite、alias 和 slot secret 原样保留。
2. 部署一个保存的、支持 slot manifest 的版本，并核对部署实际使用的 environment revision。
3. 调用只读 preflight。预期结果：`readyForApply=true`、目标域为 `unapplied` 或 `forward`、旧 readable keys 全部 valid、新 key 为 `staging_required`，所有引用完整。
4. 调用 `manifest/apply` 应用 generation `N`；保存 command/request ID。此动作只登记控制状态，不创建 canary。
5. 再次运行 preflight，目标域必须为 `current`；随后通过 `keys/register` 登记新 staged key canary，并保存 backup reference 与 command/request ID。
6. 第三次运行只读 preflight；新 staged key 必须显示 canary 和 verifier valid，`ready=true`。

从新 environment revision 部署到 generation 成功 apply 之间，Gateway credential/Agent lookup 数据面和普通 maintenance 会故意失败关闭；只读 preflight 与 lifecycle 写接口仍可诊断和完成应用。该窗口必须由单写者执行并尽量短，不能把失败关闭临时绕过。

### 阶段 C：readable 预热

1. 使用 generation `N+1` 把新 key 改为 readable，但 active 仍是旧 key。
2. 部署并核对 env revision。
3. 运行 preflight，确认 `readyForApply=true` 且所有 readable key 有有效 canary；调用 `manifest/apply`，再确认 `ready=true`。
4. 等待旧 Worker isolate 排空；在此期间不得切换 active。

### 阶段 D：active 切换

1. 使用 generation `N+2` 将新 key 设为 active；所有 previous key 继续 readable。
2. 部署并核对 env revision、active key id 和 manifest hash。
3. 运行只读 preflight，调用 `manifest/apply`，再次确认 `ready=true`，然后运行正常 maintenance。
4. 验证新建 credential 使用格式 3 和新 key id；Agent lookup 使用格式 3 和新 lookup key id。验证过程不得读取真实 token 或密文。

### 阶段 E：排空

1. Credential AES 通过每轮最多四行的 CAS 重包排空。
2. Lookup HMAC 只能在持有原 token 的成功签名请求中懒迁移；无流量 authorization 必须等待过期、显式换 token 或撤销，不能离线伪造迁移。
3. 持续观察每个 previous key 的精确引用和最晚 `valid_until`，不能只看总 backlog。
4. 在任何旧 key 引用非零时，不得关闭对应 source 或移除 slot mapping。

### 阶段 F：运行时退役、Sites 删除与最终销毁

严格按第 2 节的三个独立审批依次执行，中间至少各完成一次部署、只读 preflight 和观察窗口。对 slot key，先从 manifest 移除 mapping 但保留 Sites slot secret；对 composite/legacy source，先把 source flag 设为 false 但保留 secret。这样回滚只需更高 generation 的 manifest，不需要回读 secret。

## 7. 整包 keyring 的兼容过渡

Manifest 缺失时运行时保持 ADR 0008 行为。首次采用 slot 前只有以下两种安全路径：

### 7.1 已有完整、经过恢复验证的整包副本

可以按 ADR 0008 重新构造“新 active + 所有被引用 previous keys”的完整 JSON secret，但仍须：

- 在独立 KMS/HSM 中生成和备份新 key；
- 先确认旧 key material 与现有 canary 一致；
- 一次性更新完整 ring，不得遗漏仍被 D1 或备份引用的 key；
- 更新后部署并运行 maintenance；
- 保留被替换前的完整 secret 版本及外部恢复副本。

### 7.2 无法取得现有整包值

- 不覆盖或删除现有 secret。
- 有实时引用时，停止轮换并优先实现 slot overlay；slot overlay 可以让运行时继续读取旧 composite，同时新增不依赖回读旧值的 active key。
- 没有实时引用也不能立即销毁旧材料；先核对所有备份保留期。
- 若 Sites 中最后一份材料和独立恢复副本同时丢失，而 D1/备份仍有引用，该数据不可通过 canary 恢复：停止相关授权和写入、保护 D1/R2 快照并进入安全事故流程。

## 8. 回滚

### 8.1 密钥 active 回滚

密钥回滚是一个新的前向配置变更：

1. previous key 必须仍为 readable、canary valid 且保有恢复副本。
2. 使用更高 manifest generation 把 previous key 重新设为 active；不得降低 generation 或恢复旧 manifest revision。
3. 新 key 继续 readable，因为切换期间可能已产生引用。
4. 部署、preflight、maintenance 后再调查新 key；不得复用 key id 或删除 canary。

### 8.2 代码版本回滚

任何已持久化 v3 credential 或 lookup digest 都要求部署版本理解格式 3 和持久 key id。先执行只读检查：

```sql
SELECT COUNT(*) AS credential_v3_rows
FROM authorization_requests
WHERE encrypted_gateway_token <> '' AND encryption_key_version = 3;

SELECT COUNT(*) AS lookup_v3_rows
FROM authorization_requests
WHERE gateway_token_digest IS NOT NULL AND gateway_token_digest_version = 3;
```

若任一结果非零：

- 禁止回滚到不支持 v3 的版本；本仓库中 `4065e6a` 及更早版本不支持 v3 reader。
- 只能发布仍支持 v1/v2/v3 和 key id 的修复版本，即 roll forward。
- 仅把 v3 实时行排空也不足以批准最终旧版本回滚，因为备份恢复后仍可能重新出现 v3 数据；最低 reader version 必须随备份保留窗口管理。

### 8.3 Sites environment revision 回滚

Sites secret 不可依赖回读。合法环境回滚必须通过保留的 slot secret、外部恢复副本和更高 generation manifest 完成，不能把 production env revision 指针直接倒退。当前 Sites 更新接口没有 expected-revision CAS，因此整个窗口只能有一个操作者；任何观察到的 revision 漂移都必须停止。

## 9. 灾备恢复演练

至少每季度以及每次 key family 变更后执行：

1. 选择隔离的恢复环境，不向真实 Gateway、Supplier Agent 或 Provider 发流量。
2. 恢复一个仍在保留期内的 D1 快照及对应 R2 备份/目录；记录快照时间。
3. 从独立恢复系统把候选 key 直接投递到隔离环境的 write-only slot，不能经过文件或聊天。
4. 校验 manifest verifier、历史 canary、key id、format version 和逐 key 引用。
5. 运行只读 preflight；不得用自动创建 canary 的 maintenance 代替。
6. 对合成的非客户 fixture 执行 v1/v2/v3 credential 解密、v2/v3 lookup 验证和 legacy content reader 检查。
7. 不调用真实上游，不输出 plaintext、token、ciphertext 或 key material。
8. 删除隔离运行时 secret、副本和临时恢复资源；保留不含秘密的结果、request IDs、时间和审核签名。
9. 更新每个 key 的 `lastRecoveryTestedAt`。未在规定周期内恢复验证的 key 不得运行时退役或删除 Sites 副本。

## 10. 变更后验收与停止条件

必须全部满足：

- 部署使用预期 environment revision；
- active key id、readable key ids/count 与批准清单一致；
- 所有 active/readable canary valid；
- manifest generation/hash 与变更记录一致；
- 没有 unknown key id、format/key-id 非法组合或跨域重复材料；
- credential、lookup 和 legacy content 引用与预期一致；
- retention maintenance 仍然成功，不能因 crypto 诊断失败而长期停止隐私清理；
- API/Worker 日志没有新增 5xx 或 key 配置错误；
- 日志、工单、构建产物和仓库 diff 不含任何 key material。

出现以下任一情况立即停止，不继续“试下一步”：

- canary missing/mismatch；
- manifest verifier mismatch；
- key id 或 slot 不在批准清单；
- Sites environment revision 意外变化；
- 仍有实时引用却计划关闭 source；
- 备份目录、保留期或 KMS recovery reference 不明确；
- 计划回滚版本不支持当前最低 crypto reader version；
- 任何人提出通过删除 canary、复用 key id、打印 env 或复制 secret 到临时文件来排障。

## 11. 非秘密变更记录模板

```text
changeId:
domain:
operator:
reviewer:
startedAtUtc:
completedAtUtc:
previousEnvironmentRevision:
newEnvironmentRevision:
previousManifestGeneration:
newManifestGeneration:
manifestSha256:
previousActiveKeyId:
newActiveKeyId:
readableKeyIds:
backupReference:
materialVerifier:
canaryStatus:
preflightRequestId:
maintenanceRequestId:
runtimeRetirementEligible:
sitesSecretDeletedAtUtc:
finalRecoveryCopyDestroyedAtUtc:
backupRetentionEvidence:
rollbackDecision:
```

`sitesSecretDeletedAtUtc` 和 `finalRecoveryCopyDestroyedAtUtc` 必须由不同审批阶段填写；未执行时保持空白，不能预填。
