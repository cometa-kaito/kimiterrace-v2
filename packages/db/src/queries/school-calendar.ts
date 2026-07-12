import {
  type InferInsertModel,
  type InferSelectModel,
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  lte,
  notInArray,
} from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { fileImportEventDiffKey } from "../calendar-import-key.js";
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
 * ADR-049 決定 1/2: ファイル取込由来イベントの uid 名前空間プレフィクス。
 * `sourceId = null` + `uid LIKE 'file:%'` の**二重条件**がファイル取込行事の境界（uid 規約単独に依存しない）。
 * iCal 側は `sanitizeIcalEventUid` でこの名前空間へ侵食できない（両側強制）。
 */
export const FILE_IMPORT_UID_PREFIX = "file:";

/** ADR-049 決定 2: iCal 由来 uid のリライトで前置するプレフィクス（`file:` 名前空間の侵食防止）。 */
export const ICAL_UID_REWRITE_PREFIX = "ical:";

/** uid カラム（varchar）の最大長。リライトで前置した結果の桁あふれを防ぐクランプに使う。 */
const UID_MAX_LENGTH = 512;

/**
 * ADR-049 決定 2（iCal 取込側の名前空間強制）: 外部 iCal フィードの VEVENT UID が `file:` で始まる場合、
 * `ical:` を前置してリライトする。ファイル取込の置き換え削除（`replaceFileImportedEvents`）は
 * `source_id IS NULL AND uid LIKE 'file:%'` の二重条件だが、外部フィードが `UID: file:...` を吐いても
 * ファイル取込名前空間を侵食できないよう、書き込まれる uid 自体を両側から強制する。
 *
 * 呼び出し側（取得 Job の uid 導出単一点）は keepUids にも**リライト後の値**を渡すこと（upsert と掃除の整合）。
 * リライトは決定的（同じ入力 → 同じ出力）なので再取得の upsert 冪等性を壊さない。varchar(512) を超える場合は
 * 先頭 512 文字にクランプする（決定的なので冪等性は保たれる）。
 */
export function sanitizeIcalEventUid(uid: string): string {
  if (!uid.startsWith(FILE_IMPORT_UID_PREFIX)) {
    return uid;
  }
  return `${ICAL_UID_REWRITE_PREFIX}${uid}`.slice(0, UID_MAX_LENGTH);
}

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
 * iCal から消えた行事を掃除する（取得 Job 用、system context）。**同期中のソース由来**（`source_id = sourceId`）
 * の行事のうち `keepUids` に **含まれない**行を削除し、削除件数を返す。再取得した iCal に残っている UID 群を
 * `keepUids` に渡す想定（差分削除）。
 *
 * ★ ADR-049 決定 2（掃除スコープのソース単位化）: 旧実装は school 単位で `keepUids` 外を全削除していたため、
 * iCal ソース併用校では `sourceId = null` のファイル取込行事（`file:` 名前空間）が次回同期で誤削除された。
 * `source_id = sourceId` を削除条件に加えてスコープをソース単位に絞る（`sourceId = null` の行 = ファイル取込 /
 * orphan は SQL の `=` 比較が false になるため構造的に掃除対象外）。
 *
 * `keepUids` が空（全行事が消えた / 取得 0 件）の場合は、誤爆で全削除しないよう **何もしない**（0 を返す）。
 * 取得失敗で空集合になったケースと「本当に全行事が消えた」ケースを取得 Job 側で区別できないため、空集合掃除は
 * 安全側に倒す（last-known-good を残す）。
 *
 * RLS: system_admin context で呼び、`school_id` を明示する。DELETE は `system_admin_full_access` で通る（ルール2）。
 *
 * @param tx       system_admin コンテキストを張ったトランザクション。
 * @param schoolId 対象校。
 * @param sourceId 同期中のソース設定 id（この source 由来の行だけを掃除する）。
 * @param keepUids 残す UID 群（再取得した iCal に存在する UID）。
 * @returns 削除した行数。
 */
