import type { Tracer, Context, SpanKind as SpanKindType } from '@opentelemetry/api'
import type { Pool } from 'pg'
import { createProcLogListener } from './notify-listener.js'
import type { ProcLogEntry, ProcLogStep } from './notify-listener.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OtelProcSpanEmitterOpts {
  /** pg_notify channel (default: 'proc_log') */
  channel?: string
  /** Override the span name. Default: entry.function_name */
  spanName?: (entry: ProcLogEntry) => string
  /** Add custom attributes to procedure spans */
  attributes?: (entry: ProcLogEntry) => Record<string, string | number | boolean>
  /**
   * How long (ms) to keep buffered step events waiting for their parent proc
   * entry before discarding them. Default: 5000.
   */
  stepBufferTtl?: number
  /** Called on pg_notify / JSON parse errors */
  onError?: (err: Error) => void
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Connects the pg_notify proc log listener to an OpenTelemetry tracer.
 *
 * Each procedure execution becomes a finished OTel span, correctly nested
 * under the HTTP request that triggered it (via the W3C traceparent that the
 * Koa/Express middleware set before the query).
 *
 * Steps compiled with `log: 'step'` are attached as **span events** on the
 * procedure span, preserving timing and row-count information.
 *
 * Requires `@opentelemetry/api`:
 *   npm install @opentelemetry/api
 *
 * @example
 * ```ts
 * import { trace } from '@opentelemetry/api'
 * import { createOtelProcSpanEmitter } from 'kysely-pg-procedures'
 *
 * const emitter = await createOtelProcSpanEmitter(
 *   trace.getTracer('my-app'),
 *   pool,
 * )
 *
 * // On graceful shutdown:
 * await emitter.stop()
 * ```
 *
 * In your middleware, set the traceparent before any query that might trigger
 * a procedure:
 *
 * ```ts
 * import { context, trace } from '@opentelemetry/api'
 *
 * async function traceMiddleware(ctx, next) {
 *   const span = trace.getActiveSpan()
 *   if (span) {
 *     const { traceId, spanId, traceFlags } = span.spanContext()
 *     const traceparent = `00-${traceId}-${spanId}-${traceFlags.toString(16).padStart(2, '0')}`
 *     await db.executeQuery(sql`SET LOCAL "app.traceparent" = ${traceparent}`.compile(db))
 *   }
 *   return next()
 * }
 * ```
 */
export async function createOtelProcSpanEmitter(
  tracer: Tracer,
  pool: Pool,
  opts?: OtelProcSpanEmitterOpts,
): Promise<{ stop(): Promise<void> }> {
  // Dynamic import — throws a clear error if @opentelemetry/api is not installed
  let api: typeof import('@opentelemetry/api')
  try {
    api = await import('@opentelemetry/api')
  } catch {
    throw new Error(
      'createOtelProcSpanEmitter requires @opentelemetry/api.\n' +
        'Install it with: npm install @opentelemetry/api',
    )
  }

  const { trace, ROOT_CONTEXT, TraceFlags, SpanKind } = api
  const ttl = opts?.stepBufferTtl ?? 5000

  // execution_id → buffered steps (arrive before the proc entry)
  const stepBuffer = new Map<string, Array<ProcLogStep>>()
  const stepTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function clearBuffer(executionId: string) {
    stepBuffer.delete(executionId)
    const t = stepTimers.get(executionId)
    if (t !== undefined) {
      clearTimeout(t)
      stepTimers.delete(executionId)
    }
  }

  function parentContextFromTraceparent(traceparent: string | null): Context {
    if (!traceparent) return ROOT_CONTEXT
    // W3C format: 00-{32hex traceId}-{16hex parentSpanId}-{2hex flags}
    const parts = traceparent.split('-')
    if (parts.length < 4) return ROOT_CONTEXT
    const [, traceId, parentSpanId, flagsHex] = parts
    if (!traceId || !parentSpanId || !flagsHex) return ROOT_CONTEXT
    const flags = parseInt(flagsHex, 16)
    return trace.setSpanContext(ROOT_CONTEXT, {
      traceId,
      spanId: parentSpanId,
      traceFlags: (flags & 1) !== 0 ? TraceFlags.SAMPLED : TraceFlags.NONE,
      isRemote: true,
    })
  }

  const listener = createProcLogListener(pool, {
    channel: opts?.channel,
    onError: opts?.onError,

    onStep(step) {
      const id = step.execution_id
      const existing = stepBuffer.get(id) ?? []
      existing.push(step)
      stepBuffer.set(id, existing)

      // TTL: discard steps if no proc entry arrives within the timeout
      const prev = stepTimers.get(id)
      if (prev !== undefined) clearTimeout(prev)
      stepTimers.set(
        id,
        setTimeout(() => { stepBuffer.delete(id); stepTimers.delete(id) }, ttl),
      )
    },

    onEntry(entry) {
      const parentCtx = parentContextFromTraceparent(entry.traceparent)
      const startTime = new Date(entry.started_at)
      const endTime = new Date(startTime.getTime() + entry.duration_ms)
      const name = opts?.spanName?.(entry) ?? entry.function_name
      const extraAttrs = opts?.attributes?.(entry) ?? {}

      const span = tracer.startSpan(
        name,
        {
          kind: SpanKind.INTERNAL,
          startTime,
          attributes: {
            'db.system': 'postgresql',
            'db.operation.name': 'procedure',
            'procedure.name': entry.function_name,
            // entry.span_id is the span ID generated inside the PL/pgSQL procedure;
            // stored as an attribute so it can be correlated with table-based logs
            'procedure.span_id': entry.span_id,
            'procedure.execution_id': entry.execution_id,
            ...extraAttrs,
          },
        },
        parentCtx,
      )

      // Attach buffered steps as span events (point-in-time within the span)
      const steps = stepBuffer.get(entry.execution_id) ?? []
      clearBuffer(entry.execution_id)

      for (const step of steps.sort((a, b) => a.step_index - b.step_index)) {
        span.addEvent(step.step_name, {
          'step.index': step.step_index,
          'step.statement_kind': step.statement_kind,
          'step.rows_affected': step.rows_affected,
        }, new Date(step.executed_at))
      }

      span.end(endTime)
    },
  })

  return {
    async stop() {
      // Clear all pending TTL timers
      for (const t of stepTimers.values()) clearTimeout(t)
      stepTimers.clear()
      stepBuffer.clear()
      await listener.stop()
    },
  }
}
