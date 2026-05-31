import { resolve } from 'node:path'
import type { ProcConfig } from './types.js'

const defaults: ProcConfig = {
  procedures: ['src/procedures/**/*.ts'],
  manifest: 'kysely-procedures.json',
  migrations: 'migrations/',
}

export async function loadConfig(configPath?: string): Promise<ProcConfig> {
  const target = configPath ?? 'kpp.config.ts'
  const absolute = resolve(process.cwd(), target)
  const mod = await import(absolute)
  const userConfig: Partial<ProcConfig> = mod.default ?? {}
  return { ...defaults, ...userConfig }
}
