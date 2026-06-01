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
    deviceMac: z.string().min(1),
    // PIR は瞬間検知。"DETECTED" / "NOT_DETECTED" 等（大小・表記ゆれを許容して下流で正規化）。
    detectionState: z.string().min(1).optional(),
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

/** zod 検証 + 正規化。失敗時は null（呼び出し側で ignore）。 */
export function parsePresenceWebhook(body: unknown): NormalizedPresenceEvent | null {
  const parsed = switchBotWebhookSchema.safeParse(body);
  if (!parsed.success) return null;
  const ctx = parsed.data.context;
  const deviceMac = canonicalizeMac(ctx.deviceMac);
  if (deviceMac.length === 0) return null;
  return {
    deviceMac,
    detectionState: ctx.detectionState ? ctx.detectionState.toUpperCase() : null,
    timeOfSampleMs: ctx.timeOfSample ?? null,
    eventVersion: parsed.data.eventVersion ?? null,
  };
}
