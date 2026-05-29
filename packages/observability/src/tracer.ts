import { SpanStatusCode, trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";

const TRACER_NAME = "@kimiterrace/observability";

let sdk: NodeSDK | null = null;

/**
 * Initialise an OpenTelemetry NodeSDK for the given service.
 *
 * The Cloud Trace exporter is intentionally NOT wired up here. This keeps
 * local/CI runs from accidentally exporting spans. To enable export in a
 * deployed environment:
 *
 *   1. Add `@google-cloud/opentelemetry-cloud-trace-exporter` as a dep.
 *   2. Construct a `TraceExporter` and pass it to NodeSDK at the marked
 *      wiring point below.
 *   3. Set `OTEL_EXPORTER_ENABLED=true` so `sdk.start()` runs.
 *
 * Subsequent calls return the existing SDK instance (idempotent).
 */
export function initTracer(serviceName: string): NodeSDK {
  if (sdk) {
    return sdk;
  }

  // NodeSDK reads the service name from OTEL_SERVICE_NAME. We set it here
  // rather than constructing a Resource so we stay decoupled from the
  // semantic-conventions / resources package shape across SDK versions.
  if (!process.env.OTEL_SERVICE_NAME) {
    process.env.OTEL_SERVICE_NAME = serviceName;
  }

  // Cloud Trace exporter wiring point: pass `traceExporter` here once the
  // exporter dependency is added. Left empty by design (see header).
  sdk = new NodeSDK({});

  if (process.env.OTEL_EXPORTER_ENABLED === "true") {
    sdk.start();
  }

  return sdk;
}

/**
 * Wrap an async operation in an OpenTelemetry span.
 *
 * On success the span is closed with `OK`. On failure the error is recorded
 * via `recordException` and the span status is set to `ERROR` before the
 * exception is re-thrown.
 */
export async function withSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, async (span) => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Test helper: reset the cached SDK so a subsequent `initTracer` constructs
 * a fresh instance. Not intended for production callers.
 */
export function __resetTracerForTests(): void {
  sdk = null;
}
