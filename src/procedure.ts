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

export type ProcedureCallback<TTables extends TempTableDef[] = []> = (ctx: {
  sql: typeof sql
  db: DbContext<TempTableAliasMap<TTables>>
}) => void

export interface ProcedureOptions {
  name: string
  language?: string
  returns?: string
  volatility?: Volatility
  security?: SecurityMode
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
  readonly language: string
  readonly returns: string
  readonly volatility?: Volatility
  readonly security?: SecurityMode
  readonly tempTables: TempTableDef[]
  readonly vars: VarDecls
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly body: ProcedureCallback<any>   // erased: any bypasses contra-variance at storage site
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

export function defineProcedure<TTables extends TempTableDef[] = []>(
  options: ProcedureOptions,
  tempTables: TTables,
  vars: VarDecls,
  body: ProcedureCallback<TTables>,
): ProcedureDefinition {
  return {
    _tag: 'Procedure',
    name: options.name,
    language: options.language ?? 'plpgsql',
    returns: options.returns ?? 'TRIGGER',
    volatility: options.volatility,
    security: options.security,
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
 * Conditional row-ref availability based on trigger events:
 * - INSERT or UPDATE → NEW is available
 * - UPDATE or DELETE → OLD is available
 */
type RowRefs<TRow, TEvents extends readonly TriggerEvent[]> =
  ([Extract<TEvents[number], 'INSERT' | 'UPDATE'>] extends [never] ? unknown : { NEW: TypedRowRef<TRow> }) &
  ([Extract<TEvents[number], 'UPDATE' | 'DELETE'>] extends [never] ? unknown : { OLD: TypedRowRef<TRow> })

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
export function defineRowTrigger<TSchema extends Record<string, unknown>>() {
  return function <
    TTable extends keyof TSchema & string,
    TTables extends TempTableDef[] = [],
    const TEvents extends readonly TriggerEvent[] = readonly TriggerEvent[],
  >(
    table: TTable,
    options: RowTriggerOptions<TEvents>,
    tempTables: TTables,
    vars: VarDecls,
    body: (
      ctx: { sql: typeof sql; db: DbContext<TempTableAliasMap<TTables>> } & RowRefs<TSchema[TTable], TEvents>,
    ) => void,
  ): TriggerDefinition {
    const proc = defineProcedure(
      { name: options.procedureName },
      tempTables,
      vars,
      ({ sql: s, db }) => {
        const NEW = makeTypedRowRef<TSchema[TTable]>('NEW')
        const OLD = makeTypedRowRef<TSchema[TTable]>('OLD')
        body({ sql: s, db, NEW, OLD } as Parameters<typeof body>[0])
      },
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
export function defineRowProcedure<TSchema extends Record<string, unknown>>() {
  return function <
    TTable extends keyof TSchema & string,
    TTables extends TempTableDef[] = [],
  >(
    _table: TTable,   // used only for type inference — not emitted in SQL
    options: ProcedureOptions,
    tempTables: TTables,
    vars: VarDecls,
    body: (ctx: {
      sql: typeof sql
      db: DbContext<TempTableAliasMap<TTables>>
      NEW: TypedRowRef<TSchema[TTable]>
      OLD: TypedRowRef<TSchema[TTable]>
    }) => void,
  ): ProcedureDefinition {
    return defineProcedure(
      options,
      tempTables,
      vars,
      ({ sql: s, db }) => {
        const NEW = makeTypedRowRef<TSchema[TTable]>('NEW')
        const OLD = makeTypedRowRef<TSchema[TTable]>('OLD')
        body({ sql: s, db, NEW, OLD })
      },
    )
  }
}
