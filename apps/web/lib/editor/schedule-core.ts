import type { TenantRole, dailyData } from "@kimiterrace/db";
import type { AuthUser } from "../auth/session";

/**
 * エディタ Schedule セクション (#48-H) の純粋ロジック・型・定数。
 *
 * **schedule 要素の正式スキーマをここで確定する** (#48-A では daily_data.schedules を opaque
 * JSONB 保持、#48-H/#48-I が各セクションの形を定義)。サイネージ描画 (#48-E1) は要素から
 * `subject` 等を拾うため、ここで `subject` を必須にすることで描画と整合する。
 *
 * `"use server"` ファイル (schedule-actions.ts) は async export しか持てないため、検証・型・
 * 定数はここに分離する (school-admin/hub-core.ts と同じ構成、ActionResult も自己完結で定義)。
 */

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

/** スケジュールを編集できるロール。教員と学校管理者 (自校スコープ)。 */
export const EDITOR_ROLES = ["school_admin", "teacher"] as const;

/**
 * daily_data (連絡 / 予定 / 提出物) の 3 action **のみ**が使う編集ロール。`EDITOR_ROLES` に
 * system_admin を加え、テナント外の system_admin が特定校スコープ (/ops 経路) で daily_data を
 * 書けるようにする (ads の `ADS_ROLES` と同思想)。
 *
 * **`EDITOR_ROLES` は据え置く** (callouts / visitors / assistant / blackout actions が共有しており、
 * system_admin は users 行を持たないため created_by/updated_by に uid を入れると FK 違反 (23503) する。
 * これらは daily-data-write の userRef=null 配線を経由しないため、本ロールでは開かない)。
 */
export const DAILY_DATA_EDITOR_ROLES = [
  "school_admin",
  "teacher",
  "system_admin",
] as const satisfies readonly TenantRole[];

/**
 * 編集対象スコープ。`daily_data.scope` (`hierarchy_scope` enum) と単一ソース (ルール3、手書き union を
 * 別宣言しない)。`ck_daily_data_scope` 制約に合わせ、scope ごとに非 null になる id 列が決まる:
 * school→全 id NULL / department→departmentId / grade→gradeId / class→classId。
 */
export type EditorScope = (typeof dailyData.scope.enumValues)[number];

/**
 * 編集対象。`scope` に応じて対応する id を 1 つだけ持つ (school は id 不要)。汎用 upsert / query /
 * scope ページが「どの daily_data 行を編集するか」を表す単一の型。`*_id` 列の組は
 * `ck_daily_data_scope` を充足するよう `targetIdColumns` で導出する (手書きで列を散らさない)。
 */
export type EditorTarget =
  | { scope: "school" }
  | { scope: "department"; departmentId: string }
  | { scope: "grade"; gradeId: string }
  | { scope: "class"; classId: string };

/**
 * 任意入力 (フォーム / URL params) を `EditorTarget` に正規化する。scope 文字列と id の整合を検証し、
 * 不正なら null。id は UUID 形式のみ受理する (DB 到達前に弾く)。
 */
export function parseEditorTarget(scope: unknown, id: unknown): EditorTarget | null {
  if (scope === "school") {
    return { scope: "school" };
  }
  if (!isUuid(id)) {
    return null;
  }
  if (scope === "department") {
    return { scope: "department", departmentId: id };
  }
  if (scope === "grade") {
    return { scope: "grade", gradeId: id };
  }
  if (scope === "class") {
    return { scope: "class", classId: id };
  }
  return null;
}

/**
 * `EditorTarget` を daily_data の `scope` + `*_id` 列の組に変換する (`ck_daily_data_scope` を充足)。
 * INSERT の values と WHERE 句の両方でこの導出を使い、scope と id 列のズレを 1 か所に閉じ込める。
 */
export function targetIdColumns(target: EditorTarget): {
  scope: EditorScope;
  gradeId: string | null;
  departmentId: string | null;
  classId: string | null;
} {
  switch (target.scope) {
    case "school":
      return { scope: "school", gradeId: null, departmentId: null, classId: null };
    case "department":
      return {
        scope: "department",
        gradeId: null,
        departmentId: target.departmentId,
        classId: null,
      };
    case "grade":
      return { scope: "grade", gradeId: target.gradeId, departmentId: null, classId: null };
    case "class":
      return { scope: "class", gradeId: null, departmentId: null, classId: target.classId };
  }
}

/**
 * target の id (school は null)。汎用アクション呼び出しの `targetId` 引数に渡す。scope と id を
 * 別々に持ち回らず target 1 つから導出する (整合を 1 か所に閉じ込める)。
 */
