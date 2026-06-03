// 型・定数は **client-safe な /schema サブパス** や enum 由来の値域から組み立てる。barrel
// (`@kimiterrace/db`) は client.ts 経由で postgres を引き込み、"use client" のフォームにバンドルされると
// next build が落ちる (#148 の罠)。`import type` なので enum のランタイム値も postgres も持ち込まない
// (command-core.ts と同方針)。許可値・ラベルは下記 satisfies で DB enum とズレないことを保証する。
import type { AdvertiserStatus } from "@kimiterrace/db/schema";

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

/** 広告主ステータスの型 (単一ソース)。DB enum (`advertiser_status`) 由来で手書き union を作らない。 */
export type { AdvertiserStatus };

/**
 * 営業ステータスの日本語ラベル (見込/契約中/休止)。`satisfies Record<AdvertiserStatus, string>` で
 * **DB enum の全値を網羅し余剰キーを持たない**ことをコンパイル時に強制する (enum を末尾追加したら
 * ここがコンパイルエラーになり気付ける = ルール3 の値域単一ソース)。順序は UI のセレクト並びに使う。
 */
export const ADVERTISER_STATUS_LABEL = {
  prospect: "見込み",
  active: "契約中",
  paused: "休止",
} as const satisfies Record<AdvertiserStatus, string>;

/** セレクトに添える説明 (UX: 各ステータスの意味を一言で)。enum 全値を網羅する。 */
export const ADVERTISER_STATUS_DESCRIPTION = {
  prospect: "提案・商談中（未契約）",
  active: "契約中（配信対象）",
  paused: "休止（配信対象外）",
} as const satisfies Record<AdvertiserStatus, string>;

/** フォームのセレクト並び順。enum 全値を列挙する (見込 → 契約中 → 休止)。 */
export const ADVERTISER_STATUS_ORDER: readonly AdvertiserStatus[] = [
  "prospect",
  "active",
  "paused",
];

/**
 * 受け取った値が許可ステータスか (クライアント自由入力の検証)。`Object.hasOwn` で **自身のキー**のみ
 * 判定し、`in` 演算子の prototype チェーン誤判定 ("toString" 等を真と誤認) を避ける (command-core と同方針)。
 */
export function isAdvertiserStatus(value: unknown): value is AdvertiserStatus {
  return typeof value === "string" && Object.hasOwn(ADVERTISER_STATUS_LABEL, value);
}

/**
 * `status` と `is_active` の不変条件 (advertisers schema doc / PR #534): `status='paused' ⟺ is_active=false`、
 * `status∈{prospect,active} ⟺ is_active=true`。create/update/toggle の各 Action がこの導出で両者を整合させる。
 */
export function isActiveForStatus(status: AdvertiserStatus): boolean {
  return status !== "paused";
}

/** 検証済みの広告主作成入力。任意項目は未指定を null に正規化する。status は既定 'prospect'。 */
export type AdvertiserCreateInput = {
  companyName: string;
  industry: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  notes: string | null;
  status: AdvertiserStatus;
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
  status?: unknown;
}): Validated<AdvertiserCreateInput> {
  const companyName = required(raw.companyName, COMPANY_MAX);
  if (!companyName) {
    return { ok: false, message: `会社名は 1〜${COMPANY_MAX} 文字で入力してください。` };
  }

  // status: 未指定は既定 'prospect' (新規行)。指定時は 3 値の membership を enum 由来で検証する。
  let status: AdvertiserStatus = "prospect";
  if (raw.status !== undefined && raw.status !== null && raw.status !== "") {
    if (!isAdvertiserStatus(raw.status)) {
      return { ok: false, message: "ステータスの指定が不正です。" };
    }
    status = raw.status;
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
    value: { companyName, industry, contactEmail, contactPhone, address, notes, status },
  };
}
