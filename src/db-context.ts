import type { SqlFragment, Statement, RaiseLevel, VarDecls } from './types.js'
import type { TempTableDef } from './types.js'
import { sql } from './sql.js'
import { compileDb, isCompilable, toSqlFragment, extractFromClause } from './kysely-compile.js'
import type { Compilable } from './kysely-compile.js'
import { buildTempTableAliasMap } from './tempTable.js'
import type { TempTableHelper } from './tempTable.js'
import type { SelectQueryBuilder, AnyColumn } from 'kysely'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A column reference — a SqlFragment that also carries its raw name for use
 * as an assignment target in db.set(). */
export interface ColumnRef extends SqlFragment {
  readonly _colName: string
}

/** Condition accepted by db.if():
 *  - SqlFragment / ColumnRef — used verbatim
 *  - [ColumnRef, opString, SqlFragment | string | number] — compiled to "lhs op rhs"
 */
export type IfCondition =
  | SqlFragment
  | ColumnRef
  | [ColumnRef | SqlFragment, string, SqlFragment | string | number]

/** A wrapped SelectQueryBuilder extended with .into() */
export interface DbSelectBuilder {
  where(...args: Parameters<SelectQueryBuilder<any, any, any>['where']>): DbSelectBuilder
  innerJoin(...args: Parameters<SelectQueryBuilder<any, any, any>['innerJoin']>): DbSelectBuilder
  leftJoin(...args: Parameters<SelectQueryBuilder<any, any, any>['leftJoin']>): DbSelectBuilder
  rightJoin(...args: Parameters<SelectQueryBuilder<any, any, any>['rightJoin']>): DbSelectBuilder
  orderBy(...args: Parameters<SelectQueryBuilder<any, any, any>['orderBy']>): DbSelectBuilder
  groupBy(...args: Parameters<SelectQueryBuilder<any, any, any>['groupBy']>): DbSelectBuilder
  having(...args: Parameters<SelectQueryBuilder<any, any, any>['having']>): DbSelectBuilder
  limit(...args: Parameters<SelectQueryBuilder<any, any, any>['limit']>): DbSelectBuilder
  offset(...args: Parameters<SelectQueryBuilder<any, any, any>['offset']>): DbSelectBuilder
  select(...args: Parameters<SelectQueryBuilder<any, any, any>['select']>): DbSelectBuilder
  selectAll(...args: Parameters<SelectQueryBuilder<any, any, any>['selectAll']>): DbSelectBuilder
  into(vars: Record<string, SqlFragment>, opts?: { strict?: boolean }): void
}

/** The imperative db context exposed to the procedure callback. */
export interface DbContext {
  /** Proxy — db.NEW.colName returns sql.raw('NEW."colName"') */
  readonly NEW: Record<string, ColumnRef>
  /** Proxy — db.OLD.colName returns sql.raw('OLD."colName"') */
  readonly OLD: Record<string, ColumnRef>
  /** Proxy — db.var.name returns sql.raw(name) for declared variables */
  readonly var: Record<string, ColumnRef>

  /** Assign: target := value; */
  set(target: ColumnRef | SqlFragment | string, value: SqlFragment | string | number): void

  /** IF … THEN … [ELSE …] END IF */
  if(condition: IfCondition, thenCb: () => void, elseCb?: () => void): void

  /** CASE expr WHEN … THEN … [ELSE …] END CASE */
  switch(col: SqlFragment | ColumnRef, cases: Record<string, () => void>): void

  /** SELECT … FROM … (returns a Kysely builder extended with .into()) */
  selectFrom(table: string): DbSelectBuilder

  /** CTE wrapper — delegates to compileDb.withRecursive */
  withRecursive: (typeof compileDb)['withRecursive']

  /** UPDATE wrapper — delegates to compileDb.updateTable */
  updateTable: (typeof compileDb)['updateTable']

  /** Execute a raw SQL statement */
  execute(query: SqlFragment | Compilable): void

  /** RETURN [value] */
  return(value?: SqlFragment | ColumnRef | string | number): void

  /** RAISE level 'msg' [, args] */
  raise(level: RaiseLevel, message: string, args?: Array<SqlFragment | ColumnRef>): void

  /** EXCEPTION handlers — hoisted to the EXCEPTION section by the compiler */
  catch(handlers: Record<string, () => void>): void

  /** PERFORM query */
  perform(query: SqlFragment | Compilable): void

  /** Debug snapshot — only emitted when compiled with debug=true */
  snapshot(label: string): void

