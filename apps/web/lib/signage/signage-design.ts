import { type TenantTx, getSchoolConfigValue } from "@kimiterrace/db";
import { type SignageDesignPattern, parseSignageDesignPattern } from "./design-pattern";

/**
 * **server 専用**のサイネージデザイン解決（school_configs 読み取り）。
 *
 * 定数・型・型ガード・URL ヘルパ（端末別 `?design` の合成/抽出）は client-safe な `./design-pattern` に
 * 集約し（postgres 非依存。"use client" な TV 設定フォームからも import 可）、本ファイルは barrel
 * `@kimiterrace/db`（postgres を引き込む）に依存する**学校レベル既定の読み取り**だけを持つ。端末別デザインは
 * `tv_devices.signage_url` の `?design=patternN` で表し（スキーマ非変更）、未指定時に本関数の学校レベル
 * 既定へ、それも無ければ `pattern1` に倒す（fail-soft）。
 */

// client-safe 層の公開 API を本 server モジュールからも引けるよう re-export（既存 import 元を壊さない）。
export {
  DEFAULT_SIGNAGE_DESIGN_PATTERN,
  SIGNAGE_DESIGN_PATTERNS,
  SIGNAGE_DESIGN_PATTERN_LABELS,
  SIGNAGE_SCHEDULE_DAY_COUNT,
  type SignageDesignPattern,
  isSignageDesignPattern,
  parseSignageDesignPattern,
  signageScheduleDayCount,
} from "./design-pattern";

/**
 * 自校の**学校レベル既定**サイネージデザインパターンを読む（端末別 `?design` 未指定時のフォールバック。
 * `getSignageDisplayData` のテナント context tx 内で呼ぶ）。`school_configs`（scope='school',
 * kind='display_settings'）の `value.signageDesign` を解決。RLS で自校に限定（ルール2）。未設定なら既定
 * `pattern1`。
 */
export async function getSignageDesignPattern(tx: TenantTx): Promise<SignageDesignPattern> {
  const value = await getSchoolConfigValue(tx, "display_settings");
  return parseSignageDesignPattern(value);
}
