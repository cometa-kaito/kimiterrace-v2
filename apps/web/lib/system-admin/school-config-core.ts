/**
 * UIUX-03: 学校設定 (school_configs) の value (jsonb) テキスト編集の純粋ロジック。
 *
 * `"use server"` ファイル (school-config-actions.ts) は async 関数しか export できない Next の制約、
 * かつ Client Component は barrel (`@kimiterrace/db`) を import できない (#181: postgres ランタイムが
 * client bundle に混入し next build を落とす) ため、検証ロジックはここに分離する
 * (schools-core.ts と同じ構成)。クライアント側の事前検証と Server Action 側の authoritative 検証が
 * **同じ規則**になる単一ソース。
 */

/** value (jsonb) テキスト入力の上限文字数 (誤貼り付け・巨大ペイロードの安全側ガード)。 */
export const CONFIG_VALUE_TEXT_MAX = 20_000;

/** JSON テキスト検証の結果。失敗はユーザー向けメッセージを返し UI 側でインライン表示する。 */
export type ParsedConfigValue =
  | { ok: true; value: Record<string, unknown> | unknown[] }
  | { ok: false; message: string };

/**
 * textarea の JSON テキストを検証して jsonb 保存値に変換する。
 *
 * - パース不可 → エラー (パーサのメッセージを併記し、どこが壊れているか手掛かりを残す)。
 * - トップレベルが object / 配列以外 (scalar / null) → エラー。jsonb 列としては合法だが、既存の
 *   読み取り契約 (quiet-hours-core の `{ ranges: [...] }` 等) はコンテナ前提で、scalar はほぼ確実に
 *   入力ミス (引用符忘れ等) のため安全側で弾く。配列は V1 由来の値形を壊さないよう許容する。
 */
export function parseConfigValueText(text: string): ParsedConfigValue {
  if (text.trim() === "") {
    return { ok: false, message: "JSON を入力してください。" };
  }
  if (text.length > CONFIG_VALUE_TEXT_MAX) {
    return {
      ok: false,
      message: `JSON は ${CONFIG_VALUE_TEXT_MAX.toLocaleString("ja-JP")} 文字以内で入力してください。`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `JSON として解釈できません: ${detail}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {
      ok: false,
      message: "JSON のトップレベルはオブジェクトまたは配列にしてください。",
    };
  }
  return { ok: true, value: parsed as Record<string, unknown> | unknown[] };
}
