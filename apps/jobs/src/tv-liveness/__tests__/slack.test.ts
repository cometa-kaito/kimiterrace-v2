import type { TvLivenessCheckSummary } from "@kimiterrace/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deliverTvLivenessAlerts,
  formatHeartbeatMessage,
  formatTvDownMessage,
  formatTvLongSilenceClearedMessage,
  formatTvLongSilenceMessage,
  formatTvRecoveredMessage,
  getSlackWebhookUrl,
  hoursSince,
  minutesSince,
} from "../slack.js";

/**
 * F16 (§4/§9): TV 死活 Slack 配信の **純フォーマッタ + no-op 規律**の単体テスト。
 * ネットワーク（fetch）には依存しない。Webhook 未設定時に配信が no-op になることだけ fetch スパイで pin する。
 */

const NOW = new Date("2026-06-09T08:00:00.000Z");

const downBase = {
  deviceId: "abcd1234-ef56-4abc-8def-0123456789ab",
  schoolId: "school-A",
  label: "電子工学科 1年",
  lastSeenAt: new Date(NOW.getTime() - 180_000), // 3 分前
  wentDownAt: new Date(NOW.getTime() - 180_000),
  // F16 拡張（遠隔起動）で downDevices に追加された宛先トークン。Slack フォーマッタはこれを使わないが
  // 型（downDevices 要素）を満たすため null を置く。
  fcmToken: null,
};

/** 長時間サイレンス エッジの素材（6h 超 無音）。 */
const longSilentBase = {
  deviceId: "abcd1234-ef56-4abc-8def-0123456789ab",
  schoolId: "school-A",
  label: "電子工学科 3年",
  lastSeenAt: new Date(NOW.getTime() - 7 * 60 * 60_000), // 7 時間前
};

/** サマリ全フィールドを埋めるヘルパ（overrides で必要な配列/件数だけ差し替える。新フィールドの boilerplate 集約）。 */
function summary(overrides: Partial<TvLivenessCheckSummary> = {}): TvLivenessCheckSummary {
  return {
    scanned: 0,
    newlyDown: 0,
    recovered: 0,
    downDevices: [],
    recoveredDevices: [],
    newlyLongSilent: 0,
    longSilenceCleared: 0,
    longSilentDevices: [],
    longSilenceClearedDevices: [],
    ...overrides,
  };
}

