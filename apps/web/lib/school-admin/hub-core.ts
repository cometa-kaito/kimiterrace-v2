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
export type ClassUpdate = { id: string; name: string; academicYear: number; grade: number };

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
  academicYear?: unknown;
  grade?: unknown;
}): Validated<ClassUpdate> {
  if (!isUuid(raw.id)) {
    return { ok: false, message: "クラスの指定が不正です。" };
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
  return { ok: true, value: { id: raw.id, name, academicYear, grade } };
}

/** delete 系の入力: id (UUID) のみ。 */
export function validateId(raw: unknown): Validated<{ id: string }> {
  if (!isUuid(raw)) {
    return { ok: false, message: "指定が不正です。" };
  }
  return { ok: true, value: { id: raw } };
}

/* ------------------------------------------------------------------ *
 *  新年度へ複製 (#48-K3 PR3)
 *
 *  departments / grades は年度非依存マスタで、年度を持つのは classes.academic_year のみ。
 *  よって「新年度へ複製」= 現在の最新年度 (source) のクラス群を翌年度 (target=source+1) の空クラス
 *  として複製する (予定/公開内容は複製しない)。学年未割当 (gradeId=null) のクラスは継承先が無く
 *  掲示単位にならないため複製対象外。
 *
 *  注: source は常に最新年度なので、本操作は **実行のたびに 1 年進む**（target は常に未存在の年度）。
 *  単一操作の二重押下は UI のボタン無効化 (useTransition pending) で抑止し、対象年度は確認モーダルで明示する。
 *
 *  並行/再実行による翌年度クラスの重複生成は二段で防ぐ:
 *    1. DB: 部分 unique index ux_classes_school_year_grade_name（恒久ガード・直列化の砦）。
 *    2. app: planNextYearDuplication に「既に target 年度にあるクラス」(existingTargetKeys) を渡し除外
 *       （並行コミットを RLS tx 内で観測できた場合に 23505 を避け graceful skip する防御。観測できない
 *        phantom race は 1 の index が 23505 → conflict に倒す）。
 * ------------------------------------------------------------------ */

export type ClassYearRow = {
  gradeId: string | null;
  name: string;
  grade: number;
  academicYear: number;
};

export type NextYearPlan = {
  sourceYear: number;
  targetYear: number;
  toCreate: { gradeId: string; name: string; grade: number; academicYear: number }[];
};

/**
 * (gradeId, name) を複製の同一性キーにする。gradeId は常に UUID（空白を含まない固定書式）なので、
 * 空白区切りでも先頭の UUID 部分が境界として一意に決まり、name に空白があっても別ペアと衝突しない。
 */
export function classDupKey(gradeId: string, name: string): string {
  return `${gradeId} ${name}`;
}

/**
 * rows（自校の全クラス）から複製の source(最新年度)/target(=source+1) を決める。rows が空なら null。
 * source は常に最新年度ゆえ target は常に未存在年度（本操作は実行のたびに 1 年進む・冪等ではない）。
 * action 側が target 年度の既存クラス取得 (getTargetYearClassKeys) のために先に target を知るのに使う。
 */
export function nextDuplicationYears(
  rows: ClassYearRow[],
): { sourceYear: number; targetYear: number } | null {
  if (rows.length === 0) {
    return null;
  }
  const sourceYear = Math.max(...rows.map((r) => r.academicYear));
  return { sourceYear, targetYear: sourceYear + 1 };
}

/**
 * 現クラス一覧から「翌年度へ複製すべきクラス」を算出する純関数。クラスが無ければ null。
 *
 * @param rows 自校の全クラス（全年度）。source=最新年度 / target=source+1 を決める。
 * @param existingTargetKeys 既に target 年度に存在するクラスの classDupKey 集合。冪等化のため除外する
 *   （並行コミットを RLS tx 内で観測できた場合に重複 insert を避け graceful skip するための防御。観測
 *    できない phantom race の恒久ガードは DB の部分 unique index ux_classes_school_year_grade_name）。
 *   未指定は空集合（除外なし＝従来挙動）。
 */
export function planNextYearDuplication(
  rows: ClassYearRow[],
  existingTargetKeys: ReadonlySet<string> = new Set(),
): NextYearPlan | null {
  const years = nextDuplicationYears(rows);
  if (!years) {
    return null;
  }
  const { sourceYear, targetYear } = years;
  const toCreate = rows
    .filter((r) => r.academicYear === sourceYear && r.gradeId)
    .filter((r) => !existingTargetKeys.has(classDupKey(r.gradeId as string, r.name)))
    .map((r) => ({
      gradeId: r.gradeId as string,
      name: r.name,
      grade: r.grade,
      academicYear: targetYear,
    }));
  return { sourceYear, targetYear, toCreate };
}
