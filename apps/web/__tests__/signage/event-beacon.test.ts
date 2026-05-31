// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getClientId, sendSignageEvent } from "../../lib/signage/event-beacon";

/**
 * F07 (#43): クライアント送信ヘルパのテスト。localStorage への匿名 client id 永続化と、
 * sendBeacon 優先 / fetch フォールバック / 失敗握りつぶしを jsdom 環境で検証する。
 */

const TOKEN = "THETOKEN";
const URL = `/signage/${TOKEN}/events`;

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("getClientId", () => {
  it("初回は uuid を生成して保存し、2 回目は保存済みを返す", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "11111111-1111-4111-8111-111111111111" });
    const first = getClientId();
    expect(first).toBe("11111111-1111-4111-8111-111111111111");
    expect(localStorage.getItem("kimiterrace.signage.clientId")).toBe(first);
    const second = getClientId();
    expect(second).toBe(first);
  });

  it("localStorage が例外なら空文字 (無効値/PII を増やさない)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getClientId()).toBe("");
  });

  it("crypto.randomUUID 不在なら空文字", () => {
    vi.stubGlobal("crypto", {});
    expect(getClientId()).toBe("");
  });
});

describe("sendSignageEvent", () => {
  it("sendBeacon があれば URL + application/json Blob で送る", () => {
    const beacon = vi.fn((_url: string, _data?: BodyInit | null) => true);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
    sendSignageEvent(TOKEN, { type: "view", adId: "a1", slotIndex: 0 });
    expect(beacon).toHaveBeenCalledTimes(1);
    const call = beacon.mock.calls[0];
    expect(call?.[0]).toBe(URL);
    const body = call?.[1];
    expect(body).toBeInstanceOf(Blob);
    expect((body as Blob).type).toBe("application/json");
    Reflect.deleteProperty(navigator, "sendBeacon");
  });

  it("sendBeacon 不在なら fetch(keepalive, POST) にフォールバック", () => {
    Reflect.deleteProperty(navigator, "sendBeacon");
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchMock);
    sendSignageEvent(TOKEN, { type: "tap" });
    expect(fetchMock).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({ method: "POST", keepalive: true }),
    );
  });

  it("classToken 空なら何も送らない", () => {
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
    sendSignageEvent("", { type: "view" });
    expect(beacon).not.toHaveBeenCalled();
    Reflect.deleteProperty(navigator, "sendBeacon");
  });

  it("送信が例外を投げても伝播させない (表示をブロックしない)", () => {
    Object.defineProperty(navigator, "sendBeacon", {
      value: () => {
        throw new Error("boom");
      },
      configurable: true,
    });
    expect(() => sendSignageEvent(TOKEN, { type: "view" })).not.toThrow();
    Reflect.deleteProperty(navigator, "sendBeacon");
  });
});
