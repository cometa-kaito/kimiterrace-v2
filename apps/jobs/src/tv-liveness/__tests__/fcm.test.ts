import type { TvLivenessCheckSummary } from "@kimiterrace/db";
import type { FcmSender, FcmSendResult, FcmV1Message } from "@kimiterrace/fcm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverTvWakeOnDown, getFcmProjectId } from "../fcm.js";

/**
 * F16 拡張（遠隔起動）: down エッジ → FCM wake 結線の単体テスト。
 * `@kimiterrace/fcm` の sender を注入してネットワーク・認証なしで「送信対象の抽出 / no-op / 送信件数」を固定する。
 */

const NOW = new Date("2026-06-10T08:00:00.000Z");

/** down エッジ 1 件分（fcmToken の有無を差し替える）。 */
function down(deviceId: string, fcmToken: string | null) {
  return {
    deviceId,
    schoolId: "school-A",
    label: "電子工学科 1年",
    lastSeenAt: new Date(NOW.getTime() - 180_000),
    wentDownAt: new Date(NOW.getTime() - 180_000),
    fcmToken,
  };
}

function summaryWithDown(
  downDevices: TvLivenessCheckSummary["downDevices"],
): TvLivenessCheckSummary {
  return {
    scanned: downDevices.length,
    newlyDown: downDevices.length,
    recovered: 0,
    downDevices,
    recoveredDevices: [],
    // 長時間サイレンスは FCM wake には無関係（wake は down エッジのみ）。空で埋める。
    newlyLongSilent: 0,
    longSilenceCleared: 0,
    longSilentDevices: [],
    longSilenceClearedDevices: [],
  };
}

/** 送信を記録するフェイク sender（既定は成功）。 */
function fakeSender(result: FcmSendResult = { ok: true }): {
  sender: FcmSender;
  sent: FcmV1Message[];
} {
  const sent: FcmV1Message[] = [];
  return {
    sent,
    sender: {
      async send(message: FcmV1Message): Promise<FcmSendResult> {
        sent.push(message);
        return result;
      },
    },
  };
}

describe("getFcmProjectId", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it("GCP_PROJECT_ID を優先して返す", () => {
    vi.stubEnv("GCP_PROJECT_ID", "signage-v2-prod");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "other");
    expect(getFcmProjectId()).toBe("signage-v2-prod");
  });
  it("GCP_PROJECT_ID 未設定なら GOOGLE_CLOUD_PROJECT にフォールバック", () => {
    vi.stubEnv("GCP_PROJECT_ID", "");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "fallback-proj");
    expect(getFcmProjectId()).toBe("fallback-proj");
  });
  it("どちらも未設定なら null（送信 no-op）", () => {
    vi.stubEnv("GCP_PROJECT_ID", "");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    expect(getFcmProjectId()).toBeNull();
  });
});

describe("deliverTvWakeOnDown", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("down が無い / fcm_token 無しだけなら sender を一切呼ばない（送信対象 0）", async () => {
    const { sender, sent } = fakeSender();
    await deliverTvWakeOnDown(summaryWithDown([]), sender);
    await deliverTvWakeOnDown(summaryWithDown([down("d-1", null)]), sender);
    expect(sent).toHaveLength(0);
  });

  it("fcm_token のある down 端末にだけ wake を送る（token 無しは skip）", async () => {
    const { sender, sent } = fakeSender();
    await deliverTvWakeOnDown(
      summaryWithDown([down("d-1", "tok-aaa"), down("d-2", null), down("d-3", "tok-ccc")]),
      sender,
    );
    expect(sent).toHaveLength(2);
    expect(sent.map((m) => m.message.token).sort()).toEqual(["tok-aaa", "tok-ccc"]);
    // wake の形（HIGH priority + data.action=wake）を固定する。
    expect(sent[0]?.message.android.priority).toBe("HIGH");
    expect(sent[0]?.message.data.action).toBe("wake");
  });

  it("送信対象があり sender 未注入 + GCP_PROJECT_ID 未設定なら no-op（throw しない）", async () => {
    vi.stubEnv("GCP_PROJECT_ID", "");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    await expect(
      deliverTvWakeOnDown(summaryWithDown([down("d-1", "tok-aaa")])),
    ).resolves.toBeUndefined();
  });

  it("送信失敗（ok:false）でも throw せず完了する（可用性規律）", async () => {
    const { sender } = fakeSender({ ok: false, status: 404, errorName: "fcm_non_2xx" });
    await expect(
      deliverTvWakeOnDown(summaryWithDown([down("d-1", "tok-aaa")]), sender),
    ).resolves.toBeUndefined();
  });
});
