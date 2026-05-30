import { sql } from './sql.js'
import { executeBody } from './procedure.js'
import type {
  Statement,
  SqlFragment,
  ColumnDef,
  ColumnType,
  TempTableDef,
  CatchHandler,
} from './types.js'
import type { ProcedureDefinition, TriggerDefinition } from './procedure.js'

const IND = '    '

function ind(level: number): string {
  return IND.repeat(level)
}

function frag(f: SqlFragment): string {
  return f.text
}

function pgType(type: ColumnType): string {
  const map: Record<ColumnType, string> = {
    uuid: 'UUID',
    text: 'TEXT',
    varchar: 'VARCHAR',
    integer: 'INTEGER',
    bigint: 'BIGINT',
    smallint: 'SMALLINT',
    numeric: 'NUMERIC',
    decimal: 'DECIMAL',
    real: 'REAL',
    float: 'FLOAT',
    boolean: 'BOOLEAN',
    timestamptz: 'TIMESTAMPTZ',
    timestamp: 'TIMESTAMP',
    date: 'DATE',
    time: 'TIME',
    jsonb: 'JSONB',
    json: 'JSON',
    bytea: 'BYTEA',
  }
  return map[type] ?? type.toUpperCase()
}

function renderCol(name: string, def: ColumnDef): string {
  const type = typeof def === 'string' ? def : def.type
  const nullable = typeof def === 'string' ? true : (def.nullable ?? true)
  const defaultVal = typeof def === 'object' && 'default' in def ? def.default : undefined

  let col = `"${name}" ${pgType(type)}`
  if (!nullable) {
    col += ' NOT NULL'
  }
  if (defaultVal !== undefined) {
    col += ` DEFAULT ${defaultVal}`
  }
  return col
}

function createTempTable(table: TempTableDef): string {
  const cols = [`"_proc_instance_id" UUID NOT NULL`]
  for (const [name, def] of Object.entries(table.columns)) {
    cols.push(renderCol(name, def))
  }
  const colBlock = cols.map((c) => `${IND}${IND}${c}`).join(',\n')
  return `${IND}CREATE TEMP TABLE IF NOT EXISTS "${table.name}" (\n${colBlock}\n${IND});`
}

function collectVars(stmts: Statement[]): Map<string, string> {
  const vars = new Map<string, string>()
  for (const stmt of stmts) {
    if (stmt.kind === 'vars') {
      for (const [name, decl] of Object.entries(stmt.decls)) {
        const type = typeof decl === 'string' ? decl : decl.type
        const defaultVal = typeof decl === 'object' && decl.default ? ` := ${decl.default}` : ''
        vars.set(name, `${pgType(type)}${defaultVal}`)
      }
    }
    for (const [k, v] of collectVars(childStatements(stmt))) {
      if (!vars.has(k)) {
        vars.set(k, v)
      }
    }
  }
  return vars
}

function collectCatch(stmts: Statement[]): CatchHandler[] | undefined {
  const handler = stmts.find((s) => s.kind === 'catch')
  return handler?.kind === 'catch' ? handler.handlers : undefined
}

function childStatements(stmt: Statement): Statement[] {
  switch (stmt.kind) {
    case 'if':
      return [...stmt.then, ...(stmt.else ?? [])]
    case 'branch':
      return [...stmt.branches.flatMap((b) => b.then), ...(stmt.else ?? [])]
    case 'case':
      return [...stmt.branches.flatMap(([, s]) => s), ...(stmt.else ?? [])]
    case 'forRow':
    case 'while':
    case 'loop':
    case 'forIn':
      return stmt.body
    case 'catch':
      return stmt.handlers.flatMap((h) => h.then)
    default:
      return []
  }
}

function filterBody(stmts: Statement[]): Statement[] {
  return stmts.filter((s) => s.kind !== 'vars' && s.kind !== 'catch')
}

// ---------------------------------------------------------------------------
// Compile options and statement context
// ---------------------------------------------------------------------------

export interface CompileOpts {
  debug?: boolean
  log?: 'none' | 'info' | 'step' | 'debug'
  logTarget?: 'table' | 'notify'
}

