import { SpanStatusCode, trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sdkStartMock, nodeSdkCtor } = vi.hoisted(() => ({
  sdkStartMock: vi.fn(),
  nodeSdkCtor: vi.fn(),
}));

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: nodeSdkCtor.mockImplementation(() => ({ start: sdkStartMock })),
}));

import { __resetTracerForTests, initTracer, withSpan } from "../tracer.js";

interface FakeSpan {
  setStatus: ReturnType<typeof vi.fn>;
  recordException: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

describe("initTracer", () => {
  let originalServiceName: string | undefined;
  let originalExporterEnabled: string | undefined;

  beforeEach(() => {
    originalServiceName = process.env.OTEL_SERVICE_NAME;
    originalExporterEnabled = process.env.OTEL_EXPORTER_ENABLED;
    // Node coerces `process.env.X = undefined` to the literal string "undefined"
    // which would defeat the tracer's `if (!process.env.OTEL_SERVICE_NAME)`
    // check — `delete` is the only way to actually unset the var.
    // biome-ignore lint/performance/noDelete: env vars must be unset, not stringified
    delete process.env.OTEL_SERVICE_NAME;
    // biome-ignore lint/performance/noDelete: env vars must be unset, not stringified
    delete process.env.OTEL_EXPORTER_ENABLED;
    sdkStartMock.mockClear();
    nodeSdkCtor.mockClear();
    __resetTracerForTests();
  });

  afterEach(() => {
    process.env.OTEL_SERVICE_NAME = originalServiceName;
    process.env.OTEL_EXPORTER_ENABLED = originalExporterEnabled;
    __resetTracerForTests();
  });

  it("returns the same SDK instance on repeated calls (idempotent)", () => {
    const first = initTracer("svc-a");
    const second = initTracer("svc-b");

    expect(second).toBe(first);
    expect(nodeSdkCtor).toHaveBeenCalledOnce();
  });

  it("sets OTEL_SERVICE_NAME on the first call and silently ignores subsequent name changes", () => {
    initTracer("svc-a");
    expect(process.env.OTEL_SERVICE_NAME).toBe("svc-a");

    initTracer("svc-b");
    expect(process.env.OTEL_SERVICE_NAME).toBe("svc-a");
  });

  it("does not overwrite an explicitly pre-set OTEL_SERVICE_NAME", () => {
    process.env.OTEL_SERVICE_NAME = "pre-set";
    initTracer("svc-a");
    expect(process.env.OTEL_SERVICE_NAME).toBe("pre-set");
  });

  it("does not call sdk.start when OTEL_EXPORTER_ENABLED is unset", () => {
    initTracer("svc-a");
    expect(sdkStartMock).not.toHaveBeenCalled();
  });

  it("does not call sdk.start when OTEL_EXPORTER_ENABLED is a falsy string", () => {
    process.env.OTEL_EXPORTER_ENABLED = "false";
    initTracer("svc-a");
    expect(sdkStartMock).not.toHaveBeenCalled();
  });

  it("calls sdk.start exactly once when OTEL_EXPORTER_ENABLED='true'", () => {
    process.env.OTEL_EXPORTER_ENABLED = "true";
    initTracer("svc-a");
    expect(sdkStartMock).toHaveBeenCalledOnce();
  });
});

describe("withSpan", () => {
  let span: FakeSpan;

  beforeEach(() => {
    span = {
      setStatus: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
    };
    const fakeTracer = {
      startActiveSpan: vi.fn((_name: string, cb: (s: FakeSpan) => Promise<unknown>) => cb(span)),
    };
    vi.spyOn(trace, "getTracer").mockReturnValue(fakeTracer as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sets status OK and ends the span on success", async () => {
    const result = await withSpan("test.op", async () => 42);

    expect(result).toBe(42);
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(span.recordException).not.toHaveBeenCalled();
    expect(span.end).toHaveBeenCalledOnce();
  });

  it("records the exception, sets status ERROR, ends the span, and re-throws on failure", async () => {
    const err = new Error("boom");

    await expect(withSpan("test.op", async () => Promise.reject(err))).rejects.toBe(err);
    expect(span.recordException).toHaveBeenCalledWith(err);
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: "boom" });
    expect(span.end).toHaveBeenCalledOnce();
  });

  it("wraps non-Error throws into an Error for recordException while preserving the original throw", async () => {
    await expect(withSpan("test.op", async () => Promise.reject("string-throw"))).rejects.toBe(
      "string-throw",
    );

    expect(span.recordException).toHaveBeenCalledOnce();
    const recorded = span.recordException.mock.calls[0]?.[0] as Error;
    expect(recorded).toBeInstanceOf(Error);
    expect(recorded.message).toBe("string-throw");
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "string-throw",
    });
    expect(span.end).toHaveBeenCalledOnce();
  });

  it("ends the span even if the callback throws synchronously before await", async () => {
    await expect(
      withSpan("test.op", () => {
        throw new Error("sync-throw");
      }),
    ).rejects.toThrow("sync-throw");

    expect(span.end).toHaveBeenCalledOnce();
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "sync-throw",
    });
  });
});
