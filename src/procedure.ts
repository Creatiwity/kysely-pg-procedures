import type {
  TempTableDef,
  Statement,
  VarDecls,
  Volatility,
  SecurityMode,
  TriggerTiming,
  TriggerEvent,
  TriggerForEach,
  SqlFragment,
} from './types.js'
import { sql } from './sql.js'
import { buildDbContext, makeTypedRowRef } from './db-context.js'
import type { DbContext, TypedRowRef } from './db-context.js'
import type { TempTableAliasMap } from './tempTable.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProcedureCallback<
  TDB extends Record<string, Record<string, unknown>> = Record<string, Record<string, unknown>>,
  TTables extends TempTableDef[] = [],
> = (ctx: {
  sql: typeof sql
  db: DbContext<TDB, TTables, TempTableAliasMap<TTables>>
}) => void

export type ArgMode = 'IN' | 'OUT' | 'INOUT' | 'VARIADIC'

export interface ProcArg {
  name: string
  type: string
  mode?: ArgMode
  default?: string
}

export interface ProcedureOptions {
  name: string
  args?: ProcArg[]
  language?: string
  returns?: string
  volatility?: Volatility
  security?: SecurityMode
  set?: Record<string, string>
}

export interface TriggerOptions {
  name: string
  table: string
  timing: TriggerTiming
  events: TriggerEvent[]
  forEach?: TriggerForEach
  when?: SqlFragment
  referencing?: { old?: string; new?: string }
  columns?: string[]
}

export interface ProcedureDefinition {
  readonly _tag: 'Procedure'
  readonly name: string
  readonly args: ProcArg[]
  readonly language: string
  readonly returns: string
  readonly volatility?: Volatility
  readonly security?: SecurityMode
  readonly set?: Record<string, string>
  readonly tempTables: TempTableDef[]
  readonly vars: VarDecls
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly body: ProcedureCallback<any, any>   // erased: any bypasses contra-variance at storage site
}

export interface TriggerDefinition {
  readonly _tag: 'Trigger'
  readonly name: string
  readonly table: string
  readonly timing: TriggerTiming
  readonly events: TriggerEvent[]
  readonly forEach: TriggerForEach
  readonly when?: SqlFragment
  readonly referencing?: { old?: string; new?: string }
  readonly columns?: string[]
  readonly procedure: ProcedureDefinition
}

// ---------------------------------------------------------------------------
// defineProcedure
// ---------------------------------------------------------------------------

export function defineProcedure<
  TDB extends Record<string, Record<string, unknown>> = Record<string, Record<string, unknown>>,
  TTables extends TempTableDef[] = [],
>(
  options: ProcedureOptions,
  tempTables: TTables,
  vars: VarDecls,
  body: ProcedureCallback<TDB, TTables>,
): ProcedureDefinition {
  return {
    _tag: 'Procedure',
    name: options.name,
    args: options.args ?? [],
    language: options.language ?? 'plpgsql',
    returns: options.returns ?? 'TRIGGER',
    volatility: options.volatility,
    security: options.security,
    set: options.set,
    tempTables,
    vars,
    body,
  }
}

// ---------------------------------------------------------------------------
// executeBody
// ---------------------------------------------------------------------------

/**
 * Executes the procedure body callback with a fresh DbContext and returns the
 * captured Statement[]. Called by the compiler / codegen to materialise the AST.
 */
export function executeBody(def: ProcedureDefinition): Statement[] {
  const { db, getStatements, _runWithRootFrame } = buildDbContext(
    def.tempTables,
    def.vars,
  ) as ReturnType<typeof buildDbContext> & { _runWithRootFrame: (cb: () => void) => void }

  // Inject vars declaration as the first statement when vars are declared
  const statements: Statement[] = getStatements()

  _runWithRootFrame(() => {
    if (Object.keys(def.vars).length > 0) {
      // Push vars statement at start — push() lands in rootStatements
      statements.unshift({ kind: 'vars', decls: def.vars })
    }
    def.body({ sql, db })
  })

  return statements
}

