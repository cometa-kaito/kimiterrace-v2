import {
  ContentNotFoundError,
  NoActivePublishError,
  type PublishActor,
  VersionNotFoundError,
} from "@kimiterrace/db";
import type { AuthUser } from "../auth/session";

/**
 * F04 Server Actions の**純粋コア** (検証 / actor 解決 / エラーマッピング / 型)。
 *
 * `publish-actions.ts` は `"use server"` ファイルで、Next の制約上 **async 関数しか export
 * できない**。そこで非同期でない純粋ロジック・型・定数はこのモジュールに分離し、actions と
 * テストの両方から import する (node 環境で副作用なく unit テストできる)。
 */

/** 公開操作を許可するロール。system_admin は school に属さない (cross-tenant) ため除外。 */
export const PUBLISHER_ROLES = ["school_admin", "teacher"] as const;

/**
 * 公開先スコープの許可値。実体は Drizzle `publishScope` enum (packages/db) が単一ソースで、
 * DB INSERT 時に enum 型が最終強制する (ルール3)。ここでは Next バンドルに enum のランタイム値を
 * 引き込まない方針 (lib/auth/session.ts と同じ) のためローカル宣言し、入力の早期検証にのみ使う。
 */
export const PUBLISH_SCOPES = ["school", "class", "homeroom", "private"] as const;
export type PublishScopeValue = (typeof PUBLISH_SCOPES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server Action の戻り値。例外を投げ返さず、UI が分岐できる discriminated union にする。 */
export type ActionResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      code: "invalid_input" | "not_found" | "no_active_publish" | "version_not_found" | "forbidden";
      message: string;
    };

export type ActionError = Extract<ActionResult<never>, { ok: false }>;

/** content 更新 patch の生入力 (フォーム / クライアントから来る、未検証)。 */
export type UpdateContentInput = {
  title?: string;
  body?: string;
  publishScope?: string;
  targets?: unknown;
};

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isPublishScope(value: unknown): value is PublishScopeValue {
  return typeof value === "string" && (PUBLISH_SCOPES as readonly string[]).includes(value);
}

/** invalid_input エラーを作る。 */
export function invalid(message: string): ActionError {
  return { ok: false, code: "invalid_input", message };
}

/** forbidden エラーを作る。 */
export function forbidden(message: string): ActionError {
  return { ok: false, code: "forbidden", message };
}

/**
 * 認証済み user から publish actor を作る。テナントロールは schoolId 必須。
 * schoolId が無い (= system_admin / 異常) なら null を返し、呼出側が forbidden に倒す。
 */
export function toActor(user: AuthUser): PublishActor | null {
  if (!user.schoolId) {
    return null;
  }
  return { userId: user.uid, schoolId: user.schoolId };
}

/** ドメイン例外を ActionResult のエラーにマッピングする (純粋関数、テスト対象)。 */
export function mapDomainError(error: unknown): ActionError {
  if (error instanceof ContentNotFoundError) {
    return { ok: false, code: "not_found", message: "コンテンツが見つかりません。" };
  }
  if (error instanceof NoActivePublishError) {
    return { ok: false, code: "no_active_publish", message: "公開中のバージョンがありません。" };
  }
  if (error instanceof VersionNotFoundError) {
    return { ok: false, code: "version_not_found", message: "指定したバージョンが存在しません。" };
  }
  // 想定外の例外は握りつぶさず再 throw (Next がログ + 500 にする。秘密を結果に載せない)。
  throw error;
}
