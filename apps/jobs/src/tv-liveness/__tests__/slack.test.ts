import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deliverTvLivenessAlerts,
  formatHeartbeatMessage,
  formatTvDownMessage,
  formatTvRecoveredMessage,
  getSlackWebhookUrl,
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
};

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
      const m = formatHeartbeatMessage({
        scanned: 5,
        newlyDown: 2,
        recovered: 1,
        downDevices: [],
        recoveredDevices: [],
      });
      expect(m).toContain("✅");
      expect(m).toContain("2台");
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
          {
            scanned: 1,
            newlyDown: 1,
            recovered: 0,
            downDevices: [downBase],
            recoveredDevices: [],
          },
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
        {
          scanned: 2,
          newlyDown: 1,
          recovered: 1,
          downDevices: [downBase],
          recoveredDevices: [recoveredBase],
        },
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
        {
          scanned: 2,
          newlyDown: 1,
          recovered: 1,
          downDevices: [downBase],
          recoveredDevices: [recoveredBase],
        },
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
  });
});
