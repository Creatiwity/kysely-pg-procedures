export interface KppBlock {
  name: string
  kind: 'function' | 'trigger' | 'rls-enable' | 'rls-policy'
  hash: string
  content: string
  migrationFile: string
}

export interface KppDownBlock {
  name: string
  content: string
  migrationFile: string
}

export interface ManifestEntry {
  kind: 'function' | 'trigger' | 'rls-enable' | 'rls-policy'
  hash: string
  lastChanged: string
  migrationFile: string
  conflict: boolean
  conflictingFiles?: string[]
}

export interface Manifest {
  rebuiltAt: string
  rebuiltFrom: 'migration-files'
  entries: Record<string, ManifestEntry>
}

export interface ProcConfig {
  procedures: string[]
  manifest: string
  migrations: string
}

export interface CompiledDef {
  name: string
  kind: 'function' | 'trigger' | 'rls-enable' | 'rls-policy'
  sql: string
  hash: string
}

export interface StatusEntry {
  name: string
  kind: 'function' | 'trigger' | 'rls-enable' | 'rls-policy'
  status: 'unchanged' | 'modified' | 'not-migrated' | 'orphan' | 'tampered' | 'conflict'
  sourceHash?: string
  manifestHash?: string
  migrationFile?: string
  conflictingFiles?: string[]
}
