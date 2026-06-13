import type { TvPollResult } from "@kimiterrace/db";

/**
 * F15 / ADR-022: **LP 互換**の TV ポーリング応答への変換（純ロジック・テスト可能）。
 *
 * 学校に設置済みの実機 TV アプリ（`com.kimiterrace.tvbridge`、旧 LP 向けビルド）は、ポーリング応答を
 * **snake_case + `commands` オブジェクト + `schedule.days_mask`（Calendar 曜日ビット）** で解釈する。
 * v2 ネイティブの `/api/tv/config` は camelCase + `commands` 配列で**形が異なる**ため、実機をそのまま
 * v2 へ向けても解釈できない。本変換 + `/api/tv/lp-config` ルートで「実機が今のアプリのまま v2 を叩ける」
 * 互換層を提供する（cutover を端末操作ゼロ＝ドメイン切替だけで可能にするため。ユーザー: TV の LAN に
 * 入れない）。
 *
 * v2 → LP のマッピング:
 *  - `config.targetMac` → `config.target_mac`、`signageUrl`→`signage_url`、`webhookUrl`→`webhook_url`、
 *    `deviceLabel`→`device_label`
 *  - `schedule.onHour/offHour` → `on_hour/off_hour`（+ `on_minute/off_minute=0`。v2 は時単位）、
 *    `schedule.weekdays`（0=日..6=土）→ `days_mask`（Calendar 1=日..7=土 のビット、未指定=全曜日）
 *  - `commands`: v2 のコマンドキュー（ack 必要・配列）は ack フローが LP と異なるため**本互換層では橋渡し
 *    しない**（`commands: {}`）。実機は `commands.signage_reload` 等 undefined を no-op 扱い。設定配信
 *    （schedule / signage_url / target_mac）が cutover の主目的で、reload/wake コマンド連携は follow-up。
 *  - 未登録 device_id（`unknown`）→ `{ version: 0, config: null, commands: {} }`（実機は no-op で現状維持）。
 */

/** Calendar 曜日ビットの全曜日マスク（1=日..7=土 を全部立てる = 254）。LP の EVERYDAY 相当。 */
export const EVERYDAY_DAYS_MASK =
  (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 7);

/**
 * FCM 登録トークンの上限長（防御的）。実 FCM トークンは ~160〜300 文字程度だが、巨大な入力を DB に書かない
 * よう緩く上限を設ける。超過は不正入力として無視（undefined）し、既存トークンを汚さない。
 */
export const MAX_FCM_TOKEN_LENGTH = 4096;

/**
 * lp-config の `&fcmToken=` クエリ値を、`pollTvConfig` に渡せる形へ正規化する（純関数）。
 *
 * - `null` / 空 / 空白のみ → `undefined`（= 報告なし。pollTvConfig は fcm_token を触らない＝既存値保持）。
 *   端末が `&fcmToken=` を付けない旧 APK 経路や、空送信で既存トークンを誤って消すのを防ぐ（空送信無視）。
 * - 上限長（{@link MAX_FCM_TOKEN_LENGTH}）超過 → `undefined`（不正入力として無視。切り詰めると壊れた
 *   トークンを保存して送信が無駄になるため、保存しない方が安全）。
 * - それ以外 → trim した文字列。
 *
 * FCM トークンは端末固有の不透明文字列で PII ではない（ルール4）。ログには出さない（呼び出し側の規律）。
 */
export function normalizeFcmToken(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_FCM_TOKEN_LENGTH) return undefined;
  return trimmed;
}

/**
 * v2 の weekdays（0=日..6=土 の配列、未指定=全曜日）を LP の days_mask（Calendar 1=日..7=土 のビット）へ。
 * 各 v2 曜日 w（0=日）→ Calendar 日 w+1 → ビット `1 << (w+1)`。未指定/空/全外れは全曜日マスクに倒す。
 */
export function weekdaysToCalendarMask(weekdays?: number[]): number {
  if (!weekdays || weekdays.length === 0) {
    return EVERYDAY_DAYS_MASK;
  }
  let mask = 0;
  for (const w of weekdays) {
    if (Number.isInteger(w) && w >= 0 && w <= 6) {
      mask |= 1 << (w + 1);
    }
  }
  return mask === 0 ? EVERYDAY_DAYS_MASK : mask;
}

/** LP 互換の schedule（snake_case + days_mask）。 */
export type LpSchedule = {
  enabled: boolean;
  on_hour?: number;
  on_minute?: number;
  off_hour?: number;
  off_minute?: number;
  days_mask: number;
};

/** LP 互換のポーリング応答（実機 tvbridge が解釈する形）。 */
export type LpConfigResponse = {
  version: number;
  config: {
    // 以下3つは toLpConfigResponse で null を空文字へ畳むため **必ず string**（旧実機の
    // optString "null" 化 → target_mac=NULL クラッシュ回避の不変条件を型で固定）。
    target_mac: string;
    webhook_url: string;
    signage_url: string;
    // device_label は端末が読まない表示専用フィールドのため null 許容のまま。
    device_label: string | null;
    schedule: LpSchedule | null;
  } | null;
  // v2 のコマンドキューは本互換層では橋渡ししない（空オブジェクト）。
  commands: Record<string, never>;
};

/** v2 の `TvPollResult` を LP 互換応答へ変換する。 */
export function toLpConfigResponse(result: TvPollResult): LpConfigResponse {
  if (result.unknown) {
    return { version: 0, config: null, commands: {} };
  }
  const s = result.config.schedule;
  const schedule: LpSchedule | null = s
    ? {
        enabled: s.enabled,
        ...(s.onHour !== undefined ? { on_hour: s.onHour, on_minute: 0 } : {}),
        ...(s.offHour !== undefined ? { off_hour: s.offHour, off_minute: 0 } : {}),
        days_mask: weekdaysToCalendarMask(s.weekdays),
      }
    : null;
  return {
    version: result.version,
    config: {
      // null は **空文字** で返す（JSON null にしない）。実機 tvbridge の旧 APK は
      // `JSONObject.optString(name)` を使っており、Android の仕様で **値が JSON null だと
      // 文字列 "null" を返す**。これを `applyConfigFields` が `takeIf { isNotBlank() }` を
      // すり抜けて書き戻すと、target_mac が "NULL" になり `ScanFilter.setDeviceAddress("NULL")`
      // が IllegalArgumentException → BleService.onCreate でアプリ全体がクラッシュする
      // （SwitchBot 非設置のサイネージ専用機で再現。webhook_url/signage_url も同根）。
      // 空文字なら端末側 `isNotBlank()` ガードが正しくスキップし、既定値/既存値を維持する。
      target_mac: result.config.targetMac ?? "",
      webhook_url: result.config.webhookUrl ?? "",
      signage_url: result.config.signageUrl ?? "",
      device_label: result.config.deviceLabel,
      schedule,
    },
    commands: {},
  };
}
