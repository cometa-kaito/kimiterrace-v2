import type { ReactNode } from "react";

export const metadata = {
  title: "キミテラス v2",
  description: "学校サイネージ・校務 DX プラットフォーム",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
