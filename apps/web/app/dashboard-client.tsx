"use client";

import type {
  AuthorizationRequestView,
  CapacityOfferView,
  MarketplaceApiErrorBody,
  MarketplaceDashboardSnapshot,
  PurgeMarketplaceContentResponse,
  PurgeableMarketplaceResource,
  RunInferenceResponse
} from "@token-streaming/protocol";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { ArtifactTaskPanel } from "./artifact-task-panel";

type ViewName = "总览" | "购买算力" | "供给管理" | "账本" | "隐私中心" | "审核";
type ModalName = "supplier" | "authorization" | "offer" | "rotate-credential" | null;

const baseNavigation: Array<{ label: ViewName; glyph: string }> = [
  { label: "总览", glyph: "⌂" },
  { label: "购买算力", glyph: "◎" },
  { label: "供给管理", glyph: "↗" },
  { label: "账本", glyph: "¥" },
  { label: "隐私中心", glyph: "◇" }
];

export function DashboardClient({ initialSnapshot }: { initialSnapshot: MarketplaceDashboardSnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [activeView, setActiveView] = useState<ViewName>("总览");
  const [modal, setModal] = useState<ModalName>(null);
  const [credentialTarget, setCredentialTarget] = useState<AuthorizationRequestView | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("已连接生产数据 · 所有写入持久保存");
  const [inferenceResult, setInferenceResult] = useState<RunInferenceResponse | null>(null);

  const navigation = snapshot.user.isAdmin
    ? [...baseNavigation, { label: "审核" as const, glyph: "◇" }]
    : baseNavigation;
  const activeOffers = snapshot.offers.filter((offer) => offer.status === "active").length;
  const approvedAuthorizations = snapshot.authorizationRequests.filter((item) => item.status === "approved");
  const firstName = snapshot.user.displayName.split(/[@\s]/)[0] || "朋友";

  async function mutate(path: string, method: "POST" | "PUT", body: unknown, success: string) {
    setBusy(true);
    try {
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const result = (await response.json()) as MarketplaceDashboardSnapshot | MarketplaceApiErrorBody;
      if (!response.ok || "ok" in result) throw new Error(readApiError(result));
      setSnapshot(result);
      setModal(null);
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  async function toggleSupply() {
    if (!snapshot.supplier) return;
    await mutate(
      "/api/v1/supply",
      "PUT",
      { commandId: crypto.randomUUID(), enabled: !snapshot.supplier.supplyEnabled },
      snapshot.supplier.supplyEnabled ? "新任务供应已暂停" : "供应已开启，符合策略的任务可以进入调度"
    );
  }

  async function revokeAuthorization(item: AuthorizationRequestView) {
    const action = item.status === "pending" ? "撤回" : "撤销";
    if (!window.confirm(`${action} ${item.providerId} / ${item.modelPattern} 的授权？该操作会立即阻止新任务。`)) return;
    await mutate(
      `/api/v1/authorizations/${encodeURIComponent(item.requestId)}/revoke`,
      "POST",
      { commandId: crypto.randomUUID(), reasonCode: "supplier-requested" },
      item.status === "pending" ? "待审核授权已撤回，网关凭据已清除" : "授权已撤销，新任务已阻断，网关凭据与心跳已清除"
    );
  }

  async function purgeContent(resourceType: PurgeableMarketplaceResource, resourceId: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/v1/privacy/purge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceType, resourceId })
      });
      const result = await response.json() as PurgeMarketplaceContentResponse | MarketplaceApiErrorBody;
      if (!response.ok || !result.ok) throw new Error(readApiError(result));
      if (resourceType === "inference-job") setInferenceResult(null);
      await refreshSnapshot(setSnapshot);
      setNotice("可重放内容已清除；结算凭证和追加账本按审计要求保留");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "内容清除失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand sidebar-brand" onClick={() => setActiveView("总览")}>
          <span className="brand-mark"><i /><i /><i /></span>
          <span className="brand-name">共算云</span>
          <span className="brand-beta">LIVE BETA</span>
        </button>

        <nav className="primary-nav" aria-label="主导航">
          <p className="nav-caption">试运营工作台</p>
          {navigation.map((item) => (
            <button
              key={item.label}
              className={activeView === item.label ? "nav-item active" : "nav-item"}
              onClick={() => setActiveView(item.label)}
              aria-current={activeView === item.label ? "page" : undefined}
            >
              <span className="nav-glyph">{item.glyph}</span>{item.label}
              {item.label === "审核" && snapshot.pendingReviews.length > 0 && <span className="nav-count">{snapshot.pendingReviews.length}</span>}
            </button>
          ))}
        </nav>

        <div className="trust-card">
          <div className="trust-orbit"><span>✓</span></div>
          <p>安全边界已启用</p>
          <span>身份隔离 · 加密凭据 · 追加账本</span>
          <button onClick={() => setNotice("生产策略：P2/P3、未审核授权、未通过签名节点证明和非白名单网关全部拒绝")}>查看边界</button>
        </div>

        <div className="profile-card">
          <div className="avatar">{firstName.slice(0, 1).toUpperCase()}</div>
          <div><strong>{firstName}</strong><span>{snapshot.supplier ? roleLabel(snapshot.supplier.kind) : "购买方账号"}</span></div>
          <a href="/signout-with-chatgpt?return_to=%2F" aria-label="退出登录">退出</a>
        </div>
      </aside>

      <main className="dashboard">
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-mark"><i /><i /><i /></span>共算云</div>
          <div className="environment"><span />真实数据 <b>BETA</b></div>
          <div className="topbar-actions">
            <span className="identity-chip">{snapshot.user.email}</span>
            <button className="buyer-button" onClick={() => setActiveView("购买算力")}>购买算力</button>
          </div>
        </header>

        {activeView === "总览" && (
          <Overview
            snapshot={snapshot}
            firstName={firstName}
            activeOffers={activeOffers}
            onOpen={setModal}
            onNavigate={setActiveView}
            onToggleSupply={toggleSupply}
            busy={busy}
          />
        )}
        {activeView === "购买算力" && (
          <BuyerWorkspace
            snapshot={snapshot}
            busy={busy}
            result={inferenceResult}
            onSnapshot={setSnapshot}
            onNotice={setNotice}
            onPurge={purgeContent}
            onRun={async (event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              setBusy(true);
              setInferenceResult(null);
              try {
                const response = await fetch("/api/v1/inference", {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "idempotency-key": crypto.randomUUID()
                  },
                  body: JSON.stringify({
                    model: String(form.get("model")),
                    input: String(form.get("input")),
                    dataClass: String(form.get("dataClass")),
                    maxOutputTokens: Number(form.get("maxOutputTokens")),
                    privacyMode: String(form.get("privacyMode")),
                    supplierProcessingAcknowledged: form.get("supplierProcessingAcknowledged") === "on"
                  })
                });
                const result = (await response.json()) as RunInferenceResponse | MarketplaceApiErrorBody;
                if (!response.ok || !result.ok) throw new Error(readApiError(result));
                setInferenceResult(result);
                setNotice(`凭证验证通过并完成结算 · ${result.usage.totalTokens.toLocaleString()} tokens · ${formatMicros(result.serviceProof.buyerChargeMicros)}`);
                await refreshSnapshot(setSnapshot);
              } catch (error) {
                setNotice(error instanceof Error ? error.message : "推理请求失败");
              } finally {
                setBusy(false);
              }
            }}
          />
        )}
        {activeView === "供给管理" && (
          <SupplierWorkspace
            snapshot={snapshot}
            busy={busy}
            onOpen={setModal}
            onToggleSupply={toggleSupply}
            onRevoke={(item) => { void revokeAuthorization(item); }}
            onRotate={(item) => { setCredentialTarget(item); setModal("rotate-credential"); }}
          />
        )}
        {activeView === "账本" && <LedgerWorkspace snapshot={snapshot} />}
        {activeView === "隐私中心" && <PrivacyWorkspace snapshot={snapshot} onNavigate={setActiveView} />}
        {activeView === "审核" && snapshot.user.isAdmin && (
          <ReviewWorkspace
            reviews={snapshot.pendingReviews}
            busy={busy}
            onReview={async (requestId, decision) => {
              await mutate(
                `/api/v1/admin/authorizations/${encodeURIComponent(requestId)}`,
                "POST",
                { commandId: crypto.randomUUID(), decision },
                decision === "approve" ? "授权已审核通过，供应商已激活" : "授权申请已拒绝"
              );
            }}
          />
        )}

        <footer className="dashboard-footer">
          <span className="live-indicator"><i />API {snapshot.apiVersion} · <a href="/privacy">隐私说明</a></span>
          <span aria-live="polite">{notice}</span>
          <button onClick={async () => { await refreshSnapshot(setSnapshot); setNotice("生产数据已刷新"); }}>刷新数据 →</button>
        </footer>
      </main>

      <nav className="mobile-nav" aria-label="移动端导航">
        {navigation.slice(0, 4).map((item) => (
          <button key={item.label} className={activeView === item.label ? "active" : ""} onClick={() => setActiveView(item.label)}>
            <span>{item.glyph}</span>{item.label.replace("算力", "")}
          </button>
        ))}
      </nav>

      {modal === "supplier" && (
        <Modal title="注册供应商" kicker="SUPPLIER ONBOARDING" onClose={() => setModal(null)}>
          <form onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void mutate("/api/v1/suppliers", "POST", {
              commandId: crypto.randomUUID(),
              kind: String(form.get("kind")),
              legalName: String(form.get("legalName")),
              displayName: String(form.get("displayName")),
              countryCode: String(form.get("countryCode")),
              taxResidenceCountryCode: String(form.get("taxResidenceCountryCode"))
            }, "供应商资料已保存，请继续提交容量授权");
          }}>
            <p className="modal-intro">个人与企业使用同一套事件与隔离模型；正式供给前必须完成审核。</p>
            <label>主体类型<select name="kind" defaultValue="individual"><option value="individual">个人</option><option value="organization">企业 / 组织</option></select></label>
            <label>法定姓名或企业名称<input name="legalName" required maxLength={200} /></label>
            <div className="form-grid"><label>展示名称<input name="displayName" required maxLength={120} /></label><label>所在地区<input name="countryCode" defaultValue="CN" pattern="[A-Za-z]{2}" required /></label></div>
            <label>税务居民地区<input name="taxResidenceCountryCode" defaultValue="CN" pattern="[A-Za-z]{2}" required /></label>
            <ModalActions busy={busy} onCancel={() => setModal(null)} label="保存供应商资料" />
          </form>
        </Modal>
      )}

      {modal === "authorization" && snapshot.supplier && (
        <Modal title="提交容量授权" kicker="PROVIDER AUTHORIZATION" onClose={() => setModal(null)} wide>
          <form onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void mutate("/api/v1/authorizations", "POST", {
              commandId: crypto.randomUUID(),
              providerId: String(form.get("providerId")),
              sourceType: String(form.get("sourceType")),
              meteringMode: String(form.get("meteringMode")),
              evidenceRef: String(form.get("evidenceRef")),
              modelPattern: String(form.get("modelPattern")),
              regionCode: String(form.get("regionCode")),
              dataClasses: [String(form.get("dataClass"))],
              limits: {
                requestsPerMinute: Number(form.get("requestsPerMinute")),
                tokensPerMinute: Number(form.get("tokensPerMinute")),
                concurrency: Number(form.get("concurrency")),
                maxOutputTokens: Number(form.get("maxOutputTokens"))
              },
              validUntil: toUtc(String(form.get("validUntil"))),
              gatewayEndpoint: String(form.get("gatewayEndpoint")),
              gatewayBearerToken: String(form.get("gatewayBearerToken"))
            }, "授权申请与加密网关凭据已提交，等待管理员审核");
          }}>
            <p className="modal-intro">只接受供应商自有、具备转售授权的签名版 v3 HTTPS 节点。每单必须返回绑定 Provider、精确模型、输入/输出摘要和用量的签名执行凭证。</p>
            <div className="form-grid"><label>Provider 标识<input name="providerId" defaultValue="authorized-gateway" required pattern="[A-Za-z0-9][A-Za-z0-9._:-]{2,127}" /></label><label>容量来源<select name="sourceType" defaultValue="commercial-account"><option value="commercial-account">商业账户</option><option value="api-project">API Project</option><option value="self-hosted-license">自托管许可</option><option value="subscription-plan">个人订阅（需明确许可）</option></select></label></div>
            <div className="form-grid"><label>精确模型名<input name="modelPattern" placeholder="model-exact-2026-08-26" required pattern="[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}" /></label><label>地区<input name="regionCode" defaultValue="CN" required pattern="[A-Za-z]{2}" /></label></div>
            <div className="form-grid"><label>计量方式<select name="meteringMode" defaultValue="signed-receipt"><option value="signed-receipt">签名回执</option><option value="provider-report">Provider 报告</option><option value="dedicated-counter">独立计数器</option></select></label><label>数据等级<select name="dataClass" defaultValue="P0"><option value="P0">P0 · 公开数据</option><option value="P1">P1 · 一般业务数据</option></select></label></div>
            <label>授权证据引用<input name="evidenceRef" placeholder="contract-2026-001（只填编号，不粘贴密钥）" required pattern="[A-Za-z0-9][A-Za-z0-9._:-]{2,127}" /></label>
            <div className="form-grid four"><label>RPM<input name="requestsPerMinute" type="number" min="1" defaultValue="60" required /></label><label>TPM<input name="tokensPerMinute" type="number" min="1" defaultValue="200000" required /></label><label>并发<input name="concurrency" type="number" min="1" defaultValue="4" required /></label><label>最大输出<input name="maxOutputTokens" type="number" min="1" defaultValue="4096" required /></label></div>
            <label>授权有效至<input name="validUntil" type="datetime-local" defaultValue={defaultLocalDate(180)} required /></label>
            <label>供应节点地址<input name="gatewayEndpoint" type="url" defaultValue="https://node.example.com/v3/inference" required /></label>
            <label>节点共享令牌<input name="gatewayBearerToken" type="password" minLength={32} autoComplete="off" required /></label>
            <div className="policy-note"><span>◇</span><p><b>密钥边界</b><small>令牌不会进入领域事件、浏览器响应、日志或审计详情</small></p></div>
            <ModalActions busy={busy} onCancel={() => setModal(null)} label="加密提交审核" />
          </form>
        </Modal>
      )}

      {modal === "offer" && approvedAuthorizations.length > 0 && (
        <Modal title="发布容量报价" kicker="CAPACITY OFFER" onClose={() => setModal(null)} wide>
          <form onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const priceCny = Number(form.get("priceCny"));
            void mutate("/api/v1/offers", "POST", {
              commandId: crypto.randomUUID(),
              authorizationRequestId: String(form.get("authorizationRequestId")),
              model: String(form.get("model")),
              dataClasses: [String(form.get("dataClass"))],
              limits: {
                requestsPerMinute: Number(form.get("requestsPerMinute")),
                tokensPerMinute: Number(form.get("tokensPerMinute")),
                concurrency: Number(form.get("concurrency")),
                maxOutputTokens: Number(form.get("maxOutputTokens"))
              },
              priceMicrosPerMillionTokens: String(Math.round(priceCny * 1_000_000)),
              validUntil: toUtc(String(form.get("validUntil")))
            }, "报价已通过授权边界校验并正式发布");
          }}>
            <p className="modal-intro">报价不能扩大已审核授权的模型、地区、数据等级、有效期或容量上限。</p>
            <label>已审核授权<select name="authorizationRequestId">{approvedAuthorizations.map((item) => <option value={item.requestId} key={item.requestId}>{item.providerId} · {item.modelPattern} · {item.gatewayHost}</option>)}</select></label>
            <div className="form-grid"><label>精确模型名<input name="model" defaultValue={approvedAuthorizations[0]?.modelPattern ?? ""} required /></label><label>数据等级<select name="dataClass" defaultValue="P0"><option value="P0">P0</option><option value="P1">P1</option></select></label></div>
            <div className="form-grid four"><label>RPM<input name="requestsPerMinute" type="number" min="1" defaultValue="30" required /></label><label>TPM<input name="tokensPerMinute" type="number" min="1" defaultValue="100000" required /></label><label>并发<input name="concurrency" type="number" min="1" defaultValue="2" required /></label><label>最大输出<input name="maxOutputTokens" type="number" min="1" defaultValue="2048" required /></label></div>
            <div className="form-grid"><label>报价（¥ / 百万 token）<input name="priceCny" type="number" min="0.000001" step="0.01" defaultValue="8.40" required /></label><label>报价有效至<input name="validUntil" type="datetime-local" defaultValue={defaultLocalDate(30)} required /></label></div>
            <ModalActions busy={busy} onCancel={() => setModal(null)} label="正式发布报价" />
          </form>
        </Modal>
      )}

      {modal === "rotate-credential" && credentialTarget && (
        <Modal title="替换网关令牌" kicker="GATEWAY CREDENTIAL ROTATION" onClose={() => setModal(null)}>
          <form onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void mutate(
              `/api/v1/authorizations/${encodeURIComponent(credentialTarget.requestId)}/credentials/rotate`,
              "POST",
              {
                commandId: crypto.randomUUID(),
                reasonCode: String(form.get("reasonCode")),
                gatewayBearerToken: String(form.get("gatewayBearerToken"))
              },
              "新网关令牌已验证并替换，旧令牌不可再用于新任务"
            );
          }}>
            <p className="modal-intro">平台会先向同一网关执行签名证明，再以原子写入替换令牌。旧令牌无法读取或重发，响应也不会返回新旧令牌。</p>
            <label>授权<input value={`${credentialTarget.providerId} · ${credentialTarget.modelPattern}`} readOnly /></label>
            <label>轮换原因<select name="reasonCode" defaultValue="scheduled"><option value="scheduled">计划轮换</option><option value="credential-compromised">疑似泄露</option><option value="gateway-reconfigured">网关重新配置</option></select></label>
            <label>新节点共享令牌<input name="gatewayBearerToken" type="password" minLength={32} autoComplete="new-password" required /></label>
            <div className="policy-note"><span>◇</span><p><b>替换边界</b><small>提交成功后授权 revision 会递增，旧 revision 的 reserve / claim / heartbeat 全部失效</small></p></div>
            <ModalActions busy={busy} onCancel={() => setModal(null)} label="验证并替换令牌" />
          </form>
        </Modal>
      )}
    </div>
  );
}

