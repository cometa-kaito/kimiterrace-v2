import type { AuthUser } from "../auth/session";

/**
 * 学校管理者ハブ (#48-K) の純粋ロジック・型・定数。
 *
 * `"use server"` ファイル (hub-actions.ts) は async 関数しか export できない Next の制約のため、
 * 検証・型・定数はここに分離する (contents/publish-core.ts と同じ構成)。
 *
 * 注: `ActionResult` 等の汎用ヘルパは contents モジュールにも同等物があるが、機能間結合を避け
 * school-admin を自己完結させるため本ファイルで定義する (将来 `lib/actions/` への共通化候補)。
 */

/** Server Action の結果。失敗は throw せず `{ ok:false }` で返し、UI 側でメッセージ表示する。 */
export type ActionResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: { code: "invalid" | "forbidden" | "conflict" | "not_found"; message: string };
    };

export type ActionError = Extract<ActionResult<never>, { ok: false }>;

export function invalid(message: string): ActionError {
  return { ok: false, error: { code: "invalid", message } };
}
export function forbidden(message: string): ActionError {
  return { ok: false, error: { code: "forbidden", message } };
}

/**
 * 学年/クラス/学科を操作できるロール。学校横断の system_admin と自校の school_admin。
 * teacher は階層編集不可 (閲覧のみ、UI 側で出し分け)。
 */
export const SCHOOL_HIERARCHY_ROLES = ["school_admin", "system_admin"] as const;

/** mutation の実行者。`schoolId` は RLS WITH CHECK 充足 + 監査に使う (テナント外は不可)。 */
export type HubActor = { userId: string; schoolId: string };

/**
 * AuthUser を mutation actor に変換する。school に属さない (school_id null = system_admin で
 * テナント未選択) 場合は null。呼出側が forbidden に変換する。
 */
export function toHubActor(user: AuthUser): HubActor | null {
  if (!user.schoolId) {
    return null;
  }
  return { userId: user.uid, schoolId: user.schoolId };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_MAX = 64;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** 名称: 前後空白を除いた 1..64 文字。空・超過は不正。 */
function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX) {
    return null;
  }
  return trimmed;
}

/** displayOrder: 未指定は 0。整数 0..32767 のみ許可。 */
function normalizeOrder(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return 0;
  }
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 32767) {
    return null;
  }
  return n;
}

function normalizeInt(value: unknown, min: number, max: number): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    return null;
  }
  return n;
}

export type DepartmentInput = { name: string; displayOrder: number };
export type GradeInput = {
  name: string;
  displayOrder: number;
  hasClasses: boolean;
  departmentId: string | null;
};
export type ClassInput = { gradeId: string; name: string; academicYear: number; grade: number };

type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

export function validateDepartmentInput(raw: {
  name?: unknown;
  displayOrder?: unknown;
}): Validated<DepartmentInput> {
  const name = normalizeName(raw.name);
  if (!name) {
    return { ok: false, message: "学科名は 1〜64 文字で入力してください。" };
  }
  const displayOrder = normalizeOrder(raw.displayOrder);
  if (displayOrder === null) {
    return { ok: false, message: "表示順は 0 以上の整数で入力してください。" };
  }
  return { ok: true, value: { name, displayOrder } };
}

export function validateGradeInput(raw: {
  name?: unknown;
  displayOrder?: unknown;
  hasClasses?: unknown;
  departmentId?: unknown;
}): Validated<GradeInput> {
  const name = normalizeName(raw.name);
  if (!name) {
    return { ok: false, message: "学年名は 1〜64 文字で入力してください。" };
  }
  const displayOrder = normalizeOrder(raw.displayOrder);
  if (displayOrder === null) {
    return { ok: false, message: "表示順は 0 以上の整数で入力してください。" };
  }
  // departmentId は任意 (学科モード校のみ)。指定時は UUID 必須。
  let departmentId: string | null = null;
  if (raw.departmentId !== undefined && raw.departmentId !== null && raw.departmentId !== "") {
    if (!isUuid(raw.departmentId)) {
      return { ok: false, message: "学科の指定が不正です。" };
    }
    departmentId = raw.departmentId;
  }
  return {
    ok: true,
    value: { name, displayOrder, hasClasses: raw.hasClasses !== false, departmentId },
  };
}

export function validateClassInput(raw: {
  gradeId?: unknown;
  name?: unknown;
  academicYear?: unknown;
  grade?: unknown;
}): Validated<ClassInput> {
  if (!isUuid(raw.gradeId)) {
    return { ok: false, message: "学年の指定が不正です。" };
  }
  const name = normalizeName(raw.name);
  if (!name) {
    return { ok: false, message: "クラス名は 1〜64 文字で入力してください。" };
  }
  const academicYear = normalizeInt(raw.academicYear, 2000, 2100);
  if (academicYear === null) {
    return { ok: false, message: "年度は 2000〜2100 で入力してください。" };
  }
  const grade = normalizeInt(raw.grade, 1, 12);
  if (grade === null) {
    return { ok: false, message: "学年の数値は 1〜12 で入力してください。" };
  }
  return { ok: true, value: { gradeId: raw.gradeId, name, academicYear, grade } };
}
