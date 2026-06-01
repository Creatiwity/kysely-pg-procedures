import { sql as ksql, expressionBuilder } from 'kysely'
import type { ExpressionBuilder, Expression, SqlBool, RawBuilder } from 'kysely'
import type { ColumnType } from './types.js'
import { compileDb } from './kysely-compile.js'

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
 *
 * Each variable is set by your middleware via `SET LOCAL app.<name> = $1`
 * and referenced in policy clauses as `current_setting('app.<name>', true)::<pgtype>`.
 *
 * ```ts
 * const session = defineSessionVars({
 *   orgId:  'uuid',
 *   userId: 'uuid',
 *   role:   'text',
 * })
 * ```
 */
export function defineSessionVars<TVars extends SessionVarDefs>(vars: TVars): SessionVarsDef<TVars> {
  return { _tag: 'SessionVars', vars }
}

// ---------------------------------------------------------------------------
// RLS enable definition
// ---------------------------------------------------------------------------

export interface RlsEnableOpts {
  /** Also emit FORCE ROW LEVEL SECURITY (bypasses table-owner exemption). Default: false. */
  force?: boolean
}

export interface RlsEnableDef {
  readonly _tag: 'RlsEnable'
  readonly table: string
  readonly force: boolean
}

/**
 * Enable Row Level Security on a table.
 *
 * ```ts
 * const rlsItems = enableRls<DB>()('items', { force: true })
 * ```
 *
 * Compiles to:
 * ```sql
 * ALTER TABLE "items" ENABLE ROW LEVEL SECURITY;
 * ALTER TABLE "items" FORCE ROW LEVEL SECURITY;   -- only when force: true
 * ```
 */
export function enableRls<TSchema extends Record<string, Record<string, unknown>>>() {
  return function <TTable extends keyof TSchema & string>(
    table: TTable,
    opts?: RlsEnableOpts,
  ): RlsEnableDef {
    return { _tag: 'RlsEnable', table, force: opts?.force ?? false }
  }
}