export function targetId(target: EditorTarget): string | null {
  switch (target.scope) {
    case "school":
      return null;
    case "department":
      return target.departmentId;
    case "grade":
      return target.gradeId;
    case "class":
      return target.classId;
  }
}

/**
 * 編集対象のエディタ画面 path を返す (date クエリは付けない)。クラスは既存
 * `/app/editor/[classId]`、scope 編集は `/app/editor/scope/...`。route 形を 1 か所に閉じ込め、
 * 日付変更ナビ (client) と index / scope ページ (server) で同じ path 生成を共有する。
 */
export function editorBasePath(target: EditorTarget): string {
  switch (target.scope) {
    case "school":
      return "/app/editor/scope/school";
    case "department":
      return `/app/editor/scope/department/${target.departmentId}`;
    case "grade":
      return `/app/editor/scope/grade/${target.gradeId}`;
    case "class":
      return `/app/editor/${target.classId}`;
  }
}

export type EditorActor = { userId: string; schoolId: string };

export function toEditorActor(user: AuthUser): EditorActor | null {
  if (!user.schoolId) {
    return null;
  }
  return { userId: user.uid, schoolId: user.schoolId };
}

/**
 * daily_data 書き込みの実行者 (`EditorActor` の三系統版)。`EditorActor` は callouts / visitors /
 * assistant / blackout が共有するため壊さず、system_admin を含む daily_data 3 action 用に**別型**を足す
 * (ads-core.ts の `AdsActor` と同思想)。
 *
 * **監査 actor の三系統 (CLAUDE.md ルール1 / system_admin は users 表に行を持たない)**:
 * - `actorUserId`: `audit_log.actor_user_id` の操作者 uid。`tenantScoped` 降格後 (system_admin →
 *   school_admin) も `audit_log_insert` policy が `actor_user_id = app.current_user_id` を要求するため
 *   常に acting uid を入れる (school_admin はこれが users.id でもある)。FK は無い。
 * - `userRef`: daily_data / audit_log の `created_by` / `updated_by` (users.id への FK)。system_admin は
 *   users 行を持たないため **null** (FK 違反 23503 回避)。school_admin / teacher は自身の users.id。
 * - `identityUid`: `audit_log.actor_identity_uid` (IdP uid キャッシュ)。system_admin のみ記録し、
 *   tenant ロールは従来どおり null。
 */
export type ScopedEditorActor = {
  actorUserId: string;
  userRef: string | null;
  identityUid: string | null;
  schoolId: string;
};

/**
 * AuthUser を daily_data mutation actor に変換する (ads-core.ts の `toAdsActor` と同規律)。
 * - **system_admin**: テナント外 (session schoolId は null) のため、対象校 `targetSchoolId` を**明示**で
 *   受け取りそれを actor の schoolId にする。未指定 / UUID でないときは null (呼出側が forbidden 化)。
 *   `userRef` は null (users 行が無い → created_by/updated_by の FK 回避)、`identityUid` に uid を残す。
 * - **tenant ロール (school_admin / teacher)**: `targetSchoolId` は**無視**し必ず自校 (`user.schoolId`)
 *   に固定する (クライアント由来 schoolId で他校へ切り替えさせない = 越境防止)。自校が無ければ null。
 */
export function toScopedEditorActor(
  user: AuthUser,
  targetSchoolId?: string,
): ScopedEditorActor | null {
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
  return { actorUserId: user.uid, userRef: user.uid, identityUid: null, schoolId: user.schoolId };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** YYYY-MM-DD 形式かつ実在日付か (例: 2026-02-30 は不正)。 */
export function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    return false;
  }
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === (m as number) - 1 && dt.getUTCDate() === d
  );
}

/**
 * 時限を持たない特殊スロット。1〜12 限に**加えて**選べる時間帯（朝の会・昼休み・放課後）。
 * 数値の時限と区別するため文字列リテラルにする。daily_data.schedules は JSONB なので migration 不要。
 */
export const SPECIAL_SLOTS = ["morning", "lunch", "afterschool"] as const;
export type SpecialSlot = (typeof SPECIAL_SLOTS)[number];

/** 自由入力の時限（select で「その他」を選んだとき。例: 補習 / 0限）。`{ custom }` でタグ付けし数値/特殊と区別する。 */
export type CustomPeriod = { custom: string };
/** 自由入力ラベルの最大長（暴走入力抑止・盤面の時限欄は短い）。 */
export const CUSTOM_PERIOD_MAX = 16;

/**
 * 予定 1 コマの時限。数値 (1..12) / 特殊スロット (朝 / 昼休み / 放課後) に加え、**自由入力 (`{ custom }`)** を取りうる。
 * **この union を単一ソースとする**（手書きで別宣言しない、ルール3）。
 */