function Overview({ snapshot, firstName, activeOffers, onOpen, onNavigate, onToggleSupply, busy }: {
  snapshot: MarketplaceDashboardSnapshot;
  firstName: string;
  activeOffers: number;
  onOpen: (modal: ModalName) => void;
  onNavigate: (view: ViewName) => void;
  onToggleSupply: () => void;
  busy: boolean;
}) {
  const supplier = snapshot.supplier;
  return <>
    <section className="hero-row">
      <div className="hero-copy"><div className="eyebrow"><span />{supplier ? `${roleLabel(supplier.kind)} · ${statusLabel(supplier.status)}` : "BUYER · 已登录"}</div><h1>你好，{firstName}。</h1><p>{supplier ? "真实报价、用量和账本均由服务端持久化。" : "你可以先购买容量，也可以注册成为个人或企业供给方。"}</p></div>
      {supplier ? <div className={supplier.supplyEnabled ? "supply-switch online" : "supply-switch paused"}><div><span className="status-dot" /><p>{supplier.supplyEnabled ? "正在供给" : "供应已暂停"}</p><small>{supplier.status === "active" ? `${activeOffers} 个有效报价` : "等待授权审核"}</small></div><button role="switch" aria-checked={supplier.supplyEnabled} disabled={busy || supplier.status !== "active"} onClick={onToggleSupply}><span /></button></div> : <button className="primary-button hero-action" onClick={() => onOpen("supplier")}>注册成为供给方</button>}
    </section>
    <section className="metric-grid">
      <MetricCard label="试运营余额" value={formatMicros(snapshot.usage.promotionalBalanceMicros)} meta="可用于真实网关请求" tone="lime" />
      <MetricCard label="供应收益" value={formatMicros(snapshot.usage.supplierEarningsMicros)} meta="追加式账本" tone="blue" />
      <MetricCard label="完成任务" value={String(snapshot.usage.completedJobs)} meta={`${snapshot.usage.totalTokens.toLocaleString()} tokens`} tone="violet" />
      <MetricCard label="在线报价" value={String(snapshot.marketOffers.length)} meta="符合当前生产策略" tone="amber" />
    </section>
    <section className="content-grid">
      <article className="panel operation-panel"><div className="panel-heading"><div><span className="section-kicker">NEXT ACTION</span><h2>试运营进度</h2></div></div><ol className="operation-list">
        <Step done={Boolean(supplier)} title="注册供应商主体" meta="个人与企业均可接入" action={!supplier ? () => onOpen("supplier") : undefined} />
        <Step done={snapshot.authorizationRequests.some((item) => item.status === "approved")} title="提交并通过容量授权" meta={snapshot.authorizationRequests.some((item) => item.status === "pending") ? "等待白名单与签名节点证明" : "含加密网关、证据引用与实时证明"} action={supplier && snapshot.authorizationRequests.length === 0 ? () => onOpen("authorization") : undefined} />
        <Step done={activeOffers > 0} title="发布容量报价" meta="受授权容量与有效期约束" action={snapshot.authorizationRequests.some((item) => item.status === "approved") && activeOffers === 0 ? () => onOpen("offer") : undefined} />
        <Step done={snapshot.usage.completedJobs > 0} title="完成真实推理与结算" meta="输入不落库，输出加密保留 24 小时" action={snapshot.marketOffers.length > 0 ? () => onNavigate("购买算力") : undefined} />
      </ol></article>
      <article className="panel boundary-panel"><div className="panel-heading compact"><div><span className="section-kicker">PRODUCTION GUARDRAILS</span><h3>当前边界</h3></div><span className="health-pill">全部启用</span></div><ul className="boundary-list"><li><span>✓</span><div><b>价服一致担保</b><small>逐单核对 Provider、精确模型、内容摘要与用量；不一致不扣款</small></div></li><li><span>✓</span><div><b>服务端身份绑定</b><small>请求体无法指定其他租户</small></div></li><li><span>✓</span><div><b>签名节点证明</b><small>批准前核对 Provider、模型、数据等级和容量</small></div></li><li><span>✓</span><div><b>网关域名白名单</b><small>私网、IP 和非 HTTPS 默认拒绝</small></div></li><li><span>✓</span><div><b>幂等与并发控制</b><small>避免重试重复扣费和容量超卖</small></div></li><li><span>✓</span><div><b>P2/P3 关闭</b><small>未建立专用合规策略前不接收</small></div></li></ul></article>
    </section>
  </>;
}

