import type { KppBlock, KppDownBlock } from './types.js'

const BEGIN_RE = new RegExp(
  '^--\\s*\\[KPP:BEGIN\\s+name="([^"]+)"\\s+kind="([^"]+)"\\s+hash="([^"]+)"\\]\\s*$'
)
const END_RE = new RegExp('^--\\s*\\[KPP:END\\s+name="([^"]+)"\\]\\s*$')
const DOWN_BEGIN_RE = new RegExp('^--\\s*\\[KPP:DOWN:BEGIN\\s+name="([^"]+)"\\]\\s*$')
const DOWN_END_RE = new RegExp('^--\\s*\\[KPP:DOWN:END\\s+name="([^"]+)"\\]\\s*$')

export function parseKppBlocks(fileContent: string, migrationFile: string): KppBlock[] {
  const lines = fileContent.split('\n')
  const blocks: KppBlock[] = []

  let current: { name: string; kind: 'function' | 'trigger' | 'rls-enable' | 'rls-policy'; hash: string; lines: string[] } | null = null

  for (const line of lines) {
    if (current === null) {
      const beginMatch = BEGIN_RE.exec(line)
      if (beginMatch) {
        current = {
          name: beginMatch[1]!,
          kind: beginMatch[2] as 'function' | 'trigger' | 'rls-enable' | 'rls-policy',
          hash: beginMatch[3]!,
          lines: [],
        }
      }
    } else {
      const endMatch = END_RE.exec(line)
      if (endMatch && endMatch[1] === current.name) {
        blocks.push({
          name: current.name,
          kind: current.kind,
          hash: current.hash,
          content: current.lines.join('\n').trim(),
          migrationFile,
        })
        current = null
      } else {
        current.lines.push(line)
      }
    }
  }

  return blocks
}

export function parseKppDownBlocks(fileContent: string, migrationFile: string): KppDownBlock[] {
  const lines = fileContent.split('\n')
  const blocks: KppDownBlock[] = []

  let current: { name: string; lines: string[] } | null = null

  for (const line of lines) {
    if (current === null) {
      const beginMatch = DOWN_BEGIN_RE.exec(line)
      if (beginMatch) {
        current = {
          name: beginMatch[1]!,
          lines: [],
        }
      }
    } else {
      const endMatch = DOWN_END_RE.exec(line)
      if (endMatch && endMatch[1] === current.name) {
        blocks.push({
          name: current.name,
          content: current.lines.join('\n').trim(),
          migrationFile,
        })
        current = null
      } else {
        current.lines.push(line)
      }
    }
  }

  return blocks
}

export function generateKppUpBlock(name: string, kind: string, hash: string, sql: string): string {
  return [
    `-- [KPP:BEGIN name="${name}" kind="${kind}" hash="${hash}"]`,
    sql,
    `-- [KPP:END name="${name}"]`,
  ].join('\n')
}

export function generateKppDownBlock(name: string, sql: string): string {
  return [
    `-- [KPP:DOWN:BEGIN name="${name}"]`,
    sql,
    `-- [KPP:DOWN:END name="${name}"]`,
  ].join('\n')
}
