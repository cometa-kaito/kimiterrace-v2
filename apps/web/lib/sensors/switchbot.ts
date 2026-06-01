import { z } from "zod";

/**
 * F13 (#408, ADR-020 §2): SwitchBot Webhook ペイロードの検証・正規化。
 *
 * SwitchBot 人感センサー（PIR）の `changeReport` Webhook を受ける。**個人を識別する情報は含まれない**
 * （カメラ非搭載、ADR-020 §6）。本モジュールは payload を厳格に検証し、device MAC を正規化する。
 * 余計なフィールドは持ち越さない（ルール4: PII/未検証データの混入を構造的に避ける）。
 */

/** SwitchBot changeReport の context（人感センサー）。未知フィールドは無視する（厳格に拾う）。 */
const switchBotContextSchema = z
  .object({
    // 長さ上限で jsonb/入力 bloat を防ぐ（#437 Low-3）。MAC は最長でも区切り付き 17 字、PIR 状態語も短い。
    deviceMac: z.string().min(1).max(64),
    // PIR は瞬間検知。"DETECTED" / "NOT_DETECTED" 等（大小・表記ゆれを許容して下流で正規化）。
    detectionState: z.string().min(1).max(64).optional(),
    // 検知時刻（epoch ms）。無ければ受信時刻（DB now()）を使う。
    timeOfSample: z.number().finite().nonnegative().optional(),
    deviceType: z.string().optional(),
  })
  .passthrough();

export const switchBotWebhookSchema = z.object({
  eventType: z.string().optional(),
  eventVersion: z.string().optional(),
  context: switchBotContextSchema,
});

export type SwitchBotWebhook = z.infer<typeof switchBotWebhookSchema>;

/** 検証済みの正規化済みフィールド（ingest が使う最小集合）。 */
export interface NormalizedPresenceEvent {
  /** 正規化済み device MAC（大文字・区切り無し）。`sensor_devices` 解決キー。 */
  deviceMac: string;
  /** 検知状態（大文字化）。null 可。F08 集計は 'DETECTED' を数える。 */
  detectionState: string | null;
  /** 検知時刻（epoch ms）。null なら受信時刻を使う。冪等 dedup のキーにもなる。 */
  timeOfSampleMs: number | null;
  eventVersion: string | null;
}

/**
 * device MAC を正規化する: 大文字化し、`:` / `-` / 空白の区切りを除去する。
 * SwitchBot は区切り無し（`AABBCCDDEEFF`）、登録は区切り付き（`AA:BB:...`）等の表記ゆれがありうるため、
 * 解決時に両者を同じ正規形へ揃える（解決クエリ側も同じ正規化を適用する）。
 */
export function canonicalizeMac(mac: string): string {
  return mac.replace(/[\s:-]/g, "").toUpperCase();
}

/**
 * `timeOfSample` の許容窓（#437 Low-1）。受信時刻から見て **過去 7 日 〜 未来 5 分**。
 *
 * SwitchBot のオフライン後バックフィルや軽微なクロックスキューを許容しつつ、窓外（遠い過去/未来）は
 * 時刻注入とみなす。過去 7 日はバックフィル余裕、未来 5 分はスキュー余裕。
 */
const TIME_OF_SAMPLE_MAX_PAST_MS = 7 * 24 * 60 * 60 * 1000;
const TIME_OF_SAMPLE_MAX_FUTURE_MS = 5 * 60 * 1000;

/**
 * `timeOfSample` が許容窓内かを判定する（#437 Low-1）。
 * 窓外は時刻注入（occurred_at 汚染 / dedup キー水増し）とみなし、呼び出し側で null（受信時刻 fallback）に倒す。
 */
function isTimeOfSampleSane(ms: number, nowMs: number): boolean {
  return ms <= nowMs + TIME_OF_SAMPLE_MAX_FUTURE_MS && ms >= nowMs - TIME_OF_SAMPLE_MAX_PAST_MS;
}

/**
 * zod 検証 + 正規化。失敗時は null（呼び出し側で ignore）。
 *
 * @param body  受信ペイロード
 * @param nowMs 受信時刻（epoch ms）。既定 `Date.now()`。テストで時刻窓（Low-1）を決定的に検証するため注入可能。
 *
 * **時刻窓（#437 Low-1）**: `timeOfSample` が sane window 外なら、検知イベント自体は保持しつつ
 * `timeOfSampleMs=null` に倒す（= DB の受信時刻 `now()` を使う）。共有シークレット保持攻撃者による
 * **occurred_at 汚染（任意の過去/未来時刻で F08 時間帯/日次集計を歪曲）を無力化**する（受信時刻に倒す）。
 * presence 検知は実在しうるため event は捨てない（時刻のみ中和）。
 * 注: 同一検知の連投による行数膨張は本処理では止まらない（null 時刻は dedup を経ず受信時刻で記録される）。
 * 行数膨張は IP レート制限（route.ts）が律速する。
 */
export function parsePresenceWebhook(
  body: unknown,
  nowMs: number = Date.now(),
): NormalizedPresenceEvent | null {
  const parsed = switchBotWebhookSchema.safeParse(body);
  if (!parsed.success) return null;
  const ctx = parsed.data.context;
  const deviceMac = canonicalizeMac(ctx.deviceMac);
  if (deviceMac.length === 0) return null;
  const rawTime = ctx.timeOfSample ?? null;
  const timeOfSampleMs = rawTime !== null && isTimeOfSampleSane(rawTime, nowMs) ? rawTime : null;
  return {
    deviceMac,
    detectionState: ctx.detectionState ? ctx.detectionState.toUpperCase() : null,
    timeOfSampleMs,
    eventVersion: parsed.data.eventVersion ?? null,
  };
}
