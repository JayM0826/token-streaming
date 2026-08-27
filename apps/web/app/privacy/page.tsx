import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "隐私与安全边界｜共算云",
  description: "共算云共享算力的数据流、加密、留存、供应方可见性与内容清除说明。"
};

export default function PrivacyPage() {
  return <main className="privacy-page">
    <nav className="privacy-nav"><Link className="brand" href="/"><span className="brand-mark"><i /><i /><i /></span><span className="brand-name">共算云</span></Link><Link className="secondary-button" href="/">返回控制台</Link></nav>
    <header className="privacy-hero"><span className="section-kicker">PRIVACY & SECURITY BOUNDARY</span><h1>先说清谁能看到，<br />再谈加密与安全。</h1><p>共算云不会把“加密存储”描述成“执行方不可见”。共享算力任务必须由匹配供应节点及其上游 Provider 读取明文才能完成；平台通过最小留存、隔离、记录绑定加密、短租约和主动清除降低风险。</p></header>
    <section className="privacy-document">
      <article><span>01</span><div><h2>内容会经过谁</h2><p>浏览器把请求发送给共算云控制平面；平台根据已审核报价选择供应节点。普通任务的正文经签名 HTTPS 请求发送给供应节点，再由其发送给授权 Provider。文件任务以加密分块保存，只有持有有效短租约的匹配 Agent 能逐块读取。</p><strong>供应节点操作者或上游 Provider 仍可能在执行环境中接触明文。需要任何第三方都不可见时，请勿使用共享供应节点。</strong></div></article>
      <article><span>02</span><div><h2>平台保存什么</h2><p>普通提示词正文不写入数据库；当次校验完成后，原始 SHA-256 会转换成绑定用途、租户和任务的密钥化 HMAC 承诺，平台另保存模型、用量、价格、状态和执行凭证。输出为了断线重放会加密短期保存。文件正文只进入 R2 加密对象，不进入 JSON、D1、日志或普通工作目录。登录邮箱和昵称由身份服务显示，不复制到市场数据库；供应方实名或企业资料因审核、结算和法定义务需要单独保存。</p></div></article>
      <article><span>03</span><div><h2>标准与严格模式</h2><p><b>严格模式（默认）</b>不上传原始文件名，普通/文件输出保留 60 分钟；文件上传后等待执行的窗口最长 60 分钟，执行期间由短租约锁定，任务终止后立即进入物理清除流程。<b>标准模式</b>允许原始文件名，输出保留 24 小时，文件最长保留 48 小时，以获得更长的重试窗口。</p></div></article>
      <article><span>04</span><div><h2>加密与密钥边界</h2><p>网关凭据、可重放内容、文件分块和摘要承诺使用四把独立的 256 位密钥。AES-256-GCM 附加认证数据及 HMAC 承诺都绑定用途、租户和记录编号；把一条记录的密文或摘要替换到另一条记录会校验失败。供应 Agent 的 Provider Key 使用用户口令经 scrypt 派生密钥后在本地加密。</p></div></article>
      <article><span>05</span><div><h2>主动清除与不可变记录</h2><p>购买方可在控制台立即清除普通结果或文件任务内容。文件任务清除会撤销租约、阻止后续分块下载、删除 R2 对象、清除处理指令与结果，并让 Agent 删除本地加密检查点。为防止账务篡改，金额、用量和不含正文的执行凭证不会被覆盖或删除。</p></div></article>
      <article><span>06</span><div><h2>当前不接收的数据</h2><p>封闭试运营只接受 P0 公开数据与 P1 一般业务数据。不要提交密码、API Key、Cookie、身份证件、医疗信息、金融账户、精确位置、商业绝密或其他 P2/P3 数据。文件内容不会被执行、解压，也不会触发其中的链接或工具指令。</p></div></article>
    </section>
    <section className="privacy-limit"><h2>真正的“供应方不可见”还需要什么</h2><p>需要平台管理的可信执行环境、远程证明、内存加密和可审计镜像，或者由客户自己控制的执行节点。当前节点签名能证明请求经过指定内核并返回精确模型证据，但不能阻止设备所有者检查其机器内存。</p></section>
  </main>;
}
