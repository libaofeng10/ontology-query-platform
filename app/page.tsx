import type { Metadata } from "next";
import { PlatformApp } from "./platform-app";

export const metadata: Metadata = {
  title: "OntoQuery · 本体驱动智能问数平台",
  description: "以可验证的业务本体驱动安全、可信、可追溯的自然语言问数。",
};

export default function Home() {
  return <PlatformApp />;
}
