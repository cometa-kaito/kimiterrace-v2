import { hashToken } from "@/lib/magic-link/token";
import {
  type EffectiveAd,
  type TenantTx,
  getEffectiveAdsForClass,
  resolveMagicLink,
  withTenantContext,
} from "@kimiterrace/db";
import { getDb } from "../db";
import { type EffectiveDailyData, getEffectiveDailyData } from "./effective-daily-data";

/**
 * 公開サイネージ表示の**データアクセス層** (#48-E / F12)。`/signage/{classToken}` の Server
 * Component (初期描画) とポーリング Route Handler (自動更新) の両方が本層を 1 回呼ぶ。
 *
 * ## RLS コンテキスト (CLAUDE.md ルール2 / STATUS「withSession→withTenantContext」)
 *
 * サイネージ端末は**匿名** (教員の Identity Platform セッションを持たない) なので、認証必須の
 * `withSession` (lib/db) は使えない。代わりに 2 段で安全にテナント文脈を確立する:
 *
 *  1. URL の `classToken` を `resolveMagicLink` (SECURITY DEFINER 関数、RLS 文脈不要) で
 *     `{schoolId, classId}` に解決。失効/期限切れ/不明トークンは null → 呼び出し側が 410/無効画面へ。
 *     これは F05 の生徒匿名アクセスと同じ「RLS をくぐる唯一の扉」を再利用する (新規スキーマ不要)。
 *  2. 解決できた `schoolId` のみを `withTenantContext` に載せてトランザクションを開く。userId/role は
 *     **載せない** (deny-by-default)。`app.current_school_id` だけが set されるので、`daily_data` /
 *     `effective_ads_per_class` VIEW (security_invoker) の `tenant_isolation` が DB レベルで自校に
 *     限定する。手書き `WHERE school_id=?` には依存しない (ルール2)。`getDb()` は非 BYPASSRLS の
 *     `kimiterrace_app` 接続。
 *
 * **PII 非表示 (threat-model S-03)**: 表示するのはクラス単位の公開情報 (時間割・連絡・課題・広告)
 * のみで、個別生徒の氏名・出欠は含まない。よって本経路は Vertex AI を呼ばず PII マスキング (ルール4)
 * の対象外。`classToken` は credential なのでログ・例外に出さない (ルール5)。
 *
 * ## NFR01 接続試算 (タスク要件: 50 台×ポーリングを NFR01 と突合)
 *
 * - 1 ポーリング = 本関数 1 回 = `withTenantContext` 1 トランザクション = プール 1 接続を**短時間**
 *   占有 (内訳: クラス解決 1 + daily 1 + ads 1 の計 3 SELECT、いずれも index 等価結合で
 *   NFR01「DB クエリ p95 < 100ms」内、合計 < 数十 ms)。
 * - 負荷: 50 台/校 ÷ 10 秒 (POLL_BASE_MS) = **5 req/s/校** (v1-v2-mapping が懸念した 5 秒間隔の
 *   10 req/s を、サイネージの低更新頻度を根拠に 10 秒へ倍化して半減)。`rotation.ts` のジッタで
 *   位相を分散し同一秒バーストを回避。
 * - 同時接続: 5 req/s × ~0.05s 占有 ≒ **平均 0.25 接続/校**。`createDbClient` の `max:10`
 *   プール (Cloud Run 1 インスタンス) に対し桁違いに余裕。最悪ケース (50 台が同位相に揃う) でも
 *   ジッタ + Cloud Run の水平オートスケール (ADR-002) + 短トランザクションで吸収。
 * - 多校展開時の真の上限は Cloud SQL 全体の `max_connections`。1 インスタンス当たり max:10 を
 *   守り、必要なら Phase 2 で pgBouncer / Cloud SQL コネクションプーラを前段に置く (本 MVP では不要)。
 * - 鮮度: NFR01「公開からサイネージ反映まで最大 60 秒」に対し 10 秒ポーリングは十分内側。
 *   失効反映も毎リクエスト再解決なので即時 (キャッシュしない、下記 Route Handler の no-store 参照)。
 */

/** サイネージ 1 画面分のペイロード。Server Component の初期描画とポーリング応答で共有。 */
export type SignagePayload = {
  date: string;
  daily: EffectiveDailyData;
  ads: EffectiveAd[];
};

/** トークンを {schoolId, classId} に解決。無効 (失効/期限切れ/不明) なら null。 */
async function resolveSignageClass(
  classToken: string,
): Promise<{ schoolId: string; classId: string } | null> {
  const resolved = await resolveMagicLink(getDb(), hashToken(classToken));
  if (!resolved) {
    return null;
  }
  return { schoolId: resolved.schoolId, classId: resolved.classId };
}

/**
 * 指定クラストークン・日付のサイネージ表示データを 1 トランザクションで取得する。
 *
 * @param classToken 公開クラストークン (magic link)。credential なのでログに出さない。
 * @param date       YYYY-MM-DD (JST)。
 * @returns          有効トークンかつクラス可視なら `SignagePayload`、無効/不可視なら null。
 */
export async function getSignageDisplayData(
  classToken: string,
  date: string,
): Promise<SignagePayload | null> {
  const cls = await resolveSignageClass(classToken);
  if (!cls) {
    return null;
  }

  return await withTenantContext(getDb(), { schoolId: cls.schoolId }, async (tx: TenantTx) => {
    const daily = await getEffectiveDailyData(tx, cls.classId, date);
    if (!daily) {
      // トークンは有効だがクラスが (別テナント等で) 不可視 → null。呼び出し側が無効扱いにする。
      return null;
    }
    const ads = await getEffectiveAdsForClass(tx, cls.classId);
    return { date, daily, ads } satisfies SignagePayload;
  });
}