function BuyerWorkspace({ snapshot, busy, result, onRun, onSnapshot, onNotice, onPurge }: {
  snapshot: MarketplaceDashboardSnapshot;
  busy: boolean;
  result: RunInferenceResponse | null;
  onRun: (event: FormEvent<HTMLFormElement>) => void;
  onSnapshot: (snapshot: MarketplaceDashboardSnapshot) => void;
  onNotice: (message: string) => void;
  onPurge: (resourceType: PurgeableMarketplaceResource, resourceId: string) => Promise<void>;
}) {
  const models = [...new Set(snapshot.marketOffers.filter((offer) => !offer.mine).map((offer) => offer.model))];
  return <section className="workspace-section">
    <div className="workspace-heading"><div><span className="section-kicker">MANAGED INFERENCE</span><h1>购买算力</h1><p>系统选择满足约束的最低有效报价；执行凭证通过后才结算，请求不会经过本地 Codex。</p></div><span className="balance-card">余额 <b>{formatMicros(snapshot.usage.promotionalBalanceMicros)}</b></span></div>
    <div className="buyer-grid">
      <form className="panel inference-form" onSubmit={onRun}>
        <label>模型<select name="model" disabled={models.length === 0}>{models.length ? models.map((model) => <option key={model}>{model}</option>) : <option>暂无其他供应商的在线模型</option>}</select></label>
        <div className="form-grid">
          <label>数据等级<select name="dataClass" defaultValue="P0"><option value="P0">P0 · 公开数据</option><option value="P1">P1 · 一般业务数据</option></select></label>
          <label>最大输出 token<input name="maxOutputTokens" type="number" min="1" max="32768" defaultValue="1024" /></label>
        </div>
        <label>隐私留存<select name="privacyMode" defaultValue="strict"><option value="strict">严格 · 结果仅保留 60 分钟</option><option value="standard">标准 · 结果保留 24 小时</option></select></label>
        <label>输入<textarea name="input" required maxLength={40000} placeholder="输入要发送到已授权供应网关的内容……" /></label>
        <div className="policy-note privacy-warning"><span>!</span><p><b>加密不等于供应方不可见</b><small>匹配供应节点及其上游 Provider 必须在执行时读取明文。平台不持久化提示词正文；请选择可信供给方且不要提交 P2/P3、密码或密钥。</small></p></div>
        <label className="consent-check"><input name="supplierProcessingAcknowledged" type="checkbox" required />我已理解内容会发送给匹配供应节点和上游 Provider 执行</label>
        <div className="policy-note"><span>◇</span><p><b>价服一致</b><small>Provider、精确模型、输入/输出摘要、用量或签名任一不符，本单失败且不扣款</small></p></div>
        <button className="primary-button full" disabled={busy || models.length === 0}>{busy ? "正在安全调度…" : "提交真实推理"}</button>
      </form>
      <article className="panel inference-output"><span className="section-kicker">RESULT + SERVICE PROOF</span><h3>模型输出</h3>{result ? <><pre>{result.output}</pre><div className="privacy-result-actions"><span>{result.job.privacyMode === "strict" ? "严格模式 · 60 分钟自动清除" : "标准模式 · 24 小时自动清除"}</span><button className="secondary-button danger" disabled={busy} onClick={() => void onPurge("inference-job", result.job.jobId)}>立即清除结果</button></div><ServiceProofCard result={result} /></> : <div className="empty-state"><span>◎</span><p>通过执行凭证验证的结果会显示在这里</p><small>失败请求不会生成账本扣款</small></div>}</article>
    </div>
    <ArtifactTaskPanel snapshot={snapshot} onSnapshot={onSnapshot} onNotice={onNotice} onPurge={onPurge} />
    <OfferCatalog offers={snapshot.marketOffers} />
  </section>;
}

