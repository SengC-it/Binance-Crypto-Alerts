import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BCA 机会雷达 | Binance Crypto Alerts",
  description: "Binance USDT-M 永续合约机会扫描、信号评分与风险提示。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