export type SchedulePeriod = number | SpecialSlot | CustomPeriod;

/** `period` が特殊スロット文字列か。 */
export function isSpecialSlot(value: unknown): value is SpecialSlot {
  return typeof value === "string" && (SPECIAL_SLOTS as readonly string[]).includes(value);
}

/** `period` が自由入力（「その他」）か。 */
export function isCustomPeriod(value: unknown): value is CustomPeriod {
  return (
    typeof value === "object" &&
    value !== null &&
    "custom" in value &&
    typeof (value as { custom: unknown }).custom === "string"
  );
}

/** 特殊スロットの表示ラベル（select の選択肢・サイネージ整形で共有）。 */
const SPECIAL_SLOT_LABEL: Record<SpecialSlot, string> = {
  morning: "朝",
  lunch: "昼休み",
  afterschool: "放課後",
};

/**
 * 並び順キー。**morning < 1 < 2 < … < 12 < lunch < afterschool**。
 * 数値時限 (1..12) はその値、morning は全数値の手前 (0)、lunch / afterschool は全数値の後ろに
 * 連続した大きな有限値で置く（`Infinity - 1 === Infinity` で潰れるのを避け、両者を区別する）。
 * 保存（validate のソート）・描画（盤面の並べ替え）で同じキーを使う。
 */
const SPECIAL_SLOT_SORT_KEY: Record<SpecialSlot, number> = {
  morning: 0,
  lunch: 1000,
  afterschool: 1001,
};
/** 自由入力（その他）の並び順キー。標準スロット（morning 0 〜 afterschool 1001）より後ろに固定で置く。 */
const CUSTOM_PERIOD_SORT_KEY = 2000;
export function scheduleSlotSortKey(period: SchedulePeriod): number {
  // 自由入力は標準スロットの後ろ。同値の複数件は安定ソートで入力順を保つ（保存・盤面描画で同一キー）。
  if (isCustomPeriod(period)) {
    return CUSTOM_PERIOD_SORT_KEY;
  }
  if (isSpecialSlot(period)) {
    return SPECIAL_SLOT_SORT_KEY[period];
  }
  return period;
}

/** 時限の表示ラベル（数値→`N限`、特殊→朝 / 昼休み / 放課後、自由入力→その文字列）。サイネージ・エディタで共有。 */
export function scheduleSlotLabel(period: SchedulePeriod): string {
  if (isCustomPeriod(period)) {
    return period.custom;
  }
  if (isSpecialSlot(period)) {
    return SPECIAL_SLOT_LABEL[period];
  }
  return `${period}限`;
}

/** select 用の時限オプション 1 件。`value` は number（数値時限）または特殊スロット文字列。 */
export type ScheduleSlotOption = { value: SchedulePeriod; label: string };

/**
 * select の選択肢列（並び順 morning < 1..12 < lunch < afterschool）。エディタ各所で共有する単一ソース。
 * value は数値時限なら number、特殊スロットなら文字列。
 */
export const SCHEDULE_SLOT_OPTIONS: readonly ScheduleSlotOption[] = [
  { value: "morning", label: SPECIAL_SLOT_LABEL.morning },
  ...Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `${i + 1}限` })),
  { value: "lunch", label: SPECIAL_SLOT_LABEL.lunch },
  { value: "afterschool", label: SPECIAL_SLOT_LABEL.afterschool },
];

/**
 * 予定の 1 コマ。`period` は時限 (1..12) または特殊スロット (朝 / 昼休み / 放課後)、`subject` は科目名
 * (1..32)、`note` は任意の補足。`location`（場所）/ `targetAudience`（対象者）はパターン2 盤面で表示する
 * 任意フィールド（例: 場所「体育館」、対象者「3年生」）。いずれも施設/学年区分で **PII ではない**
 * （ルール4 対象外）。サイネージ (#48-E1) は `subject` を代表ラベルとして描画する。
 */
export type ScheduleItem = {
  period: SchedulePeriod;
  subject: string;
  note?: string;
  location?: string;
  targetAudience?: string;
};

/** 数値時限の上限（1..MAX_ITEMS）。特殊スロット（朝 / 昼休み / 放課後）はこの範囲外で別途許容する。 */
const MAX_ITEMS = 12;
/**
 * 予定 1 日あたりの行数上限（暴走入力の抑止）。数値時限 12 + 特殊スロット（朝 / 昼休み / 放課後）に加え、
 * 特殊スロットの重複（例: 放課後に部活と三者面談）を許容するため、数値上限とは独立に余裕を持たせる。
 */
