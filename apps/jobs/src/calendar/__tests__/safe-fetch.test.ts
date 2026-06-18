import { describe, expect, it, vi } from "vitest";
import {
  type DnsResolver,
  type SafeFetchOptions,
  SsrfBlockedError,
  assertSafeUrl,
  fetchPublicIcs,
  isBlockedIp,
} from "../safe-fetch.js";

/**
 * ADR-045 §SSRF: `fetchPublicIcs` の SSRF ガード（https 限定・プライベート/予約 IP 拒否・リダイレクト各ホップ
 * 再検証・サイズ上限・timeout）を、fetch / DNS resolver をフェイク注入して単体検証する（ネットワーク非依存）。
 */

/** 公開 IP に解決する resolver（許可ケース用）。 */
const publicResolver: DnsResolver = async () => [{ address: "93.184.216.34", family: 4 }];

/** 必ず内部 IP に解決する resolver（拒否ケース用）。 */
const internalResolver: DnsResolver = async () => [{ address: "10.0.0.5", family: 4 }];

function okFetch(body: string): typeof fetch {
  return vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
}

const baseOptions = (over: Partial<SafeFetchOptions> = {}): SafeFetchOptions => ({
  userAgent: "test-ua/1.0",
  timeoutMs: 1000,
  resolver: publicResolver,
  ...over,
});

describe("isBlockedIp", () => {
  it("IPv4 プライベート/予約レンジを拒否する", () => {
    for (const ip of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1", // CGNAT
      "127.0.0.1",
      "169.254.169.254", // GCP メタデータ
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.0.2.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1", // multicast
      "240.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isBlockedIp(ip), `${ip} は拒否されるべき`).toBe(true);
    }
  });

  it("IPv4 公開アドレスは許可する", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.32.0.1", "100.63.255.255"]) {
      expect(isBlockedIp(ip), `${ip} は許可されるべき`).toBe(false);
    }
  });

  it("IPv6 ループバック/未指定/ULA/link-local/IPv4-mapped 内部を拒否する", () => {
    for (const ip of [
      "::1", // loopback
      "::", // unspecified
      "fc00::1", // ULA
      "fd00::1", // ULA
      "fe80::1", // link-local
      "::ffff:127.0.0.1", // IPv4-mapped loopback
      "::ffff:10.0.0.1", // IPv4-mapped private
      "::ffff:169.254.169.254", // IPv4-mapped メタデータ
    ]) {
      expect(isBlockedIp(ip), `${ip} は拒否されるべき`).toBe(true);
    }
  });

  it("IPv6 公開アドレス / IPv4-mapped 公開は許可する", () => {
    expect(isBlockedIp("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
    expect(isBlockedIp("::ffff:93.184.216.34")).toBe(false);
  });

  it("IP として解釈できない文字列は安全側で拒否する", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
    expect(isBlockedIp("")).toBe(true);
  });
});

describe("assertSafeUrl", () => {
  it("(a) http scheme を拒否する", async () => {
    await expect(assertSafeUrl("http://example.com/cal.ics", publicResolver)).rejects.toThrow(
      SsrfBlockedError,
    );
  });

  it("file/ftp/data scheme を拒否する", async () => {
    for (const u of ["file:///etc/passwd", "ftp://example.com/x", "data:text/plain,hi"]) {
      await expect(assertSafeUrl(u, publicResolver)).rejects.toThrow(SsrfBlockedError);
    }
  });

  it("(b) IP リテラル直指定の内部 IP を拒否する", async () => {
    for (const u of [
      "https://169.254.169.254/computeMetadata/v1/",
      "https://127.0.0.1/x.ics",
      "https://10.0.0.5/x.ics",
      "https://192.168.1.1/x.ics",
      "https://[::1]/x.ics",
    ]) {
      await expect(assertSafeUrl(u, publicResolver)).rejects.toThrow(SsrfBlockedError);
    }
  });

  it("拒否ホスト名（localhost / .internal / metadata.google.internal）を拒否する", async () => {
    for (const u of [
      "https://localhost/x.ics",
      "https://foo.localhost/x.ics",
      "https://anything.internal/x.ics",
      "https://metadata.google.internal/x",
    ]) {
      await expect(assertSafeUrl(u, publicResolver)).rejects.toThrow(SsrfBlockedError);
    }
  });

  it("ホスト名が内部 IP に解決される場合を拒否する（DNS リバインディング系の保険）", async () => {
    await expect(assertSafeUrl("https://evil.example.com/x.ics", internalResolver)).rejects.toThrow(
      SsrfBlockedError,
    );
  });

  it("解決された複数 IP のうち 1 つでも内部なら拒否する", async () => {
    const mixed: DnsResolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.9", family: 4 },
    ];
    await expect(assertSafeUrl("https://mixed.example.com/x.ics", mixed)).rejects.toThrow(
      SsrfBlockedError,
    );
  });

  it("(c) 公開 https + 公開 IP リテラル / 公開解決ホスト名は許可する", async () => {
    await expect(
      assertSafeUrl("https://93.184.216.34/x.ics", publicResolver),
    ).resolves.toBeUndefined();
    await expect(
      assertSafeUrl("https://example.com/x.ics", publicResolver),
    ).resolves.toBeUndefined();
  });

  it("DNS 解決失敗 / 空は拒否する", async () => {
    const failing: DnsResolver = async () => {
      throw new Error("ENOTFOUND");
    };
    const empty: DnsResolver = async () => [];
    await expect(assertSafeUrl("https://x.example.com/x.ics", failing)).rejects.toThrow(
      SsrfBlockedError,
    );
    await expect(assertSafeUrl("https://x.example.com/x.ics", empty)).rejects.toThrow(
      SsrfBlockedError,
    );
  });
});

