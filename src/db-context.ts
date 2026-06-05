import type { SqlFragment, Statement, RaiseLevel, VarDecls } from './types.js'
import type { TempTableDef } from './types.js'
import { sql } from './sql.js'
import { compileDb, isCompilable, toSqlFragment, extractFromClause, extractSelectList, isKyselyExpression, expressionToFragment } from './kysely-compile.js'
import type { Compilable } from './kysely-compile.js'
import { buildTempTableAliasMap } from './tempTable.js'
import type { TempTableHelper, TempTableAliasMap, TempTableDbExt } from './tempTable.js'
import type { Expression, Kysely, SelectQueryBuilder } from 'kysely'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A column reference — a SqlFragment that also carries its raw name for use
 * as an assignment target in db.set(). */
export interface ColumnRef extends SqlFragment {
  readonly _colName: string
  readonly expressionType: unknown
  toOperationNode(): unknown
}

/**
 * A typed reference to a trigger row (NEW or OLD), parameterised by the table
 * schema type TRow.
 *
 * - ref itself    → ColumnRef  → db.return(NEW) compiles to RETURN NEW
 * - ref.colName   → ColumnRef  → db.set(NEW.score, ...) with full type safety
 *
 * Uses a mapped type (not an index signature) so column access is precise:
 * TypedRowRef<{ label: string; score: number }> gives .label and .score as
 * ColumnRef without any catch-all unknown or string in the value type.
 */
export type TypedRowRef<TRow> = ColumnRef & {
  readonly [K in keyof TRow & string]: ColumnRef
}

/** @internal Create a TypedRowRef proxy for NEW or OLD. */
export function makeTypedRowRef<TRow>(rowName: string): TypedRowRef<TRow> {
  const self = { _tag: 'sql' as const, text: rowName, _colName: rowName, expressionType: undefined as unknown, toOperationNode: () => ({ kind: 'RawNode' as const, sqlFragments: [rowName], parameters: [] as readonly never[] }) }
  return new Proxy(self as unknown as TypedRowRef<TRow>, {
    get(target, prop: string | symbol): unknown {
      if (typeof prop !== 'string') return (target as unknown as Record<symbol, unknown>)[prop]
      if (prop === '_tag' || prop === 'text' || prop === '_colName' || prop === 'expressionType' || prop === 'toOperationNode') {
        return (target as unknown as Record<string, unknown>)[prop]
      }
      return makeColumnRef(`${rowName}."${prop}"`, prop)
    },
  })
}

/**
 * The type of db.NEW and db.OLD.
 *
 * - As a whole (db.NEW) it is a valid SqlFragment/ColumnRef — so db.return(db.NEW)
 *   compiles to RETURN NEW without a type error.
 * - Column access (db.NEW.label) returns ColumnRef | string; the string arm covers
 *   the internal _tag / text / _colName properties of the proxy target.
 */
/**
 * The type of db.NEW and db.OLD.
 *
 * - As a whole (db.NEW) it satisfies SqlFragment (has _tag + text), so
 *   db.return(db.NEW) compiles to RETURN NEW without a type error.
 * - Column access (db.NEW.label) returns any — TypeScript cannot express
 *   "all string keys return ColumnRef except the internal _tag/text/_colName
 *   which are strings" in a single index signature without conflicts.
 *   The runtime behaviour is always correct: only actual column names return
 *   a ColumnRef SqlFragment; the proxy target's own properties handle the rest.
 */
export interface RowProxy {
  readonly _tag: 'sql'
  readonly text: string
  readonly _colName: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly [col: string]: any
}

/** Condition accepted by db.if():
 *  - SqlFragment / ColumnRef — used verbatim
 *  - [ColumnRef, opString, SqlFragment | string | number] — compiled to "lhs op rhs"
 */
export type IfCondition =
  | SqlFragment
  | ColumnRef
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | Expression<any>
  | [ColumnRef | SqlFragment, string, SqlFragment | string | number]

/**
 * Module augmentation — adds `.into()` to every Kysely SelectQueryBuilder.
 * The runtime implementation is injected by wrapSelectBuilder() via a Proxy.
 * This augmentation is the only addition to Kysely's type system made by this
 * library; it avoids redeclaring any of Kysely's existing query-building types.
 */
