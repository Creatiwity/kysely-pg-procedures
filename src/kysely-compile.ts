import {
  Kysely,
  DummyDriver,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  createQueryId,
} from 'kysely'
import type { RootOperationNode, Expression } from 'kysely'
import type { SqlFragment } from './types.js'

/**
 * A compile-only Kysely instance backed by DummyDriver and the PostgresAdapter.
 * No real database connection is made. Use this to build and compile queries at
 * module-load time (compile time) without any I/O.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const compileDb = new Kysely<any>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
})

/**
 * Anything that can be compiled down to a SQL string and a parameter list.
 * Matches the shape returned by Kysely's SelectQueryBuilder.compile() and
 * similar builders.
 */
export interface Compilable {
  compile(): { sql: string; parameters: readonly unknown[] }
}

/**
 * Returns true when `v` looks like a Compilable (has a `.compile()` method
 * that returns an object with `sql` and `parameters`).
 */
export function isCompilable(v: unknown): v is Compilable {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>)['compile'] === 'function'
  )
}

/** Format a single JS value as a PostgreSQL literal for inline embedding. */
function formatPgLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
  if (Array.isArray(value)) return `ARRAY[${value.map(formatPgLiteral).join(', ')}]`
  if (typeof value === "object" && value !== null && "_tag" in value && (value as any)._tag === "sql" && "text" in value) {
    return (value as any).text
  }
  // Date, Buffer, etc. — safe fallback
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Substitute $1, $2, … placeholders back into the SQL string as inlined literals. */
export function inlineParameters(sqlText: string, parameters: readonly unknown[]): string {
  return sqlText.replace(/\$(\d+)/g, (_, idx: string) => {
    const val = parameters[Number(idx) - 1]
    return formatPgLiteral(val)
  })
}

/**
 * Converts a SqlFragment or a Compilable into a SqlFragment.
 *
 * For Compilable inputs the query is compiled and parameters are inlined as
 * PostgreSQL literals so the result can be embedded verbatim into PL/pgSQL source.
 */
export function toSqlFragment(query: SqlFragment | Compilable): SqlFragment {
  if (typeof query === 'object' && query !== null && '_tag' in query && query._tag === 'sql') {
    return query as SqlFragment
  }

  if (isKyselyExpression(query as unknown)) { return expressionToFragment(query as unknown as Expression<any>) }

  const compiled = (query as Compilable).compile()

  return { _tag: 'sql', text: inlineParameters(compiled.sql, compiled.parameters) }
}

/**
 * Compiles a Kysely SelectQueryBuilder and extracts only the FROM clause
 * (everything after "select ... from "), returned as a SqlFragment.
 *
 * This is useful for turning a Kysely query builder into a PL/pgSQL
 * `FOR row IN SELECT ... FROM ... LOOP` or a `SELECT INTO` source without
 * re-expressing the table / join logic as a raw string.
 *
 * Throws if the SQL does not contain a recognisable "from" keyword. Parameters
 * are inlined as PostgreSQL literals before extraction.
 */
export function extractFromClause(query: Compilable): SqlFragment {
  const compiled = query.compile()

  const inlinedSql = inlineParameters(compiled.sql, compiled.parameters)
  const match = /^select\s+.+?\s+from\s+([\s\S]+)$/is.exec(inlinedSql.trim())

  if (!match || !match[1]) {
    throw new Error(
      `extractFromClause: could not find a FROM clause in the compiled SQL:\n${inlinedSql}`,
    )
  }

  return { _tag: 'sql', text: match[1].trim() }
}

/**
 * Compile a Kysely RootOperationNode to SQL using PostgresQueryCompiler.
 * Used by KyselyOtelPlugin to get the SQL statement for span attributes.
 * PostgresQueryCompiler is not in Kysely's public type exports so we expose
 * it via this helper rather than importing it directly in otel.ts.
 */
export function compileNode(node: RootOperationNode): { sql: string; parameters: readonly unknown[] } {
  // createQueryId() generates a fresh UUID — required by compileQuery signature
  // but only used for query correlation, not for the SQL output itself
  return new PostgresQueryCompiler().compileQuery(node, createQueryId())
}

/**
 * Returns true when v is a Kysely Expression (has expressionType phantom + toOperationNode()).
 * These are returned by jsonBuildObject(), eb helpers, etc. — they are NOT Compilable
 * (no standalone .compile() method) and require special handling.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isKyselyExpression(v: unknown): v is Expression<any> {
  return (
    typeof v === 'object' &&
    v !== null &&
    'expressionType' in v &&
    typeof (v as { toOperationNode?: unknown }).toOperationNode === 'function'
  )
}

/**
 * Compiles a Kysely Expression (jsonBuildObject, eb helpers, …) to a SqlFragment
 * by wrapping it in a minimal SelectQueryNode and stripping the leading "select ".
 * Parameters ($1, $2, …) are inlined as PostgreSQL literals.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function expressionToFragment(expr: Expression<any>): SqlFragment {
  const exprNode = expr.toOperationNode()
  const compiled = compileNode({
    kind: 'SelectQueryNode',
    selections: [{ kind: 'SelectionNode', selection: exprNode }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  // Strip leading "select " to get just the expression SQL
  const exprSql = compiled.sql.replace(/^select\s+/i, '').trim()
  return { _tag: 'sql', text: inlineParameters(exprSql, compiled.parameters) }
}
