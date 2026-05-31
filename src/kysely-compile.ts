import {
  Kysely,
  DummyDriver,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  createQueryId,
} from 'kysely'
import type { RootOperationNode } from 'kysely'
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

/**
 * Converts a SqlFragment or a Compilable into a SqlFragment.
 *
 * For Compilable inputs the query is compiled and its `.sql` string is used
 * directly. Throws if the compiled query contains bound parameters — parameter
 * placeholders ($1, $2, …) cannot be embedded verbatim into PL/pgSQL source.
 */
export function toSqlFragment(query: SqlFragment | Compilable): SqlFragment {
  if (typeof query === 'object' && query !== null && '_tag' in query && query._tag === 'sql') {
    return query as SqlFragment
  }

  const compiled = (query as Compilable).compile()

  if (compiled.parameters.length > 0) {
    throw new Error(
      `toSqlFragment: compiled query contains ${compiled.parameters.length} bound parameter(s). ` +
        'Parameterised queries cannot be embedded as SQL fragments. ' +
        'Use sql.raw() or inline the values directly.',
    )
  }

  return { _tag: 'sql', text: compiled.sql }
}

/**
 * Compiles a Kysely SelectQueryBuilder and extracts only the FROM clause
 * (everything after "select ... from "), returned as a SqlFragment.
 *
 * This is useful for turning a Kysely query builder into a PL/pgSQL
 * `FOR row IN SELECT ... FROM ... LOOP` or a `SELECT INTO` source without
 * re-expressing the table / join logic as a raw string.
 *
 * Throws if the compiled query contains bound parameters (same reason as
 * toSqlFragment), or if the SQL does not contain a recognisable "from" keyword.
 */
export function extractFromClause(query: Compilable): SqlFragment {
  const compiled = query.compile()

  if (compiled.parameters.length > 0) {
    throw new Error(
      `extractFromClause: compiled query contains ${compiled.parameters.length} bound parameter(s). ` +
        'Parameterised queries cannot be embedded as SQL fragments.',
    )
  }

  // Match "select <projection> from <rest>" — case-insensitive, the projection
  // may span multiple lines so we use the 's' (dotAll) flag.
  const match = /^select\s+.+?\s+from\s+([\s\S]+)$/is.exec(compiled.sql.trim())

  if (!match || !match[1]) {
    throw new Error(
      `extractFromClause: could not find a FROM clause in the compiled SQL:\n${compiled.sql}`,
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
