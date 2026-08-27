# 定价、报价与结算方案

- 状态：Draft
- 日期：2026-08-24
- 适用范围：经授权的多 Provider、多模型容量市场；按 Provider/模型/能力/档位分别计价

## 1. 定价目标

定价同时满足四个目标：

1. 购买方比可比官方零售路径更低或至少更透明。
2. 供应方每个已完成任务有确定、可审计的收益。
3. 平台不会因“无限套餐”、汇率、长上下文、推理 token、退款或应用商店抽成而倒挂。
4. 价格变化不会影响已经接受的报价。

因此不卖“无限次”，不按模糊消息次数结算，也不把不可核验的个人订阅剩余次数直接折成 token。只有上游正式连接器能提供授权范围和可验证计量时，订阅容量才可规范化为平台用量单位。

## 2. 标准计量单位

内部账务不发明一个掩盖成本的虚拟 token。原始计量保持供应商语义：

```text
input_tokens
cached_input_tokens
cache_write_tokens
output_tokens          # 包含供应商计费口径下的 reasoning tokens
tool_units             # 搜索、容器等按调用/时间收费项目
context_band           # short / long
service_tier
compute_units          # 可选：GPU 秒、图片、音频、容器时间等
region
currency
```

前端可以显示“算力积分”作为预算单位，但每张账单必须能展开成上述实际用量、费率版本和金额。积分与法币保持固定兑付关系，不允许平台单方面稀释历史余额。

## 3. 费率卡

费率卡 `RateCard` 是不可变版本：

```text
rate_card_id
provider
model
service_tier
region
context_band
input_rate
cached_input_rate
cache_write_rate
output_rate
tool_rates
compute_unit_rates
currency
effective_from
effective_to
source_contract_version
```

任何公开零售价只能作为同 Provider、同模型、同档位、同地区的可比参考，不能替代供应项目的合同/账单成本。研发使用的本地 Codex Sol/xhigh/Fast 配置不是产品费率输入，也不能被写入客户报价。

禁止在代码中硬编码供应商价格。费率卡更新需要双人审批、签名和生效时间；旧报价继续引用旧版本。

每个 Provider Adapter 必须把其官方计量映射到上述规范化单位，同时在费率卡保留原始单位、舍入规则和来源凭证；不能为了统一展示而丢失上游账单语义。

## 4. 单次请求成本

对请求 `j`，上游成本为：

```text
C_upstream(j) =
    input_tokens      * input_rate
  + cached_tokens     * cached_rate
  + cache_write       * cache_write_rate
  + output_tokens     * output_rate
  + sum(tool_usage_k  * tool_rate_k)
  + sum(compute_usage_m * compute_rate_m)
  + regional_uplift
```

平台变量成本为：

```text
C_variable(j) = C_gateway + C_egress + C_storage + C_safety + C_support_alloc
```

对于供应市场，`C_upstream` 使用已接受的供应报价和最终用量计算；平台自有容量使用供应商账单费率。

## 5. 买方价格公式

设：

- `r_pay`：支付渠道费率。
- `r_risk`：退款、坏账、欺诈和账单修正准备率。
- `r_margin`：该套餐目标贡献毛利率。
- `C_fixed`：每请求固定成本。
- `P_min`：防止极小请求亏损的最低请求费。

报价税前价格：

```text
P_pre_tax = max(
  P_min,
  (C_upstream_estimate + C_variable_estimate + C_fixed)
  / (1 - r_pay - r_risk - r_margin)
)
```

最终价格按真实用量重新计算，但不能超过购买方已确认的 `authorized_max`。如果预测会超出上限，服务必须提前停止或请求二次授权。

税费、汇率和应用商店费用均作为显式报价组成项，不从供应方已确认收益中倒扣。

## 6. 建议会员方案

会员费覆盖固定产品成本；推理成本始终按量付费。以下是首轮 A/B 测试起点，不是永久价格承诺。

| 套餐 | 月费建议 | 目标贡献毛利 `r_margin` | 并发 | 主要能力 |
|---|---:|---:|---:|---|
| 按量 | ¥0 | 18% | 1 | API/TUI、严格预算、无 SLA |
| 个人 | ¥29 | 10% | 4 | 多端同步、预算提醒、较低平台费 |
| 专业 | ¥99 | 6% | 16 | API keys、项目预算、用量导出 |
| 团队 | ¥499/5 席 | 4% | 64 | RBAC、审计、成本中心、统一发票 |
| 企业 | 年度承诺 | 3%–8% | 合同 | SLA、SSO、地区/ZDR/EKM、专属供应池 |