const MAX_ROWS = 20;
const SUBJECT_MAX = 32;
const NOTE_MAX = 200;
/** 場所 / 対象者 の最大長（任意フィールド。暴走入力抑止）。 */
const LOCATION_MAX = 50;
const TARGET_MAX = 50;

/** 検証結果。`ok` なら正規化済 value、そうでなければ表示用 message。エディタ各 core で共有。 */
export type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

function normalizeString(value: unknown, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    return null;
  }
  return trimmed;
}

/**
 * 入力の `period` を正規化する。number 1..12 / 数値文字列 "1".."12" は number 化し、特殊スロット 3 文字列
 * (morning / lunch / afterschool) はそのまま通す。いずれにも該当しなければ null（不正）。
 * 既存の numeric データは後方互換でそのまま有効。
 */
function normalizePeriod(raw: unknown): SchedulePeriod | null {
  if (isSpecialSlot(raw)) {
    return raw;
  }
  // 自由入力（その他）: trim 後 1..CUSTOM_PERIOD_MAX 文字なら許容。空は不正（未入力）として弾く。
  if (isCustomPeriod(raw)) {
    const trimmed = raw.custom.trim();
    if (trimmed.length === 0 || trimmed.length > CUSTOM_PERIOD_MAX) {
      return null;
    }
    return { custom: trimmed };
  }
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_ITEMS) {
    return n;
  }
  return null;
}

/**
 * 予定配列を検証・正規化する。1 件でも不正なら全体を拒否 (部分保存しない)。
 * period は数値時限 (1..12) もしくは特殊スロット (朝 / 昼休み / 放課後) を許容する。
 *
 * **重複の扱い**: 数値時限 (1限〜12限) の重複は拒否する（同じ時限が 2 つあるのはデータ誤り）。一方、特殊スロット
 * (朝 / 昼休み / 放課後) は **重複を許容**する（例: 放課後に「部活」と「三者面談」の 2 件）。要望: 放課後が
 * 2 つあると反映されない、の是正 (2026-06-22)。並びは安定ソートのため重複スロットは入力順を保つ。
 */
export function validateScheduleItems(raw: unknown): Validated<ScheduleItem[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, message: "予定の形式が不正です。" };
  }
  if (raw.length > MAX_ROWS) {
    return { ok: false, message: `予定は最大 ${MAX_ROWS} 件までです。` };
  }
  // 重複検知は **数値時限のみ**。特殊スロットは複数件を許すので Set に入れない。
  const seenNumbered = new Set<number>();
  const items: ScheduleItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, message: "予定の各コマが不正です。" };
    }
    const rec = entry as Record<string, unknown>;
    const period = normalizePeriod(rec.period);
    if (period === null) {
      return {
        ok: false,
        message: `時限は 1〜${MAX_ITEMS} の整数 / 朝・昼休み・放課後 / その他（自由入力）で指定してください。`,
      };
    }
    // 重複拒否は **数値時限のみ**。特殊スロット（朝 / 昼休み / 放課後）と自由入力（その他）は複数件を許容する。
    if (typeof period === "number") {
      if (seenNumbered.has(period)) {
        return { ok: false, message: `「${scheduleSlotLabel(period)}」が重複しています。` };
      }
      seenNumbered.add(period);
    }
    const subject = normalizeString(rec.subject, SUBJECT_MAX);
    if (!subject) {
      return { ok: false, message: `科目名は 1〜${SUBJECT_MAX} 文字で入力してください。` };
    }
    const item: ScheduleItem = { period, subject };
    if (rec.note !== undefined && rec.note !== null && rec.note !== "") {
      const note = normalizeString(rec.note, NOTE_MAX);
      if (!note) {
        return { ok: false, message: `補足は ${NOTE_MAX} 文字以内で入力してください。` };
      }
      item.note = note;
    }
    if (rec.location !== undefined && rec.location !== null && rec.location !== "") {
      const location = normalizeString(rec.location, LOCATION_MAX);
      if (!location) {
        return { ok: false, message: `場所は ${LOCATION_MAX} 文字以内で入力してください。` };
      }
      item.location = location;
    }
    if (
      rec.targetAudience !== undefined &&
      rec.targetAudience !== null &&
      rec.targetAudience !== ""
    ) {
      const targetAudience = normalizeString(rec.targetAudience, TARGET_MAX);
      if (!targetAudience) {
        return { ok: false, message: `対象者は ${TARGET_MAX} 文字以内で入力してください。` };
      }
      item.targetAudience = targetAudience;
    }
    items.push(item);
  }
  // 時限の昇順に正規化 (保存・描画の決定性)。並びは morning < 1..12 < lunch < afterschool。
  items.sort((a, b) => scheduleSlotSortKey(a.period) - scheduleSlotSortKey(b.period));
  return { ok: true, value: items };
}
