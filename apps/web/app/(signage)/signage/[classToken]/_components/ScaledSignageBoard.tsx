import type { SignagePayload } from "@/lib/signage/signage-display";
import type { EditRegionsProps } from "./BoardRegionEditButton";
import scaler from "./ScaledSignageBoard.module.css";
import { SignageBoardView } from "./SignageBoardView";

/**
 * 実機サイネージ盤面（`SignageBoardView`）を **16:9・固定 TV 解像度（1280×720）で描画し、与えられた幅へ
 * `transform: scale()` で縮小**する**静的・read-only** ラッパ（F・盤面ビューの再利用部品化）。サムネイル表示や
 * 後続のエディタキャンバス（実画面モニタの壁 / WYSIWYG エディタ）の土台として使う。
 *
 * ## 静的描画（再生制御を持たない）
 * ポーリング・実時計・広告ローテーション・テレメトリは**一切持たない**（hooks/effect 無し）。`SignageBoardView`
 * へ `now=null`（時計非表示）・広告は `payload.ads` の**先頭を静止表示**・`adLink=null`（リンク非生成）・
 * `onAdTap=noop` で渡す。クリックは親（エディタ）が扱うので盤面自身はリンクを張らない（read-only）。
 *
 * ## レイアウト / スケール
 * - 外枠 `.frame` が `aspect-ratio: 16/9` でレイアウト領域を確保する。
 * - `width` 指定時: その幅（px）に合わせ `--sb-scale = width / 1280` をインラインで与える（**JS 不要 = Server
 *   Component 互換**）。`.frame` の幅も `width` に固定する。
 * - `width` 省略時: `.frame` はコンテナ幅 100% に広がり、CSS container query 単位（`cqw`）で枠幅に scale を
 *   追従させる（こちらも JS 計測不要）。
 *
 * `"use client"` は付けない（effect 不要・純描画）。`SignageBoardView` も client 指定を持たないため、本部品は
 * Server Component からも描画できる。
 */
export function ScaledSignageBoard({
  payload,
  width,
  editRegions,
}: {
  /** 表示する盤面のスナップショット（Server 側で取得した確定 `SignagePayload`）。 */
  payload: SignagePayload;
  /**
   * 描画幅（px）。指定時はこの幅に固定し `--sb-scale = width / 1280` で縮小する（JS 不要）。
   * 省略時はコンテナ幅 100% に広がり、container query で枠幅へ自動フィットする。
   */
  width?: number;
  /**
   * **WYSIWYG「盤面を編集」の実エリア直接クリック配線**（任意・素通し）。`SignageBoardView` の `editRegions` へ
   * そのまま渡すだけ。**省略時（既定 undefined）は read-only のまま従来不変**（サムネ / モニタの壁は編集ボタンを
   * 一切描かず出力が変わらない）。渡すのは WYSIWYG エディタ（client）だけ。
   */
  editRegions?: EditRegionsProps;
}) {
  // 広告は payload.ads の先頭のみ静止表示（ローテーションしない）。空なら null（広告枠は空表示）。
  const ad = payload.ads.length > 0 ? (payload.ads[0] ?? null) : null;
  // width 指定時のみインラインでスケールを固定する（未指定時は CSS の cqw 既定にまかせる）。
  const frameStyle: React.CSSProperties | undefined =
    width != null
      ? ({ width: `${width}px`, "--sb-scale": `${width / 1280}` } as React.CSSProperties)
      : undefined;
  return (
    <div className={scaler.frame} style={frameStyle}>
      <div className={scaler.stage}>
        <SignageBoardView
          data={payload}
          ad={ad}
          // 静的サムネはタップ不可・リンク非生成。クリックは親が扱う（read-only）。
          adLink={null}
          // ローテーション無し（先頭広告を静止表示）。ドットは出さない。
          adCount={ad ? 1 : 0}
          safeIndex={0}
          // 時計は出さない（静的スナップショット）。
          now={null}
          // タップ計測はしない（read-only）。
          onAdTap={NOOP_AD_TAP}
          // WYSIWYG 編集の領域クリック配線を素通し（省略時は read-only のまま不変）。
          editRegions={editRegions}
        />
      </div>
    </div>
  );
}

/** read-only サムネのタップ noop（テレメトリを送らない）。 */
function NOOP_AD_TAP(): void {}
