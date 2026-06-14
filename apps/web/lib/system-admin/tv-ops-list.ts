import {
  type TenantTx,
  schools,
  tvCommandStatus,
  tvCommandType,
  tvDeviceCommands,
  tvDeviceDowntime,
  type tvDowntimeCause,
  tvDevices,
  users,
} from "@kimiterrace/db";
import {
  type InferSelectModel,
  type SQL,
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  isNotNull,
  isNull,
  lt,
} from "drizzle-orm";
import {
  type ListParams,
  dateRangeBounds,
  escapeLike,
  pageWindow,
} from "@/app/_components/datalist/list-params";

/**
 * UIUX-03: TV 運用ログビューア 2 本 (`/ops/tv-commands` / `/ops/tv-downtime`) の
 * ページング/検索/ソート対応 SELECT 層。`audit-log-list.ts` / `event-log.ts` と同構造 (共通 DataList 基盤)。
 *
 * ## 置き場所 (並行レーン回避)
 * `packages/db` (chokepoint) を編集せず `apps/web/lib` に置く。テーブル/enum は barrel から import し、
 * 行型は schema 由来 (`InferSelectModel`、ルール3)。
 *
 * ## 既存クエリ (packages/db) との関係 — 重複実装ではない
 * `packages/db/src/queries/tv-device-commands.ts` (`listRecentTvCommands`) /
 * `tv-downtime.ts` (`listTvDeviceDowntime`) は **デバイス 1 台**の履歴を引く射影で、
 * `/ops/tv-devices/[deviceId]` 配下のデバイス単位ビューが使う。本層は **全校横断**の運用ログ一覧
 * (学校・デバイス・発行者を JOIN 解決 + 検索/フィルタ/ソート/ページング) で要件が異なるため、
 * `apps/web/lib` 側に別途持つ (デバイス単位の取得セマンティクスは packages/db に単一ソースのまま)。
 *
 * ## テナント分離 (ルール2 / ADR-019)
 * 両テーブルとも school_id を持ち、RLS (tenant_isolation + system_admin_full_access、
 * migrations/0018・0019) が可視範囲を DB レベルで決める。本層は **school_id / role の WHERE を
 * テナント境界としては書かない** — 呼び出し側 (`withSession`) が張る RLS context に委譲する
 * (system_admin = 全校)。`filters.school` の絞り込みは**検索条件** (任意校に絞る UI 機能) であって
 * 境界ではない。
 *
 * ## JOIN の件数安全性
 * - `schools` への innerJoin: school_id NOT NULL + FK (restrict) のため行を落とさない。
 * - `tv_devices` への leftJoin: device_id はグローバル UNIQUE (`ux_tv_devices_device_id`) のため行を
 *   増やさない。FK (restrict) で親は常に存在するが、可視性の揺れでログ行ごと消えないよう left にする
 *   (ラベル欠落時は呼び出し側が device_id 短縮表示にフォールバック)。
 * - `users` への leftJoin (コマンド発行者): issued_by は nullable (system_admin 発行 = users 行でないため
 *   null、enqueueTvCommand 参照) かつ PK 結合で行を増やさない。
 *
 * ## PII (ルール4)
 * 両テーブルは schema 設計で PII 非格納 (params_json は機械メタのみ / notes は運用メモ)。表示側は
 * params_json を `formatMaskedJson` に通し、デバイスは label or device_id 短縮のみ出す。
 */

/** SELECT だけできれば良い。 */
type Selectable = Pick<TenantTx, "select">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `filters.school` を uuid として検証する (uuid 形式でない値を SQL に渡さない形式検証)。
 * **テナント境界ではない** — 境界は RLS が DB レベルで守る (ルール2、event-log.ts と同パターン)。
 */
export function parseSchoolFilter(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.toLowerCase();
  return UUID_RE.test(normalized) ? normalized : null;
}

// ---------------------------------------------------------------------------
// コマンドキュー履歴 (/ops/tv-commands)
// ---------------------------------------------------------------------------

/** `tv_command_status` enum の値域 (pending/delivered/failed/expired)。schema の pgEnum が単一ソース (ルール3)。 */
export const TV_COMMAND_STATUS_VALUES = tvCommandStatus.enumValues;

