/**
 * Returns DDL to create the UNLOGGED log tables used by the procedure log
 * infrastructure.  Run this once per environment that needs queryable log
 * history (e.g. via `db:procedures:setup-log`).  These tables are NOT part of
 * regular migrations.
 */
export function logSetupSql(): string {
  return [
    'CREATE UNLOGGED TABLE IF NOT EXISTS _proc_log (',
    '    execution_id   uuid        NOT NULL,',
    '    function_name  text        NOT NULL,',
    '    traceparent    text,',
    '    span_id        text,',
    '    started_at     timestamptz NOT NULL,',
    '    duration_ms    int         NOT NULL',
    ');',
    '',
    'CREATE UNLOGGED TABLE IF NOT EXISTS _proc_log_steps (',
    '    execution_id   uuid        NOT NULL,',
    '    step_index     int         NOT NULL,',
    '    step_name      text        NOT NULL,',
    '    statement_kind text        NOT NULL,',
    '    rows_affected  int         NOT NULL,',
    '    executed_at    timestamptz NOT NULL',
    ');',
  ].join('\n')
}
