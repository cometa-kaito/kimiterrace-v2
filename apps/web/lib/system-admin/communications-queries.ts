import { type TenantTx, communications } from "@kimiterrace/db";
import { type InferSelectModel, and, desc, eq } from "drizzle-orm";

/**
 * F10 (#46): 広告主とのコミュニケーション履歴 (CRM) の読み取り層。**サーバー専用**。
 *
 * communications は **cross-tenant・system_admin 専用** (RLS `system_admin_full_access`、ADR-018/019)。
 * 呼び出し側は `requireRole(SYSTEM_ADMIN_ROLES)` + `withSession` (system_admin context) で RLS を
 * 満たすこと。本層の `WHERE advertiser_id = ...` / `WHERE id = ...` は**対象特定であってテナント境界
 * ではない** — 可視範囲は RLS が決め、非 system_admin context では 0 行に倒れる (ルール2)。
 *
 * **クエリの置き場所**: advertisers-queries と同様に `apps/web` へ inline する (`packages/db` barrel を
 * 触る並行レーンとの衝突回避)。型は communications スキーマ由来 (`InferSelectModel`) のままなので単一
 * ソースは維持する (ルール3)。
 *
 * 消費する UI (広告主詳細の履歴表示) は別スライス。本 PR は read 層 + 単体テストのみ。
 */

/** 一覧 1 行の軽量射影。本文 (body_md) と添付は詳細ビューに回す。 */
export type CommunicationSummary = Pick<
  InferSelectModel<typeof communications>,
  "id" | "contractId" | "channel" | "occurredAt" | "subject" | "createdAt"
>;

/** ページング既定 / 上限。長い履歴で全件返しを避ける。 */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

/** offset を非負整数へ。未指定 / 非有限 (NaN/Infinity) は 0 (clampLimit と対称、`.offset(NaN)` を防ぐ)。 */
function normalizeOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

/**
 * ある広告主のコミュニケーション履歴を新しい順に返す。並びは発生日時降順、同時刻は記録時刻降順
 * (`ix_communications_occurred_at` を利用)。`advertiserId` での絞り込みは対象特定であって
 * テナント境界ではない (上記 doc 参照)。`limit` は 1..500 にクランプ、`offset` は非負へ正規化。
 */
export async function listCommunicationsByAdvertiser(
  tx: TenantTx,
  advertiserId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<CommunicationSummary[]> {
  const limit = clampLimit(opts.limit);
  const offset = normalizeOffset(opts.offset);
  return await tx
    .select({
      id: communications.id,
      contractId: communications.contractId,
      channel: communications.channel,
      occurredAt: communications.occurredAt,
      subject: communications.subject,
      createdAt: communications.createdAt,
    })
    .from(communications)
    .where(eq(communications.advertiserId, advertiserId))
    .orderBy(desc(communications.occurredAt), desc(communications.createdAt))
    .limit(limit)
    .offset(offset);
}

/** 詳細ビュー用の全表示フィールド (本文・添付・紐づく契約を含む)。 */
export type CommunicationDetail = Pick<
  InferSelectModel<typeof communications>,
  | "id"
  | "advertiserId"
  | "contractId"
  | "channel"
  | "occurredAt"
  | "subject"
  | "bodyMd"
  | "attachmentsJson"
  | "createdAt"
>;

/**
 * 単一コミュニケーションを id で取得する。`advertiserId` も渡された場合は **親広告主との一致を AND
 * 条件に加える** (URL 越しの id 取り違え / 別広告主の記録の誤表示を防ぐ防御。テナント境界ではなく
 * 整合チェック)。見つからなければ `null` (RLS 不可視 / 不存在は区別せず 404 相当、ルール2)。
 */
export async function getCommunicationDetail(
  tx: TenantTx,
  id: string,
  advertiserId?: string,
): Promise<CommunicationDetail | null> {
  const condition =
    advertiserId === undefined
      ? eq(communications.id, id)
      : and(eq(communications.id, id), eq(communications.advertiserId, advertiserId));
  const [row] = await tx
    .select({
      id: communications.id,
      advertiserId: communications.advertiserId,
      contractId: communications.contractId,
      channel: communications.channel,
      occurredAt: communications.occurredAt,
      subject: communications.subject,
      bodyMd: communications.bodyMd,
      attachmentsJson: communications.attachmentsJson,
      createdAt: communications.createdAt,
    })
    .from(communications)
    .where(condition)
    .limit(1);
  return row ?? null;
}