describe("fetchPublicIcs", () => {
  it("(c) 公開 https を取得し本文を返す。明示 User-Agent / credentials:omit / redirect:manual を付ける", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["User-Agent"]).toBe("test-ua/1.0");
      expect(init?.redirect).toBe("manual");
      expect(init?.credentials).toBe("omit");
      return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR", { status: 200 });
    }) as unknown as typeof fetch;
    const text = await fetchPublicIcs("https://example.com/cal.ics", baseOptions({ fetchImpl }));
    expect(text).toContain("VCALENDAR");
  });

  it("(a) http は fetch 前に拒否する（fetch を呼ばない）", async () => {
    const fetchImpl = okFetch("x");
    await expect(
      fetchPublicIcs("http://example.com/cal.ics", baseOptions({ fetchImpl })),
    ).rejects.toThrow(SsrfBlockedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("(b) 内部 IP 直指定は fetch 前に拒否する", async () => {
    const fetchImpl = okFetch("x");
    await expect(
      fetchPublicIcs("https://169.254.169.254/x", baseOptions({ fetchImpl })),
    ).rejects.toThrow(SsrfBlockedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("(d) リダイレクトで内部 IP へ飛ぶケースを拒否する（各ホップ再検証）", async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      if (String(url) === "https://example.com/cal.ics") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/computeMetadata/v1/" },
        });
      }
      return new Response("should-not-reach", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      fetchPublicIcs("https://example.com/cal.ics", baseOptions({ fetchImpl })),
    ).rejects.toThrow(SsrfBlockedError);
    // 1 回目（公開ホスト）は呼ぶが、内部 IP への 2 ホップ目 fetch は呼ばれない（検証で弾く）。
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("(d) 公開→公開のリダイレクトは追従して許可する", async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      if (String(url) === "https://example.com/cal.ics") {
        return new Response(null, {
          status: 301,
          headers: { location: "https://cdn.example.org/real.ics" },
        });
      }
      return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR", { status: 200 });
    }) as unknown as typeof fetch;
    const text = await fetchPublicIcs(
      "https://example.com/cal.ics",
      baseOptions({ fetchImpl, resolver: publicResolver }),
    );
    expect(text).toContain("VCALENDAR");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("リダイレクト上限を超えたら拒否する", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `https://hop${n}.example.com/next.ics` },
      });
    }) as unknown as typeof fetch;
    await expect(
      fetchPublicIcs("https://example.com/cal.ics", baseOptions({ fetchImpl, maxRedirects: 2 })),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("Location 欠落のリダイレクトは拒否する", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302 }),
    ) as unknown as typeof fetch;
    await expect(
      fetchPublicIcs("https://example.com/cal.ics", baseOptions({ fetchImpl })),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("(e) サイズ上限超過を拒否する（ストリーム中断）", async () => {
    const big = "A".repeat(1024);
    const fetchImpl = vi.fn(async () => {
      // ReadableStream で chunk を流し、上限超過を検出させる。
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = new TextEncoder().encode(big);
          for (let i = 0; i < 100; i++) controller.enqueue(chunk);
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      fetchPublicIcs("https://example.com/cal.ics", baseOptions({ fetchImpl, maxBytes: 2048 })),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("サイズ上限内のストリームは許可する", async () => {
    const fetchImpl = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("BEGIN:VCALENDAR\r\nEND:VCALENDAR"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const text = await fetchPublicIcs(
      "https://example.com/cal.ics",
      baseOptions({ fetchImpl, maxBytes: 1024 }),
    );
    expect(text).toContain("VCALENDAR");
  });

  it("非 2xx（4xx/5xx）は throw する", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 403 }),
    ) as unknown as typeof fetch;
    await expect(
      fetchPublicIcs("https://example.com/cal.ics", baseOptions({ fetchImpl })),
    ).rejects.toThrow(/status=403/);
  });

  it("(f) timeout: abort signal で取得が中断される", async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          // signal が abort されたら reject（実 fetch の挙動を模倣）。
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;
    await expect(
      fetchPublicIcs("https://example.com/cal.ics", baseOptions({ fetchImpl, timeoutMs: 10 })),
    ).rejects.toThrow();
  });
});
