import type { TempTableColumns, TempTableDef, SqlFragment, Statement } from './types.js'
import { sql } from './sql.js'
import { isCompilable, toSqlFragment } from './kysely-compile.js'
import type { Compilable } from './kysely-compile.js'

export interface TempTableHelper<TCols extends TempTableColumns = TempTableColumns> {
  readonly name: string
  readonly ref: SqlFragment
  readonly instanceFilter: SqlFragment
  insert(values: { [K in keyof TCols]?: SqlFragment }): Statement
  insertFrom(columns: ReadonlyArray<string & keyof TCols>, query: SqlFragment | Compilable, opts?: { label?: string }): Statement
  delete(where?: SqlFragment): Statement
  exists(where?: SqlFragment): SqlFragment
  notExists(where?: SqlFragment): SqlFragment
  filter(alias: string): SqlFragment
}

export function defineTempTable<TName extends string, TCols extends TempTableColumns>(
  name: TName,
  columns: TCols,
  opts?: { as?: string },
): TempTableDef<TName, TCols> {
  return { _tag: 'TempTable', name, columns, as: opts?.as }
}

export function buildTempTableHelper<T extends TempTableDef>(def: T): TempTableHelper<T['columns']> {
  const tableRef = sql.ident(def.name)
  const instanceFilter = sql.raw('"_proc_instance_id" = _proc_instance_id')

  return {
    name: def.name,
    ref: tableRef,
    instanceFilter,

    filter(alias: string): SqlFragment {
      return sql.raw(`${alias}."_proc_instance_id" = _proc_instance_id`)
    },

    insert(values): Statement {
      return { kind: 'tempInsert', table: def, values: values as Record<string, SqlFragment> }
    },

    insertFrom(columns, query, opts): Statement {
      const fragment = isCompilable(query) ? toSqlFragment(query) : query
      return { kind: 'tempInsertFrom', table: def, columns: [...columns] as string[], query: fragment, label: opts?.label }
    },

    delete(where): Statement {
      return { kind: 'tempDelete', table: def, where }
    },

    exists(where): SqlFragment {
      const base = sql.raw(`t."_proc_instance_id" = _proc_instance_id`)
      const whereClause = where ? sql`${base} AND ${where}` : base
      return sql`EXISTS (SELECT FROM ${tableRef} AS t WHERE ${whereClause})`
    },

    notExists(where): SqlFragment {
      const base = sql.raw(`t."_proc_instance_id" = _proc_instance_id`)
      const whereClause = where ? sql`${base} AND ${where}` : base
      return sql`NOT EXISTS (SELECT FROM ${tableRef} AS t WHERE ${whereClause})`
    },
  }
}

export type TempTableMap<TTables extends TempTableDef[]> = {
  [K in TTables[number] as K['name']]: TempTableHelper<
    Extract<TTables[number], { name: K['name'] }>['columns']
  >
}

// Key used to access a temp table in the db context: alias if defined, else name.
export type TempTableKey<T extends TempTableDef> = T['as'] extends string ? T['as'] : T['name']

// Maps each temp table to its TempTableHelper, keyed by alias (or name as fallback).
// This is the type added to DbContext via generics so db.myAlias is fully typed.
export type TempTableAliasMap<TTables extends TempTableDef[]> = {
  [K in TTables[number] as TempTableKey<K>]: TempTableHelper<K['columns']>
}

export function buildTempTableMap<TTables extends TempTableDef[]>(
  tables: TTables,
): TempTableMap<TTables> {
  const result: Record<string, TempTableHelper> = {}
  for (const table of tables) {
    result[table.name] = buildTempTableHelper(table)
  }
  return result as TempTableMap<TTables>
}

/**
 * Same as buildTempTableMap but keyed by table.as ?? table.name.
 * Used by DbContext to expose temp table helpers as db[alias].
 */
export function buildTempTableAliasMap(tables: TempTableDef[]): Record<string, TempTableHelper> {
  const result: Record<string, TempTableHelper> = {}
  for (const table of tables) {
    const key = table.as ?? table.name
    result[key] = buildTempTableHelper(table)
  }
  return result
}
