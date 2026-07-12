import { clampIndex } from "@/lib/signage/rotation";
import type { SignagePayload } from "@/lib/signage/signage-display";
import type { EditRegionsProps } from "./BoardRegionEditButton";
import scaler from "./ScaledSignageBoard.module.css";
import boardStyles from "./signage.module.css";
import { SignageBoardView } from "./SignageBoardView";

/**
 * 実機サイネージ盤面（`SignageBoardView`）を **16:9・固定 TV 解像度（1280×720）で描画し、与えられた幅へ
 * `transform: scale()` で縮小**する**静的・read-only** ラッパ（F・盤面ビューの再利用部品化）。サムネイル表示や
 * 後続のエディタキャンバス（実画面モニタの壁 / WYSIWYG エディタ）の土台として使う。
 *
 * ## 静的描画（再生制御を持たない）
 * ポーリング・実時計・広告ローテーション・テレメトリは**自身では一切持たない**（hooks/effect 無し＝Server
 * Component 互換）。`SignageBoardView` へ `adLink=null`（リンク非生成）・`onAdTap=noop` で渡す。クリックは親
 * （エディタ）が扱うので盤面自身はリンクを張らない（read-only）。
 *
 * 広告は既定で `payload.ads` の**先頭を静止表示**する。ただし `adIndex` を渡すと**そのインデックスの広告**を
 * 出し、ローテーションドットも表示する（回転の駆動＝`setTimeout` は持たず、index は client の親が
 * {@link useAdRotation} で供給する＝本部品は hooks-free のまま）。サムネ / モニタの壁は `adIndex` を渡さず従来の
 * 先頭静止のまま。時計（`now`）も同様で、省略時は非表示。
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
  now = null,
  adIndex,
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
  /**
   * ヘッダーに出す実時計（任意）。**省略時（既定 null）は時計を出さない**＝サムネ / モニタの壁の静的描画は
   * 従来どおり不変。WYSIWYG エディタ（client）が live TV と同じ 1 秒刻みの `Date` を渡すと、編集プレビューの
   * ヘッダーが実盤面（`SignageClient`）と一致して「実機にどう出るか」がより正確になる（ヘッダー差の縮小）。
   * 静的に渡るサムネ等は now を渡さない（SSR/サーバ描画でも非決定にならない）。
   */
  now?: Date | null;
  /**
   * **表示する広告のインデックス**（任意）。**省略時（既定 undefined）は従来どおり先頭広告を静止表示**し
   * ドットも出さない（サムネ / モニタの壁は不変）。client の親（WYSIWYG エディタ）が {@link useAdRotation} で
   * 算出した回転 index を渡すと、その広告を表示しローテーションドットも出る＝実機の見え方に一致する。
   * 本部品は依然 hooks-free（回転の `setTimeout` は親が持つ）。範囲外値は内部で丸める。
   */
  adIndex?: number;
}) {
  // 広告: adIndex 指定時はその（範囲内に丸めた）広告を表示しドットを出す（親が供給する回転 index）。未指定は
  // 先頭を静止表示（サムネ / モニタの壁の従来挙動）。空なら null（広告枠は空表示）。回転の駆動は親が持つ。
  const adCount = payload.ads.length;
  const rotating = adIndex != null;
  const safeIndex = rotating ? clampIndex(adIndex, adCount) : 0;
  const ad = adCount > 0 ? (payload.ads[safeIndex] ?? null) : null;
  // ドットは adCount>1 のとき出る。静止表示（未指定）時は従来どおり ad?1:0 でドットを出さない。
  const displayAdCount = rotating ? adCount : ad ? 1 : 0;
  // width 指定時のみインラインでスケールを固定する（未指定時は CSS の cqw 既定にまかせる）。
  const frameStyle: React.CSSProperties | undefined =
    width != null
      ? ({ width: `${width}px`, "--sb-scale": `${width / 1280}` } as React.CSSProperties)
      : undefined;
  return (
    <div className={scaler.frame} style={frameStyle}>
      {/* .scaledStage: ステージ内は §12 の大型モニタプロファイル（≥1800px=×1.35 / ≥3000px=×2）を中和し
          720p 基底プロファイルを固定する（signage.module.css §15）。これがないと職員室のフル HD 画面で
          盤面が 1280×720 を超過し frame の overflow:hidden で見切れる。 */}
      <div className={`${scaler.stage} ${boardStyles.scaledStage}`}>
        <SignageBoardView
          data={payload}
          ad={ad}
          // 静的サムネはタップ不可・リンク非生成。クリックは親が扱う（read-only）。
          adLink={null}
          // adIndex 指定時は実件数 + 回転 index（ドット表示）。未指定は先頭静止（ドット無し）。
          adCount={displayAdCount}
          safeIndex={safeIndex}
          // 時計は呼び出し側が渡したときだけ出す（既定 null＝静的スナップショットは従来どおり時計なし）。
          now={now}
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
