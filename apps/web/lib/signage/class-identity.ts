import type { SignageClassContext } from "@kimiterrace/db";

/**
 * #243 (②UI-UX): サイネージのヘッダーに出す識別ラベルの整形（純ロジック）。
 *
 * 学校の階層モードで連結要素が変わる:
 *   - 学科制（departmentName あり）: 「学科 学年」（例「電子工学科 1年」）。**組（className）は出さない**。
 *     学科制では各「学科 × 学年」に組は 1 つだけの構造上のプレースホルダ（実体「A組」）で識別子に
 *     ならないため（BUG-3）。
 *   - クラス制（departmentName なし）: 「学年 組」（例「1年 1組」）。
 * 存在する要素だけを半角スペースで連結し、全て未設定なら空文字（呼び出し側は何も表示しない）。
 * client/server 双方から使えるよう純関数にして単体テストで固定する。
 */
export function formatClassIdentity(ctx: SignageClassContext | null | undefined): string {
  if (!ctx) {
    return "";
  }
  // 学科（学科制）があるなら組を落とす。空白のみの departmentName は「学科なし」とみなす。
  const parts = ctx.departmentName?.trim()
    ? [ctx.departmentName, ctx.gradeName]
    : [ctx.gradeName, ctx.className];
  return parts
    .map((s) => s?.trim())
    .filter((s): s is string => !!s && s.length > 0)
    .join(" ");
}