// ---------------------------------------------------------------------------
// defineStatementTrigger
// ---------------------------------------------------------------------------

/**
 * Helper type: extends DB with typed transition tables from REFERENCING.
 * TRefNew → typed as DB[TTable]; TRefOld → typed as DB[TTable].
 * `never` keys are omitted (no REFERENCING clause for that direction).
 */
export type WithTransitionTables<
  TDB extends Record<string, Record<string, unknown>>,
  TTable extends keyof TDB & string,
  TRefNew extends string,
  TRefOld extends string,
> = TDB &
  ([TRefNew] extends [never] ? Record<never, never> : { [K in TRefNew]: TDB[TTable] }) &
  ([TRefOld] extends [never] ? Record<never, never> : { [K in TRefOld]: TDB[TTable] })

export interface StatementTriggerOptions<
  TRefNew extends string = never,
  TRefOld extends string = never,
> {
  name: string
  procedureName: string
  timing: TriggerTiming
  events: TriggerEvent[]
  /** Transition table aliases — inferred as literal types for typed selectFrom. */
  referencing?: {
    new?: TRefNew
    old?: TRefOld
  }
  when?: SqlFragment
}

/**
 * Factory for FOR EACH STATEMENT triggers with typed transition tables.
 *
 * The `referencing` aliases are inferred as literal types so
 * `db.selectFrom('inserted')` and `db.selectFrom('removed')` are
 * fully type-checked as the trigger table's row type.
 *
 * ```ts
 * const trigger = defineStatementTrigger<DB>()(
 *   'items',
 *   {
 *     name: 'trg_audit', procedureName: 'fn_audit',
 *     timing: 'AFTER', events: ['UPDATE'],
 *     referencing: { old: 'removed', new: 'inserted' },
 *   },
 *   [modifiedTable], {},
 *   ({ db }) => {
 *     db.modified.insertFrom(['id'], db.selectFrom('inserted').select(['id']))
 *     //                                                ↑ typed as DB['items'] ✓
 *   },
 * )
 * ```
 */
export function defineStatementTrigger<TSchema extends Record<string, Record<string, unknown>>>() {
  return function <
    TTable extends keyof TSchema & string,
    TTables extends TempTableDef[] = [],
    TRefNew extends string = never,
    TRefOld extends string = never,
  >(
    table: TTable,
    options: StatementTriggerOptions<TRefNew, TRefOld>,
    tempTables: TTables,
    vars: VarDecls,
    body: (ctx: {
      sql: typeof sql
      db: DbContext<
        WithTransitionTables<TSchema, TTable, TRefNew, TRefOld>,
        TTables,
        TempTableAliasMap<TTables>
      >
    }) => void,
  ): TriggerDefinition {
    const proc = defineProcedure<WithTransitionTables<TSchema, TTable, TRefNew, TRefOld>, TTables>(
      { name: options.procedureName },
      tempTables,
      vars,
      body,
    )
    return defineTrigger(
      {
        name: options.name,
        table,
        timing: options.timing,
        events: options.events,
        forEach: 'STATEMENT',
        referencing: options.referencing
          ? { old: options.referencing.old, new: options.referencing.new }
          : undefined,
        when: options.when,
      },
      proc,
    )
  }
}

// ---------------------------------------------------------------------------
// defineTrigger  (unchanged from existing implementation)
// ---------------------------------------------------------------------------

export function defineTrigger(
  options: TriggerOptions,
  procedure: ProcedureDefinition,
): TriggerDefinition {
  return {
    _tag: 'Trigger',
    name: options.name,
    table: options.table,
    timing: options.timing,
    events: options.events,
    forEach: options.forEach ?? 'ROW',
    when: options.when,
    referencing: options.referencing,
    columns: options.columns,
    procedure,
  }
}

