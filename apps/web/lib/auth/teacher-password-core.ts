/**
 * ADR-032: 教員「学校共通パスワード」のパスワードポリシー（純ロジック・client-safe）。
 *
 * 共通パスワードは **Identity Platform の email/password アカウントのパスワードそのもの**（ADR-032）。
 * Identity Platform は最小 **6 文字**を下限とし（パスワードポリシーの最小長は 6〜30 で設定可能・6 未満は不可）、
 * これより短いと `createUser`/`updateUser` が `auth/invalid-password` で拒否し、設定アクションが失敗する
 * （prod で 6 文字未満を設定するとエラーバウンダリに落ちた不具合の根因）。よって本ポリシーの下限も IdP に
 * 揃えて **6 文字**とする。学校には覚えやすい **英数字 6 文字以上**を案内する（数字のみは総当たりに弱いので避ける）。
 * 短いほど総当たりに弱いため、ログイン route 側で IP レート制限を併用する（ADR-032 §セキュリティ）。
 * 設定フォーム（system_admin）とログインフォーム（教員）双方からこの規則を参照し単一ソース化する。
 */

export const MIN_TEACHER_PASSWORD_LENGTH = 6;
export const MAX_TEACHER_PASSWORD_LENGTH = 128;

export type TeacherPasswordPolicyResult = { ok: true } | { ok: false; message: string };

/** 共通パスワードがポリシーを満たすか検証する（設定時に使用）。 */
export function validateTeacherPasswordPolicy(plain: unknown): TeacherPasswordPolicyResult {
  if (typeof plain !== "string" || plain.length < MIN_TEACHER_PASSWORD_LENGTH) {
    return {
      ok: false,
      message: `パスワードは ${MIN_TEACHER_PASSWORD_LENGTH} 文字以上で設定してください。`,
    };
  }
  if (plain.length > MAX_TEACHER_PASSWORD_LENGTH) {
    return {
      ok: false,
      message: `パスワードは ${MAX_TEACHER_PASSWORD_LENGTH} 文字以内で設定してください。`,
    };
  }
  return { ok: true };
}
