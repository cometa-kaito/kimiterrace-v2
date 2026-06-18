import { type InferSelectModel, and, asc, eq, gte, lte, notInArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { TenantTx } from "../client.js";
import { schoolCalendarEvents } from "../schema/school-calendar-events.js";
import { schoolCalendarSources } from "../schema/school-calendar-sources.js";

/**
 * ADR-045: 学校行事カレンダー（公開 iCal/ICS 取込）のクエリ層。
 *
 * 2 系統に分かれる（tv_devices / daily_data と同じ tenant_isolation テーブルの「読みは RLS 委譲 / 取得 Job は
 * system context」構造）:
 *   1. **取得 Job 側**（`listEnabledCalendarSources` / `upsertCalendarEvent` / `deleteStaleCalendarEvents` /
 *      `updateCalendarSourceStatus`）: `system_admin` コンテキストを張った接続で呼ぶ。`system_admin_full_access`
 *      policy（migration 0032）が cross-tenant の列挙・書込みを system に許す。各校の school_id を **明示**して
 *      書き込む（cross-tenant 越境は WITH CHECK = system role で許可される）。WHERE/role を手書きせず DB の RLS に
 *      委ねる（ルール2）。
 *   2. **サイネージ / アプリ読み取り側**（`getCalendarEvents` / `upsertCalendarSource`）: 呼び出し接続の RLS
 *      コンテキスト（`app.current_school_id`、ADR-019）が `tenant_isolation` policy で自校行のみに絞る。匿名
 *      サイネージ（role 未設定・school_id のみ set）も自校イベントを読める（他校は不可視）。手書きの
 *      `WHERE school_id=?` は書かない（ルール2、RLS に委譲）。
 *
 * 型は schema の `schoolCalendarSources` / `schoolCalendarEvents` から `InferSelectModel` で派生する（ルール3、
 * 手書きドメイン型を作らない）。
 *
 * ## ★ PII（ルール4）
 * 行事は「学校公開行事カレンダー」専用の運用前提（schema コメント参照）。本層は LLM / embedding 経路に載せない。
 */

/** SELECT だけできれば良い接続（db / tx の両方を受ける）。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

type CalendarSourceRow = InferSelectModel<typeof schoolCalendarSources>;
type CalendarEventRow = InferSelectModel<typeof schoolCalendarEvents>;

/** 公開 iCal ソース設定の行（schema 由来、全フィールド）。 */
export type SchoolCalendarSource = CalendarSourceRow;
/** 学校行事イベントの行（schema 由来、全フィールド）。 */
export type SchoolCalendarEvent = CalendarEventRow;

/** 取得 Job の per-school フェーズが列挙する「有効なソース」1 件（取得に要る最小射影）。 */
export type EnabledCalendarSource = Pick<CalendarSourceRow, "id" | "schoolId" | "icsUrl">;

/**
 * ソース設定を upsert する入力（school_admin の設定 UI / ops 初期投入用）。`(school_id)` 競合で UPDATE。
 * `createdBy` / `updatedBy` は呼び出し側（Server Action）が actor から渡す（system_admin は users 行でないため
 * null、ルール1）。
 */
export type UpsertCalendarSourceInput = {
  schoolId: string;
  icsUrl: string;
  enabled?: boolean;
  /** 監査 actor（system_admin は null）。 */
  actorUserId?: string | null;
};

/**
 * 公開 iCal ソース設定を 1 行 upsert する。`(school_id)` 競合時は icsUrl / enabled を差し替える（UPDATE 分岐でも
 * `updatedAt` を明示更新する。ルール1: `auditColumns.updatedAt` は INSERT 既定のみで `$onUpdate` を持たないため、
 * 明示しないと作成時刻のまま残り監査不整合になる。[[updatedat-explicit-on-update]]）。
 *
 * RLS: 呼び出し接続のコンテキストに委ねる（school_admin は自校のみ tenant_isolation、system_admin は full_access）。
 * 手書き WHERE school_id は書かない（ルール2）。
 *
 * @param tx 呼び出し側でテナント / system コンテキストを張ったトランザクション。
 * @returns upsert 後の行 id。
 */
export async function upsertCalendarSource(
  tx: Pick<PostgresJsDatabase, "insert">,
  input: UpsertCalendarSourceInput,
): Promise<string> {
  const actor = input.actorUserId ?? null;
  const rows = await tx
    .insert(schoolCalendarSources)
    .values({
      schoolId: input.schoolId,
      icsUrl: input.icsUrl,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      createdBy: actor,
      updatedBy: actor,
    })
    .onConflictDoUpdate({
      target: schoolCalendarSources.schoolId,
      set: {
        icsUrl: input.icsUrl,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        // ルール1: 設定変更時刻として updated_at を明示更新（created_at / created_by は初回値を保つ）。
        updatedAt: new Date(),
        updatedBy: actor,
      },
    })
    .returning({ id: schoolCalendarSources.id });
  const id = rows[0]?.id;
  if (!id) {
    throw new Error("upsertCalendarSource: INSERT ... RETURNING が行を返しませんでした");
  }
  return id;
}

/**
 * 取得 Job の per-school フェーズが走査する **有効なソース一覧**を返す（system context で呼ぶ）。
 * `enabled = true` のみ。可視範囲は RLS が決める（system_admin = 全校）。school_id → id で決定的に並べる
 * （取得順を安定させ、監視ログの再現性を保つ）。
 *
 * @param db SELECT 可能な接続 / tx（system_admin コンテキスト）。
 */
export async function listEnabledCalendarSources(db: Selectable): Promise<EnabledCalendarSource[]> {
  return db
    .select({
      id: schoolCalendarSources.id,
      schoolId: schoolCalendarSources.schoolId,
      icsUrl: schoolCalendarSources.icsUrl,
    })
    .from(schoolCalendarSources)
    .where(eq(schoolCalendarSources.enabled, true))
    .orderBy(asc(schoolCalendarSources.schoolId), asc(schoolCalendarSources.id));
}

/**
 * 取得 Job が 1 イベントを upsert する入力。`school_id` を **明示**して渡す（取得 Job は system context で
 * cross-tenant に書くため、対象校を行ごとに固定する）。各フィールドは取得できない場合 null / 既定に倒す（fail-soft）。
 */
export type UpsertCalendarEventInput = {
  schoolId: string;
  /** iCal VEVENT UID（無ければ取得 Job がソース安定キーから生成して渡す）。 */
  uid: string;
  summary?: string | null;
  /** 開始日（JST 暦日 'YYYY-MM-DD'）。必須。 */
  startDate: string;
  endDate?: string | null;
  startAt?: Date | null;
  endAt?: Date | null;
  allDay?: boolean;
  location?: string | null;
  /** 由来のソース設定 id（運用追跡）。 */
  sourceId?: string | null;
  /** 原文（パース済み VEVENT フィールド等）の保全。 */
  raw?: unknown;
};

/**
 * 学校行事イベントを 1 行 upsert する（取得 Job 用、system context で呼ぶ）。`(school_id, uid)` 競合時は
 * 行事内容を差し替える（UPDATE 分岐でも `updatedAt` を明示更新。ルール1）。`createdBy` / `updatedBy` は null
 * （システム = `system://calendar-fetch`、auditColumns の「システム作成は null」規約）。
 *
 * RLS: system_admin context で呼び、`school_id` を明示する。`system_admin_full_access` の WITH CHECK が
 * cross-tenant の書込みを許す（BYPASSRLS 不使用、ルール2）。
 *
 * @param tx system_admin コンテキストを張ったトランザクション。
 * @returns upsert 後の行 id。
 */
export async function upsertCalendarEvent(
  tx: Pick<PostgresJsDatabase, "insert">,
  input: UpsertCalendarEventInput,
): Promise<string> {
  const rawValue = input.raw ?? {};
  const rows = await tx
    .insert(schoolCalendarEvents)
    .values({
      schoolId: input.schoolId,
      uid: input.uid,
      summary: input.summary ?? null,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      startAt: input.startAt ?? null,
      endAt: input.endAt ?? null,
      allDay: input.allDay ?? false,
      location: input.location ?? null,
      sourceId: input.sourceId ?? null,
      raw: rawValue,
      createdBy: null,
      updatedBy: null,
    })
    .onConflictDoUpdate({
      target: [schoolCalendarEvents.schoolId, schoolCalendarEvents.uid],
      set: {
        summary: input.summary ?? null,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        startAt: input.startAt ?? null,
        endAt: input.endAt ?? null,
        allDay: input.allDay ?? false,
        location: input.location ?? null,
        sourceId: input.sourceId ?? null,
        raw: rawValue,
        // ルール1: 再取得時刻として updated_at を明示更新（created_at / created_by は初回値を保つ）。
        updatedAt: new Date(),
        updatedBy: null,
      },
    })
    .returning({ id: schoolCalendarEvents.id });
  const id = rows[0]?.id;
  if (!id) {
    throw new Error("upsertCalendarEvent: INSERT ... RETURNING が行を返しませんでした");
  }
  return id;
}

/**
 * iCal から消えた行事を掃除する（取得 Job 用、system context）。指定校の行事のうち `keepUids` に **含まれない**
 * 行を削除し、削除件数を返す。再取得した iCal に残っている UID 群を `keepUids` に渡す想定（差分削除）。
 *
 * `keepUids` が空（全行事が消えた / 取得 0 件）の場合は、誤爆で全削除しないよう **何もしない**（0 を返す）。
 * 取得失敗で空集合になったケースと「本当に全行事が消えた」ケースを取得 Job 側で区別できないため、空集合掃除は
 * 安全側に倒す（last-known-good を残す）。
 *
 * RLS: system_admin context で呼び、`school_id` を明示する。DELETE は `system_admin_full_access` で通る（ルール2）。
 *
 * @param tx       system_admin コンテキストを張ったトランザクション。
 * @param schoolId 対象校。
 * @param keepUids 残す UID 群（再取得した iCal に存在する UID）。
 * @returns 削除した行数。
 */
export async function deleteStaleCalendarEvents(
  tx: Pick<PostgresJsDatabase, "delete">,
  schoolId: string,
  keepUids: readonly string[],
): Promise<number> {
  // 空集合掃除は安全側に倒す（取得失敗と全消去の区別がつかないため last-known-good を残す）。
  if (keepUids.length === 0) {
    return 0;
  }
  const rows = await tx
    .delete(schoolCalendarEvents)
    .where(
      and(
        eq(schoolCalendarEvents.schoolId, schoolId),
        notInArray(schoolCalendarEvents.uid, [...keepUids]),
      ),
    )
    .returning({ id: schoolCalendarEvents.id });
  return rows.length;
}

/**
 * ソースの取得結果（成功時刻 / 失敗理由）を記録する（取得 Job 用、system context）。成功時は
 * `lastFetchedAt = now`・`lastError = null`、失敗時は `lastError` に理由（PII 非格納）を入れる。`updatedAt` も
 * 明示更新する（ルール1）。
 *
 * RLS: system_admin context で呼び、`id` で対象ソースを特定する（`system_admin_full_access` で UPDATE 可）。
 *
 * @param tx        system_admin コンテキストを張ったトランザクション。
 * @param sourceId  対象ソース設定 id。
 * @param result    成功 / 失敗（失敗は error に理由、★ 生 PII を入れない）。
 */
export async function updateCalendarSourceStatus(
  tx: Pick<PostgresJsDatabase, "update">,
  sourceId: string,
  result: { ok: true; fetchedAt?: Date } | { ok: false; error: string },
): Promise<void> {
  await tx
    .update(schoolCalendarSources)
    .set(
      result.ok
        ? { lastFetchedAt: result.fetchedAt ?? new Date(), lastError: null, updatedAt: new Date() }
        : { lastError: result.error, updatedAt: new Date() },
    )
    .where(eq(schoolCalendarSources.id, sourceId));
}

/**
 * 指定校の行事を `startDate` の範囲で取得する（サイネージ / アプリ読み取り用）。`fromDate` 以降、`toDate` 指定時は
 * それ以下。`startDate` 昇順 → id 昇順で決定的に並べる。
 *
 * RLS: 呼び出し接続のコンテキスト（`app.current_school_id`）が `tenant_isolation` で自校行のみに絞る。匿名
 * サイネージ（role 未設定・school_id のみ set）でも自校イベントは読める。`WHERE school_id` は **対象特定**であって
 * テナント境界ではない（越権は RLS が弾く）が、ここでは敢えて school_id でも絞り、cross-tenant 混入を多層防御する。
 *
 * @param db       SELECT 可能な tx（テナント / 匿名サイネージ コンテキスト）。
 * @param schoolId 自校 id（RLS と二重で絞る）。
 * @param fromDate 取得開始日（JST 暦日 'YYYY-MM-DD'、含む）。
 * @param toDate   取得終了日（JST 暦日 'YYYY-MM-DD'、含む）。省略時は上限なし。
 */
export async function getCalendarEvents(
  db: Selectable,
  schoolId: string,
  fromDate: string,
  toDate?: string,
): Promise<SchoolCalendarEvent[]> {
  const conditions = [
    eq(schoolCalendarEvents.schoolId, schoolId),
    gte(schoolCalendarEvents.startDate, fromDate),
  ];
  if (toDate !== undefined) {
    conditions.push(lte(schoolCalendarEvents.startDate, toDate));
  }
  return db
    .select()
    .from(schoolCalendarEvents)
    .where(and(...conditions))
    .orderBy(asc(schoolCalendarEvents.startDate), asc(schoolCalendarEvents.id));
}

/** 取得 Job が write 系で使う tx 型エイリアス（system context、insert/update/delete を含む）。 */
export type CalendarWriteTx = TenantTx;
