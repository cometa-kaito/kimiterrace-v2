import type { SchoolHierarchyMode } from "@kimiterrace/db/schema";

/**
 * #48-L (#123): システム管理者の学校編集の純粋ロジック・型・定数。
 *
 * `"use server"` ファイル (schools-actions.ts) は async 関数しか export できない Next の制約のため、
 * 検証・型・定数はここに分離する (school-admin/hub-core.ts と同じ構成)。型は `@kimiterrace/db/schema`
 * のサブパスから引く: barrel (`@kimiterrace/db`) は postgres ランタイムを client bundle に混入させ
 * next build を落とすため (#181)。本ファイルは `import type` のみなのでランタイム値は引き込まない。
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
 * 階層モードの許可値 (V1 setSchoolHierarchyMode の mode と対応)。
 * `satisfies readonly SchoolHierarchyMode[]` で DB enum とズレないことをコンパイル時に担保 (ルール3)。
 */
export const HIERARCHY_MODES = [
  "class",
  "department",
] as const satisfies readonly SchoolHierarchyMode[];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_MAX = 200;
const PREF_MAX = 32;
const CODE_MAX = 32;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** 前後空白を除いた 1..max 文字。空・超過は null (不正)。 */
function normalizeRequired(value: unknown, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    return null;
  }
  return trimmed;
}

/** 任意文字列。未指定/空は null、超過は不正 (undefined を返して呼出側が弾く)。 */
function normalizeOptional(value: unknown, max: number): string | null | undefined {
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
  if (trimmed.length > max) {
    return undefined;
  }
  return trimmed;
}

function normalizeMode(value: unknown): SchoolHierarchyMode | null {
  return HIERARCHY_MODES.includes(value as SchoolHierarchyMode)
    ? (value as SchoolHierarchyMode)
    : null;
}

/** 学校更新の検証済み入力 (id + 全フィールド置換)。型は DB 由来の値域に合わせる。 */
export type SchoolUpdateInput = {
  id: string;
  name: string;
  prefecture: string;
  code: string | null;
  hierarchyMode: SchoolHierarchyMode;
};

/** 学校新規作成の検証済み入力 (#48-L3、id なし)。型は DB 由来の値域に合わせる。 */
export type SchoolCreateInput = {
  name: string;
  prefecture: string;
  code: string | null;
  hierarchyMode: SchoolHierarchyMode;
};

type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * 学校新規作成の入力検証 (#48-L3)。検証規則は update と共通 (id を要求しない点のみ差分)。
 * name / prefecture は必須、code は任意 (null 可)、hierarchyMode は enum 値のみ。
 */
export function validateSchoolCreate(raw: {
  name?: unknown;
  prefecture?: unknown;
  code?: unknown;
  hierarchyMode?: unknown;
}): Validated<SchoolCreateInput> {
  const name = normalizeRequired(raw.name, NAME_MAX);
  if (!name) {
    return { ok: false, message: `学校名は 1〜${NAME_MAX} 文字で入力してください。` };
  }
  const prefecture = normalizeRequired(raw.prefecture, PREF_MAX);
  if (!prefecture) {
    return { ok: false, message: `都道府県は 1〜${PREF_MAX} 文字で入力してください。` };
  }
  const code = normalizeOptional(raw.code, CODE_MAX);
  if (code === undefined) {
    return { ok: false, message: `学校コードは ${CODE_MAX} 文字以内で入力してください。` };
  }
  const hierarchyMode = normalizeMode(raw.hierarchyMode);
  if (!hierarchyMode) {
    return { ok: false, message: "階層モードは class か department を指定してください。" };
  }
  return { ok: true, value: { name, prefecture, code, hierarchyMode } };
}

/**
 * 学校編集の入力検証。patch ではなく**全フィールド置換**にして、UI から来た現在値で上書きする
 * (省略フィールドを null 化する事故を避ける、hub-core の update と同方針)。code は任意 (null 可)。
 */
export function validateSchoolUpdate(raw: {
  id?: unknown;
  name?: unknown;
  prefecture?: unknown;
  code?: unknown;
  hierarchyMode?: unknown;
}): Validated<SchoolUpdateInput> {
  if (!isUuid(raw.id)) {
    return { ok: false, message: "学校の指定が不正です。" };
  }
  const name = normalizeRequired(raw.name, NAME_MAX);
  if (!name) {
    return { ok: false, message: `学校名は 1〜${NAME_MAX} 文字で入力してください。` };
  }
  const prefecture = normalizeRequired(raw.prefecture, PREF_MAX);
  if (!prefecture) {
    return { ok: false, message: `都道府県は 1〜${PREF_MAX} 文字で入力してください。` };
  }
  const code = normalizeOptional(raw.code, CODE_MAX);
  if (code === undefined) {
    return { ok: false, message: `学校コードは ${CODE_MAX} 文字以内で入力してください。` };
  }
  const hierarchyMode = normalizeMode(raw.hierarchyMode);
  if (!hierarchyMode) {
    return { ok: false, message: "階層モードは class か department を指定してください。" };
  }
  return { ok: true, value: { id: raw.id, name, prefecture, code, hierarchyMode } };
}