function PrivacyWorkspace({ snapshot, onNavigate }: {
  snapshot: MarketplaceDashboardSnapshot;
  onNavigate: (view: ViewName) => void;
}) {
  const privacy = snapshot.privacy;
  return <section className="workspace-section privacy-workspace">
    <div className="workspace-heading"><div><span className="section-kicker">PRIVACY CENTER</span><h1>隐私中心</h1><p>这里说明谁能看到内容、平台保存什么，以及如何主动清除可重放数据。</p></div><a className="secondary-button" href="/privacy">查看完整说明</a></div>
    <section className="privacy-grid">
      <article className="panel privacy-card"><span className="privacy-card-mark warn">明</span><h2>执行时明文可见</h2><p>共享算力供应节点和它调用的上游 Provider 必须读取任务正文。当前版本不是端到端加密或可信执行环境。</p></article>
      <article className="panel privacy-card"><span className="privacy-card-mark">少</span><h2>平台最小留存</h2><p>普通提示词正文不入库；原始摘要在校验后转换为绑定任务的 HMAC 承诺，仅保留计量与执行凭证。严格模式输出仅保留 {privacy.strictOutputRetentionMinutes} 分钟。</p></article>
      <article className="panel privacy-card"><span className="privacy-card-mark">删</span><h2>主动清除</h2><p>购买方可立即撤销文件租约并清除密文、文件分块、指令和结果；不可变账本与不含正文的凭证继续保留。</p></article>
      <article className="panel privacy-card"><span className="privacy-card-mark">锁</span><h2>分离密钥与记录绑定</h2><p>网关凭据、任务内容和文件分块使用不同 AES-256-GCM 密钥；附加认证数据绑定租户、用途和记录编号。</p></article>
    </section>
    <article className="panel privacy-mode-table"><div className="panel-heading"><div><span className="section-kicker">RETENTION MODES</span><h3>留存策略</h3></div></div><div className="table-scroll"><table><thead><tr><th>模式</th><th>普通结果</th><th>文件输入</th><th>文件名</th><th>适用场景</th></tr></thead><tbody><tr><td><b>严格（默认）</b></td><td>{privacy.strictOutputRetentionMinutes} 分钟</td><td>等待窗口 {privacy.strictArtifactRetentionMinutes} 分钟；执行时短租约锁定，结束即清除</td><td>不上传原始文件名</td><td>P0/P1 中较敏感的一般业务资料</td></tr><tr><td><b>标准</b></td><td>{privacy.standardOutputRetentionHours} 小时</td><td>{privacy.standardArtifactRetentionHours} 小时</td><td>用于任务展示</td><td>公开内容与需要较长重试窗口的任务</td></tr></tbody></table></div></article>
    <div className="privacy-cta"><p>真正要求供应方也看不到内容时，请等待可信执行环境或改用客户自有节点；不要把“平台加密存储”误解为“执行方不可见”。</p><button className="primary-button" onClick={() => onNavigate("购买算力")}>返回购买算力</button></div>
  </section>;
}