// ---------------------------------------------------------------------------
// defineRowTrigger — typed NEW/OLD factory for FOR EACH ROW triggers
// ---------------------------------------------------------------------------

/**
 * Context passed to the body of a FOR EACH ROW trigger or procedure.
 *
 * `NEW` and `OLD` are always present as typed proxies (they compile to
 * `NEW."col"` / `OLD."col"` in PL/pgSQL). PostgreSQL sets them to NULL for
 * events that don't populate them, but you should access them only inside the
 * appropriate `whenInsert` / `whenUpdate` / `whenDelete` scope.
 *
 * `whenInsert`, `whenUpdate`, `whenDelete` generate `IF TG_OP = '...' THEN`
 * blocks. Inside each callback, TypeScript guarantees the right refs are
 * non-null. Code outside these blocks runs unconditionally regardless of event.
 *
 * ```ts
 * defineRowTrigger<DB>()('items', opts, [modifiedTable], {}, ({ db, whenInsert, whenUpdate, whenDelete }) => {
 *   // Event-specific: insert into temp table based on operation
 *   whenInsert(({ NEW }) => db.modified.insert({ itemId: NEW.id }))
 *   whenUpdate(({ NEW, OLD }) => db.modified.insert({ itemId: NEW.id }))
 *   whenDelete(({ OLD }) => db.modified.insert({ itemId: OLD.id }))
 *
 *   // Unified processing — runs after the event-specific block
 *   db.if(db.modified.notExists(), () => { db.return(sql`NULL`) })
 *   db.return(sql`NULL`)
 * })
 * ```
 */
export interface RowBodyContext<
  TRow,
  TDB extends Record<string, Record<string, unknown>>,
  TTables extends TempTableDef[],
> {
  sql: typeof sql
  db: DbContext<TDB, TTables, TempTableAliasMap<TTables>>
  /** NEW row proxy — use inside whenNew / whenInsert / whenUpdate. */
  NEW: TypedRowRef<TRow>
  /** OLD row proxy — use inside whenOld / whenUpdate / whenDelete. */
  OLD: TypedRowRef<TRow>

  /**
   * `IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE'` — fires whenever NEW is non-null.
   * Avoids duplicating NEW-handling logic between whenInsert and whenUpdate.
   */
  whenNew(cb: (ctx: { NEW: TypedRowRef<TRow> }) => void): void
  /**
   * `IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE'` — fires whenever OLD is non-null.
   * Avoids duplicating OLD-handling logic between whenUpdate and whenDelete.
   */
  whenOld(cb: (ctx: { OLD: TypedRowRef<TRow> }) => void): void

  /** `IF TG_OP = 'INSERT'` — NEW guaranteed non-null, OLD is NULL. */
  whenInsert(cb: (ctx: { NEW: TypedRowRef<TRow> }) => void): void
  /** `IF TG_OP = 'UPDATE'` — both NEW and OLD guaranteed non-null. */
  whenUpdate(cb: (ctx: { NEW: TypedRowRef<TRow>; OLD: TypedRowRef<TRow> }) => void): void
  /** `IF TG_OP = 'DELETE'` — OLD guaranteed non-null, NEW is NULL. */
  whenDelete(cb: (ctx: { OLD: TypedRowRef<TRow> }) => void): void
}

