import { createHash } from 'node:crypto'

export function hashSql(sql: string): string {
  const normalised = sql.trim().replace(/\s+/g, ' ')
  return 'sha256:' + createHash('sha256').update(normalised).digest('hex')
}

export function hashMatches(sql: string, storedHash: string): boolean {
  return hashSql(sql) === storedHash
}