function SupplierWorkspace({ snapshot, busy, onOpen, onToggleSupply, onRevoke, onRotate }: {
  snapshot: MarketplaceDashboardSnapshot;
  busy: boolean;
  onOpen: (modal: ModalName) => void;
  onToggleSupply: () => void;
  onRevoke: (item: AuthorizationRequestView) => void;
  onRotate: (item: AuthorizationRequestView) => void;
}) {
  const supplier = snapshot.supplier;
  if (!supplier) return <EmptyPanel title="尚未注册供应商" copy="注册个人或企业主体后即可提交正式容量授权。" action="注册供应商" onAction={() => onOpen("supplier")} />;
  const approved = snapshot.authorizationRequests.some((item) => item.status === "approved");
  return <section className="workspace-section"><div className="workspace-heading"><div><span className="section-kicker">SUPPLIER CONTROL PLANE</span><h1>供给管理</h1><p>{supplier.displayName} · {statusLabel(supplier.status)} · {supplier.countryCode}</p></div><div className="heading-actions"><button className="secondary-button" onClick={() => onOpen("authorization")}>提交授权</button><button className="primary-button" disabled={!approved} onClick={() => onOpen("offer")}>发布报价</button></div></div>
    <article className="panel agent-card"><div><span className="section-kicker">SUPPLIER AGENT</span><h2>先运行供应客户端，再提交节点授权</h2><p>客户端支持 Windows、macOS 和 Linux：本机加密保存 Provider Key，管理端口只绑定 127.0.0.1，并复用 v3 节点内核生成价服一致凭证。</p></div><ol><li><span>1</span>安装并打开 Supplier Agent</li><li><span>2</span>配置精确模型与稳定 HTTPS 地址</li><li><span>3</span>复制网关地址和令牌到授权申请</li></ol><div className="agent-note">技术 Beta 安装包由平台管理员发放；不要提交 Provider API Key、Cookie 或个人订阅登录态。</div></article>
    <section className="panel supplier-status"><div><span className={supplier.supplyEnabled ? "health-pill" : "health-pill muted"}>{supplier.supplyEnabled ? "供给在线" : "供给关闭"}</span><h2>{snapshot.offers.filter((offer) => offer.status === "active").length} 个有效报价</h2><p>开启后调度器只会选择已审核、未过期且容量足够的报价。</p></div><button className="secondary-button" disabled={busy || supplier.status !== "active"} onClick={onToggleSupply}>{supplier.supplyEnabled ? "暂停新任务" : "开启供应"}</button></section>
    <AuthorizationTable authorizations={snapshot.authorizationRequests} busy={busy} onRevoke={onRevoke} onRotate={onRotate} />
    <OfferCatalog offers={snapshot.offers} mine />
  </section>;
}

