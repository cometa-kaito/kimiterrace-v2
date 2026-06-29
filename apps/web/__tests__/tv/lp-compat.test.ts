import type { TvPollResult } from "@kimiterrace/db";
import { describe, expect, it } from "vitest";
import {
  EVERYDAY_DAYS_MASK,
  MAX_FCM_TOKEN_LENGTH,
  normalizeFcmToken,
  toLpConfigResponse,
  weekdaysToCalendarMask,
} from "@/lib/tv/lp-compat";

/**
 * F15 / ADR-022: LP 互換ポーリング応答変換の単体検証。実機 tvbridge（旧 LP 向け）が解釈できる
 * snake_case + days_mask 形に正しく落ちることを固定する。
 */

describe("weekdaysToCalendarMask", () => {
  it("未指定/空は全曜日マスク（254）", () => {
    expect(weekdaysToCalendarMask(undefined)).toBe(EVERYDAY_DAYS_MASK);
    expect(weekdaysToCalendarMask([])).toBe(EVERYDAY_DAYS_MASK);
    expect(EVERYDAY_DAYS_MASK).toBe(254);
  });

  it("月〜金（v2 [1..5]）→ Calendar ビット 124（LP の WEEKDAYS_MASK と一致）", () => {
    // 1<<2 + 1<<3 + 1<<4 + 1<<5 + 1<<6 = 4+8+16+32+64 = 124
    expect(weekdaysToCalendarMask([1, 2, 3, 4, 5])).toBe(124);
  });

  it("日(0)→ビット1<<1=2、土(6)→ビット1<<7=128", () => {
    expect(weekdaysToCalendarMask([0])).toBe(1 << 1);
    expect(weekdaysToCalendarMask([6])).toBe(1 << 7);
  });

  it("範囲外しか無ければ全曜日に倒す（0 マスクにしない）", () => {
    expect(weekdaysToCalendarMask([9, -1])).toBe(EVERYDAY_DAYS_MASK);
  });
});

/** 登録済み（unknown=false）の TvPollResult。`.config` にアクセスするため判別済みの型に絞る。 */
type Registered = Extract<TvPollResult, { unknown: false }>;

function registered(schedule: Registered["config"]["schedule"]): Registered {
  return {
    unknown: false,
    version: 3,
    config: {
      deviceLabel: "電子工学科 1年",
      targetMac: "DC:A5:B3:C2:98:D7",
      signageUrl: "https://example.test/s/abc",
      webhookUrl: "https://example.test/wh",
      schedule,
    },
  };
}

