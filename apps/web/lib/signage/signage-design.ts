import { type TenantTx, getSchoolConfigValue } from "@kimiterrace/db";

/**
 * 学校ごとに選べる**サイネージ盤面デザインパターン**（#48 / 学校別デザイン）。
 *
 * 公開サイネージ盤面は学校ごとに見た目（レイアウト）を切り替えられる設計にする。各パターンは
 * `SignageClient` 側で専用の盤面コンポーネントに対応づけ（dispatch）、学校の選択に応じて描画を切替える。
 *
 * - `pattern1`: 旧キミテラス v1 レイアウト移植版（予定=今後3平日の3列5行 / 連絡 / 提出物表 / 広告70:30 /
 *   天気ストリップ）。**既定**。今回作成した盤面をこのパターンとして登録する。
 *
 * 選択は `school_configs`（scope='school', kind='display_settings'）の JSON `value.signageDesign` に持つ。
 * **enum/スキーマ変更不要**（display_settings は既存 config_kind）。未設定・不正値は既定 `pattern1`。
 * 将来パターン追加時は本 union と `SignageClient` の dispatch に case を増やすだけで拡張できる。
 */
export const SIGNAGE_DESIGN_PATTERNS = ["pattern1"] as const;

export type SignageDesignPattern = (typeof SIGNAGE_DESIGN_PATTERNS)[number];

/** 未設定・不正値・未知パターン時の既定（今回作成した v1 レイアウト）。 */
export const DEFAULT_SIGNAGE_DESIGN_PATTERN: SignageDesignPattern = "pattern1";

/** 文字列が既知のパターンか型ガードする。 */
export function isSignageDesignPattern(value: unknown): value is SignageDesignPattern {
  return (
    typeof value === "string" && (SIGNAGE_DESIGN_PATTERNS as readonly string[]).includes(value)
  );
}

/**
 * `display_settings` config の `value`（JSONB, opaque）から `signageDesign` を **defensive に**取り出す。
 * 形が想定外・キー欠落・未知パターンはいずれも既定 `pattern1` に倒す（fail-soft、盤面を壊さない）。
 */
export function parseSignageDesignPattern(configValue: unknown): SignageDesignPattern {
  if (configValue && typeof configValue === "object" && !Array.isArray(configValue)) {
    const v = (configValue as Record<string, unknown>).signageDesign;
    if (isSignageDesignPattern(v)) {
      return v;
    }
  }
  return DEFAULT_SIGNAGE_DESIGN_PATTERN;
}

/**
 * 自校のサイネージデザインパターンを読む（`getSignageDisplayData` のテナント context tx 内で呼ぶ）。
 * `school_configs`（scope='school', kind='display_settings'）の `value.signageDesign` を解決。RLS で自校に
 * 限定（ルール2）。未設定なら既定 `pattern1`。
 */
export async function getSignageDesignPattern(tx: TenantTx): Promise<SignageDesignPattern> {
  const value = await getSchoolConfigValue(tx, "display_settings");
  return parseSignageDesignPattern(value);
}