function LedgerWorkspace({ snapshot }: { snapshot: MarketplaceDashboardSnapshot }) {
  const provenJobs = snapshot.jobs.filter((job) => job.serviceProof);
  return <section className="workspace-section"><div className="workspace-heading"><div><span className="section-kicker">APPEND-ONLY LEDGER</span><h1>用量与账本</h1><p>扣款必须绑定不可变执行凭证；历史分录不可覆盖，纠错使用补偿分录。</p></div></div><section className="metric-grid compact-metrics"><MetricCard label="当前余额" value={formatMicros(snapshot.usage.promotionalBalanceMicros)} meta="含试运营赠送额" tone="lime" /><MetricCard label="累计消费" value={formatMicros(snapshot.usage.buyerSpendMicros)} meta="仅凭证通过的推理" tone="amber" /><MetricCard label="供应收益" value={formatMicros(snapshot.usage.supplierEarningsMicros)} meta="提现通道待接入" tone="blue" /></section><article className="panel table-panel"><div className="panel-heading"><div><span className="section-kicker">SERVICE EVIDENCE</span><h3>价服一致凭证</h3></div><span className="health-pill">{provenJobs.length} 单已验证</span></div><div className="table-scroll"><table><thead><tr><th>时间 / 任务</th><th>Provider</th><th>购买 → 实际模型</th><th>单价 / 实扣</th><th>凭证摘要</th></tr></thead><tbody>{provenJobs.map((job) => { const proof = job.serviceProof!; return <tr key={job.jobId}><td>{formatDate(proof.completedAt)}<small className="cell-sub">{job.jobId.slice(0, 18)}</small></td><td><b>{proof.providerId}</b><small className="cell-sub">节点签名已验证</small></td><td><b>{proof.requestedModel}</b><small className="cell-sub">实际：{proof.servedModel}</small></td><td>{formatPrice(proof.unitPriceMicrosPerMillionTokens)}<small className="cell-sub">实扣 {formatMicros(proof.buyerChargeMicros)}</small></td><td><code title={proof.evidenceDigest}>{shortDigest(proof.evidenceDigest)}</code></td></tr>; })}{provenJobs.length === 0 && <tr><td colSpan={5}><div className="empty-row">完成首笔通过验证的推理后，这里会生成价服一致凭证</div></td></tr>}</tbody></table></div></article><article className="panel table-panel"><div className="panel-heading"><div><span className="section-kicker">ENTRIES</span><h3>最近分录</h3></div></div><div className="table-scroll"><table><thead><tr><th>时间</th><th>类型</th><th>方向</th><th>金额</th><th>关联任务</th></tr></thead><tbody>{snapshot.ledger.map((entry) => <tr key={entry.entryId}><td>{formatDate(entry.createdAt)}</td><td>{ledgerLabel(entry.entryType)}</td><td><span className={`status-pill ${entry.direction === "credit" ? "live" : "review"}`}>{entry.direction === "credit" ? "入账" : "扣款"}</span></td><td><strong>{entry.direction === "credit" ? "+" : "-"}{formatMicros(entry.amountMicros)}</strong></td><td><code>{entry.jobId?.slice(0, 16) ?? "开户"}</code></td></tr>)}{snapshot.ledger.length === 0 && <tr><td colSpan={5}><div className="empty-row">暂无账本分录</div></td></tr>}</tbody></table></div></article></section>;
}

