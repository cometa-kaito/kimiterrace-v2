import type { ReactNode } from "react";
import { KioskKeepAlive } from "./_components/KioskKeepAlive";

/**
 * 公開サイネージ系ルートの全画面シェル (#48-E2 / F12)。`/signage/{classToken}` 等が属する
 * route group `(signage)` の layout。教員向け `/admin` のナビ・ログインシェルとは独立した、
 * **余白なし・高コントラスト・スクロールなし**の TV 表示用コンテナを与える。
 *
 * 認証は掛けない (匿名公開。テナント分離は token→RLS で `signage-display.ts` が担保)。
 * route group なので URL には現れない。
 */
export default function SignageLayout({ children }: { children: ReactNode }) {
  // 配色は v1（旧キミテラス）の「マットトーン」盤面に合わせ、白地 + Ink Black 文字を基調にする。
  // 盤面本体 (`signage.module.css` の .signageRoot) も同じ白地を敷くが、描画前の隙間で暗色が
  // ちらつかないよう外殻もここで白く塗っておく。
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        background: "#ffffff",
        color: "#111827",
        fontFamily: '"Inter", "Noto Sans JP", "Helvetica Neue", Arial, sans-serif',
      }}
    >
      {children}
      <KioskKeepAlive />
    </div>
  );
}
