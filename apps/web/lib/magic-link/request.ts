import type { TenantRole } from "@kimiterrace/db";

/**
 * F05: magic link 発行 API のリクエスト検証 (pure、副作用なし = mock 不要で unit テスト可能)。
 */

/**
 * magic link を発行・失効できるロール。生徒/保護者は不可。
 * system_admin は school に属さない (schoolId=null) ためテナント所属リンクを発行できず除外。
 * `satisfies` で TenantRole の妥当性をコンパイル時に担保 (ルール3)。
 */
export const MAGIC_LINK_ISSUER_ROLES = [
  "teacher",
  "school_admin",
] as const satisfies readonly TenantRole[];

export function isIssuerRole(role: TenantRole): boolean {
  return (MAGIC_LINK_ISSUER_ROLES as readonly TenantRole[]).includes(role);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** 有効期限の許容範囲 (日)。F05 既定 90 日、教員が短縮/延長する場合の上下限。 */
export const EXPIRES_MIN_DAYS = 1;
export const EXPIRES_MAX_DAYS = 365;

export type ParsedIssueBody = {
  classId: string;
  /** 未指定なら DB デフォルト (90 日)。指定時は範囲内の整数。 */
  expiresInDays?: number;
};

export type ParseResult = { ok: true; value: ParsedIssueBody } | { ok: false; error: string };

/**
 * 発行リクエストの body を検証する。
 * - `classId`: UUID 必須。
 * - `expiresInDays`: 省略可。指定時は `EXPIRES_MIN_DAYS..EXPIRES_MAX_DAYS` の整数。
 *
 * テナント所属チェック (classId が自校のクラスか) は RLS 下の DB クエリで行う (ここではしない)。
 */
export function parseIssueBody(body: unknown): ParseResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "invalid_body" };
  }
  const { classId, expiresInDays } = body as {
    classId?: unknown;
    expiresInDays?: unknown;
  };

  if (!isUuid(classId)) {
    return { ok: false, error: "invalid_class_id" };
  }

  if (expiresInDays === undefined || expiresInDays === null) {
    return { ok: true, value: { classId } };
  }

  if (
    typeof expiresInDays !== "number" ||
    !Number.isInteger(expiresInDays) ||
    expiresInDays < EXPIRES_MIN_DAYS ||
    expiresInDays > EXPIRES_MAX_DAYS
  ) {
    return { ok: false, error: "invalid_expires_in_days" };
  }

  return { ok: true, value: { classId, expiresInDays } };
}

/** `expiresInDays` 日後の有効期限を算出する。`now` を注入してテスト可能にする。 */
export function computeExpiresAt(expiresInDays: number, now: Date): Date {
  return new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000);
}

export type ParsedExtendBody = { expiresInDays: number };

export type ExtendParseResult =
  | { ok: true; value: ParsedExtendBody }
  | { ok: false; error: string };

/**
 * 期限更新リクエストの body を検証する (F05: 教員 UI からの短縮/延長)。
 * 発行 (`parseIssueBody`) と違い `expiresInDays` は **必須** — 「今から N 日」を明示する操作のため
 * 省略は許さない。範囲は発行と同じ `EXPIRES_MIN_DAYS..EXPIRES_MAX_DAYS` の整数。
 */
export function parseExtendBody(body: unknown): ExtendParseResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "invalid_body" };
  }
  const { expiresInDays } = body as { expiresInDays?: unknown };
  if (
    typeof expiresInDays !== "number" ||
    !Number.isInteger(expiresInDays) ||
    expiresInDays < EXPIRES_MIN_DAYS ||
    expiresInDays > EXPIRES_MAX_DAYS
  ) {
    return { ok: false, error: "invalid_expires_in_days" };
  }
  return { ok: true, value: { expiresInDays } };
}