export async function deleteStaleCalendarEvents(
  tx: Pick<PostgresJsDatabase, "delete">,
  schoolId: string,
  sourceId: string,
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
        // ソース単位スコープ（ADR-049 決定 2）。sourceId = null（ファイル取込 / orphan）は掃除しない。
        eq(schoolCalendarEvents.sourceId, sourceId),
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

/** ファイル取込イベント 1 件の入力（AI 構造化出力の確定形。uid / raw / 監査はヘルパが導出する）。 */
export type FileImportedEventInput = Pick<
  InferInsertModel<typeof schoolCalendarEvents>,
  "summary" | "startDate" | "endDate" | "startAt" | "endAt" | "allDay" | "location"
>;

/** `replaceFileImportedEvents` の入力。 */
export type ReplaceFileImportedEventsParams = {
  /** 対象校（RLS と二重で絞る。越権は tenant_isolation が弾く）。 */
  schoolId: string;
  /** 取込バッチ id（uid = `file:<batchId>:<n>` と `raw.batchId` に使う）。呼び出し側が採番（UUID 想定）。 */
  batchId: string;
  /** 取込元ファイル名（`raw.fileName` に保全。パス等は含めない）。 */
  fileName: string;
  /**
   * 実行者 uid（`createdBy` / `updatedBy` / `raw.importedBy`）。system_admin 代行は null
   * （users 行でないため。auditColumns の「システム作成は null」規約 + 別トラッキング）。
   */
  actorUserId: string | null;
  /** 保存するイベント（確認 UI で教員が確定した後の一覧。ADR-049 決定 4）。 */
  events: readonly FileImportedEventInput[];
};

/** `replaceFileImportedEvents` の結果（削除 / 挿入件数。取込履歴・監査ログ用）。 */
export type ReplaceFileImportedEventsResult = {
  deleted: number;
  inserted: number;
};

/**
 * ADR-049 決定 1/2/6: ファイル取込由来の行事を **`file:` 名前空間全体の置き換え**で保存する
 * （テナント RLS セッション = 教員 / school_admin から呼ぶ前提）。
 *
 * 1. 既存のファイル取込行事（**`source_id IS NULL AND uid LIKE 'file:%'` の二重条件**）を削除。
 *    - `sourceId` 非 null（iCal 由来）の行は、万一 `file:` uid が紛れても `source_id IS NULL` で保護される
 *      （名前空間の両側強制。iCal 側のリライトは `sanitizeIcalEventUid`）。
 *    - ソース行削除で `onDelete: set null` になった **orphan iCal 行**（sourceId = null・非 `file:` uid）は
 *      uid 条件で除外され誤削除しない。orphan の本格的な掃除は未実装（ADR-049 決定 2 の残存リスク・放置すると
 *      永久残留。ソース削除 UI の実装時に再検討）。
 * 2. 新バッチを一括 INSERT。uid = `file:<batchId>:<n>`（n は 1 始まりの連番）、`sourceId = null`、
 *    `raw = { origin: "file-import", batchId, fileName, importedBy }` を保全（残存リスク③の追跡子）。
 *
 * `events` が空の場合も削除は行う（= 取込の全消し）。iCal 掃除の「空は no-op」安全弁と異なり、本ヘルパは
 * 確認 UI（ADR-049 決定 4）で教員が明示確定した置き換え操作なので、空バッチは意図的なクリアとして扱う。
 *
 * RLS: 呼び出し接続の tenant_isolation（school_id 一致）が越権を弾く。`WHERE school_id` は対象特定 + 多層防御
 * （ルール2、手書き境界に依存しない）。監査（ルール1）: `createdBy` / `updatedBy` = 実行者 uid。
 *
 * @param tx     テナントコンテキスト（教員 / school_admin）を張ったトランザクション。削除と挿入を原子化するため
 *               必ず同一 tx で呼ぶ。
 * @param params 置き換え入力。
 * @returns 削除件数と挿入件数。
 */
export async function replaceFileImportedEvents(
  tx: Pick<PostgresJsDatabase, "delete" | "insert">,
  params: ReplaceFileImportedEventsParams,
): Promise<ReplaceFileImportedEventsResult> {
  // 1) 既存ファイル取込バッチの削除（source_id IS NULL AND uid LIKE 'file:%' の二重条件、ADR-049 決定 2）。
  const deletedRows = await tx
    .delete(schoolCalendarEvents)
    .where(
      and(
        eq(schoolCalendarEvents.schoolId, params.schoolId),
        isNull(schoolCalendarEvents.sourceId),
        like(schoolCalendarEvents.uid, `${FILE_IMPORT_UID_PREFIX}%`),
      ),
    )
    .returning({ id: schoolCalendarEvents.id });

  // 2) 新バッチの一括 INSERT（空バッチは削除のみ = 意図的なクリア）。
  if (params.events.length === 0) {
    return { deleted: deletedRows.length, inserted: 0 };
  }
  const insertedRows = await tx
    .insert(schoolCalendarEvents)
    .values(fileImportInsertValues(params))
    .returning({ id: schoolCalendarEvents.id });
  return { deleted: deletedRows.length, inserted: insertedRows.length };
}

/**
 * ファイル取込バッチの INSERT values を組む（replace / merge 共通の単一点）。uid = `file:<batchId>:<n>`
 * （n は 1 始まりの連番）、`sourceId = null`、`raw = { origin: "file-import", batchId, fileName, importedBy }`
 * を保全（ADR-049 残存リスク③の追跡子）。監査（ルール1）: `createdBy` / `updatedBy` = 実行者 uid。
 */
function fileImportInsertValues(
  params: ReplaceFileImportedEventsParams,
): InferInsertModel<typeof schoolCalendarEvents>[] {
  const actor = params.actorUserId;
  return params.events.map((ev, i) => ({
    schoolId: params.schoolId,
    uid: `${FILE_IMPORT_UID_PREFIX}${params.batchId}:${i + 1}`,
    summary: ev.summary ?? null,
    startDate: ev.startDate,
    endDate: ev.endDate ?? null,
    startAt: ev.startAt ?? null,
    endAt: ev.endAt ?? null,
    allDay: ev.allDay ?? false,
    location: ev.location ?? null,
    sourceId: null,
    // 取込履歴の保全（ADR-049 残存リスク③: 教員による置き換え/マージを batchId / importedBy で追跡可能にする）。
    raw: {
      origin: "file-import",
      batchId: params.batchId,
      fileName: params.fileName,
      importedBy: actor,
    },
    createdBy: actor,
    updatedBy: actor,
  }));
}

/**
 * {@link mergeFileImportedEvents} の入力。replace と同じ形 + マージ後合計の上限。
 * `maxTotalEvents` は apps/web の `MAX_FILE_IMPORT_EVENTS`（= 2000）を渡す想定（値の正本は呼び出し側。
 * ヘルパ内定数にしないのは、上限の単一ソースが取込 UI / sanitize / 保存前再検証と同じ場所にあるため）。
 */
export type MergeFileImportedEventsParams = ReplaceFileImportedEventsParams & {
  /** マージ後の `file:` 名前空間合計（そのまま残る既存 + 今回挿入）の上限。超過時は一切書き込まない。 */
  maxTotalEvents: number;
};

/** {@link mergeFileImportedEvents} の結果。over_cap はロールバック不要（書き込み前に判定・no-op）。 */
export type MergeFileImportedEventsResult =
  | {
      ok: true;
      /** キー一致で内容更新された既存行数（削除→新バッチ再挿入なので「更新件数」に等しい）。 */
      deleted: number;
      /** 挿入した行数（= 今回のイベント数。うち deleted 件は更新・残りが純増）。 */
      inserted: number;
      /** 新ファイルに無く**そのまま残った**既存ファイル取込行事の数。 */
      keptExisting: number;
    }
  | {
      ok: false;
      reason: "over_cap";
      keptExisting: number;
      incoming: number;
    };

/**
 * ADR-049 決定 1 の 2026-07-12 追補: ファイル取込由来の行事を**マージ**（追加・更新）で保存する
 * （`replaceFileImportedEvents` と対をなす第 2 の書き込み口。テナント RLS セッション = 教員 /
 * school_admin から呼ぶ前提）。部分的な予定表（学期別・追補分）を、既存の取込行事を消さずに足すための
 * 意味論:
 *
 * - **キー = (trim(summary), startDate)**（`fileImportEventDiffKey`・#1278 の差分表示と単一ソース）。
 * - キー一致の既存ファイル取込行事 → 新ファイルの内容で**更新**（実装は「一致した既存行を id 指定で
 *   削除し、新バッチ行を挿入」。uid はバッチ依存（`file:<batchId>:<n>`）のため in-place UPDATE の意義がなく、
 *   削除+挿入の方が replace と挿入経路を共有できる）。
 * - 新規キー → 追加。新ファイルに無い既存ファイル取込行事 → **残す**（マージの目的）。
 * - iCal 由来（`sourceId` 非 null / `ical:` uid）は従来どおり一切触れない（読みも削除も
 *   `source_id IS NULL AND uid LIKE 'file:%'` の二重条件・ADR-049 決定 2）。
 *
 * キー正規化の SQL/TS ズレ防止のため、既存行を SELECT で fetch して **TS 側でキー計算 → id 指定 DELETE**
 * する（SQL 側に trim 比較を書かない。RLS も素直: SELECT/DELETE とも tenant_isolation が自校に絞る）。
 *
 * 上限: マージ後の `file:` 名前空間合計（残す既存 + 挿入）が `maxTotalEvents` を超える場合は
 * **一切書き込まず** `over_cap` を返す（同一 tx 内で既存 fetch → 判定するので TOCTOU を作らない）。
 *
 * RLS: 呼び出し接続の tenant_isolation（school_id 一致）が越権を弾く（他校の既存行は USING で不可視 =
 * 触れない・他校への INSERT は WITH CHECK で拒否）。`WHERE school_id` は対象特定 + 多層防御（ルール2）。
 *
 * @param tx     テナントコンテキスト（教員 / school_admin）を張ったトランザクション。fetch / 削除 / 挿入を
 *               原子化するため必ず同一 tx で呼ぶ。
 * @param params マージ入力（replace と同形 + maxTotalEvents）。
 */
export async function mergeFileImportedEvents(
  tx: Pick<PostgresJsDatabase, "select" | "delete" | "insert">,
  params: MergeFileImportedEventsParams,
): Promise<MergeFileImportedEventsResult> {
  // 1) 既存のファイル取込行事を fetch（境界は replace と同じ二重条件）。キーは TS 側で計算する。
  const existing = await tx
    .select({
      id: schoolCalendarEvents.id,
      summary: schoolCalendarEvents.summary,
      startDate: schoolCalendarEvents.startDate,
    })
    .from(schoolCalendarEvents)
    .where(
      and(
        eq(schoolCalendarEvents.schoolId, params.schoolId),
        isNull(schoolCalendarEvents.sourceId),
        like(schoolCalendarEvents.uid, `${FILE_IMPORT_UID_PREFIX}%`),
      ),
    );

  const incomingKeys = new Set(params.events.map((ev) => fileImportEventDiffKey(ev)));
  const matchedIds = existing
    .filter((row) => incomingKeys.has(fileImportEventDiffKey(row)))
    .map((row) => row.id);
  const keptExisting = existing.length - matchedIds.length;

  // 2) 上限判定（書き込み前・同一 tx）。超過なら no-op で返し、呼び出し側が検証エラーとして案内する。
  if (keptExisting + params.events.length > params.maxTotalEvents) {
    return { ok: false, reason: "over_cap", keptExisting, incoming: params.events.length };
  }

  // 3) キー一致の既存行を削除（id 指定 + 二重条件の AND で多層防御。iCal 行は id 集合に入り得ない）。
  let deleted = 0;
  if (matchedIds.length > 0) {
    const deletedRows = await tx
      .delete(schoolCalendarEvents)
      .where(
        and(
          eq(schoolCalendarEvents.schoolId, params.schoolId),
          isNull(schoolCalendarEvents.sourceId),
          like(schoolCalendarEvents.uid, `${FILE_IMPORT_UID_PREFIX}%`),
          inArray(schoolCalendarEvents.id, matchedIds),
        ),
      )
      .returning({ id: schoolCalendarEvents.id });
    deleted = deletedRows.length;
  }

  // 4) 新バッチの一括 INSERT（挿入経路は replace と共有 = 単一点）。空イベントのマージは no-op。
  if (params.events.length === 0) {
    return { ok: true, deleted, inserted: 0, keptExisting };
  }
  const insertedRows = await tx
    .insert(schoolCalendarEvents)
    .values(fileImportInsertValues(params))
    .returning({ id: schoolCalendarEvents.id });
  return { ok: true, deleted, inserted: insertedRows.length, keptExisting };
}

/** 取得 Job が write 系で使う tx 型エイリアス（system context、insert/update/delete を含む）。 */
export type CalendarWriteTx = TenantTx;
