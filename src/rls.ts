import type { ColumnType, SqlFragment } from './types.js'

// ---------------------------------------------------------------------------
// Session variable definitions
// ---------------------------------------------------------------------------

export type SessionVarType = ColumnType

export type SessionVarDefs = Record<string, SessionVarType>

export interface SessionVarsDef<TVars extends SessionVarDefs = SessionVarDefs> {
  readonly _tag: 'SessionVars'
  readonly vars: TVars
}

/**
 * Declare session variables used inside RLS policies.
 * Each variable is referenced as `current_setting('app.<name>', true)::<pgtype>` in compiled SQL.
 *
 * ```ts
 * const sessionVars = defineSessionVars({ userId: 'uuid', orgId: 'uuid' })
 * ```
 */
export function defineSessionVars<TVars extends SessionVarDefs>(vars: TVars): SessionVarsDef<TVars> {
  return { _tag: 'SessionVars', vars }
}

// ---------------------------------------------------------------------------
// RLS enable definition
// ---------------------------------------------------------------------------

export interface RlsEnableOpts {
  force?: boolean
}

export interface RlsEnableDef {
  readonly _tag: 'RlsEnable'
  readonly table: string
  readonly force: boolean
}

/**
 * Enable Row Level Security on a table (and optionally FORCE it for table owners too).
 *
 * ```ts
 * const rlsItems = enableRls<DB>()('items', { force: true })
 * ```
 */
export function enableRls<_TSchema extends Record<string, unknown>>() {
  return function <TTable extends string>(
    table: TTable,
    opts?: RlsEnableOpts,
  ): RlsEnableDef {
    return {
      _tag: 'RlsEnable',
      table,
      force: opts?.force ?? false,
    }
  }
}

/**
 * Compile an RlsEnableDef to SQL.
 */
