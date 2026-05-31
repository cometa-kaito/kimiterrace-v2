import { hashToken } from "@/lib/magic-link/token";
import {
  events,
  type TenantTx,
  effectiveAdsPerClass,
  resolveMagicLink,
  withTenantContext,
} from "@kimiterrace/db";
import { and, eq } from "drizzle-orm";
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
    // 形式 (uuid) のみここで検証し、「当該クラスの実効広告か」の実在照合は recordSignageEvent の
    // tenant 文脈内 (RLS スコープ下) で行う (#265 L-1、純関数では DB に触れないため)。
    if (typeof raw.adId !== "string" || !UUID_RE.test(raw.adId)) {
      return { ok: false, message: "adId が不正です。" };
    }
    payload.adId = raw.adId;
  }

  return { ok: true, value: { type, contentId, payload } };
}

/**
 * トークンを {schoolId, classId} に解決。無効 (失効/期限切れ/不明) なら null。
 * classId は adId 実在照合 (effective_ads_per_class はクラス単位) に使う。
 */
async function resolveClass(
  classToken: string,
): Promise<{ schoolId: string; classId: string } | null> {
  if (!classToken) {
    return null;
  }
  const resolved = await resolveMagicLink(getDb(), hashToken(classToken));
  return resolved ? { schoolId: resolved.schoolId, classId: resolved.classId } : null;
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

  const cls = await resolveClass(classToken);
  if (!cls) {
    return { ok: false, reason: "gone" };
  }
  const { schoolId, classId } = cls;

  return await withTenantContext(getDb(), { schoolId }, async (tx: TenantTx) => {
    // #265 L-1 (集計健全性): adId は当該クラスの実効広告 (effective_ads_per_class) と突合する。
    // 形式検証だけでは、有効 classToken 保持者が任意 uuid を送って広告到達数を水増しできる。
    // VIEW は security_invoker で `app.current_school_id` に RLS スコープされ、さらに classId で
    // 絞るため、テナント越境の adId は不可視 = 自校の実効広告だけが照合に通る (ルール2)。
    // 通らない adId (偽装、または描画直後にローテで実効集合から外れた稀ケース) は invalid に倒し、
    // 不正な impression を記録しない (僅かな undercount より過大計上を防ぐ方を優先)。
    const { adId } = v.value.payload;
    if (typeof adId === "string") {
      const hit = await tx
        .select({ adId: effectiveAdsPerClass.adId })
        .from(effectiveAdsPerClass)
        .where(and(eq(effectiveAdsPerClass.classId, classId), eq(effectiveAdsPerClass.adId, adId)))
        .limit(1);
      if (hit.length === 0) {
        return { ok: false, reason: "invalid" };
      }
    }

    await tx.insert(events).values({
      schoolId,
      contentId: v.value.contentId,
      type: v.value.type,
      // occurred_at は DB 既定 now() に委ねる (クライアント時刻を信用しない)。
      payload: v.value.payload,
    });
    return { ok: true };
  });
}
