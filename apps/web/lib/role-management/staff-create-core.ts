/**
 * F11 (#508): 教職員発行の **入力検証の純ロジック・型・定数（単一ソース）**。
 *
 * これまで検証は `member-actions.ts`（"use server"）内に inline で書かれており、client フォームから
 * 再利用できず項目別インライン検証が作れなかった。本モジュールに分離し、Server Action（authoritative）と
 * client フォーム（FormField の前段 UX）の**双方が同じ規則・同じメッセージ**を使えるようにする
 * （schools-core / advertisers-core と同構成）。"use server" でない pure module なので client へ安全に import 可。
 *
 * 値域は users スキーマに合わせる（email=varchar(320)、displayName 上限 100）。メッセージは従来の
 * Server Action 表記をそのまま維持する（既存挙動・テスト不変）。
 */

/** メールアドレスの最小検証（形式 + 長さ）。RFC 完全準拠はしない（送信検証で担保）。 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const STAFF_EMAIL_MAX = 320;
export const STAFF_DISPLAY_NAME_MAX = 100;

/** 教職員発行フォームの**項目別**エラー（FormField のインライン表示用）。エラーの無い項目はキーごと欠落。 */
export type StaffCreateFieldErrors = { email?: string; displayName?: string };

/**
 * クライアント側の項目別検証（FormField のインライン表示用）。Server Action と**同じ規則**で項目別
 * メッセージに分解する。メッセージは従来の Server 表記を維持。
 */
export function collectStaffCreateFieldErrors(raw: {
  email?: unknown;
  displayName?: unknown;
}): StaffCreateFieldErrors {
  const errors: StaffCreateFieldErrors = {};
  const email = typeof raw.email === "string" ? raw.email.trim() : "";
  const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  if (!EMAIL_RE.test(email) || email.length > STAFF_EMAIL_MAX) {
    errors.email = "メールアドレスの形式が不正です。";
  }
  if (displayName.length === 0 || displayName.length > STAFF_DISPLAY_NAME_MAX) {
    errors.displayName = "表示名を入力してください (100 文字以内)。";
  }
  return errors;
}

/** 項目別エラーが 1 件でもあるか。 */
export function hasStaffCreateFieldErrors(errors: StaffCreateFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** 検証済みの教職員発行入力（トリム済み）。 */
export type StaffCreateInput = { email: string; displayName: string };

type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Server Action 用の入力検証。項目別検証の**最初のエラー**を単一メッセージで返す（従来挙動）。
 * 正常時はトリム済みの値を返す。client の `collectStaffCreateFieldErrors` と同じ規則・メッセージ。
 */
export function validateStaffCreate(raw: {
  email?: unknown;
  displayName?: unknown;
}): Validated<StaffCreateInput> {
  const errors = collectStaffCreateFieldErrors(raw);
  if (errors.email) {
    return { ok: false, message: errors.email };
  }
  if (errors.displayName) {
    return { ok: false, message: errors.displayName };
  }
  const email = typeof raw.email === "string" ? raw.email.trim() : "";
  const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  return { ok: true, value: { email, displayName } };
}
