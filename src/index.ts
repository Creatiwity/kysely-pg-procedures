export { sql } from './sql.js'

export { defineTempTable } from './tempTable.js'
export type { TempTableHelper, TempTableMap, TempTableAliasMap, TempTableKey, TempTableRow, TempTableDbExt, ColumnDefToTs, ColumnTypeToTs } from './tempTable.js'

export { defineProcedure, defineTrigger, defineRowTrigger, defineRowProcedure, defineStatementProcedure, defineStatementTrigger } from './procedure.js'
export type {
  ProcedureDefinition,
  TriggerDefinition,
  ProcedureOptions,
  RowBodyContext,
  TriggerOptions,
  RowTriggerOptions,
  RowProcedureOptions,
  StatementTriggerOptions,
  WithTransitionTables,
  ProcedureCallback,
} from './procedure.js'

export { compileProcedure, compileTrigger, compileAll, snapshotSetupSql } from './compiler.js'
export type { CompileOpts } from './compiler.js'

export { logSetupSql } from './log-setup.js'

export {
  defineSessionVars,
  enableRls,
  definePolicy,
  compileRlsEnable,
  compilePolicyBlock,
} from './rls.js'
export type {
  SessionVarDefs,
  SessionVarType,
  SessionVarsDef,
  RlsEnableOpts,
  RlsEnableDef,
  PolicyCommand,
  PolicyPermissiveness,
  PolicyOpts,
  PolicyDef,
  PolicyBodyCtx,
  SessionProxy,
} from './rls.js'

export { createProcLogListener } from './notify-listener.js'
export type { ProcLogEntry, ProcLogStep } from './notify-listener.js'

// Optional OpenTelemetry integration — requires @opentelemetry/api
// npm install @opentelemetry/api
export { createOtelProcSpanEmitter, KyselyOtelPlugin } from './otel.js'
export type { OtelProcSpanEmitterOpts, KyselyOtelPluginOpts } from './otel.js'

export { compileDb, toSqlFragment, extractFromClause, extractSelectList, isCompilable } from './kysely-compile.js'
export type { Compilable } from './kysely-compile.js'

// Kysely's own sql tag — use this inside query builders (.where, .select, .orderBy, etc.)
// Our `sql` is for statement fragments (db.set, db.return, db.execute values).
export { sql as ksql } from 'kysely'

export type { ColumnRef, RowProxy, TypedRowRef, DbContext, ExtendedDB, IfCondition } from './db-context.js'
export { makeTypedRowRef } from './db-context.js'

export { withProcDB } from './proc-db.js'

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
