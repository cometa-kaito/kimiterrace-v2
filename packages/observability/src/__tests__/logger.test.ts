import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../logger.js";

interface SinkChunk {
  raw: string;
  parsed: Record<string, unknown>;
}

function makeSink(): { sink: { write(s: string): void }; chunks: SinkChunk[] } {
  const chunks: SinkChunk[] = [];
  const sink = {
    write(s: string) {
      chunks.push({ raw: s, parsed: JSON.parse(s) });
    },
  };
  return { sink, chunks };
}

describe("createLogger (production)", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("emits valid JSON per log call", () => {
    const { sink, chunks } = makeSink();
    const logger = createLogger("test-svc", { destination: sink });

    logger.info("hello");

    expect(chunks).toHaveLength(1);
    const entry = chunks[0];
    if (!entry) throw new Error("expected one log entry");
    expect(entry.parsed).toMatchObject({
      msg: "hello",
      service: "test-svc",
    });
    expect(typeof entry.parsed.time).toBe("string");
  });

  it("maps info level to Cloud Logging severity INFO", () => {
    const { sink, chunks } = makeSink();
    const logger = createLogger("test-svc", { destination: sink });

    logger.info("hi");

    const entry = chunks[0];
    if (!entry) throw new Error("expected one log entry");
    expect(entry.parsed.severity).toBe("INFO");
    expect(entry.parsed.level).toBe("info");
  });

  it("maps error level to Cloud Logging severity ERROR", () => {
    const { sink, chunks } = makeSink();
    const logger = createLogger("test-svc", { destination: sink });

    logger.error("boom");

    const entry = chunks[0];
    if (!entry) throw new Error("expected one log entry");
    expect(entry.parsed.severity).toBe("ERROR");
    expect(entry.parsed.level).toBe("error");
  });

  it("maps warn level to WARNING and fatal to CRITICAL", () => {
    const { sink, chunks } = makeSink();
    const logger = createLogger("test-svc", { level: "debug", destination: sink });

    logger.warn("careful");
    logger.fatal("dying");

    const warn = chunks[0];
    const fatal = chunks[1];
    if (!warn || !fatal) throw new Error("expected two log entries");
    expect(warn.parsed.severity).toBe("WARNING");
    expect(fatal.parsed.severity).toBe("CRITICAL");
  });

  it("respects the requested minimum level", () => {
    const { sink, chunks } = makeSink();
    const logger = createLogger("test-svc", { level: "warn", destination: sink });

    logger.info("filtered out");
    logger.warn("kept");

    expect(chunks).toHaveLength(1);
    const entry = chunks[0];
    if (!entry) throw new Error("expected one log entry");
    expect(entry.parsed.msg).toBe("kept");
  });
});