function ServiceProofCard({ result }: { result: RunInferenceResponse }) {
  const proof = result.serviceProof;
  return <section className="service-proof"><div className="service-proof-head"><div><span className="proof-seal">✓</span><p><b>价服一致凭证已通过</b><small>节点签名 · 上游响应模型已核对</small></p></div><span className="proof-badge">已结算</span></div><dl><div><dt>Provider</dt><dd>{proof.providerId}</dd></div><div><dt>购买 / 实际模型</dt><dd>{proof.requestedModel} / {proof.servedModel}</dd></div><div><dt>报价 / 实扣</dt><dd>{formatPrice(proof.unitPriceMicrosPerMillionTokens)} / {formatMicros(proof.buyerChargeMicros)}</dd></div><div><dt>计量</dt><dd>{result.usage.totalTokens.toLocaleString()} tokens</dd></div><div className="proof-digest"><dt>证据摘要</dt><dd title={proof.evidenceDigest}>{proof.evidenceDigest}</dd></div></dl></section>;
}

function ReviewWorkspace({ reviews, busy, onReview }: { reviews: AuthorizationRequestView[]; busy: boolean; onReview: (id: string, decision: "approve" | "reject") => void }) {
  return <section className="workspace-section"><div className="workspace-heading"><div><span className="section-kicker">ADMIN REVIEW</span><h1>授权审核</h1><p>批准时会连接白名单节点并完成一次签名证明；Provider、模型、数据等级或容量不匹配都会失败，结果写入审计记录。</p></div><span className="balance-card">待处理 <b>{reviews.length}</b></span></div><div className="review-list">{reviews.map((item) => <article className="panel review-card" key={item.requestId}><div className="review-main"><span className="scope-pill">{item.sourceType}</span><h3>{item.supplierDisplayName}</h3><p>{item.providerId} · {item.modelPattern} · {item.gatewayHost}</p><dl><div><dt>证据引用</dt><dd>{item.evidenceRef}</dd></div><div><dt>数据范围</dt><dd>{item.dataClasses.join(" / ")}</dd></div><div><dt>容量</dt><dd>{item.limits.tokensPerMinute.toLocaleString()} TPM · {item.limits.concurrency} 并发</dd></div><div><dt>有效至</dt><dd>{formatDate(item.validUntil)}</dd></div></dl></div><div className="review-actions"><button className="secondary-button danger" disabled={busy} onClick={() => onReview(item.requestId, "reject")}>拒绝</button><button className="primary-button" disabled={busy} onClick={() => onReview(item.requestId, "approve")}>验证节点并批准</button></div></article>)}{reviews.length === 0 && <EmptyPanel title="没有待审核授权" copy="新的供应商容量授权会显示在这里。" />}</div></section>;
}

function AuthorizationTable({ authorizations, busy, onRevoke, onRotate }: {
  authorizations: AuthorizationRequestView[];
  busy: boolean;
  onRevoke: (item: AuthorizationRequestView) => void;
  onRotate: (item: AuthorizationRequestView) => void;
}) {
  return <article className="panel table-panel"><div className="panel-heading"><div><span className="section-kicker">AUTHORIZATIONS</span><h3>容量授权</h3></div></div><div className="table-scroll"><table><thead><tr><th>Provider / 模型</th><th>来源</th><th>网关</th><th>数据</th><th>状态</th><th>操作</th></tr></thead><tbody>{authorizations.map((item) => <tr key={item.requestId}><td><b>{item.providerId}</b><small className="cell-sub">{item.modelPattern}</small></td><td>{item.sourceType}</td><td>{item.gatewayHost}<small className="cell-sub">revision {item.authorizationRevision}{item.credentialRotatedAt ? ` · ${formatDate(item.credentialRotatedAt)}` : ""}</small></td><td>{item.dataClasses.join(" / ")}</td><td><span className={`status-pill ${authorizationStatusTone(item.status)}`}>{reviewLabel(item.status)}</span></td><td>{item.status === "approved" && <button className="table-action" disabled={busy} onClick={() => onRotate(item)}>替换令牌</button>}{(item.status === "pending" || item.status === "approved") && <button className="table-action danger" disabled={busy} onClick={() => onRevoke(item)}>{item.status === "pending" ? "撤回申请" : "撤销授权"}</button>}</td></tr>)}{authorizations.length === 0 && <tr><td colSpan={6}><div className="empty-row">尚未提交授权</div></td></tr>}</tbody></table></div></article>;
}

