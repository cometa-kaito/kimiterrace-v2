import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../logger.js";

/**
 * 脅威 I-03: createLogger の出力 (Cloud Logging へ渡る JSON) に PII 平文が残らないことを
 * end-to-end で固定する。`formatters.log` 配線の非空虚性を sink でキャプチャして実証。
 */

function makeSink(): { sink: { write(s: string): void }; chunks: Array<Record<string, unknown>> } {
  const chunks: Array<Record<string, unknown>> = [];
  return {
    sink: {
      write(s: string) {
        chunks.push(JSON.parse(s));
      },
    },
    chunks,
  };
}

describe("createLogger — payload PII 自動マスキング (I-03)", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
  });
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("PII payload は出力で *** に伏せられ、平文が JSON に残らない", () => {
    const { sink, chunks } = makeSink();
    const logger = createLogger("test-svc", { destination: sink });

    // pino API は merging object が第1引数、msg が第2引数。
    logger.error(
      {
        schedule: { student: { fullName: "田中太郎", id: "stu-1" }, classId: "cls-1" },
        contact: "taro@example.com",
      },
      "save failed",
    );

    const entry = chunks[0];
    if (!entry) throw new Error("expected one log entry");
    const raw = JSON.stringify(entry);
    // 平文 PII は出力のどこにも残らない。
    expect(raw).not.toContain("田中太郎");
    expect(raw).not.toContain("taro@example.com");
    // 構造は維持され、伏字 + stable ID は残る。
    const schedule = (entry.schedule ?? {}) as { student?: { fullName?: string; id?: string } };
    expect(schedule.student?.fullName).toBe("***");
    expect(schedule.student?.id).toBe("stu-1");
    expect(entry.contact).toBe("***");
  });

  it("ログ基本フィールド (msg / severity / service) は redaction の影響を受けない", () => {
    const { sink, chunks } = makeSink();
    const logger = createLogger("auth-svc", { destination: sink });

    logger.warn({ userId: "u-1" }, "careful");

    const entry = chunks[0];
    if (!entry) throw new Error("expected one log entry");
    expect(entry.msg).toBe("careful");
    expect(entry.severity).toBe("WARNING");
    expect(entry.service).toBe("auth-svc");
    expect(entry.userId).toBe("u-1");
  });
});
