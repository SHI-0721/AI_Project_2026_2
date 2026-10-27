import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "语间 Kotoba · 四语字幕与会议翻译",
  description: "中文、英语、日语、韩语实时字幕与原文纠错。远程双人各自开麦、同步原文和翻译，也支持面对面对话及会议音频翻译。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
