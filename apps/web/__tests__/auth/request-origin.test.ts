import { describe, expect, it } from "vitest";
import { originFromHeaders } from "../../lib/http/request-origin";

/**
 * 公開オリジン解決の純ロジック検証 (リセットリンクの宛先 origin に使う)。
 *
 * Cloud Run/GCLB は公開ホストを `x-forwarded-host`、スキームを `x-forwarded-proto` に載せる (内部 host は
 * `*.run.app`)。csrf.ts と同じく `x-forwarded-host` を優先する。
 */
describe("originFromHeaders", () => {
  it("x-forwarded-host + x-forwarded-proto から組み立てる", () => {
    const h = new Headers({ "x-forwarded-host": "app.example", "x-forwarded-proto": "https" });
    expect(originFromHeaders(h)).toBe("https://app.example");
  });

  it("x-forwarded-host を host より優先する (Cloud Run の内部 host を使わない)", () => {
    const h = new Headers({
      "x-forwarded-host": "app.example",
      host: "kimiterrace-web.run.app",
      "x-forwarded-proto": "https",
    });
    expect(originFromHeaders(h)).toBe("https://app.example");
  });

  it("x-forwarded-host が無ければ host にフォールバック", () => {
    const h = new Headers({ host: "app.example", "x-forwarded-proto": "https" });
    expect(originFromHeaders(h)).toBe("https://app.example");
  });

  it("proto 未指定は https を既定にする (公開は TLS 終端)", () => {
    const h = new Headers({ "x-forwarded-host": "app.example" });
    expect(originFromHeaders(h)).toBe("https://app.example");
  });

  it("複数ホップ (カンマ区切り) は先頭の公開値を採る", () => {
    const h = new Headers({
      "x-forwarded-host": "app.example, internal.run.app",
      "x-forwarded-proto": "https, http",
    });
    expect(originFromHeaders(h)).toBe("https://app.example");
  });

  it("host が全く無ければ null (安全側でフォールバック可能に)", () => {
    expect(originFromHeaders(new Headers())).toBeNull();
  });
});
