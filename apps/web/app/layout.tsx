import type { Metadata } from "next";
import "./globals.css";
import { PwaRegister } from "./pwa-register";

const siteOrigin = "https://gongsuanyun-market.wenzaiyin.chatgpt.site";

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  title: "共算云｜个人算力供给控制台",
  description: "个人与企业均可接入的授权模型容量共享市场控制台。",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "共算云"
  },
  openGraph: {
    title: "共算云｜让闲置模型额度持续创造价值",
    description: "个人与企业均可接入的授权模型容量共享市场。",
    type: "website",
    images: [{ url: "/og.png", width: 1733, height: 909, alt: "共算云算力市场" }]
  },
  twitter: {
    card: "summary_large_image",
    title: "共算云｜让闲置模型额度持续创造价值",
    description: "个人与企业均可接入的授权模型容量共享市场。",
    images: ["/og.png"]
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body><PwaRegister />{children}</body>
    </html>
  );
}
