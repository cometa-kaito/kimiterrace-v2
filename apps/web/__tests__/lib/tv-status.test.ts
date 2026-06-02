import { describe, expect, it } from "vitest";
import {
  ONLINE_THRESHOLD_MS,
  QUIET_THRESHOLD_MS,
  TV_STATUS_LABEL,
  classifyTvLiveness,
  maskMac,
  shortDeviceId,
} from "../../lib/tv/status";

/**
 * F15 §4.1 / F16 §5: TV 稼働ステータス判定（純関数）の単体テスト。
 * `now` を固定して last_seen ギャップ → online/quiet/down/never の境界を決定的に検証する。
 */
describe("classifyTvLiveness", () => {
  const now = new Date("2026-06-02T12:00:00.000Z");

  it("last_seen が null → never（未接続）", () => {
    expect(classifyTvLiveness(null, now)).toBe("never");
  });

  it("ギャップ 0（たった今）→ online", () => {
    expect(classifyTvLiveness(now, now)).toBe("online");
  });

  it("ギャップ = ONLINE 閾値ちょうど → online（境界含む）", () => {
    const lastSeen = new Date(now.getTime() - ONLINE_THRESHOLD_MS);
    expect(classifyTvLiveness(lastSeen, now)).toBe("online");
  });

  it("ギャップ ONLINE 閾値超 〜 QUIET 閾値以内 → quiet", () => {
    const lastSeen = new Date(now.getTime() - (ONLINE_THRESHOLD_MS + 1000));
    expect(classifyTvLiveness(lastSeen, now)).toBe("quiet");
  });

  it("ギャップ = QUIET 閾値ちょうど → quiet（境界含む）", () => {
    const lastSeen = new Date(now.getTime() - QUIET_THRESHOLD_MS);
    expect(classifyTvLiveness(lastSeen, now)).toBe("quiet");
  });

  it("ギャップ QUIET 閾値超 → down（応答なし）", () => {
    const lastSeen = new Date(now.getTime() - (QUIET_THRESHOLD_MS + 1000));
    expect(classifyTvLiveness(lastSeen, now)).toBe("down");
  });

  it("全ステータスに日本語ラベルがある（色のみ依存しない、NFR05）", () => {
    for (const status of ["online", "quiet", "down", "never"] as const) {
      expect(TV_STATUS_LABEL[status].length).toBeGreaterThan(0);
    }
  });
});

describe("shortDeviceId", () => {
  it("9 文字以上は先頭 8 桁 + 省略記号に短縮", () => {
    expect(shortDeviceId("11111111-1111-4111-8111-111111111111")).toBe("11111111…");
  });
  it("8 文字以下はそのまま", () => {
    expect(shortDeviceId("abcd1234")).toBe("abcd1234");
    expect(shortDeviceId("")).toBe("");
  });
});

describe("maskMac", () => {
  it("末尾 4 文字のみ平文（F15 §5）", () => {
    expect(maskMac("DC:A5:B3:C2:98:A1")).toBe("****98A1");
  });
  it("null は em-dash に倒す", () => {
    expect(maskMac(null)).toBe("—");
  });
});
