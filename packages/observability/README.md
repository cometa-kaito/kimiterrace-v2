# @kimiterrace/observability

Shared observability primitives for kimiterrace-v2 — structured logging
(pino → Cloud Logging) and OpenTelemetry tracing (NodeSDK → Cloud Trace).

Backing decision: [ADR-014](../../docs/adr/014-observability.md). Error
tracking (Sentry) lives in a separate layer — see
[ADR-013](../../docs/adr/013-sentry.md).

## PII non-emission policy (CLAUDE.md rule 4)

This package **MUST NOT** be used to log raw PII. Student names, addresses,
phone numbers, guardian names, and any other directly-identifying field of a
public-school student are out of scope for both logs and span attributes.
Pass stable opaque identifiers (e.g. `user_id`, `student_id`, `school_id`)
instead, and resolve them to human-readable values only in UI surfaces
authorised by the request. Any log line containing raw PII is treated as an
incident — see `docs/runbooks/incident-response.md` for rotation steps. This
rule applies equally to Vertex AI prompts, embeddings, and downstream
analytics; the masking policy upstream of the LLM is the source of truth.

## Usage

### Logger

```ts
import { createLogger } from "@kimiterrace/observability";

const log = createLogger("schedules-api");

log.info({ schoolId, scheduleId }, "schedule created");
log.error({ err }, "schedule create failed");
```

- `NODE_ENV=production` → single-line JSON on stdout with a `severity`
  field (`DEBUG` / `INFO` / `WARNING` / `ERROR` / `CRITICAL`) so Cloud
  Logging classifies entries correctly.
- Otherwise → `pino-pretty` for human-readable local output.
- `createLogger(name, { level: "warn" })` overrides the minimum level.

### Tracer

```ts
import { initTracer, withSpan } from "@kimiterrace/observability";

initTracer("schedules-api");

await withSpan("schedules.create", async () => {
  // ...domain work...
});
```

- `initTracer` is idempotent; call it once at process start.
- The Cloud Trace exporter is not wired by default. Set
  `OTEL_EXPORTER_ENABLED=true` and add the exporter dependency at the
  marked wiring point in `src/tracer.ts` to enable export.
- `withSpan` records exceptions and sets span status on failure.

## Scope

In scope: logger + tracer wrappers, severity mapping, span helper.

Out of scope (separate issues / packages):

- `apps/web` integration (wiring middleware, request-scoped loggers).
- Sentry SDK setup (ADR-013).
- Cloud Logging / Cloud Trace export configuration in the deployment env
  (handled by Terraform + Cloud Run env vars).
- Metrics / Cloud Monitoring.

## Scripts

```bash
pnpm --filter @kimiterrace/observability typecheck
pnpm --filter @kimiterrace/observability lint
pnpm --filter @kimiterrace/observability test
```
