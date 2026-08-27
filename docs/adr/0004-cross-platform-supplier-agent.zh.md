# ADR 0004：跨平台供应客户端复用无界面节点内核

- 状态：接受
- 日期：2026-08-25

## 背景

`apps/supplier-node` 已具备签名、重放防护、容量控制、Provider Adapter、精确模型核对和执行凭证，但依赖环境变量与服务器运维。普通个人供应方若必须手工配置 Docker、域名和密钥，供给侧无法形成类似网约车司机端的低门槛体验。与此同时，把业务逻辑复制到 Electron、TUI 或各平台原生应用会产生多个安全实现和升级分叉。

## 决策

新增 `apps/supplier-agent` 作为 Windows、macOS、Linux 共用的本地客户端。Supplier Agent 只负责配置、凭据保管、节点启停、状态展示和平台接入资料；实际推理继续调用 `@token-streaming/supplier-node/runtime` 公共入口。

首版 GUI 使用本机浏览器作为可替换宿主，管理服务只监听 `127.0.0.1`。每次进程启动生成 256-bit 管理会话令牌，通过 URL fragment 交给浏览器，令牌不进入 HTTP 请求日志、HTML 或持久化文件。管理 API 同时验证精确 Host、自定义会话请求头和同源 Origin，关闭 CORS，并发送严格 CSP、frame、referrer、permissions 和 no-store 响应头。

Provider API Key 与网关令牌以 AES-256-GCM 加密保存；密钥使用用户至少 12 字符的口令、随机 salt 和 scrypt 派生。口令不保存，锁定或退出时节点进入 draining、关闭监听并释放内存凭据。状态接口只返回 Provider、模型、端口和聚合任务指标，不返回请求正文、输出、Provider Key、网关令牌或请求级日志。

Agent 不自动开放路由器端口、防火墙或创建第三方账户。稳定公网 HTTPS 反向代理或命名出站隧道属于显式部署边界，因为平台需要对白名单域名进行批准时证明。公网只转发本地推理端口，绝不转发管理端口。

消费端继续以响应式 Web/PWA 为主；Windows、macOS、Linux、Android 和 iOS 可通过支持的浏览器安装。后续原生壳只消费公开 API 与 client-core，不复制路由、计费或凭证验证。

## 后果

- 个人供应方获得配置向导、加密密钥库、状态面板和一键安全下线，客户端与节点协议保持单一实现。
- 首版仍要求 Node.js 22+ 和稳定 HTTPS 转发；签名安装包、自动更新和平台托管出站 relay 是后续发行能力，不影响内核协议。
- 本地口令不可恢复；遗失时必须重建密钥库并轮换 Provider 和网关凭据。
- 供应客户端不绕过 Provider 商业授权。ChatGPT/Codex Cookie、OAuth 登录态和个人订阅密码继续禁止接入。
