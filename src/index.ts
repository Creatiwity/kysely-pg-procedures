export { sql } from './sql.js'

export { defineTempTable } from './tempTable.js'
export type { TempTableHelper, TempTableMap, TempTableAliasMap, TempTableKey } from './tempTable.js'

export { defineProcedure, defineTrigger, defineRowTrigger, defineRowProcedure } from './procedure.js'
export type {
  ProcedureDefinition,
  TriggerDefinition,
  ProcedureOptions,
  TriggerOptions,
  RowTriggerOptions,
  ProcedureCallback,
} from './procedure.js'

export { compileProcedure, compileTrigger, compileAll, snapshotSetupSql } from './compiler.js'
export type { CompileOpts } from './compiler.js'

export { logSetupSql } from './log-setup.js'

export { createProcLogListener } from './notify-listener.js'
export type { ProcLogEntry, ProcLogStep } from './notify-listener.js'

export { compileDb, toSqlFragment, extractFromClause, isCompilable } from './kysely-compile.js'
export type { Compilable } from './kysely-compile.js'

// Kysely's own sql tag — use this inside query builders (.where, .select, .orderBy, etc.)
// Our `sql` is for statement fragments (db.set, db.return, db.execute values).
export { sql as ksql } from 'kysely'

export type { ColumnRef, RowProxy, TypedRowRef, DbContext, DbSelectBuilder, IfCondition } from './db-context.js'
export { makeTypedRowRef } from './db-context.js'

export type {
  SqlFragment,
  ColumnType,
  ColumnDef,
  TempTableColumns,
  TempTableDef,
  RaiseLevel,
  TriggerTiming,
  TriggerEvent,
  TriggerForEach,
  Volatility,
  SecurityMode,
  VarDecl,
  VarDecls,
  CatchHandler,
  Statement,
} from './types.js'
