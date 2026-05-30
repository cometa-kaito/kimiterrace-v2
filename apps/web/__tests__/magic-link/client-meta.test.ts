import { describe, expect, it } from "vitest";
import { extractClientMeta } from "../../lib/magic-link/client-meta";

describe("extractClientMeta", () => {
  it("x-forwarded-for の先頭をクライアント IP に採用", () => {
    const h = new Headers({
      "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2",
      "user-agent": "Mozilla/5.0",
    });
    expect(extractClientMeta(h)).toEqual({ ip: "203.0.113.7", userAgent: "Mozilla/5.0" });
  });

  it("x-forwarded-for 無しなら x-real-ip にフォールバック", () => {
    const h = new Headers({ "x-real-ip": "198.51.100.4" });
    expect(extractClientMeta(h)).toEqual({ ip: "198.51.100.4", userAgent: null });
  });

  it("どちらも無ければ ip=null", () => {
    expect(extractClientMeta(new Headers())).toEqual({ ip: null, userAgent: null });
  });

  it("空の x-forwarded-for は null に倒す", () => {
    const h = new Headers({ "x-forwarded-for": "  " });
    expect(extractClientMeta(h).ip).toBeNull();
  });
});