/** @internal Creates the ProcedureCallback from a RowBodyContext body function. */
export function makeRowBodyCallback<TRow, TDB extends Record<string, Record<string, unknown>>, TTables extends TempTableDef[]>(
  body: (ctx: RowBodyContext<TRow, TDB, TTables>) => void,
  newRef: TypedRowRef<TRow>,
  oldRef: TypedRowRef<TRow>,
): ProcedureCallback<TDB, TTables> {
  return ({ sql: s, db }) => {
    body({
      sql: s,
      db,
      NEW: newRef,
      OLD: oldRef,
      whenNew(cb)    { db.if(sql.raw("TG_OP = 'INSERT' OR TG_OP = 'UPDATE'"), () => cb({ NEW: newRef })) },
      whenOld(cb)    { db.if(sql.raw("TG_OP = 'UPDATE' OR TG_OP = 'DELETE'"), () => cb({ OLD: oldRef })) },
      whenInsert(cb) { db.if(sql.raw("TG_OP = 'INSERT'"), () => cb({ NEW: newRef })) },
      whenUpdate(cb) { db.if(sql.raw("TG_OP = 'UPDATE'"), () => cb({ NEW: newRef, OLD: oldRef })) },
      whenDelete(cb) { db.if(sql.raw("TG_OP = 'DELETE'"), () => cb({ OLD: oldRef })) },
    })
  }
}

/** Options for defineRowTrigger — table is a separate first arg for schema-based type inference. */
export interface RowTriggerOptions<TEvents extends readonly TriggerEvent[] = readonly TriggerEvent[]> {
  name: string
  procedureName: string
  timing: TriggerTiming
  /** Pass `as const` for event-conditional typing of NEW/OLD */
  events: TEvents
  when?: SqlFragment
  columns?: string[]
}

/**
 * Factory for FOR EACH ROW triggers with full schema-based type safety.
 *
 * The first generic is your DB schema map (table name → row type). The table
 * name is the first argument and acts as both the SQL table name and the key to
 * look up the row type — eliminating duplication between `<RowType>` and the
 * `table` string.
 *
 * ```ts
 * type DB = { items: { id: string; label: string; score: number } }
 *
 * const trigger = defineRowTrigger<DB>()(
 *   'items',                                       // table — deduces row type from DB
 *   { name: 'trg_score', procedureName: 'fn_score', timing: 'BEFORE', events: ['INSERT'] as const },
 *   [],   // temp tables
 *   {},   // vars
 *   ({ db, NEW }) => {
 *     db.set(NEW.score, sql`char_length(${NEW.label}) * 10`)
 *     db.return(NEW)
 *   },
 * )
 * ```
 *
 * With `as const` on events: NEW available for INSERT/UPDATE, OLD for UPDATE/DELETE.
 */
export function defineRowTrigger<TSchema extends Record<string, Record<string, unknown>>>() {
  return function <
    TTable extends keyof TSchema & string,
    TTables extends TempTableDef[] = [],
    const TEvents extends readonly TriggerEvent[] = readonly TriggerEvent[],
  >(
    table: TTable,
    options: RowTriggerOptions<TEvents>,
    tempTables: TTables,
    vars: VarDecls,
    body: (ctx: RowBodyContext<TSchema[TTable], TSchema, TTables>) => void,
  ): TriggerDefinition {
    const proc = defineProcedure<TSchema, TTables>(
      { name: options.procedureName },
      tempTables,
      vars,
      makeRowBodyCallback(body, makeTypedRowRef<TSchema[TTable]>('NEW'), makeTypedRowRef<TSchema[TTable]>('OLD')),
    )
    return defineTrigger(
      {
        name: options.name,
        table,
        timing: options.timing,
        events: [...options.events] as TriggerEvent[],
        forEach: 'ROW',
        when: options.when,
        columns: options.columns,
      },
      proc,
    )
  }
}

/**
 * 2-step variant: create only the PL/pgSQL function (no trigger DDL).
 * Use when the same function is shared across multiple triggers, or when you
 * need the procedure name defined separately before attaching a trigger.
 *
 * Both NEW and OLD are always available in the body — the trigger's events
 * determine which row ref PostgreSQL actually populates at runtime.
 *
 * ```ts
 * const proc = defineRowProcedure<DB>()('items', { name: 'fn_score' }, [], {}, ({ NEW }) => {
 *   db.set(NEW.score, sql`char_length(${NEW.label}) * 10`)
 *   db.return(NEW)
 * })
 *
 * const trigger = defineTrigger({
 *   name: 'trg_score', table: 'items', timing: 'BEFORE',
 *   events: ['INSERT'], forEach: 'ROW',
 * }, proc)
 * ```
 */