declare module 'kysely' {
  interface SelectQueryBuilder<DB, TB extends keyof DB, O> {
    /**
     * PL/pgSQL SELECT INTO terminator — compiles to:
     *   SELECT expr1, expr2 INTO var1, var2 FROM ... WHERE ...
     *
     * Only valid inside a `defineProcedure` / `defineRowProcedure` body.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    into(vars: Record<string, SqlFragment | Expression<any>>, opts?: { strict?: boolean }): void
    intoRow(varName: string, opts?: { strict?: boolean }): void
    intoRecord(varName: string, opts?: { strict?: boolean }): void
  }
  interface InsertQueryBuilder<DB, TB extends keyof DB, O> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    into(vars: Record<string, SqlFragment | Expression<any>>, opts?: { strict?: boolean }): void
    intoRow(varName: string, opts?: { strict?: boolean }): void
  }
  interface UpdateQueryBuilder<DB, UT extends keyof DB, TB extends keyof DB, O> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    into(vars: Record<string, SqlFragment | Expression<any>>, opts?: { strict?: boolean }): void
    intoRow(varName: string, opts?: { strict?: boolean }): void
  }
  interface DeleteQueryBuilder<DB, TB extends keyof DB, O> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    into(vars: Record<string, SqlFragment | Expression<any>>, opts?: { strict?: boolean }): void
    intoRow(varName: string, opts?: { strict?: boolean }): void
  }
}

/**
 * The combined DB type: user schema + temp table rows.
 * Used as the DB type parameter for typed Kysely query builders.
 *
 * @internal exposed for use in procedure.ts
 */
export type ExtendedDB<
  TDB extends Record<string, Record<string, unknown>>,
  TTables extends TempTableDef[],
> = TDB & TempTableDbExt<TTables>

/**
 * The imperative db context exposed to the procedure callback.
 *
 * TDB      — the user's database schema type (table name → row type). Defaults
 *             to a permissive Record so callers without schema types still work.
 * TTables  — the temp tables declared for this procedure (TempTableDef[]).
 * TAliases — TempTableAliasMap<TTables>: temp table helpers keyed by alias,
 *             intersected here so that db.myAlias is fully typed.
 */
export type DbContext<
  TDB extends Record<string, Record<string, unknown>> = Record<string, Record<string, unknown>>,
  TTables extends TempTableDef[] = [],
  TAliases extends Record<string, unknown> = Record<never, never>,
> = {
  /** Proxy — db.NEW itself is a RowProxy (compiles to NEW); db.NEW.col is a ColumnRef */
  readonly NEW: RowProxy
  /** Proxy — db.OLD itself is a RowProxy (compiles to OLD); db.OLD.col is a ColumnRef */
  readonly OLD: RowProxy
  /** Proxy — db.var.name returns a ColumnRef for a declared variable */
  readonly var: Record<string, ColumnRef>

  /** Assign: target := value; */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set(target: ColumnRef | SqlFragment | string, value: SqlFragment | Compilable | Expression<any> | string | number): void

  /** IF … THEN … [ELSE …] END IF */
  if(condition: IfCondition, thenCb: () => void, elseCb?: () => void): void

  /** CASE expr WHEN … THEN … [ELSE …] END CASE */
  switch(col: SqlFragment | ColumnRef, cases: Record<string, () => void>): void

  /**
   * SELECT … FROM … — delegates to Kysely's native selectFrom, typed against
   * the combined schema (user DB + temp tables). Returns the standard Kysely
   * SelectQueryBuilder extended with `.into()` via module augmentation.
   */
  selectFrom: Kysely<ExtendedDB<TDB, TTables>>['selectFrom']

  /** CTE wrapper — typed against the combined schema */
  withRecursive: Kysely<ExtendedDB<TDB, TTables>>['withRecursive']

  /** UPDATE wrapper — typed against the combined schema */
  updateTable: Kysely<ExtendedDB<TDB, TTables>>['updateTable']

  /** DELETE wrapper — typed against the combined schema */
  deleteFrom: Kysely<ExtendedDB<TDB, TTables>>['deleteFrom']

  /** INSERT wrapper — typed against the combined schema */
  insertInto: Kysely<ExtendedDB<TDB, TTables>>['insertInto']

  /** Execute a raw SQL statement */
  execute(query: SqlFragment | Compilable, opts?: { label?: string }): void

  /** RETURN [value]; pass db.NEW or db.OLD to return the trigger row */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return(value?: SqlFragment | ColumnRef | RowProxy | Compilable | Expression<any> | string | number): void

  /** RAISE level 'msg' [, args] [USING ERRCODE=..., HINT=..., DETAIL=...] */
  raise(level: RaiseLevel, message: string, opts?: {
    args?: Array<SqlFragment | ColumnRef>
    errcode?: string
    hint?: string
    detail?: string
  }): void

  /** PL/pgSQL special variable — TRUE if last SQL statement affected ≥1 row */
  readonly FOUND: SqlFragment

  /** Plain CTE wrapper — typed against the combined schema */
  with: Kysely<ExtendedDB<TDB, TTables>>['with']

  /** FOR [varName] IN query LOOP … END LOOP — body receives a typed row proxy */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  forRow<O extends Record<string, unknown> = Record<string, unknown>>(source: SqlFragment | Compilable, body: (row: TypedRowRef<O>) => void): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  forRow<O extends Record<string, unknown> = Record<string, unknown>>(rowVar: string, source: SqlFragment | Compilable, body: (row: TypedRowRef<O>) => void): void

  /** FOR varName IN ARRAY array LOOP … END LOOP */
  forEach(varName: string, array: SqlFragment | Compilable, body: () => void): void

  /** RETURN QUERY query */
  returnQuery(query: SqlFragment | Compilable): void

  /** FOR var IN from..to LOOP … END LOOP */
  forIn(varName: string, from: SqlFragment | number, to: SqlFragment | number, body: () => void): void

  /** WHILE condition LOOP … END LOOP */
  while(condition: IfCondition, body: () => void): void

  /** LOOP … END LOOP (unconditional — use exit() to break) */
  loop(body: () => void): void

  /** EXIT [WHEN condition]; */
  exit(when?: IfCondition): void

  /** CONTINUE [WHEN condition]; */
  continue(when?: IfCondition): void

  /** EXCEPTION handlers — hoisted to the EXCEPTION section by the compiler */
  catch(handlers: Record<string, () => void>): void

  /** PERFORM query */
  perform(query: SqlFragment | Compilable): void

  /**
   * Type-safe shortcut for calling a named procedure or function defined with
   * defineProcedure / defineRowProcedure.
   *
   * db.invoke(myProc)             → PERFORM my_proc_name();
   * db.invoke(myFn, [db.var.qty]) → PERFORM my_fn(qty);
   *
   * Note: PostgreSQL trigger functions (RETURNS TRIGGER) cannot be called via
   * PERFORM outside a trigger context — use invoke only for RETURNS VOID helpers.
   */
  invoke(proc: { readonly name: string }, args?: SqlFragment[]): void

  /** Debug snapshot — only emitted when compiled with debug=true */
  snapshot(label: string): void
} & TAliases

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
  return { _tag: 'sql', text, _colName: colName, expressionType: undefined as unknown, toOperationNode: () => ({ kind: 'RawNode' as const, sqlFragments: [text], parameters: [] as readonly never[] }) }
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
  if (isKyselyExpression(condition as unknown)) { return expressionToFragment(condition as Expression<any>) }
  if (isCompilable(condition as unknown)) { return toSqlFragment(condition as unknown as Compilable) }
  return condition as SqlFragment
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function valueToFragment(value: SqlFragment | Compilable | Expression<any> | string | number): SqlFragment {
  if (typeof value === 'object' && value !== null && '_tag' in value) {
    return value as SqlFragment
  }
  if (isKyselyExpression(value)) {
    return expressionToFragment(value)
  }
  if (isCompilable(value)) {
    return toSqlFragment(value)
  }
  if (typeof value === 'string') {
    return sql.raw(`'${value.replace(/'/g, "''")}'`)
  }
  return sql.raw(String(value))
}

// ---------------------------------------------------------------------------
// Row proxy factory (NEW / OLD)
// ---------------------------------------------------------------------------

function makeRowProxy(rowName: 'NEW' | 'OLD'): RowProxy {
  // The target carries _tag/text/_colName so that db.NEW itself satisfies
  // RowProxy (and therefore SqlFragment) when passed to db.return(db.NEW).
  const self = { _tag: 'sql' as const, text: rowName, _colName: rowName, expressionType: undefined as unknown, toOperationNode: () => ({ kind: 'RawNode' as const, sqlFragments: [rowName], parameters: [] as readonly never[] }) }
  return new Proxy(self as unknown as RowProxy, {
    get(target, prop: string | symbol): unknown {
      if (typeof prop !== 'string') return (target as unknown as Record<symbol, unknown>)[prop]
      if (prop === '_tag' || prop === 'text' || prop === '_colName' || prop === 'expressionType' || prop === 'toOperationNode') return (target as unknown as Record<string, unknown>)[prop]
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

/**
 * Wraps a Kysely SelectQueryBuilder with a runtime Proxy that intercepts
 * `.into()` calls — the only method Kysely doesn't provide natively.
 * All other accesses (where, select, innerJoin, compile, …) are forwarded
 * directly to the underlying builder via Reflect.get, preserving Kysely's
 * native behaviour. Chained methods that return SelectQueryBuilders are
 * re-wrapped so `.into()` remains interceptable throughout the chain.
 */
function wrapSelectBuilder(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inner: SelectQueryBuilder<any, any, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): SelectQueryBuilder<any, any, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Proxy(inner, {
    get(target, prop: string | symbol) {
      if (prop === 'into') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (vars: Record<string, SqlFragment | Expression<any>>, opts?: { strict?: boolean }) => {
          // If extractFromClause throws (no SELECT clause on the builder), retry with selectAll()
          let fromClause: SqlFragment
          try {
            fromClause = extractFromClause(target)
          } catch {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            fromClause = extractFromClause((target as any).selectAll())
          }
          const resolvedVars: Record<string, SqlFragment> = {}
          for (const [k, v] of Object.entries(vars)) {
            resolvedVars[k] = valueToFragment(v)
          }
          push({ kind: 'selectInto', vars: resolvedVars, from: fromClause, strict: opts?.strict })
        }
      }

      if (prop === 'intoRow') {
        return (varName: string, opts?: { strict?: boolean }) => {
          let fromClause: SqlFragment
          try {
            fromClause = extractFromClause(target)
          } catch {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            fromClause = extractFromClause((target as any).selectAll())
          }
          push({ kind: 'selectInto', vars: { [varName]: sql.raw('*') }, from: fromClause, strict: opts?.strict })
        }
      }

      if (prop === 'intoRecord') {
        return (varName: string, opts?: { strict?: boolean }) => {
          const selectList = extractSelectList(target)
          let fromClause: SqlFragment
          try {
            fromClause = extractFromClause(target)
          } catch {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            fromClause = extractFromClause((target as any).selectAll())
          }
          push({ kind: 'selectInto', vars: { [varName]: selectList }, from: fromClause, strict: opts?.strict })
        }
      }

      const val = Reflect.get(target, prop, target)
      if (typeof val !== 'function') return val

      return (...args: unknown[]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (val as (...a: unknown[]) => unknown).apply(target, args)
        // Re-wrap SelectQueryBuilder results (has .select + .where) so .into()
        // remains available throughout the chain.
        if (
          result !== null &&
          typeof result === 'object' &&
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          typeof (result as any).select === 'function' &&
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          typeof (result as any).where === 'function'
        ) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return wrapSelectBuilder(result as SelectQueryBuilder<any, any, any>)
        }
        return result
      }
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as SelectQueryBuilder<any, any, any>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapDmlBuilder(target: any, opts?: { strict?: boolean }): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Proxy(target, {
    get(inner: any, prop: string | symbol) {
      if (prop === 'into') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (vars: Record<string, SqlFragment | Expression<any>>, iopts?: { strict?: boolean }) => {
          const compiledSql = toSqlFragment(inner)
          const resolvedVars: Record<string, SqlFragment> = {}
          for (const [k, v] of Object.entries(vars)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            resolvedVars[k] = valueToFragment(v as any)
          }
          push({ kind: 'dmlInto', dml: compiledSql, vars: resolvedVars, strict: iopts?.strict ?? opts?.strict })
        }
      }

      if (prop === 'intoRow') {
        return (varName: string, iopts?: { strict?: boolean }) => {
          const compiledSql = toSqlFragment(inner)
          push({ kind: 'dmlInto', dml: compiledSql, vars: { [varName]: sql.raw('*') }, strict: iopts?.strict ?? opts?.strict })
        }
      }

      const val = Reflect.get(inner, prop, inner)
      if (typeof val !== 'function') return val

      return (...args: unknown[]) => {
        const result = (val as (...a: unknown[]) => unknown).apply(inner, args)
        // Re-wrap if the result is a DML builder (has .compile)
        if (
          result !== null &&
          typeof result === 'object' &&
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          typeof (result as any).compile === 'function'
        ) {
          return wrapDmlBuilder(result, opts)
        }
        return result
      }
    },
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapCteBuilder(builder: any): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Proxy(builder, {
    get(target: any, prop: string | symbol) {
      // Wrap selectFrom so the returned builder has .into()
      if (prop === 'selectFrom') {
        return (...args: unknown[]) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return wrapSelectBuilder((target as any).selectFrom(...args))
        }
      }
      // Allow chaining .with().with().selectFrom() — each intermediate also gets wrapped
      if (prop === 'with' || prop === 'withRecursive') {
        return (...args: unknown[]) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return wrapCteBuilder((target as any)[prop as string](...args))
        }
      }
      return Reflect.get(target, prop, target)
    },
  })
}

// ---------------------------------------------------------------------------
// buildDbContext
// ---------------------------------------------------------------------------

// Wrap a TempTableHelper so statement-producing methods auto-push to the stack.
// SqlFragment-producing methods (exists, notExists, filter) are left unchanged.
function wrapHelperForPush(helper: TempTableHelper): TempTableHelper {
  return {
    ...helper,
    insert(values) { const s = helper.insert(values); push(s); return s },
    insertFrom(columns, query, opts) { const s = helper.insertFrom(columns, query, opts); push(s); return s },
    delete(where) { const s = helper.delete(where); push(s); return s },
  }
}

export function buildDbContext<
  TTables extends TempTableDef[],
  TDB extends Record<string, Record<string, unknown>> = Record<string, Record<string, unknown>>,
>(
  tempTables: TTables,
  vars: VarDecls,
): { db: DbContext<TDB, TTables, TempTableAliasMap<TTables>>; getStatements(): Statement[] } {
  // Auto-incremented suffix for forRow loop variable names within this procedure body
  let _forRowCounter = 0

  const aliasMap: Record<string, TempTableHelper> = Object.fromEntries(
    Object.entries(buildTempTableAliasMap(tempTables)).map(([k, h]) => [k, wrapHelperForPush(h)])
  )

  // The root statement array — populated by push() calls at the top level of
  // the callback (i.e. when _stack has exactly one frame).
  const rootStatements: Statement[] = []

  function getStatements(): Statement[] {
    return rootStatements
  }

  // Cast compileDb to a typed Kysely instance for the combined schema.
  // At runtime this is still the same Kysely<any> singleton — the cast only
  // affects TypeScript's view of the query methods.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const typedDb = compileDb as unknown as Kysely<ExtendedDB<TDB, TTables>>

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

    // selectFrom: wraps the native Kysely builder with the runtime .into() proxy,
    // then casts to the correct WithInto<...> type. The `as any` on `from` is needed
    // because compileDb is Kysely<any> at runtime — the typed facade is TypeScript-only.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    selectFrom(from: any): any {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder = typedDb.selectFrom(from as any)
      return wrapSelectBuilder(builder as unknown as SelectQueryBuilder<any, any, any>)
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    withRecursive(...args: any[]): any {
      return wrapCteBuilder((typedDb.withRecursive as any)(...args))
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insertInto(from: any): any { return wrapDmlBuilder(typedDb.insertInto(from as any)) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateTable(from: any): any { return wrapDmlBuilder(typedDb.updateTable(from as any)) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deleteFrom(from: any): any { return wrapDmlBuilder(typedDb.deleteFrom(from as any)) },

    execute(query: SqlFragment | Compilable, opts?: { label?: string }): void {
      push({ kind: 'raw', sql: toSqlFragment(query), label: opts?.label })
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return(value?: SqlFragment | ColumnRef | Compilable | Expression<any> | string | number): void {
      if (value === undefined) {
        push({ kind: 'return' })
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        push({ kind: 'return', value: valueToFragment(value as SqlFragment | Compilable | Expression<any> | string | number) })
      }
    },

    raise(level: RaiseLevel, message: string, opts?: {
      args?: Array<SqlFragment | ColumnRef>
      errcode?: string
      hint?: string
      detail?: string
    }): void {
      push({
        kind: 'raise',
        level,
        message,
        args: opts?.args?.map((a) => a as SqlFragment),
        errcode: opts?.errcode,
        hint: opts?.hint,
        detail: opts?.detail,
      })
    },

    FOUND: sql.raw('FOUND'),

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    with(...args: any[]): any {
      return wrapCteBuilder((typedDb.with as any)(...args))
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    forRow<O extends Record<string, unknown> = Record<string, unknown>>(rowVarOrSource: string | SqlFragment | Compilable, sourceOrBody: SqlFragment | Compilable | ((row: TypedRowRef<O>) => void), maybeBody?: (row: TypedRowRef<O>) => void): void {
      let rowVar: string
      let source: SqlFragment | Compilable
      let body: (row: TypedRowRef<O>) => void
      if (typeof rowVarOrSource === 'string') {
        rowVar = rowVarOrSource
        source = sourceOrBody as SqlFragment | Compilable
        body = maybeBody!
      } else {
        rowVar = `_kpp_row${_forRowCounter++}`
        source = rowVarOrSource
        body = sourceOrBody as (row: TypedRowRef<O>) => void
      }
      const query = toSqlFragment(source)
      const rowRef = makeTypedRowRef<O>(rowVar)
      const bodyStmts = captureBlock(() => body(rowRef))
      push({ kind: 'forRow', rowVar, query, body: bodyStmts })
    },

    forEach(varName: string, array: SqlFragment | Compilable, body: () => void): void {
      const resolved = toSqlFragment(array)
      const bodyStmts = captureBlock(body)
      push({ kind: 'forEach', rowVar: varName, array: resolved, body: bodyStmts })
    },

    returnQuery(query: SqlFragment | Compilable): void {
      push({ kind: 'returnQuery', query: toSqlFragment(query) })
    },

    forIn(varName: string, from: SqlFragment | number, to: SqlFragment | number, body: () => void): void {
      const fromFrag: SqlFragment = typeof from === 'number' ? sql.raw(String(from)) : from
      const toFrag: SqlFragment = typeof to === 'number' ? sql.raw(String(to)) : to
      const bodyStmts = captureBlock(body)
      push({ kind: 'forIn', var: varName, from: fromFrag, to: toFrag, body: bodyStmts })
    },

    while(condition: IfCondition, body: () => void): void {
      const condFragment = conditionToFragment(condition)
      const bodyStmts = captureBlock(body)
      push({ kind: 'while', condition: condFragment, body: bodyStmts })
    },

    loop(body: () => void): void {
      const bodyStmts = captureBlock(body)
      push({ kind: 'loop', body: bodyStmts })
    },

    exit(when?: IfCondition): void {
      push({ kind: 'exit', when: when ? conditionToFragment(when) : undefined })
    },

    continue(when?: IfCondition): void {
      push({ kind: 'continue', when: when ? conditionToFragment(when) : undefined })
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

    invoke(proc: { readonly name: string }, args?: SqlFragment[]): void {
      const argList = args?.map(a => a.text).join(', ') ?? ''
      push({ kind: 'perform', query: sql.raw(`${proc.name}(${argList})`) })
    },

    snapshot(label: string): void {
      push({ kind: 'snapshot', label })
    },
  }

  // The db proxy: falls through to aliasMap for temp table aliases, delegates
  // everything else to dbMethods.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = new Proxy(dbMethods as unknown as DbContext<TDB, TTables, TempTableAliasMap<TTables>>, {
    get(target, prop: string | symbol) {
      if (typeof prop !== 'string') return undefined

      // Check built-in methods first
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  // The Proxy's generic parameter can't be inferred by TypeScript from the target
  // cast alone, so we use `as unknown as` to satisfy the declared return type.
  // Runtime behaviour is correct: db[alias] falls through to aliasMap.
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
  } as unknown as { db: DbContext<TDB, TTables, TempTableAliasMap<TTables>>; getStatements(): Statement[] } & { _runWithRootFrame: (cb: () => void) => void }
}
