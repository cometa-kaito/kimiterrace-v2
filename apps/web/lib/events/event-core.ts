import type { events } from "@kimiterrace/db";
import type { InferInsertModel } from "drizzle-orm";

/**
 * F07 行動ログ取込の**純粋バリデーション層** (#43)。DB / 認証に依存しない (テストが決定的)。
 *
 * 公開サイネージ表示 (`/signage/{classToken}`、匿名) がクライアントで貯めた view/tap/dwell を
 * バッチ POST してくる。サーバはトークンから school を解決して RLS 文脈で INSERT する
 * (lib/events/signage-events.ts) が、その前段で「DB に入れてよい形か」を本層が機械的に検証する:
 * 信頼できない公開入力なので、件数・型・サイズ・時刻範囲をすべて固定し、外れた batch は丸ごと弾く。
 *
 * 設計上の不変条件:
 * - **type は enum 単一ソース (CLAUDE.md ルール3)**: 許可型は `events.type` の Drizzle enum 由来。
 *   `SIGNAGE_EVENT_TYPES` はローカル宣言だが `satisfies readonly EventType[]` で **enum とのズレを
 *   コンパイル時に検出**する (enum 由来でない型を書いたら型エラー)。`ask` は生徒 Q&A (F06) の
 *   サーバ経路で記録するもので、表示端末からは送らせない (公開端末から偽 ask を注入させない)。
 * - **school_id はクライアントから受け取らない**: 取込側がトークン解決結果を必ず使う。本層は
 *   school_id を一切見ない (cross-tenant 注入面をそもそも作らない、ルール2 の多層防御)。
 * - **all-or-nothing**: 1 件でも不正なら batch 全体を reject (feedback 検証と同方針)。部分採用で
 *   壊れた解析データを混ぜない。
 */

/** events.type の単一ソース (Drizzle enum 由来)。 */
type EventType = InferInsertModel<typeof events>["type"];

/**
 * サイネージ表示端末が送ってよいイベント型。`ask` は含めない (生徒 Q&A はサーバ経路で記録)。
 * `satisfies` で各要素が `EventType` であることをコンパイル時に強制する (enum 改名/削除を検知)。
 */
export const SIGNAGE_EVENT_TYPES = ["view", "tap", "dwell"] as const satisfies readonly EventType[];
const SIGNAGE_EVENT_TYPE_SET = new Set<string>(SIGNAGE_EVENT_TYPES);

/** 1 リクエストで受ける最大イベント数。バッチ送信前提でも DB 書込を頭打ちにする (NFR01)。 */
export const MAX_EVENTS_PER_BATCH = 50;
/** 1 イベントの payload を JSON 直列化した最大バイト数。肥大した任意 JSON の流入を防ぐ。 */
export const MAX_PAYLOAD_BYTES = 2048;
/** occurredAt が過去すぎる/未来すぎる場合は不正扱い。端末は遅延バッチ送信しうるので過去側は緩め。 */
export const OCCURRED_AT_MAX_PAST_MS = 24 * 60 * 60 * 1000; // 24h
export const OCCURRED_AT_MAX_FUTURE_MS = 5 * 60 * 1000; // 5min (端末時計のズレ許容)

// RFC 4122 形式の UUID (バージョン桁は緩めに許可、gen_random_uuid は v4)。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 検証済みイベント 1 件 (取込側がそのまま INSERT に使える形)。school_id は載せない (取込側が付与)。 */
export type ValidatedSignageEvent = {
  type: (typeof SIGNAGE_EVENT_TYPES)[number];
  /** 任意。対象コンテンツ (UUID)。未指定なら null。 */
  contentId: string | null;
  /** 任意。端末側で観測した発生時刻。未指定なら null (DB default now())。 */
  occurredAt: Date | null;
  /** クライアント payload (検証済み plain object、最大 MAX_PAYLOAD_BYTES)。 */
  payload: Record<string, unknown>;
};

export type ValidateResult =
  | { ok: true; value: ValidatedSignageEvent[] }
  | { ok: false; message: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 単一イベントを検証して正規化。不正なら理由文字列を返す。 */
function validateOne(
  raw: unknown,
  nowMs: number,
): { ok: true; value: ValidatedSignageEvent } | { ok: false; message: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, message: "event must be an object" };
  }

  if (typeof raw.type !== "string" || !SIGNAGE_EVENT_TYPE_SET.has(raw.type)) {
    return { ok: false, message: "invalid event type" };
  }
  const type = raw.type as ValidatedSignageEvent["type"];

  let contentId: string | null = null;
  if (raw.contentId !== undefined && raw.contentId !== null) {
    if (typeof raw.contentId !== "string" || !UUID_RE.test(raw.contentId)) {
      return { ok: false, message: "invalid contentId" };
    }
    contentId = raw.contentId;
  }

  let occurredAt: Date | null = null;
  if (raw.occurredAt !== undefined && raw.occurredAt !== null) {
    if (typeof raw.occurredAt !== "string") {
      return { ok: false, message: "invalid occurredAt" };
    }
    const ms = Date.parse(raw.occurredAt);
    if (Number.isNaN(ms)) {
      return { ok: false, message: "invalid occurredAt" };
    }
    if (ms < nowMs - OCCURRED_AT_MAX_PAST_MS || ms > nowMs + OCCURRED_AT_MAX_FUTURE_MS) {
      return { ok: false, message: "occurredAt out of range" };
    }
    occurredAt = new Date(ms);
  }

  let payload: Record<string, unknown> = {};
  if (raw.payload !== undefined && raw.payload !== null) {
    if (!isPlainObject(raw.payload)) {
      return { ok: false, message: "payload must be an object" };
    }
    // 直列化バイト数で上限を測る (深さ/キー数の代理にもなる)。
    if (Buffer.byteLength(JSON.stringify(raw.payload), "utf8") > MAX_PAYLOAD_BYTES) {
      return { ok: false, message: "payload too large" };
    }
    payload = raw.payload;
  }

  return { ok: true, value: { type, contentId, occurredAt, payload } };
}

/**
 * サイネージ表示端末から来たイベントバッチを検証・正規化する。
 *
 * 受理形:  `{ events: Array<{ type, contentId?, occurredAt?, payload? }> }` (1..MAX_EVENTS_PER_BATCH)。
 * 1 件でも不正なら batch 全体を reject (理由を message に)。
 *
 * @param raw   パース済み JSON body (信頼できない任意値)。
 * @param nowMs occurredAt 範囲判定の基準時刻 (注入でテスト決定的)。
 */
export function validateSignageEventBatch(raw: unknown, nowMs: number): ValidateResult {
  if (!isPlainObject(raw) || !Array.isArray(raw.events)) {
    return { ok: false, message: "events array required" };
  }
  const list = raw.events;
  if (list.length === 0) {
    return { ok: false, message: "events must not be empty" };
  }
  if (list.length > MAX_EVENTS_PER_BATCH) {
    return { ok: false, message: `too many events (max ${MAX_EVENTS_PER_BATCH})` };
  }

  const value: ValidatedSignageEvent[] = [];
  for (const item of list) {
    const r = validateOne(item, nowMs);
    if (!r.ok) {
      return r;
    }
    value.push(r.value);
  }
  return { ok: true, value };
}
