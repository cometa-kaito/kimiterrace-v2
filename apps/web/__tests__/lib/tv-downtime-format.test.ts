import { describe, expect, it } from "vitest";
import {
  formatDowntimeCause,
  formatDowntimeDuration,
  formatJstTimestamp,
} from "../../lib/tv/downtime-format";

/**
 * F16 §5: TV ダウンタイム履歴 / 稼働サマリ表示フォーマッタ（純関数）の単体テスト。
 * 継続時間・原因・継続中フラグは色のみに依存しないテキスト（NFR05）であることを境界含めて検証する。
 */
describe("formatDowntimeDuration", () => {
  it("null（継続中）→ 継続中", () => {
    expect(formatDowntimeDuration(null)).toBe("継続中");
  });

  it("0 秒 → 0秒", () => {
    expect(formatDowntimeDuration(0)).toBe("0秒");
  });

  it("負値は 0 として扱う（防御的）", () => {
    expect(formatDowntimeDuration(-5)).toBe("0秒");
  });

  it("秒のみ", () => {
    expect(formatDowntimeDuration(45)).toBe("45秒");
  });

  it("分+秒", () => {
    expect(formatDowntimeDuration(90)).toBe("1分30秒");
  });

  it("分のみ（端数 0 秒の単位は省く）", () => {
    expect(formatDowntimeDuration(120)).toBe("2分");
  });

  it("時間+分+秒", () => {
    expect(formatDowntimeDuration(3700)).toBe("1時間1分40秒");
  });

  it("時間のみ（分秒 0 は省く）", () => {
    expect(formatDowntimeDuration(7200)).toBe("2時間");
  });

  it("時間+秒（分 0 は省く）", () => {
    expect(formatDowntimeDuration(3605)).toBe("1時間5秒");
  });

  it("小数秒は floor する", () => {
    expect(formatDowntimeDuration(59.9)).toBe("59秒");
  });
});

describe("formatDowntimeCause", () => {
  it("null → 未判定", () => {
    expect(formatDowntimeCause(null)).toBe("未判定");
  });

  it("各 enum 値に日本語ラベル（色のみに依存しない、NFR05）", () => {
    expect(formatDowntimeCause("unknown")).toBe("原因不明");
    expect(formatDowntimeCause("reboot")).toBe("再起動");
    expect(formatDowntimeCause("network")).toBe("通信断");
  });

  it("未知の値は 未判定 に倒す（防御的）", () => {
    expect(formatDowntimeCause("bogus")).toBe("未判定");
  });
});

describe("formatJstTimestamp", () => {
  it("null → em-dash", () => {
    expect(formatJstTimestamp(null)).toBe("—");
  });

  it("UTC の Date を JST の M/D HH:mm で表示（+9h）", () => {
    // 2026-06-02T03:00:00Z = JST 12:00（6/2）。
    expect(formatJstTimestamp(new Date("2026-06-02T03:00:00.000Z"))).toBe("6/2 12:00");
  });

  it("UTC 深夜は JST で翌日になる（日付境界）", () => {
    // 2026-06-02T20:30:00Z = JST 05:30（6/3）。
    expect(formatJstTimestamp(new Date("2026-06-02T20:30:00.000Z"))).toBe("6/3 05:30");
  });
});