规则：

- 套餐不绑定单一模型；每次报价明确模型、能力和档位。任何替代都要重新报价，不能靠静默降档制造“低价”。
- 不包含大额“免费 token”。获客赠送必须单独计入营销预算，并设置有效期和防欺诈条件。
- 会员费不可抵扣供应商不可退成本，避免退款时发生资金倒挂。
- 团队席位和并发是治理能力，不是共享一个终端用户身份。

## 7. 价格保护与“低成本”承诺

平台维护一个可比参考价格 `P_reference`，来源为官方公开价或有效企业合同价，并标记模型、档位、地区、长短上下文和税费。

市场报价只有满足以下条件才进入“节省型供应池”：

```text
P_buyer <= 0.90 * P_reference
```

也就是购买方至少获得 10% 的可比节省。若市场供应不能满足，调度器可以：

1. 使用平台自有的同模型、同档位授权容量；或
2. 返回“当前无满足价格和 SLA 的容量”。

不得把更慢、更低模型或不同地区的价格伪装成节省。任何替代都需要新报价和购买方明确同意。

为了给支付、风控和平台成本留出空间，供应报价准入可以先设置：

```text
supplier_landed_rate <= 0.75 * comparable_reference_rate
```

该阈值应根据真实转化、坏账和供应折扣每月复核，而不是长期写死。

## 8. 供应方收益

供应方发布一个有有效期的 ask rate。任务一旦被接受，供应方单价被冻结：

```text
SupplierGross = verified_usage * accepted_supplier_rate
SupplierPayable = SupplierGross - explicit_tax_withholding - confirmed_chargeback
```

平台不使用不透明“质量系数”克扣已正确完成的任务。可靠性影响未来调度权重和可售容量，不追溯改变已接受价格。

个人与企业使用同一已接受供应费率和回执公式。主体类型只影响 KYC/KYB、税务代扣、payout 渠道、准备金和结算周期，不得成为隐性压价系数。

建议结算：

- 已完成稳定观察期的供应方：T+7，可保留 5% 滚动准备金，不区分个人或企业。
- 新供应方/高风险：T+30，可保留最高 10%，完成三个稳定账期后下调。
- 账单回补：只能通过独立借/贷调整分录，不能修改历史订单金额。
- 争议窗口、证据和自动释放日期在供应协议中固定。
- 支付优惠、会员折扣、营销券由平台承担，不转嫁给供应方。

## 9. 报价与预授权

报价包含：

```text
quote_id
rate_card_id
supplier_offer_id or platform_pool_id
model / reasoning_effort / service_tier
region / data_class
estimated_input / max_output / tool_budget
estimated_price / authorized_max
tax / payment_channel_cost
expires_at
fallback_policy
```

建议报价有效期 60 秒。接受报价后：

1. 支付渠道预授权 `authorized_max`。
2. 原子预留供应 RPM/TPM/并发和预算。
3. 生成单用途 capability token。
4. 完成后按实际可信回执结算并释放差额。

长上下文、工具调用和超大输出必须在报价中单独提示。没有最终 token 数的估算响应不能自动进入已结算状态。

### 9.1 大文件异步任务

文件任务在创建时冻结已接受报价，并以购买方填写的 `max_total_tokens` 计算最高预留：

```text
artifact_authorized_max = ceil(max_total_tokens * accepted_rate / 1_000_000)
```

试运营期的 4 MiB 分块上传、48 小时加密 R2 保留和结果下载包含在 12% 平台费内，不另收模糊“文件处理费”。最终只按执行凭证中的实际聚合 token 结算，且不得超过预留；失败、模型替换、摘要不符、租约失效或证据签名不符均不扣款。活动文件任务的预留额会从可用余额扣除，普通推理不能占用这部分预算；终态释放差额。

超过 48 小时保留、二进制提取、OCR、沙箱代码执行、GPU 秒和大量结果下载不在当前报价内。将来启用时必须作为显式、版本化费率项展示预计量和上限，不能混入 token 单价静默收费。

## 10. 示例

假设某次请求：

- 已接受供应成本估算：¥0.20
- 平台变量成本：¥0.01
- 支付费率：2.5%
- 风险准备率：3%
- 个人套餐目标贡献毛利：10%

则：

```text
P_pre_tax = (0.20 + 0.01) / (1 - 0.025 - 0.03 - 0.10)
          = 0.2485...
```

