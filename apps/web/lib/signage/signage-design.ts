import { type TenantTx, getSchoolConfigValue } from "@kimiterrace/db";
import { type SignageDesignPattern, parseSignageDesignPattern } from "./design-pattern";

/**
 * **server 専用**のサイネージ表示設定の読み取り（school_configs display_settings）。
 *
 * 定数・型・型ガード・URL ヘルパ（端末別 `?design` の合成/抽出）は client-safe な `./design-pattern` に
 * 集約し（postgres 非依存。"use client" な TV 設定フォームからも import 可）、本ファイルは barrel
 * `@kimiterrace/db`（postgres を引き込む）に依存する**学校スコープ display_settings の読み取り**だけを持つ。
 * 端末別デザインは `tv_devices.signage_url` の `?design=patternN` で表し（スキーマ非変更）、未指定時に
 * 学校レベル既定（`value.signageDesign`）へ、それも無ければ `pattern1` に倒す（fail-soft）。
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
 * 自校の**学校スコープ** `display_settings` config の `value`（JSONB, opaque）を 1 回読む
 * （`getSignageDisplayData` / エディタの自校 RLS tx 内で呼ぶ）。同じ行に `signageDesign`（学校既定デザイン）・
 * `assignmentDeadlineFormat`（提出物の期日表示形式・#1258）・`editorDayCutover` が相乗りしているため、
 * 呼び出し側は本関数の戻り値を各 `parse*`（defensive・fail-soft）に通して複数キーを **1 round-trip** で
 * 解決する。RLS で自校に限定（ルール2）。行が無ければ null（各 parse が既定に倒す）。
 */
export async function getSchoolDisplaySettings(tx: TenantTx): Promise<unknown | null> {
  return await getSchoolConfigValue(tx, "display_settings");
}

/**
 * 自校の**学校レベル既定**サイネージデザインパターンを読む（端末別 `?design` 未指定時のフォールバック）。
 * {@link getSchoolDisplaySettings} + `parseSignageDesignPattern` の薄い合成。未設定なら既定 `pattern1`。
 * 同じ tx で他の display_settings キーも要る場合は本関数でなく {@link getSchoolDisplaySettings} を 1 回
 * 読んで各 parse に通す（round-trip を増やさない・`buildSignagePayloadForClass` 参照）。
 */
export async function getSignageDesignPattern(tx: TenantTx): Promise<SignageDesignPattern> {
  return parseSignageDesignPattern(await getSchoolDisplaySettings(tx));
}
