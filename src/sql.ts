import type { SqlFragment } from './types.js'
import { isCompilable, toSqlFragment } from './kysely-compile.js'
import type { Compilable } from './kysely-compile.js'

export function sql(
  strings: TemplateStringsArray,
  ...values: (SqlFragment | Compilable | string | number | boolean)[]
): SqlFragment {
  let result = ''
  for (let i = 0; i < strings.length; i++) {
    result += strings[i]
    if (i < values.length) {
      const v = values[i]
      if (typeof v === 'object' && v !== null) {
        if ('_tag' in v && (v as SqlFragment)._tag === 'sql') {
          result += (v as SqlFragment).text
        } else if (isCompilable(v)) {
          // Kysely RawBuilder or any other Compilable — compile to SQL text
          result += toSqlFragment(v).text
        } else {
          result += String(v)
        }
      } else {
        result += String(v)
      }
    }
  }
  return { _tag: 'sql', text: result }
}

sql.raw = (text: string): SqlFragment => ({ _tag: 'sql', text })

sql.ident = (name: string): SqlFragment => ({
  _tag: 'sql',
  text: `"${name.replace(/"/g, '""')}"`,
})