function OfferCatalog({ offers, mine = false }: { offers: CapacityOfferView[]; mine?: boolean }) {
  return <article className="panel table-panel"><div className="panel-heading"><div><span className="section-kicker">CAPACITY OFFERS</span><h3>{mine ? "我的报价" : "市场报价"}</h3></div><span className="health-pill">{offers.filter((offer) => offer.status === "active").length} 在线</span></div><div className="table-scroll"><table><thead><tr><th>模型 / 供给方</th><th>数据</th><th>容量</th><th>价格</th><th>状态</th></tr></thead><tbody>{offers.map((offer) => <tr key={offer.offerId}><td><b>{offer.model}</b><small className="cell-sub">{offer.supplierDisplayName} · {offer.providerId}</small></td><td><span className="scope-pill">{offer.dataClasses.join(" / ")}</span></td><td>{offer.limits.tokensPerMinute.toLocaleString()} TPM<br /><small>{offer.limits.concurrency} 并发</small></td><td><strong>{formatPrice(offer.priceMicrosPerMillionTokens)}</strong></td><td><span className={`status-pill ${offer.status === "active" ? "live" : "review"}`}>{offerStatusLabel(offer.status)}</span></td></tr>)}{offers.length === 0 && <tr><td colSpan={5}><div className="empty-row">暂无符合条件的报价</div></td></tr>}</tbody></table></div></article>;
}

function MetricCard({ label, value, meta, tone }: { label: string; value: string; meta: string; tone: string }) { return <article className={`metric-card ${tone}`}><div className="metric-top"><span>{label}</span><i /></div><div className="metric-value"><strong>{value}</strong></div><div className="metric-meta"><span>{meta}</span></div></article>; }
function Step({ done, title, meta, action }: { done: boolean; title: string; meta: string; action?: () => void }) { return <li className={done ? "done" : "pending"}><span>{done ? "✓" : "•"}</span><div><b>{title}</b><small>{meta}</small></div>{action && <button onClick={action}>继续 →</button>}</li>; }
function EmptyPanel({ title, copy, action, onAction }: { title: string; copy: string; action?: string; onAction?: () => void }) { return <article className="panel empty-panel"><span>◇</span><h2>{title}</h2><p>{copy}</p>{action && onAction && <button className="primary-button" onClick={onAction}>{action}</button>}</article>; }
function Modal({ title, kicker, onClose, wide, children }: { title: string; kicker: string; onClose: () => void; wide?: boolean; children: ReactNode }) { return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className={`offer-modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="section-kicker">{kicker}</span><h2>{title}</h2></div><button aria-label="关闭" onClick={onClose}>×</button></div>{children}</section></div>; }
function ModalActions({ busy, onCancel, label }: { busy: boolean; onCancel: () => void; label: string }) { return <div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel}>取消</button><button className="primary-button" disabled={busy}>{busy ? "处理中…" : label}</button></div>; }

async function refreshSnapshot(setter: (snapshot: MarketplaceDashboardSnapshot) => void) { const response = await fetch("/api/v1/dashboard", { cache: "no-store" }); const result = (await response.json()) as MarketplaceDashboardSnapshot | MarketplaceApiErrorBody; if (!response.ok || "ok" in result) throw new Error(readApiError(result)); setter(result); }
function readApiError(value: unknown): string { if (value && typeof value === "object" && "error" in value) { const error = (value as MarketplaceApiErrorBody).error; return `${error.message}（${error.code}）`; } return "服务返回了无法识别的响应"; }
function formatMicros(value: string) { return `¥ ${formatFixedMicros(value, 4)}`; }
function formatPrice(value: string) { return `¥ ${formatFixedMicros(value, 2)} / M`; }
function formatFixedMicros(value: string, digits: number) { const micros = BigInt(value); const sign = micros < 0n ? "-" : ""; const absolute = micros < 0n ? -micros : micros; const whole = absolute / 1_000_000n; const fraction = (absolute % 1_000_000n).toString().padStart(6, "0").slice(0, digits); return `${sign}${whole}.${fraction}`; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function shortDigest(value: string) { return `${value.slice(0, 10)}…${value.slice(-8)}`; }
function defaultLocalDate(days: number) { const date = new Date(Date.now() + days * 86_400_000); const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000); return local.toISOString().slice(0, 16); }
function toUtc(value: string) { return new Date(value).toISOString(); }
function roleLabel(kind: "individual" | "organization") { return kind === "individual" ? "个人供给方" : "企业供给方"; }
function statusLabel(status: string) { return ({ "pending-verification": "等待审核", active: "已激活", suspended: "已暂停", rejected: "已拒绝" } as Record<string, string>)[status] ?? status; }
function reviewLabel(status: string) { return ({ pending: "审核中", approved: "已通过", rejected: "已拒绝", withdrawn: "已撤回", revoked: "已撤销", expired: "已过期" } as Record<string, string>)[status] ?? status; }
function authorizationStatusTone(status: string) { return status === "approved" ? "live" : ["rejected", "withdrawn", "revoked"].includes(status) ? "danger" : "review"; }
function offerStatusLabel(status: string) { return ({ active: "供给中", paused: "已暂停", expired: "已过期" } as Record<string, string>)[status] ?? status; }
function ledgerLabel(type: string) { return ({ "promotional-credit": "试运营赠额", "inference-debit": "推理消费", "supplier-credit": "供应收益", "platform-fee": "平台服务费", adjustment: "补偿调整" } as Record<string, string>)[type] ?? type; }