  /** Temp table helpers — accessed as db[alias] */
  [alias: string]: TempTableHelper | unknown
}

// ---------------------------------------------------------------------------
// Statement stack
// ---------------------------------------------------------------------------

// Module-level stack of statement arrays. Each nested captureBlock() pushes a
// new array; push() always appends to the top.
let _stack: Statement[][] = []

function captureBlock(cb: () => void): Statement[] {
  const frame: Statement[] = []
  _stack.push(frame)
  try {
    cb()
  } finally {
    _stack.pop()
  }
  return frame
}

function push(stmt: Statement): void {
  if (_stack.length === 0) {
    throw new Error('db.*: called outside of a procedure body callback')
  }
  _stack[_stack.length - 1]!.push(stmt)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeColumnRef(text: string, colName: string): ColumnRef {
  return { _tag: 'sql', text, _colName: colName }
}

function isColumnRef(v: unknown): v is ColumnRef {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>)['_tag'] === 'sql' &&
    '_colName' in v
  )
}

function conditionToFragment(condition: IfCondition): SqlFragment {
  if (Array.isArray(condition)) {
    const [lhs, op, rhs] = condition as [SqlFragment, string, SqlFragment | string | number]
    const rhsFragment: SqlFragment =
      typeof rhs === 'object' && rhs !== null && '_tag' in rhs
        ? (rhs as SqlFragment)
        : sql.raw(typeof rhs === 'string' ? `'${rhs.replace(/'/g, "''")}'` : String(rhs))
    return sql`${lhs} ${sql.raw(op)} ${rhsFragment}`
  }
  return condition as SqlFragment
}

function valueToFragment(value: SqlFragment | string | number): SqlFragment {
  if (typeof value === 'object' && value !== null && '_tag' in value) {
    return value as SqlFragment
  }
  if (typeof value === 'string') {
    return sql.raw(`'${value.replace(/'/g, "''")}'`)
  }
  return sql.raw(String(value))
}

// ---------------------------------------------------------------------------
// Row proxy factory (NEW / OLD)
// ---------------------------------------------------------------------------

function makeRowProxy(rowName: 'NEW' | 'OLD'): Record<string, ColumnRef> {
  return new Proxy({} as Record<string, ColumnRef>, {
    get(_target, prop: string | symbol): ColumnRef {
      if (typeof prop !== 'string') throw new TypeError(`db.${rowName}: symbol property access not supported`)
      return makeColumnRef(`${rowName}."${prop}"`, prop)
    },
  })
}

// ---------------------------------------------------------------------------
// Var proxy factory
// ---------------------------------------------------------------------------

function makeVarProxy(): Record<string, ColumnRef> {
  return new Proxy({} as Record<string, ColumnRef>, {
    get(_target, prop: string | symbol): ColumnRef {
      if (typeof prop !== 'string') throw new TypeError('db.var: symbol property access not supported')
      return makeColumnRef(prop, prop)
    },
  })
}

// ---------------------------------------------------------------------------
// Wrapped select builder
// ---------------------------------------------------------------------------

function wrapSelectBuilder(kysely: SelectQueryBuilder<any, any, any>): DbSelectBuilder {
  const proxy: DbSelectBuilder = new Proxy({} as DbSelectBuilder, {
    get(_target, prop: string | symbol) {
      if (prop === 'into') {
        return (vars: Record<string, SqlFragment>, opts?: { strict?: boolean }) => {
          const fromClause = extractFromClause(kysely)
          push({
            kind: 'selectInto',
            vars,
            from: fromClause,
            strict: opts?.strict,
          })
        }
      }
      // Delegate to the kysely builder and re-wrap the result
      const method = (kysely as any)[prop as string]
      if (typeof method === 'function') {
        return (...args: unknown[]) => {
          const next = method.apply(kysely, args)
          // If result is still a query builder, wrap it; otherwise return raw
          if (next && typeof next === 'object' && typeof (next as any).compile === 'function') {
            return wrapSelectBuilder(next as SelectQueryBuilder<any, any, any>)
          }
          return next
        }
      }
      return undefined
    },
  })
  return proxy
}

// ---------------------------------------------------------------------------
// buildDbContext
// ---------------------------------------------------------------------------

