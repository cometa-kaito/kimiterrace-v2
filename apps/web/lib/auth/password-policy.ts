import type { TenantRole } from "@kimiterrace/db";

/**
 * パスワード設定 / 変更フォーム共通の **入力検証 (純ロジック)** と **対象ロール**。
 *
 * - リセットページ (`/reset-password`) と ログイン後のパスワード変更 (`/app/account/password`) の双方が
 *   同じ規則・同じメッセージを使う単一ソース (staff-create-core と同構成)。
 * - 真の強度ポリシーは Identity Platform 側 (最小 6 文字等) でも効くが、ここでは最低限の UX ガード
 *   (長さ + 確認一致) を client / server 双方が共有する。
 */

/** 新パスワードの最小文字数 (Identity Platform 既定 6 より厳しめにし、案内文言と一致させる)。 */
export const MIN_PASSWORD_LENGTH = 8;

export type PasswordValidation = { ok: true } | { ok: false; message: string };

/** 新パスワード + 確認用の検証。最初の違反を単一メッセージで返す。 */
export function validateNewPassword(password: string, confirm: string): PasswordValidation {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: `パスワードは ${MIN_PASSWORD_LENGTH} 文字以上にしてください。` };
  }
  if (password !== confirm) {
    return { ok: false, message: "確認用パスワードが一致しません。" };
  }
  return { ok: true };
}

/**
 * 自分のパスワードを変更できるロール = **個人の email/password アカウント** (school_admin / system_admin)。
 *
 * teacher は学校共通パスワード (ADR-032) でログインし個人パスワードを持たない (共通アカウントを変更すると
 * 学校全体に波及する) ため対象外。共通パスワードの設定は system_admin が学校編集 UI で行う。
 * `/app/account/password` の `requireRole` と nav (`lib/nav.ts`) の両方がこの集合に揃える。
 */
export const PASSWORD_CHANGE_ROLES = [
  "system_admin",
  "school_admin",
] as const satisfies readonly TenantRole[];
