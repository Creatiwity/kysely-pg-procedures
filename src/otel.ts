import type { Tracer, Span, SpanStatusCode as SpanStatusCodeType } from '@opentelemetry/api'
import type {
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  RootOperationNode,
  QueryResult,
  UnknownRow,
  QueryId,
} from 'kysely'
import { compileNode } from './kysely-compile.js'
import type { Pool } from 'pg'
import { createProcLogListener } from './notify-listener.js'
import type { ProcLogEntry, ProcLogStep } from './notify-listener.js'

// ---------------------------------------------------------------------------
// Shared: lazy OTel loader
// ---------------------------------------------------------------------------

type OtelApi = typeof import('@opentelemetry/api')

async function loadOtelApi(): Promise<OtelApi> {
  try {
    return await import('@opentelemetry/api')
  } catch {
    throw new Error(
      'kysely-pg-procedures: OpenTelemetry integration requires @opentelemetry/api.\n' +
        'Install it with: npm install @opentelemetry/api',
    )
  }
}

// ---------------------------------------------------------------------------
// createOtelProcSpanEmitter
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

/**
 * Connects the pg_notify proc log listener to an OpenTelemetry tracer.
 *
 * Each procedure execution becomes a finished OTel span, correctly nested under
 * the HTTP request that triggered it (via the W3C traceparent set by your
 * middleware before the query).
 *
 * Steps compiled with `log: 'step'` are attached as span events on the
 * procedure span, preserving timing and row-count data.
 *
 * @example
 * ```ts
 * // Set in your HTTP middleware:
 * const { traceId, spanId, traceFlags } = trace.getActiveSpan()!.spanContext()
 * const traceparent = `00-${traceId}-${spanId}-${traceFlags.toString(16).padStart(2, '0')}`
 * await sql`SET LOCAL "app.traceparent" = ${traceparent}`.execute(db)
 *
 * // Start the listener:
 * const emitter = await createOtelProcSpanEmitter(trace.getTracer('my-app'), pool)
 * // On shutdown: await emitter.stop()
 * ```
 */