interface StmtCtx {
  procName: string
  tempTables: TempTableDef[]
  vars: Map<string, string>
  debug: boolean
  log: 'none' | 'info' | 'step' | 'debug'
  logTarget: 'table' | 'notify'
  stepCounter: { value: number }
}

// ---------------------------------------------------------------------------
// Snapshot SQL helpers
// ---------------------------------------------------------------------------

function compileSnapshotDebug(stmt: { label: string }, ctx: StmtCtx, level: number): string {
  const i = ind(level)
  const label = stmt.label.replace(/'/g, "''")
  const procName = ctx.procName.replace(/'/g, "''")

  const lines: string[] = [
    `${i}INSERT INTO _proc_snapshot (execution_id, function_name, snapshot_name, created_at)`,
    `${i}VALUES (_proc_instance_id, '${procName}', '${label}', now());`,
  ]

  for (const table of ctx.tempTables) {
    const tableName = table.name.replace(/'/g, "''")
    lines.push(
      `${i}INSERT INTO _proc_snapshot_rows (execution_id, snapshot_name, table_name, row_data)`,
      `${i}SELECT _proc_instance_id, '${label}', '${tableName}', row_to_json(t)`,
      `${i}FROM "${table.name}" t WHERE t._proc_instance_id = _proc_instance_id;`,
    )
  }

  for (const varName of ctx.vars.keys()) {
    if (varName === '_proc_instance_id') continue
    const safeVar = varName.replace(/'/g, "''")
    lines.push(
      `${i}INSERT INTO _proc_snapshot_vars (execution_id, snapshot_name, var_name, var_value)`,
      `${i}VALUES (_proc_instance_id, '${label}', '${safeVar}', ${varName}::text);`,
    )
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Log-level SQL helpers
// ---------------------------------------------------------------------------

function stepName(stmt: Statement, index: number): string {
  if (
    (stmt.kind === 'raw' ||
      stmt.kind === 'tempInsert' ||
      stmt.kind === 'tempInsertFrom' ||
      stmt.kind === 'tempDelete' ||
      stmt.kind === 'selectInto') &&
    stmt.label
  ) {
    return stmt.label
  }
  return `${stmt.kind}_${index}`
}

function statementKindLabel(kind: string): string {
  const map: Record<string, string> = {
    raw: 'RAW',
    tempInsert: 'TEMPINSERT',
    tempInsertFrom: 'TEMPINSERTFROM',
    tempDelete: 'TEMPDELETE',
    selectInto: 'SELECTINTO',
  }
  return map[kind] ?? kind.toUpperCase()
}

/** Emit the step-tracking append block after a mutating statement */
function compileStepAppend(stmt: Statement, index: number, level: number, ctx: StmtCtx): string {
  const i = ind(level)
  const name = stepName(stmt, index).replace(/'/g, "''")
  const kind = statementKindLabel(stmt.kind)
  return [
    `${i}GET DIAGNOSTICS _proc_row_count = ROW_COUNT;`,
    `${i}_proc_steps := _proc_steps || jsonb_build_object(`,
    `${i}    'step_index', array_length(_proc_steps, 1),`,
    `${i}    'step_name', '${name}',`,
    `${i}    'statement_kind', '${kind}',`,
    `${i}    'rows_affected', _proc_row_count,`,
    `${i}    'executed_at', clock_timestamp()`,
    `${i});`,
  ].join('\n')
}

/** Emit the log flush SQL emitted just before every RETURN statement */
function compileLogFlush(ctx: StmtCtx, level: number): string {
  const i = ind(level)
  const procName = ctx.procName.replace(/'/g, "''")
  const lines: string[] = []

  if (ctx.log === 'none') return ''

  // Step flush (step / debug)
  if (ctx.log === 'step' || ctx.log === 'debug') {
    if (ctx.logTarget === 'table') {
      lines.push(
        `${i}INSERT INTO _proc_log_steps (execution_id, step_index, step_name, statement_kind, rows_affected, executed_at)`,
        `${i}SELECT _proc_instance_id,`,
        `${i}    (s->>'step_index')::int,`,
        `${i}    s->>'step_name',`,
        `${i}    s->>'statement_kind',`,
        `${i}    (s->>'rows_affected')::int,`,
        `${i}    (s->>'executed_at')::timestamptz`,
        `${i}FROM unnest(_proc_steps) s;`,
      )
    } else {
      // notify: one notification per step
      lines.push(
        `${i}DECLARE _proc_step_item JSONB;`,
        `${i}FOREACH _proc_step_item IN ARRAY _proc_steps LOOP`,
        `${i}    PERFORM pg_notify('proc_log', _proc_step_item::text);`,
        `${i}END LOOP;`,
      )
    }
  }

  // Info-level log (info / step / debug)
  if (ctx.logTarget === 'table') {
    lines.push(
      `${i}INSERT INTO _proc_log (execution_id, function_name, traceparent, span_id, started_at, duration_ms)`,
      `${i}VALUES (_proc_instance_id, '${procName}', _traceparent, _span_id,`,
      `${i}    _proc_started_at,`,
      `${i}    EXTRACT(MILLISECONDS FROM clock_timestamp() - _proc_started_at)::int);`,
    )
  } else {
    lines.push(
      `${i}PERFORM pg_notify('proc_log', json_build_object(`,
      `${i}    'execution_id', _proc_instance_id,`,
      `${i}    'function_name', '${procName}',`,
      `${i}    'traceparent', _traceparent,`,
      `${i}    'span_id', _span_id,`,
      `${i}    'started_at', _proc_started_at,`,
      `${i}    'duration_ms', EXTRACT(MILLISECONDS FROM clock_timestamp() - _proc_started_at)::int`,
      `${i})::text);`,
    )
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Statement compiler
// ---------------------------------------------------------------------------

function compileStmt(stmt: Statement, level: number, ctx?: StmtCtx): string {
  const i = ind(level)
  const recurse = (s: Statement, l: number) => compileStmt(s, l, ctx)

  switch (stmt.kind) {
    case 'vars':
    case 'catch':
      return ''

    case 'set':
      return `${i}${stmt.target} := ${frag(stmt.value)};`

    case 'return': {
      // Inject log flush before every RETURN when log level is active
      if (ctx && ctx.log !== 'none') {
        const flush = compileLogFlush(ctx, level)
        const ret = stmt.value ? `${i}RETURN ${frag(stmt.value)};` : `${i}RETURN;`
        return flush ? `${flush}\n${ret}` : ret
      }
      return stmt.value ? `${i}RETURN ${frag(stmt.value)};` : `${i}RETURN;`
    }

    case 'if': {
      const lines = [`${i}IF ${frag(stmt.condition)} THEN`]
      for (const s of filterBody(stmt.then)) {
        const out = recurse(s, level + 1)
        if (out) {
          lines.push(out)
        }
      }
      if (stmt.else?.length) {
        lines.push(`${i}ELSE`)
        for (const s of filterBody(stmt.else)) {
          const out = recurse(s, level + 1)
          if (out) {
            lines.push(out)
          }
        }
      }
      lines.push(`${i}END IF;`)
      return lines.join('\n')
    }

    case 'branch': {
      if (!stmt.branches.length) {
        return ''
      }
      const [first, ...rest] = stmt.branches
      if (!first) return ''
      const lines = [`${i}IF ${frag(first.when)} THEN`]
      for (const s of filterBody(first.then)) {
        const out = recurse(s, level + 1)
        if (out) {
          lines.push(out)
        }
      }
      for (const branch of rest) {
        lines.push(`${i}ELSIF ${frag(branch.when)} THEN`)
        for (const s of filterBody(branch.then)) {
          const out = recurse(s, level + 1)
          if (out) {
            lines.push(out)
          }
        }
      }
      if (stmt.else?.length) {
        lines.push(`${i}ELSE`)
        for (const s of filterBody(stmt.else)) {
          const out = recurse(s, level + 1)
          if (out) {
            lines.push(out)
          }
        }
      }
      lines.push(`${i}END IF;`)
      return lines.join('\n')
    }

    case 'case': {
      const lines = [`${i}CASE ${frag(stmt.expr)}`]
      for (const [value, body] of stmt.branches) {
        lines.push(`${i}WHEN '${value}' THEN`)
        for (const s of filterBody(body)) {
          const out = recurse(s, level + 1)
          if (out) {
            lines.push(out)
          }
        }
      }
      if (stmt.else?.length) {
        lines.push(`${i}ELSE`)
        for (const s of filterBody(stmt.else)) {
          const out = recurse(s, level + 1)
          if (out) {
            lines.push(out)
          }
        }
      }
      lines.push(`${i}END CASE;`)
      return lines.join('\n')
    }

    case 'selectInto': {
      const strict = stmt.strict ? ' STRICT' : ''
      const selectList = Object.values(stmt.vars).map(frag).join(', ')
      const intoVars = Object.keys(stmt.vars).join(', ')
      const stmtSql = `${i}SELECT ${selectList}\n${i}INTO${strict} ${intoVars}\n${i}${frag(stmt.from)};`
      if (ctx && (ctx.log === 'step' || ctx.log === 'debug')) {
        const idx = ctx.stepCounter.value++
        return `${stmtSql}\n${compileStepAppend(stmt, idx, level, ctx)}`
      }
      return stmtSql
    }

    case 'forRow': {
      const lines = [`${i}FOR ${stmt.rowVar} IN ${frag(stmt.query)} LOOP`]
      for (const s of filterBody(stmt.body)) {
        const out = recurse(s, level + 1)
        if (out) {
          lines.push(out)
        }
      }
      lines.push(`${i}END LOOP;`)
      return lines.join('\n')
    }

    case 'forIn': {
      const lines = [`${i}FOR ${stmt.var} IN ${frag(stmt.from)}..${frag(stmt.to)} LOOP`]
      for (const s of filterBody(stmt.body)) {
        const out = recurse(s, level + 1)
        if (out) {
          lines.push(out)
        }
      }
      lines.push(`${i}END LOOP;`)
      return lines.join('\n')
    }

    case 'while': {
      const lines = [`${i}WHILE ${frag(stmt.condition)} LOOP`]
      for (const s of filterBody(stmt.body)) {
        const out = recurse(s, level + 1)
        if (out) {
          lines.push(out)
        }
      }
      lines.push(`${i}END LOOP;`)
      return lines.join('\n')
    }

    case 'loop': {
      const lines = [`${i}LOOP`]
      for (const s of filterBody(stmt.body)) {
        const out = recurse(s, level + 1)
        if (out) {
          lines.push(out)
        }
      }
      lines.push(`${i}END LOOP;`)
      return lines.join('\n')
    }

    case 'exit':
      return stmt.when ? `${i}EXIT WHEN ${frag(stmt.when)};` : `${i}EXIT;`

    case 'continue':
      return stmt.when ? `${i}CONTINUE WHEN ${frag(stmt.when)};` : `${i}CONTINUE;`

    case 'raise': {
      const args = stmt.args?.length ? `, ${stmt.args.map(frag).join(', ')}` : ''
      return `${i}RAISE ${stmt.level} '${stmt.message}'${args};`
    }

    case 'perform':
      return `${i}PERFORM ${frag(stmt.query)};`

    case 'raw': {
      const text = frag(stmt.sql).trimEnd()
      const stmtSql = `${i}${text}${text.endsWith(';') ? '' : ';'}`
      if (ctx && (ctx.log === 'step' || ctx.log === 'debug')) {
        const idx = ctx.stepCounter.value++
        return `${stmtSql}\n${compileStepAppend(stmt, idx, level, ctx)}`
      }
      return stmtSql
    }

    case 'tempInsert': {
      const cols = Object.keys(stmt.values)
      const colList = ['"_proc_instance_id"', ...cols.map((c) => `"${c}"`)].join(', ')
      const valList = ['_proc_instance_id', ...cols.map((c) => frag(stmt.values[c]!))].join(', ')
      const stmtSql = `${i}INSERT INTO "${stmt.table.name}" (${colList})\n${i}VALUES (${valList});`
      if (ctx && (ctx.log === 'step' || ctx.log === 'debug')) {
        const idx = ctx.stepCounter.value++
        return `${stmtSql}\n${compileStepAppend(stmt, idx, level, ctx)}`
      }
      return stmtSql
    }

    case 'tempInsertFrom': {
      const colList = ['"_proc_instance_id"', ...stmt.columns.map((c) => `"${c}"`)].join(', ')
      const queryLines = frag(stmt.query)
        .trim()
        .split('\n')
        .map((l) => `${i}${IND}${l.trim()}`)
        .join('\n')
      const stmtSql = [
        `${i}INSERT INTO "${stmt.table.name}" (${colList})`,
        `${i}SELECT _proc_instance_id, * FROM (`,
        queryLines,
        `${i}) _subq;`,
      ].join('\n')
      if (ctx && (ctx.log === 'step' || ctx.log === 'debug')) {
        const idx = ctx.stepCounter.value++
        return `${stmtSql}\n${compileStepAppend(stmt, idx, level, ctx)}`
      }
      return stmtSql
    }

    case 'tempDelete': {
      const extra = stmt.where ? ` AND ${frag(stmt.where)}` : ''
      const stmtSql = `${i}DELETE FROM "${stmt.table.name}" AS t WHERE t."_proc_instance_id" = _proc_instance_id${extra};`
      if (ctx && (ctx.log === 'step' || ctx.log === 'debug')) {
        const idx = ctx.stepCounter.value++
        return `${stmtSql}\n${compileStepAppend(stmt, idx, level, ctx)}`
      }
      return stmtSql
    }

    case 'snapshot': {
      if (ctx?.debug) {
        return compileSnapshotDebug(stmt, ctx, level)
      }
      return ''
    }
  }
}

export function compileProcedure(def: ProcedureDefinition, opts?: CompileOpts): string {
  const stmts = executeBody(def)
  const logLevel = opts?.log ?? 'none'
  const logTarget = opts?.logTarget ?? 'table'
  const effectiveDebug = (opts?.debug ?? false) || logLevel === 'debug'

  const declVars = collectVars(stmts)

  // _proc_instance_id is needed for temp table isolation AND as execution_id in logs
  if (def.tempTables.length > 0 || logLevel !== 'none') {
    if (!declVars.has('_proc_instance_id')) {
      declVars.set('_proc_instance_id', 'UUID := gen_random_uuid()')
    }
  }

  // Log-level variables
  if (logLevel !== 'none') {
    declVars.set('_proc_started_at', 'TIMESTAMPTZ := clock_timestamp()')
    declVars.set('_traceparent', "TEXT := current_setting('app.traceparent', true)")
    declVars.set('_span_id', "TEXT := encode(gen_random_bytes(8), 'hex')")
  }
  if (logLevel === 'step' || logLevel === 'debug') {
    declVars.set('_proc_row_count', 'INTEGER')
    declVars.set('_proc_steps', "JSONB[] := ARRAY[]::JSONB[]")
  }

  const catchHandlers = collectCatch(stmts)

  const ctx: StmtCtx = {
    procName: def.name,
    tempTables: def.tempTables,
    vars: declVars,
    debug: effectiveDebug,
    log: logLevel,
    logTarget,
    stepCounter: { value: 0 },
  }

  let declare = ''
  if (declVars.size > 0) {
    const lines = [...declVars.entries()].map(([n, t]) => `${IND}${n} ${t};`)
    declare = `DECLARE\n${lines.join('\n')}\n`
  }

  const mainStmts = filterBody(stmts)

  let lastReturnIdx = -1
  for (let i = mainStmts.length - 1; i >= 0; i--) {
    if (mainStmts[i]?.kind === 'return') {
      lastReturnIdx = i
      break
    }
  }

  const preReturn = lastReturnIdx >= 0 ? mainStmts.slice(0, lastReturnIdx) : mainStmts
  const returnStmt = lastReturnIdx >= 0 ? mainStmts[lastReturnIdx] : null
  const postReturn = lastReturnIdx >= 0 ? mainStmts.slice(lastReturnIdx + 1) : []

  const lines: string[] = ['BEGIN']

  for (const table of def.tempTables) {
    lines.push(createTempTable(table))
    lines.push('')
  }

  for (const stmt of preReturn) {
    const out = compileStmt(stmt, 1, ctx)
    if (out) {
      lines.push(out)
    }
  }

  if (def.tempTables.length > 0) {
    if (lines[lines.length - 1] !== '') {
      lines.push('')
    }
    for (const table of def.tempTables) {
      lines.push(
        `${IND}DELETE FROM "${table.name}" AS t WHERE t."_proc_instance_id" = _proc_instance_id;`,
      )
    }
  }

  if (returnStmt) {
    const out = compileStmt(returnStmt, 1, ctx)
    if (out) {
      lines.push(out)
    }
  }

  for (const stmt of postReturn) {
    const out = compileStmt(stmt, 1, ctx)
    if (out) {
      lines.push(out)
    }
  }

  if (catchHandlers?.length) {
    lines.push('')
    lines.push(`${IND}EXCEPTION`)
    for (const handler of catchHandlers) {
      const conditions = Array.isArray(handler.when)
        ? handler.when.join(' OR ')
        : handler.when
      lines.push(`${IND}${IND}WHEN ${conditions} THEN`)
      for (const s of handler.then) {
        const out = compileStmt(s, 3, ctx)
        if (out) {
          lines.push(out)
        }
      }
    }
  }

  lines.push('END;')

  const funcBody = declare + lines.join('\n')

  const modifiers: string[] = []
  if (def.volatility) {
    modifiers.push(def.volatility)
  }
  if (def.security === 'DEFINER') {
    modifiers.push('SECURITY DEFINER')
  }

  const modStr = modifiers.length ? `\n${modifiers.join('\n')}` : ''

  return (
    `CREATE OR REPLACE FUNCTION ${def.name}()\n` +
    `RETURNS ${def.returns}\n` +
    `LANGUAGE ${def.language}${modStr}\n` +
    `AS $$\n${funcBody}\n$$;`
  )
}

export function compileTrigger(def: TriggerDefinition): string {
  const events = def.events.join(' OR ')
  const cols = def.columns?.length
    ? ` OF ${def.columns.map((c) => `"${c}"`).join(', ')}`
    : ''

  const lines = [
    `CREATE OR REPLACE TRIGGER ${def.name}`,
    `    ${def.timing} ${events}${cols} ON "${def.table}"`,
  ]

  if (def.referencing) {
    const refs: string[] = []
    if (def.referencing.old) {
      refs.push(`OLD TABLE AS ${def.referencing.old}`)
    }
    if (def.referencing.new) {
      refs.push(`NEW TABLE AS ${def.referencing.new}`)
    }
    if (refs.length) {
      lines.push(`    REFERENCING ${refs.join(' ')}`)
    }
  }

  lines.push(`    FOR EACH ${def.forEach}`)

  if (def.when) {
    lines.push(`    WHEN (${frag(def.when)})`)
  }

  lines.push(`    EXECUTE FUNCTION ${def.procedure.name}();`)

  return lines.join('\n')
}

export function compileAll(
  defs: Array<ProcedureDefinition | TriggerDefinition>,
  opts?: CompileOpts,
): string {
  const lines = ['-- Generated by @mesalia/kysely-pg-procedures', '-- DO NOT EDIT MANUALLY', '']
  const compiled = new Set<string>()

  for (const def of defs) {
    if (def._tag === 'Procedure') {
      if (!compiled.has(def.name)) {
        lines.push(compileProcedure(def, opts))
        lines.push('')
        compiled.add(def.name)
      }
    } else {
      if (!compiled.has(def.procedure.name)) {
        lines.push(compileProcedure(def.procedure, opts))
        lines.push('')
        compiled.add(def.procedure.name)
      }
      lines.push(compileTrigger(def))
      lines.push('')
    }
  }

  return lines.join('\n')
}

export function snapshotSetupSql(): string {
  return [
    'CREATE TABLE IF NOT EXISTS _proc_snapshot (',
    '    execution_id   uuid        NOT NULL,',
    '    function_name  text        NOT NULL,',
    '    snapshot_name  text        NOT NULL,',
    '    created_at     timestamptz NOT NULL',
    ');',
    '',
    'CREATE TABLE IF NOT EXISTS _proc_snapshot_rows (',
    '    execution_id   uuid  NOT NULL,',
    '    snapshot_name  text  NOT NULL,',
    '    table_name     text  NOT NULL,',
    '    row_data       jsonb NOT NULL',
    ');',
    '',
    'CREATE TABLE IF NOT EXISTS _proc_snapshot_vars (',
    '    execution_id   uuid NOT NULL,',
    '    snapshot_name  text NOT NULL,',
    '    var_name       text NOT NULL,',
    '    var_value      text',
    ');',
  ].join('\n')
}
