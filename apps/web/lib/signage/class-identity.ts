import type { SignageClassContext } from "@kimiterrace/db";

/**
 * #243 (②UI-UX): サイネージのヘッダーに出す「学科 学年 クラス」識別ラベルの整形（純ロジック）。
 *
 * 学校の階層モードにより学科 / 学年が無い場合があるため、存在する要素だけを「学科 → 学年 → クラス」の
 * 順に半角スペースで連結する。全て未設定なら空文字（呼び出し側は何も表示しない）。client/server 双方から
 * 使えるよう純関数にして単体テストで固定する。
 */
export function formatClassIdentity(ctx: SignageClassContext | null | undefined): string {
  if (!ctx) {
    return "";
  }
  return [ctx.departmentName, ctx.gradeName, ctx.className]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s && s.length > 0)
    .join(" ");
}