export function compileRlsEnable(def: RlsEnableDef): string {
  const lines = [`ALTER TABLE "${def.table}" ENABLE ROW LEVEL SECURITY;`]
  if (def.force) lines.push(`ALTER TABLE "${def.table}" FORCE ROW LEVEL SECURITY;`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Policy definition
// ---------------------------------------------------------------------------

export type PolicyCommand = 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'
export type PolicyPermissiveness = 'PERMISSIVE' | 'RESTRICTIVE'

export interface PolicyOpts {
  /** Policy name — must be unique per table */
  name: string
  /** PERMISSIVE (default) or RESTRICTIVE */
  as?: PolicyPermissiveness
  /** Which DML command this policy applies to. Default: ALL */
  command?: PolicyCommand
  /** PostgreSQL role names this policy applies to. Default: PUBLIC */
  roles?: string[]
}

/**
 * A session variable proxy for use inside policy bodies.
 * `session.varName` → `current_setting('app.varName', true)::<pgtype>`
 * typed as `RawBuilder<any>` so it is assignable to any column type
 * in `eb('col', '=', session.varName)` comparisons.
 */
export type SessionProxy<TVars extends SessionVarDefs> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly [K in keyof TVars & string]: RawBuilder<any>
}

/**
 * The context passed to a policy body function.
 *
 * - `eb` — Kysely `ExpressionBuilder` typed to the table's columns.
 *   Column names are type-checked against the DB schema.
 * - `session` — typed session variable proxy; each property is a
 *   `RawBuilder` that compiles to `current_setting('app.xxx', true)::type`.
 */
export interface PolicyBodyCtx<
  TSchema extends Record<string, Record<string, unknown>>,
  TTable extends keyof TSchema & string,
  TVars extends SessionVarDefs,
> {
  eb: ExpressionBuilder<TSchema, TTable>
  session: SessionProxy<TVars>
}

export interface PolicyDef {
  readonly _tag: 'Policy'
  readonly table: string
  readonly opts: PolicyOpts
  readonly using?: string      // compiled SQL for USING clause
  readonly withCheck?: string  // compiled SQL for WITH CHECK clause
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function pgTypeStr(type: ColumnType): string {
  return type  // ColumnType values are already valid PostgreSQL type names
}

function makeSessionProxy<TVars extends SessionVarDefs>(vars: TVars): SessionProxy<TVars> {
  return new Proxy({} as SessionProxy<TVars>, {
    get(_target, prop: string | symbol): RawBuilder<any> | undefined { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (typeof prop !== 'string') return undefined
      const type = vars[prop]
      if (!type) return undefined
      // Cast to RawBuilder<any> so session.xxx is assignable to any column type in eb()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ksql.raw(`current_setting('app.${prop}', true)::${pgTypeStr(type)}`) as RawBuilder<any>
    },
  })
}

/**
 * Compile a Kysely Expression<SqlBool> to the raw SQL string suitable for
 * embedding in a USING or WITH CHECK clause.
 *
 * Strategy: build a dummy SELECT WHERE query and extract the WHERE clause.
 * The sentinel table name `__rls__` makes the extraction unambiguous.
 */
function compileExpression(expr: Expression<SqlBool>): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { sql: raw } = compileDb
    .selectFrom('__rls__' as any)
    .select(ksql`1`.as('x') as any)
    .where(expr as any)
    .compile()

  const marker = 'from "__rls__" where '
  const idx = raw.indexOf(marker)
  return idx >= 0 ? raw.slice(idx + marker.length) : 'true'
}

// ---------------------------------------------------------------------------
// definePolicy
// ---------------------------------------------------------------------------

/**
 * Define a PostgreSQL Row Level Security policy.
 *
 * The body function receives a fully typed Kysely `ExpressionBuilder` (`eb`)
 * and a `session` proxy. Use `eb` for all conditions — it provides column
 * type-checking from your DB schema. Use `session.*` as values in comparisons.
 * Fall back to `eb.raw(...)` or `ksql`...`` only when necessary.
 *
 * ```ts
 * const session = defineSessionVars({ orgId: 'uuid', userId: 'uuid' })
 *
 * const policy = definePolicy<DB>()(
 *   'items',
 *   { name: 'items_tenant_isolation', as: 'PERMISSIVE', command: 'ALL', roles: ['app_user'] },
 *   session,
 *   ({ eb, session: s }) => ({
 *     using:     eb('org_id', '=', s.orgId),
 *     withCheck: eb('org_id', '=', s.orgId),
 *   }),
 * )
 *
 * // Multi-condition:
 * ({ eb, session: s }) => ({
 *   using: eb.and([
 *     eb('org_id', '=', s.orgId),
 *     eb('deleted_at', 'is', null),
 *   ]),
 * })
 *
 * // Escape hatch:
 * ({ eb, session: s }) => ({
 *   using: eb.ref('org_id').$castTo<string>().is(s.orgId),
 * })
 * ```
 *
 * Uses DROP IF EXISTS + CREATE (no CREATE OR REPLACE, which requires PG 17).
 */
export function definePolicy<TSchema extends Record<string, Record<string, unknown>>>() {
  return function <
    TTable extends keyof TSchema & string,
    TVars extends SessionVarDefs = Record<string, never>,
  >(
    table: TTable,
    opts: PolicyOpts,
    sessionVarsDef: SessionVarsDef<TVars> | null,
    body: (ctx: PolicyBodyCtx<TSchema, TTable, TVars>) => {
      using?: Expression<SqlBool>
      withCheck?: Expression<SqlBool>
    },
  ): PolicyDef {
    const eb = expressionBuilder<TSchema, TTable>()
    const session = makeSessionProxy<TVars>((sessionVarsDef?.vars ?? {}) as TVars)

    const { using, withCheck } = body({ eb, session })

    return {
      _tag: 'Policy',
      table,
      opts,
      using:     using     ? compileExpression(using)     : undefined,
      withCheck: withCheck ? compileExpression(withCheck) : undefined,
    }
  }
}

// ---------------------------------------------------------------------------
// compilePolicyBlock
// ---------------------------------------------------------------------------

/**
 * Compile a PolicyDef to SQL.
 * Emits DROP POLICY IF EXISTS + CREATE POLICY (pre-PG17 compatibility).
 */
export function compilePolicyBlock(def: PolicyDef): string {
  const lines: string[] = [
    `DROP POLICY IF EXISTS "${def.opts.name}" ON "${def.table}";`,
  ]

  let header = `CREATE POLICY "${def.opts.name}" ON "${def.table}"`
  if (def.opts.as)                       header += ` AS ${def.opts.as}`
  if (def.opts.command)                  header += ` FOR ${def.opts.command}`
  if (def.opts.roles?.length)            header += ` TO ${def.opts.roles.join(', ')}`
  lines.push(header)

  if (def.using)     lines.push(`    USING (${def.using})`)
  if (def.withCheck) lines.push(`    WITH CHECK (${def.withCheck})`)
  lines.push(';')

  return lines.join('\n')
}
