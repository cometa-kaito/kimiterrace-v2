/**
 * ADR-032: 教員「学校共通パスワード」のパスワードポリシー（純ロジック・client-safe）。
 *
 * ユーザー判断で **4 文字以上**の共通パスワードを許容する（学校の運用負荷を最優先）。短いパスワードは
 * 総当たり耐性が弱いため、ログイン route 側で IP レート制限を併用する（ADR-032 §セキュリティ）。
 * 設定フォーム（system_admin）とログインフォーム（教員）双方からこの規則を参照し単一ソース化する。
 */

export const MIN_TEACHER_PASSWORD_LENGTH = 4;
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
