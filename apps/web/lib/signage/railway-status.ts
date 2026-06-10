import { type TenantTx, getRailwayStatus } from "@kimiterrace/db";

/**
 * パターン2「鉄道」サイネージ読み取り（ADR-035）。weather と同じく **キャッシュ（railway_status）を読むだけ**で
 * 名鉄サイトを直叩きしない（端末閉域）。`getSignageDisplayData` のテナント context tx 内で呼ぶ。RLS は
 * `railway_status_read_all`（USING true）なので匿名サイネージでも読める。
 *
 * ## 現状の対象事業者（MVP）
 * 当面は **名鉄（笠松駅・岐南工業の最寄）固定**で `operator='meitetsu'` を読む。複数事業者・学校別路線への
 * 対応は school_configs に operator を持たせる follow-up（ADR-035）。取得 Job 未稼働・キャッシュ無しは null
 * （ウィジェットは「運行情報は取得できていません」表示＝fail-soft）。
 */

/** 当面の対象事業者（名鉄）。 */
const MEITETSU_OPERATOR = "meitetsu";
/** これより古いキャッシュは「鮮度低下」とみなす（取得 Job 停止時の誤情報抑止。30 分）。 */
const STALE_AFTER_MS = 30 * 60 * 1000;

/** サイネージ盤面に出す運行情報（表示専用の射影）。 */
export type SignageRailwayStatus = {
  /** 事業者表示名（例「名鉄」）。 */
  operatorName: string;
  /** 運行情報メッセージ本文。 */
  statusText: string;
  /** 運行に乱れがあるか（true で強調表示）。 */
  hasDisruption: boolean;
  /** キャッシュが古い（取得 Job が一定時間更新していない）。注記表示に使う。 */
  isStale: boolean;
};

/**
 * 当面の対象事業者（名鉄）の現況を取得する。キャッシュ無しは null（fail-soft）。
 *
 * @param tx  テナント context tx（匿名サイネージ可・RLS read_all で読める）。
 * @param now 鮮度判定の基準時刻（既定は現在時刻）。
 */
export async function getSignageRailwayStatus(
  tx: TenantTx,
  now: Date = new Date(),
): Promise<SignageRailwayStatus | null> {
  const row = await getRailwayStatus(tx, MEITETSU_OPERATOR);
  if (!row) {
    return null;
  }
  const isStale = now.getTime() - row.fetchedAt.getTime() > STALE_AFTER_MS;
  return {
    operatorName: row.operatorName ?? "鉄道",
    statusText: row.statusText,
    hasDisruption: row.hasDisruption,
    isStale,
  };
}
