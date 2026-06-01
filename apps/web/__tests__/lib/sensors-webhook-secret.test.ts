import { afterEach, describe, expect, it } from "vitest";
import { getConfiguredWebhookSecret, verifyWebhookSecret } from "../../lib/sensors/webhook-secret";

describe("F13 webhook secret 検証 (#408)", () => {
  const prev = process.env.SWITCHBOT_WEBHOOK_SECRET;
  afterEach(() => {
    if (prev === undefined) delete process.env.SWITCHBOT_WEBHOOK_SECRET;
    else process.env.SWITCHBOT_WEBHOOK_SECRET = prev;
  });

  it("一致で true", () => {
    expect(verifyWebhookSecret("s3cret-value", "s3cret-value")).toBe(true);
  });

  it("不一致で false", () => {
    expect(verifyWebhookSecret("wrong-value", "s3cret-value")).toBe(false);
  });

  it("長さ違いでも例外を投げず false（SHA-256 固定長比較で定数時間化）", () => {
    expect(verifyWebhookSecret("short", "a-much-longer-secret-value")).toBe(false);
  });

  it("null / undefined / 空文字の provided は false", () => {
    expect(verifyWebhookSecret(null, "s")).toBe(false);
    expect(verifyWebhookSecret(undefined, "s")).toBe(false);
    expect(verifyWebhookSecret("", "s")).toBe(false);
  });

  it("env 未設定で getConfiguredWebhookSecret は null（fail-closed）", () => {
    delete process.env.SWITCHBOT_WEBHOOK_SECRET;
    expect(getConfiguredWebhookSecret()).toBe(null);
  });

  it("env 設定で getConfiguredWebhookSecret は値", () => {
    process.env.SWITCHBOT_WEBHOOK_SECRET = "abc123";
    expect(getConfiguredWebhookSecret()).toBe("abc123");
  });
});
