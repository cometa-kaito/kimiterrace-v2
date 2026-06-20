import { toSignageHeatAlert } from "@/lib/signage/heat-alerts";
import { DEFAULT_STALENESS_THRESHOLD_MS } from "@/lib/signage/weather";
import type { HeatAlert } from "@kimiterrace/db";
import { describe, expect, it } from "vitest";

/**
 * ADR-044: サイネージ熱中症警戒アラートの **表示用純変換**（行→ペイロード / 鮮度）を検証する。
 * RLS / 実 PG 読み取り（fromDate 絞り・最新対象日）は packages/db の heat-alerts.test.ts でカバーする。
 *
 * NFR05（色非依存）: 段階（alertLevel）と WBGT 値は色だけでなく数値・ラベルと対で UI が出すため、ここでは
 * それらが欠落なく射影されることを固定する。
 */

/** heat_alerts 1 行の最小フェイク（テストで使う列のみ、型は schema 由来）。 */
function row(overrides: Partial<HeatAlert>): HeatAlert {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    areaCode: "210000",
    areaName: "岐阜県",
    source: "env_moe",
    fetchedAt: new Date("2026-07-15T06:00:00+09:00"),
    forecastDate: "2026-07-15",
    alertLevel: "warning",
    wbgtMax: 31,
    wbgtBand: "danger",
    raw: {},
    createdAt: new Date("2026-07-15T06:00:00+09:00"),
    updatedAt: new Date("2026-07-15T06:00:00+09:00"),
    createdBy: null,
    updatedBy: null,
    ...overrides,
  };
}

describe("toSignageHeatAlert（行→ペイロード・鮮度）", () => {
  const now = new Date("2026-07-15T12:00:00+09:00");

  it("行を表示ペイロードへ射影する（段階 / WBGT / 区分 / 対象日）", () => {
    const out = toSignageHeatAlert(row({ alertLevel: "emergency", wbgtMax: 33 }), now);
    expect(out.areaCode).toBe("210000");
    expect(out.areaName).toBe("岐阜県");
    expect(out.alertLevel).toBe("emergency");
    expect(out.wbgtMax).toBe(33);
    expect(out.wbgtBand).toBe("danger");
    expect(out.forecastDate).toBe("2026-07-15");
    expect(out.isStale).toBe(false);
  });

  it("WBGT 欠落（null）でも落ちない（fail-soft・色非依存の段階ラベルで担保）", () => {
    const out = toSignageHeatAlert(row({ wbgtMax: null, wbgtBand: null }), now);
    expect(out.wbgtMax).toBeNull();
    expect(out.wbgtBand).toBeNull();
    expect(out.alertLevel).toBe("warning");
  });

  it("fetched_at が古ければ isStale=true（last-known-good 注記）", () => {
    const stale = row({
      fetchedAt: new Date(now.getTime() - (DEFAULT_STALENESS_THRESHOLD_MS + 1000)),
    });
    expect(toSignageHeatAlert(stale, now).isStale).toBe(true);
  });

  // fetched_at は DB 上 NOT NULL（行は必ず取得時刻を持つ）。null 入力の鮮度挙動は isForecastStale の
  // 単体（weather.test.ts）でカバー済みなので、ここでは行射影の範囲に絞る。

  it("alertLevel='none'（アラートなし）でも行は射影する（帯を出すか否かは UI 判断）", () => {
    const out = toSignageHeatAlert(row({ alertLevel: "none" }), now);
    expect(out.alertLevel).toBe("none");
  });
});
