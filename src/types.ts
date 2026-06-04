export type SqlFragment = { readonly _tag: 'sql'; readonly text: string }

export type ColumnType =
  | 'uuid'
  | 'text'
  | 'varchar'
  | 'integer'
  | 'bigint'
  | 'smallint'
  | 'numeric'
  | 'decimal'
  | 'real'
  | 'float'
  | 'boolean'
  | 'timestamptz'
  | 'timestamp'
  | 'date'
  | 'time'
  | 'jsonb'
  | 'json'
  | 'bytea'

export type ColumnDef = ColumnType | { type: ColumnType; nullable?: boolean; default?: string }

export type TempTableColumns = Record<string, ColumnDef>

export interface TempTableDef<
  TName extends string = string,
  TCols extends TempTableColumns = TempTableColumns,
  TAs extends string | undefined = string | undefined,
> {
  readonly _tag: 'TempTable'
  readonly name: TName
  readonly columns: TCols
  /** Always set. undefined when no alias was provided, a string literal when { as: 'alias' } was passed. */
  readonly as: TAs
}

export type RaiseLevel = 'DEBUG' | 'LOG' | 'INFO' | 'NOTICE' | 'WARNING' | 'EXCEPTION'
export type TriggerTiming = 'BEFORE' | 'AFTER' | 'INSTEAD OF'
export type TriggerEvent = 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE'
export type TriggerForEach = 'ROW' | 'STATEMENT'
export type Volatility = 'VOLATILE' | 'STABLE' | 'IMMUTABLE'
export type SecurityMode = 'INVOKER' | 'DEFINER'

export type VarDecl = ColumnType | { type: ColumnType; default?: string } | { raw: string; default?: string }
export type VarDecls = Record<string, VarDecl>

export type CatchHandler = { when: string | string[]; then: Statement[] }

export type Statement =
  | { kind: 'vars'; decls: VarDecls }
  | { kind: 'set'; target: string; value: SqlFragment }
  | { kind: 'if'; condition: SqlFragment; then: Statement[]; else?: Statement[] }
  | { kind: 'branch'; branches: Array<{ when: SqlFragment; then: Statement[] }>; else?: Statement[] }
  | { kind: 'case'; expr: SqlFragment; branches: Array<[string, Statement[]]>; else?: Statement[] }
  | { kind: 'selectInto'; vars: Record<string, SqlFragment>; from: SqlFragment; strict?: boolean; label?: string }
  | { kind: 'forRow'; rowVar: string; query: SqlFragment; body: Statement[] }
  | { kind: 'forIn'; var: string; from: SqlFragment; to: SqlFragment; body: Statement[] }
  | { kind: 'while'; condition: SqlFragment; body: Statement[] }
  | { kind: 'loop'; body: Statement[] }
  | { kind: 'exit'; when?: SqlFragment }
  | { kind: 'continue'; when?: SqlFragment }
  | { kind: 'return'; value?: SqlFragment }
  | { kind: 'raise'; level: RaiseLevel; message: string; args?: SqlFragment[]; errcode?: string; hint?: string; detail?: string }
  | { kind: 'perform'; query: SqlFragment }
  | { kind: 'raw'; sql: SqlFragment; label?: string }
  | { kind: 'catch'; handlers: CatchHandler[] }
  | { kind: 'tempInsert'; table: TempTableDef; values: Record<string, SqlFragment>; label?: string }
  | { kind: 'tempInsertFrom'; table: TempTableDef; columns: string[]; query: SqlFragment; label?: string }
  | { kind: 'tempDelete'; table: TempTableDef; where?: SqlFragment; label?: string }
  | { kind: 'snapshot'; label: string }
