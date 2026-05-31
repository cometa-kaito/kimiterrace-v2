import type { ReactNode } from "react";

/**
 * 公開サイネージ系ルートの全画面シェル (#48-E2 / F12)。`/signage/{classToken}` 等が属する
 * route group `(signage)` の layout。教員向け `/admin` のナビ・ログインシェルとは独立した、
 * **余白なし・高コントラスト・スクロールなし**の TV 表示用コンテナを与える。
 *
 * 認証は掛けない (匿名公開。テナント分離は token→RLS で `signage-display.ts` が担保)。
 * route group なので URL には現れない。
 */
export default function SignageLayout({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        background: "#0b1220",
        color: "#f8fafc",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      {children}
    </div>
  );
}