报价可按货币最小单位向上取整到 ¥0.25。最终用量低于估算时按实际金额结算；高于估算但未超过授权上限时按实际结算；达到上限时停止生成。

这个示例只说明公式，不代表任何具体 Provider、模型或服务档位的真实价格。

## 11. 应用商店渠道

Apple 和 Google 对应用内数字服务/订阅有支付规则，且不同地区存在例外。移动渠道的 `r_pay` 必须使用该商店和地区的实际综合成本。

策略：

- 不通过隐藏 WebView、暗示性文案或远程配置绕过商店审核。
- 若应用内销售会员或推理额度，使用对应商店允许的支付能力并单独建渠道费率卡。
- Web、企业合同和应用商店的价格可以因渠道成本不同，但必须透明、符合当地规则并由法务复核。
- 移动端上线前做一次按地区的 store policy review；政策变化作为费率卡和发布门禁输入。

## 12. 资金与账本

推荐使用持牌支付服务商的 marketplace/split payout 产品：

```text
Buyer payment authorization
  -> licensed PSP custody
  -> platform fee / tax / reserve allocation
  -> supplier payable
  -> PSP payout
```

平台内部使用双重记账子账：

- buyer_cash / buyer_receivable
- supplier_payable
- platform_revenue
- provider_cost
- payment_fee
- tax_payable
- risk_reserve
- refund_liability

每个 transaction 借贷平衡。禁止用数据库余额字段直接加减来代替账本；余额是分录聚合结果。

买方“积分”默认不可提现、不可用户间转让；若需要可提现或转让，必须先完成支付/储值/反洗钱专项评估。

## 13. 反欺诈与对账

### 13.1 供应侧

- Provider request id 与平台 request/attempt 绑定并哈希保存。
- 供应代理对用量回执签名；平台验证序列、nonce 和时间窗。
- 定期导入供应商账单/usage report，按项目、模型、档位、日期对账。
- 重复 request id、异常 cached 比例、异常输出分布或供应节点时间漂移触发冻结。
- 用低价值 canary 请求验证模型、档位和输出一致性；不把 canary 内容用于监控购买方数据。

### 13.2 购买侧

- 注册、支付、API 调用和退款分别限流。
- 设备/账号/支付工具关联仅用于风控，遵循最小必要和保留期限。
- 新账号、小额高频、批量试卡、异常并发和循环退款触发阶梯式限制。
- 预算越权、租户间 key 使用和并发共享被拒绝并审计。

### 13.3 每日不变量

```text
sum(buyer_charges)
= sum(supplier_payables)
 + sum(platform_revenue)
 + sum(payment_fees)
 + sum(tax_payables)
 + sum(reserve_movements)
```

任何不平衡自动阻止结算批次并告警，不能由脚本“补平”。

## 14. 定价治理指标

每周看：

- 可比官方路径节省率 p50/p90。
- 平台贡献毛利率，不含会员费与含会员费两种口径。
- 报价接受率、供应命中率、无容量拒绝率。
- 上游账单与平台计量差异率。
- 退款、坏账、欺诈和争议率。
- 供应集中度、有效供应折扣和 TTFB/SLA。
- 按渠道、地区、套餐和租户的真实支付成本。

调整费率时保护已接受报价；任何阈值变化通过配置和审批发布，不直接改历史数据。

## 15. 上线前必须取得的数据

- 每个 Provider/模型/档位的合同输入、缓存、输出、长上下文、媒体、工具、计算时长和地区费率。
- 每个能力组合在真实目标任务上的用量分布、延迟、失败率和部分完成比例。
- 每个供应项目的 RPM、TPM、并发和 spend limit。
- PSP 在目标国家、币种、退款、拒付和供应方 payout 的完整费率。
- Apple/Google 对目标地区和产品形态的适用费用。
- 税费、汇率来源、结算周期和发票处理成本。
- 至少 30 天试运行的失败、部分流、重试和账单差异数据。

没有这些数据时可以做模拟报价，但不能发布“低于官方多少”或固定毛利承诺。

## 16. 参考资料

- [Responses API service tier and usage fields](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [OpenAI API pricing](https://platform.openai.com/pricing)
- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Google Play Payments policy](https://support.google.com/googleplay/android-developer/answer/9858738)
- [非银行支付机构监督管理条例](https://www.pbc.gov.cn/tiaofasi/144941/144953/5174993/index.html)