/** コマンド状態。enum 値とズレるとコンパイルで検出される。 */
export type TvCommandStatusValue = (typeof TV_COMMAND_STATUS_VALUES)[number];

/** `tv_command_type` enum の値域 (signage_reload 等)。schema の pgEnum が単一ソース (ルール3)。 */
export const TV_COMMAND_TYPE_VALUES = tvCommandType.enumValues;

/** コマンド種別。enum 値とズレるとコンパイルで検出される。 */
export type TvCommandTypeValue = (typeof TV_COMMAND_TYPE_VALUES)[number];

/** URL 由来の status フィルタを enum 値域に検証する (範囲外は黙って無視、URL は外部入力)。 */
export function parseTvCommandStatusFilter(value: string | undefined): TvCommandStatusValue | null {
  if (value !== undefined && (TV_COMMAND_STATUS_VALUES as readonly string[]).includes(value)) {
    return value as TvCommandStatusValue;
  }
  return null;
}

/** URL 由来の type フィルタを enum 値域に検証する (範囲外は黙って無視、URL は外部入力)。 */
export function parseTvCommandTypeFilter(value: string | undefined): TvCommandTypeValue | null {
  if (value !== undefined && (TV_COMMAND_TYPE_VALUES as readonly string[]).includes(value)) {
    return value as TvCommandTypeValue;
  }
  return null;
}

/** ソート可能列の allowlist。`parseListParams` の sortKeys と ORDER BY を 1 箇所で対応させる。 */
export const TV_COMMAND_SORT_COLUMNS = {
  issuedAt: tvDeviceCommands.issuedAt,
  command: tvDeviceCommands.command,
  status: tvDeviceCommands.status,
  schoolName: schools.name,
} as const;

export const TV_COMMAND_SORT_KEYS = Object.keys(TV_COMMAND_SORT_COLUMNS) as readonly string[];

type TvCommandRow = InferSelectModel<typeof tvDeviceCommands>;

/** 一覧 1 行。schema 由来の射影 + JOIN 解決した校名 / デバイスラベル / 発行者表示名。 */
export type TvCommandLogEntry = Pick<
  TvCommandRow,
  | "id"
  | "deviceId"
  | "schoolId"
  | "command"
  | "paramsJson"
  | "status"
  | "issuedAt"
  | "issuedBy"
  | "acknowledgedAt"
> & {
  schoolName: string;
  /** 設置場所ラベル (tv_devices.label)。デバイス不可視/未設定は null → 呼び出し側で id 短縮表示。 */
  deviceLabel: string | null;
  /** 発行者の表示名 (users.display_name)。issued_by null (system_admin 発行) / users 行欠落は null。 */
  issuerName: string | null;
};

/** 一覧 1 ページ分 + 総件数。 */
export type TvCommandLogPage = { rows: TvCommandLogEntry[]; total: number };

/**
 * TV リモートコマンド履歴を 状態/種別/学校/発行日範囲/フリーワード (デバイスラベル ilike) で絞り、
 * 列ソート・ページングで全校横断に取得する。同値ソートでも順序が安定するよう id を最終タイブレークに
 * 付ける。JOIN の件数安全性はモジュール docblock 参照。
 */
