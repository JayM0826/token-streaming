import { chatGPTSignInPath, getChatGPTUser } from "./chatgpt-auth";
import { DashboardClient } from "./dashboard-client";
import { getDashboard } from "@/server/marketplace-service";
import { requireIdentity } from "@/server/security";
import { InstallAppButton } from "./install-app-button";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();
  if (!user) return <PublicLanding />;

  const snapshot = await getDashboard(await requireIdentity());
  return <DashboardClient initialSnapshot={snapshot} />;
}

function PublicLanding() {
  return (
    <main className="landing-shell">
      <nav className="landing-nav">
        <a className="brand" href="#top" aria-label="共算云首页">
          <span className="brand-mark"><i /><i /><i /></span>
          <span className="brand-name">共算云</span>
          <span className="brand-beta">CLOSED BETA</span>
        </a>
        <a className="primary-button" href={chatGPTSignInPath("/")}>登录试运营控制台</a>
      </nav>

      <section className="landing-hero" id="top">
        <div className="landing-copy">
          <span className="eyebrow"><i /> AUTHORIZED CAPACITY MARKET</span>
          <h1>让合规的模型容量，<br /><em>安全流向真实需求。</em></h1>
          <p>像滴滴匹配车辆与乘客一样，共算云匹配已授权模型容量与真实需求。购买方先锁定 Provider、精确模型和报价；执行凭证验证通过后才按实际用量结算。</p>
          <div className="landing-actions">
            <a className="primary-button large" href={chatGPTSignInPath("/")}>使用 ChatGPT 账号进入</a>
            <InstallAppButton />
            <a className="privacy-link" href="/privacy">隐私与安全边界</a>
            <span>封闭试运营 · 仅 P0 / P1 数据</span>
          </div>
        </div>
        <div className="landing-proof" aria-label="运行边界">
          <div className="proof-head"><span>生产边界</span><b>FAIL CLOSED</b></div>
          <ol>
            <li><span>01</span><div><b>身份与租户隔离</b><small>所有写入均绑定服务端身份</small></div></li>
            <li><span>02</span><div><b>价服一致逐单验证</b><small>Provider、精确模型、内容摘要、用量或签名不符即拒绝结算</small></div></li>
            <li><span>03</span><div><b>签名节点与分离加密密钥</b><small>凭据、输出与文件分块分别加密并绑定记录</small></div></li>
            <li><span>04</span><div><b>凭证与账本原子写入</b><small>没有合格执行凭证，就没有扣款和供应商入账</small></div></li>
          </ol>
        </div>
      </section>

      <section className="role-paths" aria-label="供需双方使用方式">
        <article>
          <span className="role-number">01 · CONSUMER</span>
          <h2>消费方：打开即用</h2>
          <p>Web/PWA 选择模型并提交任务，平台自动匹配合格最低报价。执行凭证通过后才扣款，结果、实际模型和实扣金额都可追溯。</p>
          <a href={chatGPTSignInPath("/")}>进入购买算力 →</a>
        </article>
        <article>
          <span className="role-number">02 · SUPPLIER</span>
          <h2>供给方：客户端上线</h2>
          <p>Windows、macOS 或 Linux 运行 Supplier Agent，在本机加密保存 Provider Key，配置稳定 HTTPS 节点后提交授权、发布报价并接收任务。</p>
          <a href={chatGPTSignInPath("/")}>注册供给方 →</a>
        </article>
      </section>

      <section className="landing-strip">
        <span>真实账户</span><span>持久化报价</span><span>价服一致凭证</span><span>失败不扣款</span><span>严格最小留存</span><span>主动内容清除</span>
      </section>
    </main>
  );
}