describe("tv-liveness slack: 純フォーマッタ", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("minutesSince", () => {
    it("lastSeen=null は null", () => {
      expect(minutesSince(null, NOW)).toBeNull();
    });
    it("経過分は切り捨て（2 分 5 秒前 → 2）", () => {
      expect(minutesSince(new Date(NOW.getTime() - 125_000), NOW)).toBe(2);
    });
    it("未来の lastSeen は非負に丸める（0）", () => {
      expect(minutesSince(new Date(NOW.getTime() + 60_000), NOW)).toBe(0);
    });
  });

  describe("formatTvDownMessage", () => {
    it("🔴 + ラベル + 学校 + 経過分", () => {
      const m = formatTvDownMessage(downBase, NOW);
      expect(m).toContain("🔴");
      expect(m).toContain("電子工学科 1年");
      expect(m).toContain("school-A");
      expect(m).toContain("3分間");
    });
    it("ラベル未設定は device_id 先頭 8 文字でフォールバック", () => {
      const m = formatTvDownMessage({ ...downBase, label: null }, NOW);
      expect(m).toContain("ラベル未設定");
      expect(m).toContain("abcd1234");
      // 推測不能トークンの全長は載せない（先頭 8 文字のみ）。
      expect(m).not.toContain(downBase.deviceId);
    });
    it("lastSeen=null は『最終観測: なし』で経過分を出さない", () => {
      const m = formatTvDownMessage({ ...downBase, lastSeenAt: null }, NOW);
      expect(m).toContain("最終観測: なし");
      expect(m).not.toContain("分間");
    });
  });

  describe("formatTvRecoveredMessage", () => {
    it("🟢 + ラベル + 学校", () => {
      const m = formatTvRecoveredMessage({
        deviceId: "d-1",
        schoolId: "school-B",
        label: "職員室",
        lastSeenAt: NOW,
      });
      expect(m).toContain("🟢");
      expect(m).toContain("職員室");
      expect(m).toContain("school-B");
    });
  });

  describe("formatHeartbeatMessage", () => {
    it("✅ + 今回 down 台数", () => {
      const m = formatHeartbeatMessage(summary({ scanned: 5, newlyDown: 2, recovered: 1 }));
      expect(m).toContain("✅");
      expect(m).toContain("2台");
    });
  });

  describe("hoursSince", () => {
    it("経過時間を 0.1h 単位で丸める（7h ちょうど → 7）", () => {
      expect(hoursSince(new Date(NOW.getTime() - 7 * 60 * 60_000), NOW)).toBe(7);
    });
    it("6 時間 18 分前 → 6.3h（0.1h 丸め）", () => {
      expect(hoursSince(new Date(NOW.getTime() - (6 * 60 + 18) * 60_000), NOW)).toBe(6.3);
    });
    it("未来の lastSeen は非負に丸める（0）", () => {
      expect(hoursSince(new Date(NOW.getTime() + 60 * 60_000), NOW)).toBe(0);
    });
  });

  describe("formatTvLongSilenceMessage", () => {
    it("⚠️ + ラベル + 学校 + 経過時間 + 『要確認』文言（down(🔴) と別シグナル）", () => {
      const m = formatTvLongSilenceMessage(longSilentBase, NOW);
      expect(m).toContain("⚠️");
      expect(m).toContain("長時間サイレンス");
      expect(m).toContain("電子工学科 3年");
      expect(m).toContain("school-A");
      expect(m).toContain("7h");
      expect(m).toContain("消灯中でも本来ポーリング継続のはず");
      // down(🔴) とは別シグナルなので 🔴 を含めない。
      expect(m).not.toContain("🔴");
    });
    it("ラベル未設定は device_id 先頭 8 文字でフォールバック", () => {
      const m = formatTvLongSilenceMessage({ ...longSilentBase, label: null }, NOW);
      expect(m).toContain("ラベル未設定");
      expect(m).toContain("abcd1234");
      expect(m).not.toContain(longSilentBase.deviceId);
    });
  });

  describe("formatTvLongSilenceClearedMessage", () => {
    it("🟢 サイレンス復帰 + ラベル + 学校", () => {
      const m = formatTvLongSilenceClearedMessage({
        deviceId: "d-1",
        schoolId: "school-B",
        label: "玄関",
        lastSeenAt: NOW,
      });
      expect(m).toContain("🟢");
      expect(m).toContain("サイレンス復帰");
      expect(m).toContain("玄関");
      expect(m).toContain("school-B");
    });
  });

  describe("getSlackWebhookUrl", () => {
    it("未設定（空）は null", () => {
      vi.stubEnv("SLACK_WEBHOOK_URL", "");
      expect(getSlackWebhookUrl()).toBeNull();
    });
    it("空白のみは null", () => {
      vi.stubEnv("SLACK_WEBHOOK_URL", "   ");
      expect(getSlackWebhookUrl()).toBeNull();
    });
    it("URL は trim して返す", () => {
      vi.stubEnv("SLACK_WEBHOOK_URL", "  https://hooks.slack.com/services/XXX  ");
      expect(getSlackWebhookUrl()).toBe("https://hooks.slack.com/services/XXX");
    });
  });

  describe("deliverTvLivenessAlerts", () => {
    it("Webhook 未設定なら no-op（fetch を呼ばず throw しない）", async () => {
      vi.stubEnv("SLACK_WEBHOOK_URL", "");
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      await expect(
        deliverTvLivenessAlerts(
          summary({ scanned: 1, newlyDown: 1, downDevices: [downBase] }),
          NOW,
          false,
        ),
      ).resolves.toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    const recoveredBase = {
      deviceId: "ffff0000-ef56-4abc-8def-0123456789ab",
      schoolId: "school-A",
      label: "職員室",
      lastSeenAt: NOW,
    };

    it("既定は down(🔴) のみ配信し復帰(🟢) は送らない（立ち下がりのみ・F16 §9）", async () => {
      vi.stubEnv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/XXX");
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 200 }));
      await deliverTvLivenessAlerts(
        summary({
          scanned: 2,
          newlyDown: 1,
          recovered: 1,
          downDevices: [downBase],
          recoveredDevices: [recoveredBase],
        }),
        NOW,
        false,
      );
      // down の 1 件だけ POST、復帰(🟢) は抑制される。
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const text = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? "{}")).text;
      expect(text).toContain("🔴");
      expect(text).not.toContain("🟢");
    });

    it("第4引数 true（TV_ALERT_ON_RECOVERY 相当）で復帰(🟢) も配信する（opt-in）", async () => {
      vi.stubEnv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/XXX");
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 200 }));
      await deliverTvLivenessAlerts(
        summary({
          scanned: 2,
          newlyDown: 1,
          recovered: 1,
          downDevices: [downBase],
          recoveredDevices: [recoveredBase],
        }),
        NOW,
        false,
        true,
      );
      // down + 復帰の 2 件 POST。
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const texts = fetchSpy.mock.calls.map((c) => JSON.parse(String(c[1]?.body ?? "{}")).text);
      expect(texts.some((t: string) => t.includes("🔴"))).toBe(true);
      expect(texts.some((t: string) => t.includes("🟢"))).toBe(true);
    });

    it("長時間サイレンス(⚠️)は recovery opt-in と独立に常に配信される（down と別シグナル）", async () => {
      vi.stubEnv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/XXX");
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 200 }));
      // alertOnRecovery=false（既定）でも長時間サイレンスは送る。
      await deliverTvLivenessAlerts(
        summary({ scanned: 1, newlyLongSilent: 1, longSilentDevices: [longSilentBase] }),
        NOW,
        false,
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const text = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? "{}")).text;
      expect(text).toContain("⚠️");
      expect(text).toContain("長時間サイレンス");
    });

    it("長時間サイレンスの復帰(🟢 サイレンス復帰)は opt-in が立っている時だけ配信される", async () => {
      vi.stubEnv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/XXX");
      const clearedBase = {
        deviceId: "eeee1111-ef56-4abc-8def-0123456789ab",
        schoolId: "school-A",
        label: "玄関",
        lastSeenAt: NOW,
      };
      // 既定（opt-in なし）: クリアは送らない。
      const fetchSpy1 = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 200 }));
      await deliverTvLivenessAlerts(
        summary({ scanned: 1, longSilenceCleared: 1, longSilenceClearedDevices: [clearedBase] }),
        NOW,
        false,
      );
      expect(fetchSpy1).not.toHaveBeenCalled();
      fetchSpy1.mockRestore();

      // opt-in あり: クリアを 🟢 で送る。
      const fetchSpy2 = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 200 }));
      await deliverTvLivenessAlerts(
        summary({ scanned: 1, longSilenceCleared: 1, longSilenceClearedDevices: [clearedBase] }),
        NOW,
        false,
        true,
      );
      expect(fetchSpy2).toHaveBeenCalledTimes(1);
      const text = JSON.parse(String(fetchSpy2.mock.calls[0]?.[1]?.body ?? "{}")).text;
      expect(text).toContain("🟢");
      expect(text).toContain("サイレンス復帰");
    });
  });
});
