/**
 * F10 (#46): 広告主 (CRM) 作成の純粋検証・型・定数。
 *
 * `"use server"` の `advertisers-actions.ts` は async 関数しか export できない Next の制約のため、
 * 検証・型はここに分離する (schools-core と同構成)。`ActionResult` 系の結果ヘルパは system-admin
 * 共通の `schools-core` を再利用する (ドメイン非依存の汎用なので重複定義しない)。
 *
 * 値域は advertisers スキーマの varchar 長に合わせる (ルール3: スキーマが単一ソース)。address / notes は
 * text 列だが、無制限入力を避けるため運用上の上限を設ける。
 */

const COMPANY_MAX = 200;
const INDUSTRY_MAX = 100;
const EMAIL_MAX = 320;
const PHONE_MAX = 50;
const ADDRESS_MAX = 1000;
const NOTES_MAX = 2000;

/** 簡易メール形式 (空白なし・@ の前後・ドメインに `.`)。RFC 完全準拠はしない (送信検証で担保)。 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 検証済みの広告主作成入力。任意項目は未指定を null に正規化する。 */
export type AdvertiserCreateInput = {
  companyName: string;
  industry: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  notes: string | null;
};

type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

/** 前後空白を除いた 1..max 文字。空・超過は null (不正)。 */
function required(value: unknown, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > max ? null : trimmed;
}

/** 任意文字列。未指定/空は null、超過/非文字列は undefined (呼出側が弾く)。 */
function optional(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length > max ? undefined : trimmed;
}

/**
 * 広告主新規作成の入力検証。会社名のみ必須 (1..200)、その他は任意。メールは形式も確認する。
 * 超過長は項目ごとにメッセージを返す。
 */
export function validateAdvertiserCreate(raw: {
  companyName?: unknown;
  industry?: unknown;
  contactEmail?: unknown;
  contactPhone?: unknown;
  address?: unknown;
  notes?: unknown;
}): Validated<AdvertiserCreateInput> {
  const companyName = required(raw.companyName, COMPANY_MAX);
  if (!companyName) {
    return { ok: false, message: `会社名は 1〜${COMPANY_MAX} 文字で入力してください。` };
  }

  const industry = optional(raw.industry, INDUSTRY_MAX);
  if (industry === undefined) {
    return { ok: false, message: `業種は ${INDUSTRY_MAX} 文字以内で入力してください。` };
  }

  const contactEmail = optional(raw.contactEmail, EMAIL_MAX);
  if (contactEmail === undefined) {
    return { ok: false, message: `メールアドレスは ${EMAIL_MAX} 文字以内で入力してください。` };
  }
  if (contactEmail !== null && !EMAIL_RE.test(contactEmail)) {
    return { ok: false, message: "メールアドレスの形式が正しくありません。" };
  }

  const contactPhone = optional(raw.contactPhone, PHONE_MAX);
  if (contactPhone === undefined) {
    return { ok: false, message: `電話番号は ${PHONE_MAX} 文字以内で入力してください。` };
  }

  const address = optional(raw.address, ADDRESS_MAX);
  if (address === undefined) {
    return { ok: false, message: `住所は ${ADDRESS_MAX} 文字以内で入力してください。` };
  }

  const notes = optional(raw.notes, NOTES_MAX);
  if (notes === undefined) {
    return { ok: false, message: `備考は ${NOTES_MAX} 文字以内で入力してください。` };
  }

  return {
    ok: true,
    value: { companyName, industry, contactEmail, contactPhone, address, notes },
  };
}