describe("toLpConfigResponse", () => {
  it("snake_case 設定 + days_mask + on/off 分0 に変換する", () => {
    const out = toLpConfigResponse(
      registered({ enabled: true, onHour: 8, offHour: 17, weekdays: [1, 2, 3, 4, 5] }),
    );
    expect(out.version).toBe(3);
    expect(out.config?.target_mac).toBe("DC:A5:B3:C2:98:D7");
    expect(out.config?.signage_url).toBe("https://example.test/s/abc");
    expect(out.config?.webhook_url).toBe("https://example.test/wh");
    expect(out.config?.device_label).toBe("電子工学科 1年");
    expect(out.config?.schedule).toEqual({
      enabled: true,
      on_hour: 8,
      on_minute: 0,
      off_hour: 17,
      off_minute: 0,
      days_mask: 124,
    });
    // 新 APK 用の精密窓も同梱（単一窓でも常に出す）。
    expect(out.config?.schedule_windows).toEqual([
      { on_hour: 8, on_minute: 0, off_hour: 17, off_minute: 0 },
    ]);
    expect(out.commands).toEqual({});
  });

  it("legacy 単一窓の分（onMinute/offMinute）を on_minute/off_minute へ通す", () => {
    const out = toLpConfigResponse(
      registered({ enabled: true, onHour: 8, onMinute: 30, offHour: 17, offMinute: 45 }),
    );
    expect(out.config?.schedule).toMatchObject({
      on_hour: 8,
      on_minute: 30,
      off_hour: 17,
      off_minute: 45,
    });
    expect(out.config?.schedule_windows).toEqual([
      { on_hour: 8, on_minute: 30, off_hour: 17, off_minute: 45 },
    ]);
  });

  it("複数窓: schedule_windows に全窓、schedule(旧APK) は包含窓（最早点灯〜最遅消灯）", () => {
    const out = toLpConfigResponse(
      registered({
        enabled: true,
        windows: [
          { onHour: 8, onMinute: 0, offHour: 12, offMinute: 0 },
          { onHour: 13, onMinute: 30, offHour: 17, offMinute: 0 },
        ],
        weekdays: [1, 2, 3, 4, 5],
      }),
    );
    // 新 APK: 各窓を厳密に
    expect(out.config?.schedule_windows).toEqual([
      { on_hour: 8, on_minute: 0, off_hour: 12, off_minute: 0 },
      { on_hour: 13, on_minute: 30, off_hour: 17, off_minute: 0 },
    ]);
    // 旧 APK: 包含窓 08:00〜17:00（昼休みの隙間は旧 APK では消灯されない＝安全側フォールバック）
    expect(out.config?.schedule).toEqual({
      enabled: true,
      on_hour: 8,
      on_minute: 0,
      off_hour: 17,
      off_minute: 0,
      days_mask: 124,
    });
  });

  it("schedule が null ならそのまま null", () => {
    const out = toLpConfigResponse(registered(null));
    expect(out.config?.schedule).toBeNull();
  });

  it("時刻未指定なら on_hour/off_hour を省略しつつ days_mask は出す（schedule_windows も無し）", () => {
    const out = toLpConfigResponse(registered({ enabled: false, weekdays: [0, 6] }));
    expect(out.config?.schedule).toEqual({ enabled: false, days_mask: (1 << 1) | (1 << 7) });
    expect(out.config?.schedule_windows).toBeUndefined();
  });

  it("未登録(unknown)は version 0 + config null + commands {}", () => {
    const out = toLpConfigResponse({ unknown: true, version: 0 });
    expect(out).toEqual({ version: 0, config: null, commands: {} });
  });

  it('target_mac/webhook_url/signage_url が null は空文字へ畳む（旧実機 optString の "null" 化 → target_mac=NULL クラッシュ回避）', () => {
    const out = toLpConfigResponse({
      unknown: false,
      version: 3,
      config: {
        deviceLabel: "1年1組",
        targetMac: null,
        signageUrl: null,
        webhookUrl: null,
        schedule: null,
      },
    });
    // JSON null を返すと旧 APK が "null" 文字列化して書き戻し、BLE ScanFilter がクラッシュするため、
    // 端末側 `isNotBlank()` ガードが効く空文字で返す。
    expect(out.config?.target_mac).toBe("");
    expect(out.config?.webhook_url).toBe("");
    expect(out.config?.signage_url).toBe("");
    // device_label は端末が optString で Android API に渡さない（表示専用）ため、null をそのまま許容。
    expect(out.config?.device_label).toBe("1年1組");
  });
});

describe("normalizeFcmToken（遠隔起動: 空送信無視 + 上限ガード）", () => {
  it("null / undefined は undefined（報告なし → 既存値を触らない）", () => {
    expect(normalizeFcmToken(null)).toBeUndefined();
    expect(normalizeFcmToken(undefined)).toBeUndefined();
  });

  it("空文字 / 空白のみは undefined（空送信で既存トークンを消さない）", () => {
    expect(normalizeFcmToken("")).toBeUndefined();
    expect(normalizeFcmToken("   ")).toBeUndefined();
    expect(normalizeFcmToken("\t\n")).toBeUndefined();
  });

  it("通常トークンは trim して返す", () => {
    expect(normalizeFcmToken("  fcm-token-abc123  ")).toBe("fcm-token-abc123");
  });

  it("上限長ちょうどは通す / 超過は undefined（壊れたトークンを保存しない）", () => {
    const atLimit = "a".repeat(MAX_FCM_TOKEN_LENGTH);
    expect(normalizeFcmToken(atLimit)).toBe(atLimit);
    expect(normalizeFcmToken("a".repeat(MAX_FCM_TOKEN_LENGTH + 1))).toBeUndefined();
  });
});
