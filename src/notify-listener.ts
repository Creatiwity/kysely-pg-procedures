export interface ProcLogEntry {
  execution_id: string
  function_name: string
  traceparent: string | null
  span_id: string
  started_at: string
  duration_ms: number
  steps?: ProcLogStep[]
}

export interface ProcLogStep {
  step_index: number
  step_name: string
  statement_kind: string
  rows_affected: number
  executed_at: string
}

export function createProcLogListener(
  pool: import('pg').Pool,
  opts?: {
    channel?: string
    onEntry?: (entry: ProcLogEntry) => void
    onStep?: (step: ProcLogStep & { execution_id: string }) => void
    onError?: (err: Error) => void
  },
): { stop(): Promise<void> } {
  const channel = opts?.channel ?? 'proc_log'

  let client: import('pg').PoolClient | null = null
  let stopped = false

  const ready = (async () => {
    try {
      client = await pool.connect()
      await client.query(`LISTEN ${channel}`)

      client.on('notification', (msg) => {
        if (!msg.payload) return
        try {
          const payload = JSON.parse(msg.payload)
          if (
            typeof payload === 'object' &&
            payload !== null &&
            'step_index' in payload
          ) {
            opts?.onStep?.(payload as ProcLogStep & { execution_id: string })
          } else {
            opts?.onEntry?.(payload as ProcLogEntry)
          }
        } catch (err) {
          opts?.onError?.(err instanceof Error ? err : new Error(String(err)))
        }
      })

      client.on('error', (err) => {
        opts?.onError?.(err)
      })
    } catch (err) {
      if (!stopped) {
        opts?.onError?.(err instanceof Error ? err : new Error(String(err)))
      }
    }
  })()

  return {
    async stop(): Promise<void> {
      stopped = true
      await ready
      if (client) {
        try {
          await client.query(`UNLISTEN ${channel}`)
        } catch {
          // best-effort
        }
        client.release()
        client = null
      }
    },
  }
}
