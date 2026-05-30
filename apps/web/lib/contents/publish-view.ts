import type { PublishScopeValue } from "./publish-core";

/**
 * F04 安全網 UI の**純粋プレゼンテーションロジック** (副作用なし、node でテスト可能)。
 *
 * 表示の出し分け (公開先ラベル・確信度フラグ閾値・状態バッジ) を純関数/定数に切り出し、
 * React コンポーネント (`_components/*`) はこれを描画するだけにする (lib/nav.ts と同方針)。
 * 認可・実データは Server Action + RLS が担保するので、ここはあくまで見せ方。
 */

/** content の公開状態 (Drizzle `contentStatus` enum と対応)。 */
export type ContentStatusValue = "draft" | "published" | "archived";

/** 公開先スコープ 1 選択肢 (F04.4 公開先明示セレクタ用)。 */
export type ScopeOption = {
  value: PublishScopeValue;
  label: string;
  /** 補助説明 (誰に見えるか)。曖昧さを排し明示選択を促す (F04.4)。 */
  description: string;
};

/**
 * F04.4: 公開先の選択肢。
 *
 * 要件「曖昧な『全校』ボタンを設けず、明示選択させる」に従い:
 * - **狭い範囲 (クラス) を先頭**に並べ、全校をリスト末尾側に置く (全校を既定/目立たせない)。
 * - どれも既定選択にしない (セレクタ側で初期未選択 → ユーザーに明示選択させる)。
 * - 各選択肢に「誰に見えるか」の説明を必ず添える。
 */
export const SCOPE_OPTIONS: readonly ScopeOption[] = [
  { value: "class", label: "クラス", description: "指定したクラスの生徒のみに公開" },
  { value: "homeroom", label: "ホームルーム", description: "担任するホームルームの生徒に公開" },
  { value: "private", label: "下書き（自分のみ）", description: "公開せず自分だけが見られる" },
  { value: "school", label: "全校", description: "全校生徒に公開（影響範囲が最も広い）" },
] as const;

const SCOPE_LABEL: Record<PublishScopeValue, string> = {
  class: "クラス",
  homeroom: "ホームルーム",
  private: "下書き（自分のみ）",
  school: "全校",
};

/** 公開先スコープの表示名。 */
export function scopeLabel(value: PublishScopeValue): string {
  return SCOPE_LABEL[value];
}

const STATUS_LABEL: Record<ContentStatusValue, string> = {
  draft: "下書き",
  published: "公開中",
  archived: "非公開",
};

/** 公開状態の表示名。 */
export function statusLabel(status: ContentStatusValue): string {
  return STATUS_LABEL[status];
}

/** 公開状態の配色トーン (バッジ色分け用)。 */
export function statusTone(status: ContentStatusValue): "neutral" | "success" | "muted" {
  switch (status) {
    case "published":
      return "success";
    case "archived":
      return "muted";
    default:
      return "neutral";
  }
}

/** F04.3 確信度フラグの既定閾値。これ未満は「⚠️ 要確認」。 */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.7;

/**
 * F04.3: AI 確信度が低く「要確認」バッジを出すべきか。
 *
 * - `score` が閾値未満なら true (要確認)。
 * - `score` が undefined / null (= AI 由来でない、または確信度未取得) は false
 *   (フラグを出さない。人手作成コンテンツに誤った警告を付けない)。
 */
export function needsReview(
  score: number | null | undefined,
  threshold = REVIEW_CONFIDENCE_THRESHOLD,
): boolean {
  if (score === null || score === undefined) {
    return false;
  }
  return score < threshold;
}