/**
 * Options for defineRowProcedure.
 * `events` is optional — used only for TypeScript typing of NEW/OLD availability.
 * The actual trigger events are set when `defineTrigger` is called.
 */
export interface RowProcedureOptions<TEvents extends readonly TriggerEvent[] = readonly TriggerEvent[]>
  extends ProcedureOptions {
  /**
   * Pass `as const` to constrain NEW/OLD availability in the body:
   * - INSERT or UPDATE → NEW is available
   * - UPDATE or DELETE → OLD is available
   * When omitted, both NEW and OLD are available (safe default for reusable procs).
   */
  events?: TEvents
}

// ---------------------------------------------------------------------------
// defineStatementProcedure
// ---------------------------------------------------------------------------

/**
 * 2-step variant of `defineStatementTrigger`: define only the PL/pgSQL function
 * body with typed transition tables, then attach it with `defineTrigger`.
 *
 * The `referencing` field is used **only for TypeScript typing** — it adds the
 * transition table names to `ExtendedDB` so `db.selectFrom('inserted')` is
 * type-checked as `DB[table]`. The SQL function itself carries no REFERENCING
 * clause; that belongs to the `defineTrigger` call.
 *
 * ```ts
 * const auditProc = defineStatementProcedure<DB>()(
 *   'items',
 *   { name: 'fn_audit', referencing: { old: 'removed', new: 'inserted' } },
 *   [changedRows], {},
 *   ({ db }) => {
 *     db.selectFrom('inserted')  // typed as DB['items'] ✓
 *     db.cr.insertFrom(...)
 *   },
 * )
 *
 * const trigger = defineTrigger({
 *   name: 'trg_audit', table: 'items', timing: 'AFTER', events: ['UPDATE'],
 *   forEach: 'STATEMENT', referencing: { old: 'removed', new: 'inserted' },
 * }, auditProc)
 * ```
 */
export function defineStatementProcedure<TSchema extends Record<string, Record<string, unknown>>>() {
  return function <
    TTable extends keyof TSchema & string,
    TTables extends TempTableDef[] = [],
    TRefNew extends string = never,
    TRefOld extends string = never,
  >(
    _table: TTable,   // used only for type inference — not emitted in SQL
    options: ProcedureOptions & {
      /** Names used in the REFERENCING clause — typed only, not in the SQL function. */
      referencing?: { new?: TRefNew; old?: TRefOld }
    },
    tempTables: TTables,
    vars: VarDecls,
    body: (ctx: {
      sql: typeof sql
      db: DbContext<
        WithTransitionTables<TSchema, TTable, TRefNew, TRefOld>,
        TTables,
        TempTableAliasMap<TTables>
      >
    }) => void,
  ): ProcedureDefinition {
    return defineProcedure<WithTransitionTables<TSchema, TTable, TRefNew, TRefOld>, TTables>(
      options,
      tempTables,
      vars,
      body,
    )
  }
}

// ---------------------------------------------------------------------------
// defineRowProcedure
// ---------------------------------------------------------------------------

export function defineRowProcedure<TSchema extends Record<string, Record<string, unknown>>>() {
  return function <
    TTable extends keyof TSchema & string,
    TTables extends TempTableDef[] = [],
  >(
    _table: TTable,   // used only for type inference — not emitted in SQL
    options: ProcedureOptions,
    tempTables: TTables,
    vars: VarDecls,
    body: (ctx: RowBodyContext<TSchema[TTable], TSchema, TTables>) => void,
  ): ProcedureDefinition {
    return defineProcedure<TSchema, TTables>(
      options,
      tempTables,
      vars,
      makeRowBodyCallback(body, makeTypedRowRef<TSchema[TTable]>('NEW'), makeTypedRowRef<TSchema[TTable]>('OLD')),
    )
  }
}
