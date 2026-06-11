import { describe, expect, it } from "vitest";
import { FCM_WAKE_ACTION, buildWakeMessage, canSendWake, fcmSendEndpoint } from "../message.js";

/**
 * FCM 遠隔起動メッセージの純ロジック単体テスト（I/O 非依存）。
 */

describe("buildWakeMessage", () => {
  it("token + android.priority=HIGH + data.action=wake の v1 ボディを組む", () => {
    const m = buildWakeMessage("tok-123");
    expect(m).toEqual({
      message: {
        token: "tok-123",
        android: { priority: "HIGH" },
        data: { action: FCM_WAKE_ACTION },
      },
    });
    expect(FCM_WAKE_ACTION).toBe("wake");
  });

  it("通知ペイロード（notification）は付けない（サイレント data メッセージ・PII 非含み）", () => {
    const m = buildWakeMessage("tok-123");
    expect(Object.keys(m.message).sort()).toEqual(["android", "data", "token"]);
  });
});

describe("canSendWake", () => {
  it("非空トークンは true", () => {
    expect(canSendWake("tok")).toBe(true);
  });
  it("null / undefined / 空 / 空白のみは false（送信対象外）", () => {
    expect(canSendWake(null)).toBe(false);
    expect(canSendWake(undefined)).toBe(false);
    expect(canSendWake("")).toBe(false);
    expect(canSendWake("   ")).toBe(false);
  });
});

describe("fcmSendEndpoint", () => {
  it("project を埋め込んだ v1 messages:send URL", () => {
    expect(fcmSendEndpoint("signage-v2-prod")).toBe(
      "https://fcm.googleapis.com/v1/projects/signage-v2-prod/messages:send",
    );
  });
});
