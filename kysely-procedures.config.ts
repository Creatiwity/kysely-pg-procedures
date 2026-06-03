import type { ProcConfig } from './src/cli/types.js'

const config: Partial<ProcConfig> = {
  procedures: ['playground/procedures.ts'],
  manifest: 'kysely-procedures.json',
  migrations: 'playground/migrations/',
  codegen: {
    // Replace with your kysely-codegen output, e.g.:
    // "import type { Database as DB } from './generated/database.js'"
    dbImport: 'type DB = { playground_items: { id: string; label: string; score: number | null; audit_flag: boolean } }',
    output: 'playground/db-proc.generated.ts',
  },
}

export default config
