import { type TenantTx, auditLog, auditOp, schools } from "@kimiterrace/db";
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
  lt,
  or,
  sql,
} from "drizzle-orm";
import {
  type ListParams,
  dateRangeBounds,
  escapeLike,
  pageWindow,
} from "@/app/_components/datalist/list-params";

/**
 * UIUX-03: 監査ログビューア (`/ops/audit`) のページング/検索/ソート対応 SELECT 層。
 * `school-list.ts` / `user-list.ts` と同構造 (共通 DataList 基盤)。
 *
 * ## 置き場所 (並行レーン回避)
 * `packages/db` (chokepoint) を編集せず `apps/web/lib` に置く。テーブル/enum は barrel から
 * import し、行型は schema 由来 (`InferSelectModel<typeof auditLog>`、ルール3)。
 *
 * ## テナント分離 (ルール2 / ADR-019)
 * `audit_log` は cross-tenant (school_id nullable) で RLS `audit_log_tenant_read` policy
 * (SELECT: 自テナント or system_admin) が守る。WHERE に school_id / role を**書かない** —
 * 可視範囲は呼出側 (`withSession`) が張る RLS context が決める (system_admin=全行)。
 * 本層の WHERE は検索条件のみ。
 *
 * ## 検索 (q)
 * tableName / actorIdentityUid / ipAddress に加え、`diff` (jsonb) を **`::text` 化して
 * ilike 部分一致**させる — 操作対象の値や view_access 行の絞り込み条件メタを横断検索できる
 * (調査時に「この値を触った操作はどれか」を引くため)。表示時のマスキング (mask.ts) とは独立で、
 * 検索は DB 内で完結し外部送信は発生しない (ルール4)。
 */

/** SELECT (+ 対象テーブル名の selectDistinct) だけできれば良い。 */
type Selectable = Pick<TenantTx, "select" | "selectDistinct">;

/** ソート可能列の allowlist。`parseListParams` の sortKeys と ORDER BY を 1 箇所で対応させる。 */
export const AUDIT_LOG_SORT_COLUMNS = {
  occurredAt: auditLog.occurredAt,
  tableName: auditLog.tableName,
  operation: auditLog.operation,
} as const;

export const AUDIT_LOG_SORT_KEYS = Object.keys(AUDIT_LOG_SORT_COLUMNS) as readonly string[];

/** `audit_op` enum の値域 (insert / update / delete)。schema の pgEnum が単一ソース (ルール3)。 */
export const AUDIT_OPERATION_VALUES = auditOp.enumValues;

/** 操作種別。enum 値とズレるとコンパイルで検出される。 */
export type AuditOperation = (typeof AUDIT_OPERATION_VALUES)[number];

type AuditLogRow = InferSelectModel<typeof auditLog>;

/** 一覧 1 行。schema 由来の射影 + leftJoin した校名 (school_id null = 横断操作 → null)。 */
export type AuditLogListEntry = Pick<
  AuditLogRow,
  | "id"
  | "occurredAt"
  | "actorUserId"
  | "actorIdentityUid"
  | "schoolId"
  | "tableName"
  | "recordId"
  | "operation"
  | "diff"
  | "ipAddress"
  | "rowHash"
> & { schoolName: string | null };

/** 一覧 1 ページ分 + 総件数。 */
export type AuditLogListPage = { rows: AuditLogListEntry[]; total: number };

/** URL 由来の operation フィルタを enum 値域に検証する (範囲外は黙って無視、URL は外部入力)。 */
function parseAuditOperation(value: string | undefined): AuditOperation | null {
  if (value !== undefined && (AUDIT_OPERATION_VALUES as readonly string[]).includes(value)) {
    return value as AuditOperation;
  }
  return null;
}

/**
 * 監査ログを検索 (テーブル名/操作者UID/IP/diff 全文の部分一致)・操作種別/対象テーブルフィルタ・
 * 発生日範囲・列ソート・ページングで取得する。`schools` への leftJoin で校名を解決する
 * (school_id nullable のため inner ではなく left。schools は PK 結合なので件数は変わらない)。
 * 同値ソートでも順序が安定するよう id を最終タイブレークに付ける。
 */
export async function listAuditLogPage(
  db: Selectable,
  params: ListParams,
): Promise<AuditLogListPage> {
  const conditions: SQL[] = [];
  if (params.q) {
    const pattern = `%${escapeLike(params.q)}%`;
    const match = or(
      ilike(auditLog.tableName, pattern),
      ilike(auditLog.actorIdentityUid, pattern),
      ilike(auditLog.ipAddress, pattern),
      // diff (jsonb) は text 化して全文部分一致 (モジュール doc「検索 (q)」参照)。
      ilike(sql`${auditLog.diff}::text`, pattern),
    );
    if (match) {
      conditions.push(match);
    }
  }
  const { since, untilExclusive } = dateRangeBounds(params);
  if (since) {
    conditions.push(gte(auditLog.occurredAt, since));
  }
  if (untilExclusive) {
    conditions.push(lt(auditLog.occurredAt, untilExclusive));
  }
  const operation = parseAuditOperation(params.filters.operation);
  if (operation) {
    conditions.push(eq(auditLog.operation, operation));
  }
  // 対象テーブル名は完全一致 (選択肢は listAuditLogTableNames の実在値。パラメタライズ済で
  // 任意文字列でも安全 — 実在しない値は 0 件に倒れるだけ)。
  const tbl = params.filters.tbl;
  if (tbl) {
    conditions.push(eq(auditLog.tableName, tbl));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const sortColumn =
    AUDIT_LOG_SORT_COLUMNS[params.sort as keyof typeof AUDIT_LOG_SORT_COLUMNS] ??
    auditLog.occurredAt;
  const orderBy =
    params.dir === "asc"
      ? [asc(sortColumn), asc(auditLog.id)]
      : [desc(sortColumn), asc(auditLog.id)];
  const { limit, offset } = pageWindow(params);

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: auditLog.id,
        occurredAt: auditLog.occurredAt,
        actorUserId: auditLog.actorUserId,
        actorIdentityUid: auditLog.actorIdentityUid,
        schoolId: auditLog.schoolId,
        schoolName: schools.name,
        tableName: auditLog.tableName,
        recordId: auditLog.recordId,
        operation: auditLog.operation,
        diff: auditLog.diff,
        ipAddress: auditLog.ipAddress,
        rowHash: auditLog.rowHash,
      })
      .from(auditLog)
      .leftJoin(schools, eq(auditLog.schoolId, schools.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    // WHERE は auditLog の列のみ参照するため count は JOIN 不要 (left join は件数を変えない)。
    db.select({ value: count() }).from(auditLog).where(where),
  ]);

  return { rows, total: totals[0]?.value ?? 0 };
}

/**
 * 対象テーブルフィルタの選択肢用に、audit_log に**実在する** table_name を distinct で返す。
 * 物理テーブル名に加え、閲覧監査の論理 subject (`*_view_access`、view-audit.ts) も自然に並ぶ。
 * 値域は「監査対象テーブル数 + 論理 subject 数」で高々数十行オーダー (ページング不要)。
 */
export async function listAuditLogTableNames(db: Selectable): Promise<string[]> {
  const rows = await db
    .selectDistinct({ tableName: auditLog.tableName })
    .from(auditLog)
    .orderBy(asc(auditLog.tableName));
  return rows.map((r) => r.tableName);
}