export async function listTvCommandLogPage(
  db: Selectable,
  params: ListParams,
): Promise<TvCommandLogPage> {
  const conditions: SQL[] = [];

  if (params.q) {
    // デバイスラベル (設置場所) の部分一致。leftJoin のため label 未設定 (null) の行はヒットしない
    // (未設定デバイスは id 短縮でしか特定できず、識別子の部分一致検索は提供しない方針)。
    conditions.push(ilike(tvDevices.label, `%${escapeLike(params.q)}%`));
  }

  const status = parseTvCommandStatusFilter(params.filters.status);
  if (status) {
    conditions.push(eq(tvDeviceCommands.status, status));
  }

  const type = parseTvCommandTypeFilter(params.filters.type);
  if (type) {
    conditions.push(eq(tvDeviceCommands.command, type));
  }

  // 検索条件としての学校絞り込み (テナント境界は RLS、モジュール docblock 参照)。
  const school = parseSchoolFilter(params.filters.school);
  if (school) {
    conditions.push(eq(tvDeviceCommands.schoolId, school));
  }

  const { since, untilExclusive } = dateRangeBounds(params);
  if (since) {
    conditions.push(gte(tvDeviceCommands.issuedAt, since));
  }
  if (untilExclusive) {
    conditions.push(lt(tvDeviceCommands.issuedAt, untilExclusive));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const sortColumn =
    TV_COMMAND_SORT_COLUMNS[params.sort as keyof typeof TV_COMMAND_SORT_COLUMNS] ??
    tvDeviceCommands.issuedAt;
  const orderBy =
    params.dir === "asc"
      ? [asc(sortColumn), asc(tvDeviceCommands.id)]
      : [desc(sortColumn), asc(tvDeviceCommands.id)];
  const { limit, offset } = pageWindow(params);

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: tvDeviceCommands.id,
        deviceId: tvDeviceCommands.deviceId,
        schoolId: tvDeviceCommands.schoolId,
        schoolName: schools.name,
        deviceLabel: tvDevices.label,
        command: tvDeviceCommands.command,
        paramsJson: tvDeviceCommands.paramsJson,
        status: tvDeviceCommands.status,
        issuedAt: tvDeviceCommands.issuedAt,
        issuedBy: tvDeviceCommands.issuedBy,
        issuerName: users.displayName,
        acknowledgedAt: tvDeviceCommands.acknowledgedAt,
      })
      .from(tvDeviceCommands)
      .innerJoin(schools, eq(tvDeviceCommands.schoolId, schools.id))
      .leftJoin(tvDevices, eq(tvDeviceCommands.deviceId, tvDevices.deviceId))
      .leftJoin(users, eq(tvDeviceCommands.issuedBy, users.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    // count: q が tvDevices.label を参照するため同じ JOIN を張る (leftJoin は device_id UNIQUE で件数を
    // 変えない)。users は WHERE で参照しないため JOIN 不要。
    db
      .select({ value: count() })
      .from(tvDeviceCommands)
      .innerJoin(schools, eq(tvDeviceCommands.schoolId, schools.id))
      .leftJoin(tvDevices, eq(tvDeviceCommands.deviceId, tvDevices.deviceId))
      .where(where),
  ]);

  return { rows, total: totals[0]?.value ?? 0 };
}

// ---------------------------------------------------------------------------
// ダウンタイム履歴 (/ops/tv-downtime)
// ---------------------------------------------------------------------------

/** `tv_downtime_cause` enum の値域 (unknown/reboot/network)。schema の pgEnum が単一ソース (ルール3)。 */
export type TvDowntimeCauseValue = (typeof tvDowntimeCause.enumValues)[number];

/** 復旧状態フィルタの値域 (ongoing = 未復旧 / recovered = 復旧済)。 */
export const TV_DOWNTIME_STATE_VALUES = ["ongoing", "recovered"] as const;

export type TvDowntimeStateFilter = (typeof TV_DOWNTIME_STATE_VALUES)[number];

/** URL 由来の復旧状態フィルタを値域に検証する (範囲外は黙って無視、URL は外部入力)。 */
export function parseTvDowntimeStateFilter(
  value: string | undefined,
): TvDowntimeStateFilter | null {
  if (value !== undefined && (TV_DOWNTIME_STATE_VALUES as readonly string[]).includes(value)) {
    return value as TvDowntimeStateFilter;
  }
  return null;
}

/** ソート可能列の allowlist。`parseListParams` の sortKeys と ORDER BY を 1 箇所で対応させる。 */
export const TV_DOWNTIME_SORT_COLUMNS = {
  wentDownAt: tvDeviceDowntime.wentDownAt,
  durationSec: tvDeviceDowntime.durationSec,
  schoolName: schools.name,
} as const;

export const TV_DOWNTIME_SORT_KEYS = Object.keys(TV_DOWNTIME_SORT_COLUMNS) as readonly string[];

type TvDowntimeRow = InferSelectModel<typeof tvDeviceDowntime>;
type TvDeviceRow = InferSelectModel<typeof tvDevices>;

/** 一覧 1 行。schema 由来の射影 + JOIN 解決した校名 / デバイスラベル / スケジュール。notes (運用メモ) は出さない。 */
export type TvDowntimeLogEntry = Pick<
  TvDowntimeRow,
  "id" | "deviceId" | "schoolId" | "wentDownAt" | "recoveredAt" | "durationSec" | "causeHint"
