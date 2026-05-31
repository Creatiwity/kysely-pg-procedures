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
import { buildDbContext } from './db-context.js'
import type { DbContext } from './db-context.js'
import type { TempTableAliasMap } from './tempTable.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProcedureCallback<TTables extends TempTableDef[] = any[]> = (ctx: {
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
  readonly body: ProcedureCallback
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
