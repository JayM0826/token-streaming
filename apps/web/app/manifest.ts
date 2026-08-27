import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "共算云｜授权模型容量市场",
    short_name: "共算云",
    description: "个人与企业均可接入的授权模型容量共享市场。",
    start_url: "/",
    display: "standalone",
    background_color: "#f4f5ef",
    theme_color: "#10251d",
    lang: "zh-CN",
    categories: ["business", "productivity", "utilities"],
    icons: [
      { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }
    ]
  };
}