export function buildDbContext(
  tempTables: TempTableDef[],
  vars: VarDecls,
): { db: DbContext; getStatements(): Statement[] } {
  const aliasMap: Record<string, TempTableHelper> = buildTempTableAliasMap(tempTables)

  // The root statement array — populated by push() calls at the top level of
  // the callback (i.e. when _stack has exactly one frame).
  const rootStatements: Statement[] = []

  function getStatements(): Statement[] {
    return rootStatements
  }

  // Core db methods (not proxied)
  const dbMethods = {
    NEW: makeRowProxy('NEW'),
    OLD: makeRowProxy('OLD'),
    var: makeVarProxy(),

    set(target: ColumnRef | SqlFragment | string, value: SqlFragment | string | number): void {
      let targetName: string
      if (typeof target === 'string') {
        targetName = target
      } else if (isColumnRef(target)) {
        targetName = (target as ColumnRef)._colName
          ? (target as SqlFragment).text  // use full text like NEW."col"
          : target.text
        // For ColumnRef we use the full text as target (e.g. NEW."col")
        targetName = (target as SqlFragment).text
      } else {
        // Plain SqlFragment — use .text as-is
        targetName = (target as SqlFragment).text
      }
      push({ kind: 'set', target: targetName, value: valueToFragment(value) })
    },

    if(condition: IfCondition, thenCb: () => void, elseCb?: () => void): void {
      const condFragment = conditionToFragment(condition)
      const thenStmts = captureBlock(thenCb)
      const elseStmts = elseCb ? captureBlock(elseCb) : undefined
      push({ kind: 'if', condition: condFragment, then: thenStmts, else: elseStmts })
    },

    switch(col: SqlFragment | ColumnRef, cases: Record<string, () => void>): void {
      const branches: Array<[string, Statement[]]> = []
      let elseStmts: Statement[] | undefined

      for (const [key, cb] of Object.entries(cases)) {
        const stmts = captureBlock(cb)
        if (key === '_else') {
          elseStmts = stmts
        } else {
          branches.push([key, stmts])
        }
      }

      push({ kind: 'case', expr: col as SqlFragment, branches, else: elseStmts })
    },

    selectFrom(table: string): DbSelectBuilder {
      const builder = compileDb.selectFrom(table as any)
      return wrapSelectBuilder(builder as unknown as SelectQueryBuilder<any, any, any>)
    },

    withRecursive: compileDb.withRecursive.bind(compileDb),
    updateTable: compileDb.updateTable.bind(compileDb),

    execute(query: SqlFragment | Compilable): void {
      push({ kind: 'raw', sql: toSqlFragment(query) })
    },

    return(value?: SqlFragment | ColumnRef | string | number): void {
      if (value === undefined) {
        push({ kind: 'return' })
      } else {
        push({ kind: 'return', value: valueToFragment(value as SqlFragment | string | number) })
      }
    },

    raise(level: RaiseLevel, message: string, args?: Array<SqlFragment | ColumnRef>): void {
      push({
        kind: 'raise',
        level,
        message,
        args: args?.map((a) => a as SqlFragment),
      })
    },

    catch(handlers: Record<string, () => void>): void {
      const catchHandlers = Object.entries(handlers).map(([when, cb]) => ({
        when,
        then: captureBlock(cb),
      }))
      push({ kind: 'catch', handlers: catchHandlers })
    },

    perform(query: SqlFragment | Compilable): void {
      push({ kind: 'perform', query: toSqlFragment(query) })
    },

    snapshot(label: string): void {
      push({ kind: 'snapshot', label })
    },
  }

  // The db proxy: falls through to aliasMap for temp table aliases, delegates
  // everything else to dbMethods.
  const db = new Proxy(dbMethods as unknown as DbContext, {
    get(target, prop: string | symbol) {
      if (typeof prop !== 'string') return undefined

      // Check built-in methods first
      if (prop in target) {
        return (target as any)[prop]
      }

      // Fall through to temp table alias map
      if (prop in aliasMap) {
        return aliasMap[prop]
      }

      return undefined
    },
  })

  // Bootstrap: push the root frame onto the stack so the callback's top-level
  // db.* calls land in rootStatements.
  // We do NOT push the frame here — it is pushed by buildDbContext's caller
  // (executeBody) when it calls captureBlock internally. Instead we expose a
  // controlled begin/end API via a closure-based approach.

  return {
    db,
    getStatements,
    // Internal — used by executeBody to run the callback with the root frame active.
    _runWithRootFrame: (cb: () => void) => {
      _stack.push(rootStatements)
      try {
        cb()
      } finally {
        _stack.pop()
      }
    },
  } as { db: DbContext; getStatements(): Statement[] } & { _runWithRootFrame: (cb: () => void) => void }
}
