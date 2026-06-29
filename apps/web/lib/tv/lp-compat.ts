import type { TvPollResult } from "@kimiterrace/db";
import {
  type TvScheduleWindow,
  resolveScheduleWindows,
  scheduleWindowToMinutes,
} from "@kimiterrace/db/tv-schedule";

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

/** LP 互換の schedule（snake_case + days_mask）。単一窓（旧 APK が解釈する包含窓）。 */
export type LpSchedule = {
  enabled: boolean;
  on_hour?: number;
  on_minute?: number;
  off_hour?: number;
  off_minute?: number;
  days_mask: number;
};

/** LP 互換の 1 つの表示時間帯（分単位）。新 APK が `schedule_windows` から解釈する。 */
export type LpScheduleWindow = {
  on_hour: number;
  on_minute: number;
  off_hour: number;
  off_minute: number;
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
    /**
     * 複数の表示時間帯（分単位）。**新 APK のみが解釈する追加フィールド**で、旧 APK は未知キーとして無視し
     * `schedule`（包含窓）にフォールバックする（後方互換）。窓が 1 つでも常に出すことで、新 APK は常に
     * この精密な窓リストを使う。時刻指定なし（終日 ON）のときは省略する。
     */
    schedule_windows?: LpScheduleWindow[];
  } | null;
  // v2 のコマンドキューは本互換層では橋渡ししない（空オブジェクト）。
  commands: Record<string, never>;
};

/**
 * 複数窓を 1 つの包含窓（最早の点灯〜最遅の消灯）に畳む（純関数）。旧 APK（単一窓のみ解釈）が「全活動
 * 時間帯を通して点灯」するためのフォールバック値。窓間の隙間（昼休み等）は旧 APK では消灯されないが、新 APK は
 * `schedule_windows` で各窓を厳密に扱う。日跨ぎ窓（on>=off）が混じる場合は包含が定義できないため、その窓を
 * そのまま返す。`windows` は非空前提（呼び出し側が保証）。
 */
function encompassingWindow(windows: TvScheduleWindow[]): TvScheduleWindow {
  let minOn = Number.POSITIVE_INFINITY;
  let maxOff = Number.NEGATIVE_INFINITY;
  for (const w of windows) {
    const { on, off } = scheduleWindowToMinutes(w);
    if (on >= off) return w; // 日跨ぎ/縮退窓は包含不能 → その窓を返す
    if (on < minOn) minOn = on;
    if (off > maxOff) maxOff = off;
  }
  return {
    onHour: Math.floor(minOn / 60),
    onMinute: minOn % 60,
    offHour: Math.floor(maxOff / 60),
    offMinute: maxOff % 60,
  };
}

/** v2 の `TvPollResult` を LP 互換応答へ変換する。 */
export function toLpConfigResponse(result: TvPollResult): LpConfigResponse {
  if (result.unknown) {
    return { version: 0, config: null, commands: {} };
  }
  const s = result.config.schedule;
  // 表示窓を正準化（windows 優先・無ければ legacy 単一窓・時刻指定なしは空）。新 APK 用の schedule_windows と
  // 旧 APK 用の包含窓（schedule）を同じソースから導出する。
  const windows = s ? resolveScheduleWindows(s) : [];
  const enc = windows.length > 0 ? encompassingWindow(windows) : null;
  const schedule: LpSchedule | null = s
    ? {
        enabled: s.enabled,
        ...(enc
          ? {
              on_hour: enc.onHour,
              on_minute: enc.onMinute,
              off_hour: enc.offHour,
              off_minute: enc.offMinute,
            }
          : {}),
        days_mask: weekdaysToCalendarMask(s.weekdays),
      }
    : null;
  const scheduleWindows: LpScheduleWindow[] = windows.map((w) => ({
    on_hour: w.onHour,
    on_minute: w.onMinute,
    off_hour: w.offHour,
    off_minute: w.offMinute,
  }));
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
      ...(scheduleWindows.length > 0 ? { schedule_windows: scheduleWindows } : {}),
    },
    commands: {},
  };
}
