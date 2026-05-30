import type { SqlFragment } from './types.js'

export function sql(
  strings: TemplateStringsArray,
  ...values: (SqlFragment | string | number | boolean)[]
): SqlFragment {
  let result = ''
  for (let i = 0; i < strings.length; i++) {
    result += strings[i]
    if (i < values.length) {
      const v = values[i]
      result += typeof v === 'object' && v._tag === 'sql' ? v.text : String(v)
    }
  }
  return { _tag: 'sql', text: result }
}

sql.raw = (text: string): SqlFragment => ({ _tag: 'sql', text })

sql.ident = (name: string): SqlFragment => ({
  _tag: 'sql',
  text: `"${name.replace(/"/g, '""')}"`,
})
