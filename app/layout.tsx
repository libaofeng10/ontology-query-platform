import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OntoQuery · 智能问数平台",
  description: "配置只读数据源，构建 Markdown 本体，以自然语言安全查询真实业务数据。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
