import type { TvPollResult } from "@kimiterrace/db";
import { describe, expect, it } from "vitest";
import { EVERYDAY_DAYS_MASK, toLpConfigResponse, weekdaysToCalendarMask } from "@/lib/tv/lp-compat";

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
    expect(out.commands).toEqual({});
  });

  it("schedule が null ならそのまま null", () => {
    const out = toLpConfigResponse(registered(null));
    expect(out.config?.schedule).toBeNull();
  });

  it("時刻未指定なら on_hour/off_hour を省略しつつ days_mask は出す", () => {
    const out = toLpConfigResponse(registered({ enabled: false, weekdays: [0, 6] }));
    expect(out.config?.schedule).toEqual({ enabled: false, days_mask: (1 << 1) | (1 << 7) });
  });

  it("未登録(unknown)は version 0 + config null + commands {}", () => {
    const out = toLpConfigResponse({ unknown: true, version: 0 });
    expect(out).toEqual({ version: 0, config: null, commands: {} });
  });
});
