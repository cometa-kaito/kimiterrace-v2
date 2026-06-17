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
export function conflict(message: string): ActionError {
  return { ok: false, error: { code: "conflict", message } };
}
export function notFound(message: string): ActionError {
  return { ok: false, error: { code: "not_found", message } };
}

/**
 * 学年/クラス/学科を操作できるロール。学校横断の system_admin と自校の school_admin。
 * teacher は階層編集不可 (閲覧のみ、UI 側で出し分け)。
 */
export const SCHOOL_HIERARCHY_ROLES = ["school_admin", "system_admin"] as const;

/**
 * mutation の実行者。`schoolId` は RLS WITH CHECK 充足 + 監査の school_id に使う。
 *
 * **監査 actor の二系統 (CLAUDE.md ルール1 / system_admin は users 表に行を持たない)**:
 * - `actorUserId`: `audit_log.actor_user_id` に入れる「操作者 uid」。`tenantScoped` 降格後
 *   (system_admin → school_admin) は `audit_log_insert` policy (0005) が
 *   `actor_user_id = app.current_user_id` を要求するため、常に acting uid を入れる
 *   (school_admin はこれが users.id でもある)。`actor_user_id` に FK は無い。
 * - `userRef`: `created_by` / `updated_by` (users.id への FK) に入れる値。system_admin は users 行を
 *   持たないため **null** (= システム / テナント外作成、FK 違反回避)。school_admin は自身の users.id。
 * - `identityUid`: `audit_log.actor_identity_uid` (IdP uid キャッシュ)。system_admin のみ記録し、
 *   school_admin は従来どおり null のまま (既存挙動を変えない)。
 */
export type HubActor = {
  actorUserId: string;
  userRef: string | null;
  identityUid: string | null;
  schoolId: string;
};

/**
 * AuthUser を mutation actor に変換する。
 *
 * - **system_admin**: テナント外 (session schoolId は null) のため、対象校 `targetSchoolId` を**明示**で
 *   受け取りそれを actor の schoolId にする。未指定 / UUID でないときは null (呼出側が forbidden 化)。
 *   `userRef` は null (users 行が無い → created_by/updated_by の FK 回避)、`identityUid` に uid を残す。
 * - **tenant ロール (school_admin)**: `targetSchoolId` は**無視**し必ず自校 (`user.schoolId`) に固定する
 *   (越境防止)。自校が無ければ null。
 */
export function toHubActor(user: AuthUser, targetSchoolId?: string): HubActor | null {
  if (user.role === "system_admin") {
    if (!isUuid(targetSchoolId)) {
      return null;
    }
    return {
      actorUserId: user.uid,
      userRef: null,
      identityUid: user.uid,
      schoolId: targetSchoolId,
    };
  }
  if (!user.schoolId) {
    return null;
  }
  return {
    actorUserId: user.uid,
    userRef: user.uid,
    identityUid: null,
    schoolId: user.schoolId,
  };
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
export type ClassInput = { gradeId: string; name: string; grade: number };

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
  grade?: unknown;
}): Validated<ClassInput> {
  if (!isUuid(raw.gradeId)) {
    return { ok: false, message: "学年の指定が不正です。" };
  }
  const name = normalizeName(raw.name);
  if (!name) {
    return { ok: false, message: "クラス名は 1〜64 文字で入力してください。" };
  }
  const grade = normalizeInt(raw.grade, 1, 12);
  if (grade === null) {
    return { ok: false, message: "学年の数値は 1〜12 で入力してください。" };
  }
  return { ok: true, value: { gradeId: raw.gradeId, name, grade } };
}

/* ------------------------------------------------------------------ *
 *  update 用入力検証 (#48-K2)
 *
 *  create 系と対称に「id (UUID) + 変更フィールド全置換」を検証する。
 *  patch (部分更新) ではなく**全フィールド置換**にして、UI から来た現在値で
 *  上書きする (省略フィールドを null 化する事故を避ける)。フィールド検証は
 *  create と同じ normalizer を共有する (ルール3 の単一ソース思想を検証層でも維持)。
 * ------------------------------------------------------------------ */

