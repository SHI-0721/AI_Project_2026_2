import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "语间 kotoba · 中日面对面字幕",
  description: "两部手机，一段对话。中文与日语实时字幕，上方对方，下方自己。",
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
