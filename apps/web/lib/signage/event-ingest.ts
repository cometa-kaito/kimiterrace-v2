import { FixedWindowRateLimiter } from "@/lib/guide/rate-limit";
import { hashToken } from "@/lib/magic-link/token";
import {
  contents,
  events,
  type TenantTx,
  getEffectiveAdsForClass,
  resolveMagicLink,
  withTenantContext,
} from "@kimiterrace/db";
import { eq } from "drizzle-orm";
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
  | { ok: false; reason: "gone" }
  | { ok: false; reason: "rate_limited" };

/**
 * M-2 (#464, #243 検証由来): per-`classToken` 固定窓レートリミット。
 *
 * `POST /signage/{classToken}/events` は **意図的に IP 制限を採らない** (校内は NAT 共有 IP で
 * 50 端末/校が高頻度発火するため、IP 制限は正規ログを落とす — route.ts / PR #258 参照)。しかし
 * `classToken` は QR/URL に載り base64url で可読・最長 90 日 rotate なしのため、これを得た者が
 * `{"type":"view"}` を loop POST すると有効 token のまま無制限に `INSERT events` でき、特定校の
 * events 肥大・F08 集計/到達数の歪曲を招く (越境ではない integrity / DoS スメル)。
 *
 * 対策として **token 単位** (per-IP ではない) の固定窓 limiter を `guide/rate-limit.ts` の
 * {@link FixedWindowRateLimiter} 再利用で置く。per-token キーなら IP 制限を退けた NAT 懸念を回避し、
 * 単一 token を握った flood だけを頭打ちにできる。key は **raw token でなく hashToken** で、
 * credential を limiter Map・ログに残さない (ルール5)。volumetric な hard guarantee は依然 infra
 * 層 WAF (Cloud Armor) が担う defense-in-depth であり、本 limiter は WAF が land するまでの安全網。
 *
 * 上限は正規トラフィック (ADR-025: 50 端末/校 × 分次ハートビート + ローテーション毎の view/tap、
 * 1 token = 1 クラス表示なので実際は更に少数) を十分上回る寛容値にし、正規ログを落とさない。
 * 状態は module-level の per-instance Map (guide/student-qa と同じ限界。複数インスタンスの全体上限は
 * 共有ストア版 #155 が要る)。`nowMs` 注入でテスト決定的。
 */
export const SIGNAGE_EVENT_LIMIT = 600;
export const SIGNAGE_EVENT_WINDOW_MS = 60 * 1000;
export const signageEventRateLimiter = new FixedWindowRateLimiter(
  SIGNAGE_EVENT_LIMIT,
  SIGNAGE_EVENT_WINDOW_MS,
);

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

/** トークンを {schoolId, classId} に解決。無効 (失効/期限切れ/不明) なら null。 */
async function resolveTenant(
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
 * @param nowMs レート判定の時刻 (注入式、既定 `Date.now()`)。テストで決定的に窓を制御する。
 * @returns `{ok:true}` 記録成功 / `{reason:"invalid"}` 入力不正 / `{reason:"gone"}` トークン無効
 *   / `{reason:"rate_limited"}` per-token 上限超過 (M-2)。
 */
export async function recordSignageEvent(
  classToken: string,
  raw: EventIngestInput,
  nowMs: number = Date.now(),
): Promise<EventIngestResult> {
  const v = validateEventInput(raw);
  if (!v.ok) {
    return { ok: false, reason: "invalid" };
  }

  // M-2 (#464): DB 解決 (resolveMagicLink) の**前**に per-token 固定窓 limit を掛け、有効 token を
  // 握った flood を頭打ちにする。key は hashToken (raw credential を Map に残さない、ルール5)。
  // 上限内の正規トラフィックは素通りし、超過時のみ rate_limited に倒す (route が 429 + Retry-After)。
  if (!signageEventRateLimiter.tryAcquire(hashToken(classToken), nowMs)) {
    return { ok: false, reason: "rate_limited" };
  }

  const tenant = await resolveTenant(classToken);
  if (!tenant) {
    return { ok: false, reason: "gone" };
  }

  // L-1 (#265): adId は uuid 形式だけでなく**当該クラスの実効広告に実在**する場合のみ採用する。
  // 有効 classToken 保持者が任意 uuid を送って到達数を水増しするのを防ぎ、集計健全性を担保する
  // (PR #263 Reviewer L-1)。実在照合は effective_ads_per_class (security_invoker VIEW) を読むため、
  // RLS 文脈 (withTenantContext) 内で行う。adId 不在の一般 view/tap は従来どおり照合をスキップ。
  const adId = typeof v.value.payload.adId === "string" ? v.value.payload.adId : null;

  return await withTenantContext(getDb(), { schoolId: tenant.schoolId }, async (tx: TenantTx) => {
    if (adId !== null) {
      const ads = await getEffectiveAdsForClass(tx, tenant.classId);
      if (!ads.some((ad) => ad.adId === adId)) {
        // spoof / stale な adId。events を書かず invalid に倒す (count 水増し防止)。
        return { ok: false, reason: "invalid" } as const;
      }
    }

    // L-1 (#464): contentId の**自テナント可視性**を insert 前に確認する。events.content_id FK は
    // school 述語を持たず、参照先 contents は FORCE RLS でないため FK 整合チェック (table owner 権限)
    // が他校の content uuid を受理してしまう。校 A の token 保持者が校 B の content uuid を送ると
    // `school_id=A` 行に校 B を指す dangling 参照が残る (読取は RLS で解決不能化されるため越境漏洩
    // ではないが、integrity スメル)。ここは RLS 文脈 (withTenantContext) 内なので、`kimiterrace_app`
    // (非 BYPASSRLS) からの SELECT は自校行しか返さない。不可視 (他校/不在) なら contentId を null に
    // 落として焼き込みを防ぐ (adId の実在チェックと同方針)。同校 content は状態を問わず素通り。
    let contentId = v.value.contentId;
    if (contentId !== null) {
      const visible = await tx
        .select({ id: contents.id })
        .from(contents)
        .where(eq(contents.id, contentId))
        .limit(1);
      if (visible.length === 0) {
        contentId = null;
      }
    }

    await tx.insert(events).values({
      schoolId: tenant.schoolId,
      contentId,
      type: v.value.type,
      // occurred_at は DB 既定 now() に委ねる (クライアント時刻を信用しない)。
      payload: v.value.payload,
    });
    return { ok: true } as const;
  });
}
