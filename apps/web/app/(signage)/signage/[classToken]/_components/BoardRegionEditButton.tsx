"use client";

import editStyles from "./BoardRegionEditButton.module.css";

/**
 * WYSIWYG「盤面を編集」の **実エリア直接クリック層**（Approach A）。盤面 `SignageBoardView` の予定 / 連絡 /
 * 提出物の**実セクションそのもの**（`<section>`）を覆い、クリックで下のエディタへ誘導する編集ボタン。
 *
 * ## なぜ別コンポーネント（client）か
 * `SignageBoardView` は Server / Client 両用の純描画層で `"use client"` を**持たない**（live TV はもちろん、
 * モニタの壁＝`ScaledSignageBoard` 経由の Server 描画もある）。`onClick` を持つ本ボタンだけを client 島として
 * 切り出すことで、`SignageBoardView` 本体は server でも描ける性質を保つ。`editRegions`（＝関数 prop を含む）は
 * **WYSIWYG エディタ（client）からのみ**渡るので、Server 経路には関数が渡らず RSC 違反は起きない（呼び出し側で
 * `editRegions` 不在時は本ボタンを一切描かない）。
 *
 * ## 実エリアぴったりを覆う（％近似しない）
 * 親 `<section>`（実セクション）を `position: relative` にした上で本ボタンを `position:absolute; inset:0` で
 * 内側に置く。クリック対象＝実描画要素なので**原理的にズレない**（旧・別レイヤーの％オーバーレイのズレを解消）。
 * ホバー / フォーカスで枠 + 「○○を編集」ラベルを出し、選択中（`active`）は常時うっすら枠を出す。
 *
 * ## a11y
 * 盤面内部の装飾見出し（h2「連絡 / 提出物」等）や region 名は編集モードでは AT から隠し（呼び出し側で
 * `aria-hidden` 化）、領域のアクセシブルな操作名は本ボタンの `aria-label="○○を編集"` が一手に担う。これで
 * 編集器側の見出し・既存 e2e の strict locator と二重化しない。
 */
export type EditRegion = "schedules" | "notices" | "assignments";

/** `SignageBoardView` の `editRegions` prop（編集モードの配線。undefined＝既定は完全に非編集＝出力不変）。 */
export type EditRegionsProps = {
  /** 現在選択中の領域（対応エディタがアクティブ）。null は未選択。 */
  active: EditRegion | null;
  /** 領域クリック時のコールバック（下のエディタへ scroll + focus）。 */
  onRegion: (region: EditRegion) => void;
};

const REGION_LABEL: Record<EditRegion, string> = {
  schedules: "予定",
  notices: "連絡",
  assignments: "提出物",
};

/**
 * 実セクションを覆う編集ボタン。親 `<section>`（`position: relative`）の内側に絶対配置で敷く。
 * `editRegions` 不在時は呼び出し側で描かない（＝非編集の出力は一切変わらない）。
 */
export function BoardRegionEditButton({
  region,
  editRegions,
}: {
  region: EditRegion;
  editRegions: EditRegionsProps;
}) {
  const label = REGION_LABEL[region];
  const active = editRegions.active === region;
  return (
    <button
      type="button"
      className={`${editStyles.regionButton} ${active ? editStyles.regionButtonActive : ""}`}
      aria-label={`${label}を編集`}
      aria-pressed={active}
      onClick={() => editRegions.onRegion(region)}
    >
      <span className={editStyles.regionLabel}>{label}を編集</span>
    </button>
  );
}
