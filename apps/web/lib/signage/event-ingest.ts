import { hashToken } from "@/lib/magic-link/token";
import { events, type TenantTx, resolveMagicLink, withTenantContext } from "@kimiterrace/db";
import { getDb } from "../db";

/**
 * F07 (#43): サイネージ端末からの行動イベント取り込み (view/tap)。**サーバー専用**。
 *
 * `recordStudentAccess` (lib/magic-link/student-access) は magic link を開いた**最初の 1 回**を
 * `events` に記録するが、本層は表示セッション中に端末が発火する継続イベント (広告 impression =
 * `view` / タップ = `tap`) を `POST /signage/{classToken}/events` から受けて記録する。両者は補完
 * 関係で重複しない。
 *
 * ## 匿名テナント解決 (signage-display と同じ「RLS をくぐる唯一の扉」を再利用)
 * 1. URL の `classToken` を `resolveMagicLink` (SECURITY DEFINER、RLS 文脈不要) で `{schoolId}` に解決。
 *    失効/期限切れ/不明トークンは null → 呼び出し側 (route) が 410 に倒す。
 * 2. `withTenantContext({schoolId})` で `app.current_school_id` のみ set し INSERT。events の
 *    `tenant_isolation` WITH CHECK が `school_id` を自校に強制する (CLAUDE.md ルール2: DB レベルで
 *    テナント分離、手書き WHERE 非依存)。`getDb()` は非 BYPASSRLS の `kimiterrace_app` 接続。
 *
 * ## PII (ルール4) / 監査 (NFR04)
 * - `payload` は許可キー (clientId/slotIndex) のみ。clientId は cookie/localStorage 由来の**匿名 uuid**
 *   で個人特定情報ではない (F07 受け入れ条件「client_id は cookie の uuid のみ」)。氏名・自由記述・IP は
 *   保存しない。
 * - `occurred_at` は DB 既定 `now()` を使い**クライアント時刻を信用しない** (なりすまし/時計ずれ回避)。
 * - events は「行自体が行動記録」で audit_log とは目的分離 (F07 doc / NFR04)。二重記録しない。
 * - `classToken` は credential なのでログ・例外に出さない (ルール5)。
 */

/**
 * 本スライスが受理する event_type。enum は `view/tap/dwell/ask` だが:
 * - `dwell` は滞留秒数の厳密計測手段が未確定で Phase 2 まで書き込み不在 (F07 doc)。
 * - `ask` は F06 生徒対話の経路で記録するため本エンドポイントの対象外。
 * よって view/tap 以外は 400 (`invalid`) に倒し、未対応値の取りこぼしを検知可能にする。
 */
const ACCEPTED_TYPES = ["view", "tap"] as const;
type AcceptedType = (typeof ACCEPTED_TYPES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 端末から届く生の入力 (JSON/beacon)。型は不明値として受け、`validateEventInput` で確定する。 */
export type EventIngestInput = {
  type?: unknown;
  contentId?: unknown;
  clientId?: unknown;
  slotIndex?: unknown;
  adId?: unknown;
};

export type ValidatedEvent = {
  type: AcceptedType;
  contentId: string | null;
  payload: Record<string, unknown>;
};

export type EventIngestResult =
  | { ok: true }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "gone" };

/**
 * 入力検証 (純関数)。許可した形だけを通し、payload は PII を持たない最小集合に正規化する。
 * 未知キーは無視する (allowlist 方式) ので、端末が余分な項目を送っても保存されない。
 */
export function validateEventInput(
  raw: EventIngestInput,
): { ok: true; value: ValidatedEvent } | { ok: false; message: string } {
  if (typeof raw.type !== "string" || !ACCEPTED_TYPES.includes(raw.type as AcceptedType)) {
    return { ok: false, message: "未対応のイベント種別です。" };
  }
  const type = raw.type as AcceptedType;

  // contentId は省略可。あれば uuid 形式のみ。値の実在/可視性 (テナント越境の content 参照) は
  // events.content_id FK (ON DELETE set null) と、参照先 contents の RLS により読取時に解決不能化
  // されるため、ここでは形式のみを検証する (書込時の存在 SELECT は別スライスで厳格化検討)。
  let contentId: string | null = null;
  if (raw.contentId != null) {
    if (typeof raw.contentId !== "string" || !UUID_RE.test(raw.contentId)) {
      return { ok: false, message: "contentId が不正です。" };
    }
    contentId = raw.contentId;
  }

  const payload: Record<string, unknown> = {};
  if (raw.clientId != null) {
    // 匿名 uuid のみ (個人特定情報ではない)。形式を強制し、自由記述の混入を防ぐ。
    if (typeof raw.clientId !== "string" || !UUID_RE.test(raw.clientId)) {
      return { ok: false, message: "clientId が不正です。" };
    }
    payload.clientId = raw.clientId;
  }
  if (raw.slotIndex != null) {
    // 広告ローテーション位置 (非負整数、上限は妥当域)。
    if (
      typeof raw.slotIndex !== "number" ||
      !Number.isInteger(raw.slotIndex) ||
      raw.slotIndex < 0 ||
      raw.slotIndex > 9999
    ) {
      return { ok: false, message: "slotIndex が不正です。" };
    }
    payload.slotIndex = raw.slotIndex;
  }
  if (raw.adId != null) {
    // 表示中の広告 (effective_ads_per_class.ad_id) の uuid。広告主の到達数集計 (F07 ユーザーストーリー)
    // 用。events.content_id は contents への FK なので広告 id は載せられず、payload に持つ。
    if (typeof raw.adId !== "string" || !UUID_RE.test(raw.adId)) {
      return { ok: false, message: "adId が不正です。" };
    }
    payload.adId = raw.adId;
  }

  return { ok: true, value: { type, contentId, payload } };
}

/** トークンを {schoolId} に解決。無効 (失効/期限切れ/不明) なら null。 */
async function resolveSchoolId(classToken: string): Promise<string | null> {
  if (!classToken) {
    return null;
  }
  const resolved = await resolveMagicLink(getDb(), hashToken(classToken));
  return resolved ? resolved.schoolId : null;
}

/**
 * 行動イベントを 1 件記録する。匿名サイネージ端末からの呼び出しを想定。
 *
 * @returns `{ok:true}` 記録成功 / `{reason:"invalid"}` 入力不正 / `{reason:"gone"}` トークン無効。
 */
export async function recordSignageEvent(
  classToken: string,
  raw: EventIngestInput,
): Promise<EventIngestResult> {
  const v = validateEventInput(raw);
  if (!v.ok) {
    return { ok: false, reason: "invalid" };
  }

  const schoolId = await resolveSchoolId(classToken);
  if (!schoolId) {
    return { ok: false, reason: "gone" };
  }

  await withTenantContext(getDb(), { schoolId }, async (tx: TenantTx) => {
    await tx.insert(events).values({
      schoolId,
      contentId: v.value.contentId,
      type: v.value.type,
      // occurred_at は DB 既定 now() に委ねる (クライアント時刻を信用しない)。
      payload: v.value.payload,
    });
  });
  return { ok: true };
}