export type DepartmentUpdate = { id: string; name: string; displayOrder: number };
export type GradeUpdate = {
  id: string;
  name: string;
  displayOrder: number;
  hasClasses: boolean;
  departmentId: string | null;
};
export type ClassUpdate = { id: string; name: string; grade: number };

export function validateDepartmentUpdate(raw: {
  id?: unknown;
  name?: unknown;
  displayOrder?: unknown;
}): Validated<DepartmentUpdate> {
  if (!isUuid(raw.id)) {
    return { ok: false, message: "学科の指定が不正です。" };
  }
  const v = validateDepartmentInput(raw);
  if (!v.ok) {
    return v;
  }
  return { ok: true, value: { id: raw.id, ...v.value } };
}

export function validateGradeUpdate(raw: {
  id?: unknown;
  name?: unknown;
  displayOrder?: unknown;
  hasClasses?: unknown;
  departmentId?: unknown;
}): Validated<GradeUpdate> {
  if (!isUuid(raw.id)) {
    return { ok: false, message: "学年の指定が不正です。" };
  }
  const v = validateGradeInput(raw);
  if (!v.ok) {
    return v;
  }
  return { ok: true, value: { id: raw.id, ...v.value } };
}

export function validateClassUpdate(raw: {
  id?: unknown;
  name?: unknown;
  grade?: unknown;
}): Validated<ClassUpdate> {
  if (!isUuid(raw.id)) {
    return { ok: false, message: "クラスの指定が不正です。" };
  }
  const name = normalizeName(raw.name);
  if (!name) {
    return { ok: false, message: "クラス名は 1〜64 文字で入力してください。" };
  }
  const grade = normalizeInt(raw.grade, 1, 12);
  if (grade === null) {
    return { ok: false, message: "学年の数値は 1〜12 で入力してください。" };
  }
  return { ok: true, value: { id: raw.id, name, grade } };
}

/** delete 系の入力: id (UUID) のみ。 */
export function validateId(raw: unknown): Validated<{ id: string }> {
  if (!isUuid(raw)) {
    return { ok: false, message: "指定が不正です。" };
  }
  return { ok: true, value: { id: raw } };
}

/* ------------------------------------------------------------------ *
 *  表示順の一括並べ替え (#48-K3 UX hardening)
 *
 *  学科 / 学年の兄弟集合を新しい並び順（orderedIds）で受け取り、displayOrder=0..n-1 を
 *  **単一 tx で原子的に**反映する Server Action の入力検証。クラスは並べ替え列が無いため対象外。
 * ------------------------------------------------------------------ */

export type ReorderEntity = "department" | "grade";
export type ReorderInput = { entity: ReorderEntity; orderedIds: string[] };

/** 一括並べ替え入力: entity（学科/学年）+ 重複なし UUID 配列（1..1000 件）。 */
export function validateReorder(raw: {
  entity?: unknown;
  orderedIds?: unknown;
}): Validated<ReorderInput> {
  if (raw.entity !== "department" && raw.entity !== "grade") {
    return { ok: false, message: "並べ替え対象の種別が不正です。" };
  }
  if (!Array.isArray(raw.orderedIds) || raw.orderedIds.length === 0) {
    return { ok: false, message: "並べ替え対象がありません。" };
  }
  if (raw.orderedIds.length > 1000) {
    return { ok: false, message: "一度に並べ替えられる件数を超えています。" };
  }
  const seen = new Set<string>();
  const orderedIds: string[] = [];
  for (const id of raw.orderedIds) {
    if (!isUuid(id)) {
      return { ok: false, message: "並べ替え対象の指定が不正です。" };
    }
    if (seen.has(id)) {
      return { ok: false, message: "並べ替え対象に重複があります。" };
    }
    seen.add(id);
    orderedIds.push(id);
  }
  return { ok: true, value: { entity: raw.entity, orderedIds } };
}