export async function createOtelProcSpanEmitter(
  tracer: Tracer,
  pool: Pool,
  opts?: OtelProcSpanEmitterOpts,
): Promise<{ stop(): Promise<void> }> {
  const { trace, ROOT_CONTEXT, TraceFlags, SpanKind } = await loadOtelApi()
  const ttl = opts?.stepBufferTtl ?? 5_000

  // execution_id → buffered steps (arrive before the proc entry via pg_notify)
  const stepBuffer = new Map<string, ProcLogStep[]>()
  const stepTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function clearBuffer(id: string) {
    stepBuffer.delete(id)
    const t = stepTimers.get(id)
    if (t !== undefined) { clearTimeout(t); stepTimers.delete(id) }
  }

  function parentCtxFromTraceparent(traceparent: string | null) {
    if (!traceparent) return ROOT_CONTEXT
    const parts = traceparent.split('-')
    if (parts.length < 4) return ROOT_CONTEXT
    const [, traceId, parentSpanId, flagsHex] = parts
    if (!traceId || !parentSpanId || !flagsHex) return ROOT_CONTEXT
    return trace.setSpanContext(ROOT_CONTEXT, {
      traceId,
      spanId: parentSpanId,
      traceFlags: (parseInt(flagsHex, 16) & 1) !== 0 ? TraceFlags.SAMPLED : TraceFlags.NONE,
      isRemote: true,
    })
  }

  const listener = createProcLogListener(pool, {
    channel: opts?.channel,
    onError: opts?.onError,

    onStep(step) {
      const id = step.execution_id
      const buf = stepBuffer.get(id) ?? []
      buf.push(step)
      stepBuffer.set(id, buf)
      // TTL: drop buffer if proc entry never arrives
      const prev = stepTimers.get(id)
      if (prev !== undefined) clearTimeout(prev)
      stepTimers.set(id, setTimeout(() => { stepBuffer.delete(id); stepTimers.delete(id) }, ttl))
    },

    onEntry(entry) {
      const parentCtx = parentCtxFromTraceparent(entry.traceparent)
      const startTime = new Date(entry.started_at)
      const endTime = new Date(startTime.getTime() + entry.duration_ms)
      const name = opts?.spanName?.(entry) ?? entry.function_name
      const extraAttrs = opts?.attributes?.(entry) ?? {}

      const span = tracer.startSpan(name, {
        kind: SpanKind.INTERNAL,
        startTime,
        attributes: {
          'db.system': 'postgresql',
          'db.operation.name': 'procedure',
          'procedure.name': entry.function_name,
          // The in-PG span ID — correlates with _proc_log table rows
          'procedure.span_id': entry.span_id,
          'procedure.execution_id': entry.execution_id,
          ...extraAttrs,
        },
      }, parentCtx)

      // Attach buffered steps as span events
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
      for (const t of stepTimers.values()) clearTimeout(t)
      stepTimers.clear()
      stepBuffer.clear()
      await listener.stop()
    },
  }
}

// ---------------------------------------------------------------------------
// KyselyOtelPlugin
// ---------------------------------------------------------------------------

export interface KyselyOtelPluginOpts {
  /**
   * Override the span name.
   * Default: derived from query type ('db.select', 'db.insert', 'db.update', 'db.delete').
   */
  spanName?: (args: PluginTransformQueryArgs) => string
  /** Add custom attributes to each query span */
  attributes?: (args: PluginTransformQueryArgs) => Record<string, string | number | boolean>
  /**
   * Include the SQL statement as a span attribute. May contain sensitive data.
   * Default: true.
   */
  dbStatement?: boolean
  /**
   * Milliseconds before a pending span is abandoned if transformResult is never
   * called (e.g. query threw an error). Default: 30 000.
   */
  abandonTimeout?: number
}

function nodeKindToOperation(kind: string): string {
  if (kind === 'SelectQueryNode') return 'db.select'
  if (kind === 'InsertQueryNode') return 'db.insert'
  if (kind === 'UpdateQueryNode') return 'db.update'
  if (kind === 'DeleteQueryNode') return 'db.delete'
  return 'db.query'
}

/**
 * A Kysely plugin that emits an OpenTelemetry span for every query.
 *
 * Spans are automatically nested under the active context (e.g. an HTTP request
 * span) via Node.js's AsyncLocalStorage-based context propagation — no manual
 * context threading required.
 *
 * On error, the plugin sets the span status to ERROR and ends it after a
 * configurable `abandonTimeout` (default 30 s). For immediate error spans,
 * combine with the Kysely `log` callback.
 *
 * @example
 * ```ts
 * import { trace } from '@opentelemetry/api'
 * import { KyselyOtelPlugin } from 'kysely-pg-procedures'
 * import { Kysely, PostgresDialect } from 'kysely'
 *
 * const db = new Kysely<DB>({
 *   dialect: new PostgresDialect({ pool }),
 *   plugins: [new KyselyOtelPlugin(trace.getTracer('my-app'))],
 * })
 * ```
 */
export class KyselyOtelPlugin implements KyselyPlugin {
  // Span + node keyed by QueryId object (same reference in both hooks — WeakMap is memory-safe)
  private readonly pending = new WeakMap<object, { span: Span; timer: ReturnType<typeof setTimeout>; node: RootOperationNode }>()
  private api: OtelApi | null = null
  private readonly ttl: number
  private readonly opts: KyselyOtelPluginOpts

  constructor(
    private readonly tracer: Tracer,
    opts?: KyselyOtelPluginOpts,
  ) {
    this.ttl = opts?.abandonTimeout ?? 30_000
    this.opts = opts ?? {}
    // Eager-load the OTel API so it is available before the first query.
    // Dynamic import is always async, but resolves well before any I/O.
    void import('@opentelemetry/api').then((api) => { this.api = api })
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    const api = this.api
    if (!api) return args.node // OTel not yet loaded (first microtask — extremely unlikely)

    const name = this.opts.spanName?.(args) ?? nodeKindToOperation(args.node.kind)
    const extraAttrs = this.opts.attributes?.(args) ?? {}

    const span = this.tracer.startSpan(name, {
      kind: api.SpanKind.CLIENT,
      attributes: {
        'db.system': 'postgresql',
        ...extraAttrs,
      },
    })
    // context.active() is implicitly used by startSpan — the current HTTP request
    // span (set via AsyncLocalStorage) becomes the parent automatically.

    const timer = setTimeout(() => {
      if (this.pending.has(args.queryId)) {
        this.pending.delete(args.queryId)
        span.setStatus({ code: api.SpanStatusCode.ERROR, message: 'abandoned: no result received' })
        span.end()
      }
    }, this.ttl)

    this.pending.set(args.queryId, { span, timer, node: args.node })
    return args.node
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    const api = this.api
    const pending = this.pending.get(args.queryId)
    if (!pending || !api) return args.result

    clearTimeout(pending.timer)
    this.pending.delete(args.queryId)

    const { span } = pending

    if (this.opts.dbStatement !== false) {
      try {
        const { sql: statement } = compileNode(pending.node)
        span.setAttribute('db.statement', statement)
      } catch {
        // best-effort — never fail the query because of tracing
      }
    }

    const numAffected = args.result.numAffectedRows
    if (numAffected !== undefined) {
      span.setAttribute('db.rows_affected', Number(numAffected))
    } else {
      span.setAttribute('db.rows_returned', args.result.rows.length)
    }

    span.setStatus({ code: api.SpanStatusCode.OK })
    span.end()
    return args.result
  }
}
