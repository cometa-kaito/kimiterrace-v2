/**
 * F03 PII マスキングの型（CLAUDE.md ルール4）。
 *
 * 名簿（ロスター）由来の確実な PII を `PiiEntry` として渡し、確定トークン化する。表記揺れは
 * `aliases` に列挙すると同一トークンへ集約され、逆変換時は正規表記 `value` に戻る。
 */

/** PII のカテゴリ。トークン接頭辞になる（例 `{{STUDENT_001}}`）。 */
export type PiiCategory = "STUDENT" | "GUARDIAN" | "STAFF";

/** 名簿の 1 エントリ。`value` が正規表記、`aliases` は同義の表記揺れ。 */
export interface PiiEntry {
  value: string;
  category: PiiCategory;
  aliases?: string[];
}

/** パターン検出（電話・メール）の ON/OFF。既定はいずれも ON。 */
export interface MaskOptions {
  detectPhones?: boolean;
  detectEmails?: boolean;
}

/** マスク結果。`dictionary` は token → 正規表記で、`unmaskPII` の逆変換に使う。 */
export interface MaskResult {
  masked: string;
  dictionary: Record<string, string>;
}