export function compileRlsEnable(def: RlsEnableDef): string {
  const lines = [`ALTER TABLE "${def.table}" ENABLE ROW LEVEL SECURITY;`]
  if (def.force) {
    lines.push(`ALTER TABLE "${def.table}" FORCE ROW LEVEL SECURITY;`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Policy definition
// ---------------------------------------------------------------------------

export type PolicyCommand = 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'
export type PolicyPermissiveness = 'PERMISSIVE' | 'RESTRICTIVE'

export interface PolicyOpts {
  name: string
  as?: PolicyPermissiveness
  command?: PolicyCommand
  roles?: string[]
}

/**
 * A column reference proxy for use inside policy bodies.
 * col.columnName → `"columnName"` in compiled SQL.
 */
export type ColProxy<TRow> = {
  readonly [K in keyof TRow & string]: SqlFragment
}

/**
 * A session variable proxy for use inside policy bodies.
 * session.varName → `current_setting('app.varName', true)::<pgtype>` in compiled SQL.
 */
export type SessionProxy<TVars extends SessionVarDefs> = {
  readonly [K in keyof TVars & string]: SqlFragment
}

export interface PolicyBody<TRow, TVars extends SessionVarDefs> {
  using?: (ctx: PolicyBodyCtx<TRow, TVars>) => SqlFragment
  withCheck?: (ctx: PolicyBodyCtx<TRow, TVars>) => SqlFragment
}

export interface PolicyBodyCtx<TRow, TVars extends SessionVarDefs> {
  col: ColProxy<TRow>
  session: SessionProxy<TVars>
  sql: {
    raw(text: string): SqlFragment
  }
}

export interface PolicyDef {
  readonly _tag: 'Policy'
  readonly table: string
  readonly opts: PolicyOpts
  readonly using?: SqlFragment
  readonly withCheck?: SqlFragment
}

function pgTypeStr(type: ColumnType): string {
  const map: Record<ColumnType, string> = {
    uuid: 'uuid',
    text: 'text',
    varchar: 'varchar',
    integer: 'integer',
    bigint: 'bigint',
    smallint: 'smallint',
    numeric: 'numeric',
    decimal: 'decimal',
    real: 'real',
    float: 'float',
    boolean: 'boolean',
    timestamptz: 'timestamptz',
    timestamp: 'timestamp',
    date: 'date',
    time: 'time',
    jsonb: 'jsonb',
    json: 'json',
    bytea: 'bytea',
  }
  return map[type] ?? type
}

function makeColProxy<TRow>(): ColProxy<TRow> {
  return new Proxy({} as ColProxy<TRow>, {
    get(_target, prop: string | symbol): SqlFragment | undefined {
      if (typeof prop !== 'string') return undefined
      return { _tag: 'sql', text: `"${prop}"` }
    },
  })
}

function makeSessionProxy<TVars extends SessionVarDefs>(vars: TVars): SessionProxy<TVars> {
  return new Proxy({} as SessionProxy<TVars>, {
    get(_target, prop: string | symbol): SqlFragment | undefined {
      if (typeof prop !== 'string') return undefined
      const type = vars[prop]
      if (!type) return undefined
      return { _tag: 'sql', text: `current_setting('app.${prop}', true)::${pgTypeStr(type)}` }
    },
  })
}

/**
 * Define an RLS policy for a table.
 *
 * Uses DROP IF EXISTS + CREATE (no CREATE OR REPLACE, which requires PG17).
 *
 * ```ts
 * const policy = definePolicy<DB>()(
 *   'items',
 *   { name: 'items_tenant_isolation', as: 'PERMISSIVE', command: 'ALL', roles: ['app_user'] },
 *   sessionVars,
 *   {
 *     using: ({ col, session }) =>
 *       sql.raw(`${col.org_id.text} = ${session.orgId.text}`),
 *   },
 * )
 * ```
 */
export function definePolicy<_TSchema extends Record<string, unknown>>() {
  return function <
    TTable extends string,
    TVars extends SessionVarDefs = Record<string, never>,
  >(
    table: TTable,
    opts: PolicyOpts,
    sessionVarsDef: SessionVarsDef<TVars> | null,
    body: PolicyBody<_TSchema extends Record<TTable, infer TRow> ? TRow : Record<string, unknown>, TVars>,
  ): PolicyDef {
    const colProxy = makeColProxy<_TSchema extends Record<TTable, infer TRow> ? TRow : Record<string, unknown>>()
    const sessionProxy = makeSessionProxy<TVars>(
      (sessionVarsDef?.vars ?? {}) as TVars,
    )
    const sqlHelper = { raw: (text: string): SqlFragment => ({ _tag: 'sql', text }) }

    const ctx = { col: colProxy, session: sessionProxy, sql: sqlHelper }

    const using = body.using?.(ctx)
    const withCheck = body.withCheck?.(ctx)

    return {
      _tag: 'Policy',
      table,
      opts,
      using,
      withCheck,
    }
  }
}

/**
 * Compile a PolicyDef to SQL.
 * Emits DROP POLICY IF EXISTS followed by CREATE POLICY (no CREATE OR REPLACE for pre-PG17 compat).
 */
export function compilePolicyBlock(def: PolicyDef): string {
  const lines: string[] = []

  // Drop first (pre-PG17 compatibility — no CREATE OR REPLACE POLICY)
  lines.push(`DROP POLICY IF EXISTS "${def.opts.name}" ON "${def.table}";`)

  // CREATE POLICY header
  let header = `CREATE POLICY "${def.opts.name}" ON "${def.table}"`

  if (def.opts.as) {
    header += ` AS ${def.opts.as}`
  }
  if (def.opts.command) {
    header += ` FOR ${def.opts.command}`
  }
  if (def.opts.roles && def.opts.roles.length > 0) {
    header += ` TO ${def.opts.roles.join(', ')}`
  }

  lines.push(header)

  if (def.using) {
    lines.push(`    USING (${def.using.text})`)
  }
  if (def.withCheck) {
    lines.push(`    WITH CHECK (${def.withCheck.text})`)
  }

  lines.push(';')

  return lines.join('\n')
}