> & {
  schoolName: string;
  /** 設置場所ラベル (tv_devices.label)。デバイス不可視/未設定は null → 呼び出し側で id 短縮表示。 */
  deviceLabel: string | null;
  /**
   * デバイスの現在の表示スケジュール (tv_devices.schedule_json)。推定原因の「消灯時間帯か」判定に使う
   * (estimateDowntimeCause)。デバイス不可視 (leftJoin で null) は常時 ON 扱い。非 PII・非 secret。
   */
  scheduleJson: TvDeviceRow["scheduleJson"];
};

/** 一覧 1 ページ分 + 総件数。 */
export type TvDowntimeLogPage = { rows: TvDowntimeLogEntry[]; total: number };

/**
 * TV ダウンタイム履歴を 学校/復旧状態 (未復旧・復旧済)/発生日範囲/フリーワード (デバイスラベル ilike) で
 * 絞り、列ソート・ページングで全校横断に取得する。継続中 (`recovered_at IS NULL`) の行も含めて返し、
 * UI 側で「未復旧」と明示する。同値ソートでも順序が安定するよう id を最終タイブレークに付ける。
 */
export async function listTvDowntimeLogPage(
  db: Selectable,
  params: ListParams,
): Promise<TvDowntimeLogPage> {
  const conditions: SQL[] = [];

  if (params.q) {
    // デバイスラベルの部分一致 (コマンド履歴の q と同方針。label null の行はヒットしない)。
    conditions.push(ilike(tvDevices.label, `%${escapeLike(params.q)}%`));
  }

  // 検索条件としての学校絞り込み (テナント境界は RLS、モジュール docblock 参照)。
  const school = parseSchoolFilter(params.filters.school);
  if (school) {
    conditions.push(eq(tvDeviceDowntime.schoolId, school));
  }

  // 復旧状態: 未復旧 (継続中) = recovered_at IS NULL / 復旧済 = IS NOT NULL (schema docblock の
  // 「未解決行は recovered_at IS NULL で一意に識別」に対応)。
  const state = parseTvDowntimeStateFilter(params.filters.state);
  if (state === "ongoing") {
    conditions.push(isNull(tvDeviceDowntime.recoveredAt));
  } else if (state === "recovered") {
    conditions.push(isNotNull(tvDeviceDowntime.recoveredAt));
  }

  const { since, untilExclusive } = dateRangeBounds(params);
  if (since) {
    conditions.push(gte(tvDeviceDowntime.wentDownAt, since));
  }
  if (untilExclusive) {
    conditions.push(lt(tvDeviceDowntime.wentDownAt, untilExclusive));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const sortColumn =
    TV_DOWNTIME_SORT_COLUMNS[params.sort as keyof typeof TV_DOWNTIME_SORT_COLUMNS] ??
    tvDeviceDowntime.wentDownAt;
  const orderBy =
    params.dir === "asc"
      ? [asc(sortColumn), asc(tvDeviceDowntime.id)]
      : [desc(sortColumn), asc(tvDeviceDowntime.id)];
  const { limit, offset } = pageWindow(params);

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: tvDeviceDowntime.id,
        deviceId: tvDeviceDowntime.deviceId,
        schoolId: tvDeviceDowntime.schoolId,
        schoolName: schools.name,
        deviceLabel: tvDevices.label,
        scheduleJson: tvDevices.scheduleJson,
        wentDownAt: tvDeviceDowntime.wentDownAt,
        recoveredAt: tvDeviceDowntime.recoveredAt,
        durationSec: tvDeviceDowntime.durationSec,
        causeHint: tvDeviceDowntime.causeHint,
      })
      .from(tvDeviceDowntime)
      .innerJoin(schools, eq(tvDeviceDowntime.schoolId, schools.id))
      .leftJoin(tvDevices, eq(tvDeviceDowntime.deviceId, tvDevices.deviceId))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    // count: q が tvDevices.label を参照するため同じ JOIN を張る (件数安全性はモジュール docblock 参照)。
    db
      .select({ value: count() })
      .from(tvDeviceDowntime)
      .innerJoin(schools, eq(tvDeviceDowntime.schoolId, schools.id))
      .leftJoin(tvDevices, eq(tvDeviceDowntime.deviceId, tvDevices.deviceId))
      .where(where),
  ]);

  return { rows, total: totals[0]?.value ?? 0 };
}
