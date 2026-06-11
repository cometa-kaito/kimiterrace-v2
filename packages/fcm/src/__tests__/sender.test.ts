import { describe, expect, it, vi } from "vitest";
import { createGoogleAuthFcmSender, sendWakeToToken } from "../sender.js";

/**
 * FCM 送信アダプタの分岐テスト。OAuth（getAccessToken）と HTTP（fetchImpl）を注入し、ネットワーク・認証なしで
 * 「成功 / 非2xx / 例外 / トークン無し」と「送信可否 skip」を固定する。可用性規律: send は throw しない。
 */

const PROJECT = "signage-v2-prod";
const ENDPOINT = `https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`;

describe("createGoogleAuthFcmSender.send", () => {
  it("2xx は ok:true。Bearer トークンと v1 ボディを正しい endpoint に POST する", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const sender = createGoogleAuthFcmSender({
      projectId: PROJECT,
      getAccessToken: async () => "access-tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await sender.send({
      message: { token: "dev-tok", android: { priority: "HIGH" }, data: { action: "wake" } },
    });
    expect(res).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer access-tok");
    const body = JSON.parse(String(init.body));
    expect(body.message.token).toBe("dev-tok");
    expect(body.message.android.priority).toBe("HIGH");
    expect(body.message.data.action).toBe("wake");
  });

  it("非2xx は ok:false + status（throw しない）", async () => {
    const sender = createGoogleAuthFcmSender({
      projectId: PROJECT,
      getAccessToken: async () => "access-tok",
      fetchImpl: (async () => new Response(null, { status: 404 })) as unknown as typeof fetch,
    });
    const res = await sender.send({
      message: { token: "dev-tok", android: { priority: "HIGH" }, data: { action: "wake" } },
    });
    expect(res).toEqual({ ok: false, status: 404, errorName: "fcm_non_2xx" });
  });

  it("fetch 例外は握りつぶして ok:false（name のみ・throw しない）", async () => {
    const sender = createGoogleAuthFcmSender({
      projectId: PROJECT,
      getAccessToken: async () => "access-tok",
      fetchImpl: (async () => {
        throw new TypeError("network down");
      }) as unknown as typeof fetch,
    });
    const res = await sender.send({
      message: { token: "dev-tok", android: { priority: "HIGH" }, data: { action: "wake" } },
    });
    expect(res).toEqual({ ok: false, status: null, errorName: "TypeError" });
  });

  it("アクセストークン取得不可（null）は送信せず ok:false", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const sender = createGoogleAuthFcmSender({
      projectId: PROJECT,
      getAccessToken: async () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await sender.send({
      message: { token: "dev-tok", android: { priority: "HIGH" }, data: { action: "wake" } },
    });
    expect(res).toEqual({ ok: false, status: null, errorName: "no_access_token" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("sendWakeToToken", () => {
  it("トークン無し/空は送信せず skipped を返す（送信対象外）", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const sender = createGoogleAuthFcmSender({
      projectId: PROJECT,
      getAccessToken: async () => "access-tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await sendWakeToToken(sender, null)).toEqual({
      ok: false,
      status: null,
      errorName: "skipped_no_token",
    });
    expect(await sendWakeToToken(sender, "  ")).toEqual({
      ok: false,
      status: null,
      errorName: "skipped_no_token",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("非空トークンは wake ボディを組んで send する", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const sender = createGoogleAuthFcmSender({
      projectId: PROJECT,
      getAccessToken: async () => "access-tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await sendWakeToToken(sender, "dev-tok-xyz");
    expect(res).toEqual({ ok: true });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).message.token).toBe("dev-tok-xyz");
  });
});
