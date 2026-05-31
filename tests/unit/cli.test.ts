import { describe, expect, it } from 'vitest'
import { hashMatches, hashSql } from '../../src/cli/hash.js'
import {
  generateKppDownBlock,
  generateKppUpBlock,
  parseKppBlocks,
  parseKppDownBlocks,
} from '../../src/cli/kpp.js'

describe('hashSql', () => {
  it('same SQL with different whitespace produces the same hash', () => {
    const a = 'CREATE FUNCTION foo() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;'
    const b = 'CREATE   FUNCTION  foo()   RETURNS void  AS $$  BEGIN   END   $$  LANGUAGE  plpgsql;'
    expect(hashSql(a)).toBe(hashSql(b))
  })

  it('different SQL produces different hashes', () => {
    const a = 'CREATE FUNCTION foo() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;'
    const b = 'CREATE FUNCTION bar() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;'
    expect(hashSql(a)).not.toBe(hashSql(b))
  })
})

describe('hashMatches', () => {
  it('returns true when SQL matches the stored hash', () => {
    const sql = 'SELECT 1;'
    const hash = hashSql(sql)
    expect(hashMatches(sql, hash)).toBe(true)
  })

  it('returns false when SQL does not match the stored hash', () => {
    const sql = 'SELECT 1;'
    const otherHash = hashSql('SELECT 2;')
    expect(hashMatches(sql, otherHash)).toBe(false)
  })
})

describe('parseKppBlocks', () => {
  it('parses a single block and returns the correct fields', () => {
    const hash = hashSql('CREATE FUNCTION foo() RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;')
    const content = `-- [KPP:BEGIN name="foo" kind="function" hash="${hash}"]
CREATE FUNCTION foo() RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
-- [KPP:END name="foo"]`

    const blocks = parseKppBlocks(content, 'migration.ts')
    expect(blocks).toHaveLength(1)
    const block = blocks[0]!
    expect(block.name).toBe('foo')
    expect(block.kind).toBe('function')
    expect(block.hash).toBe(hash)
    expect(block.content).toContain('CREATE FUNCTION foo()')
    expect(block.migrationFile).toBe('migration.ts')
  })

  it('parses two blocks and returns both', () => {
    const hashFoo = hashSql('CREATE FUNCTION foo() RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;')
    const hashBar = hashSql('CREATE TRIGGER bar AFTER INSERT ON "users" FOR EACH ROW EXECUTE FUNCTION bar();')
    const content = `-- [KPP:BEGIN name="foo" kind="function" hash="${hashFoo}"]
CREATE FUNCTION foo() RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
-- [KPP:END name="foo"]

-- [KPP:BEGIN name="bar" kind="trigger" hash="${hashBar}"]
CREATE TRIGGER bar AFTER INSERT ON "users" FOR EACH ROW EXECUTE FUNCTION bar();
-- [KPP:END name="bar"]`

    const blocks = parseKppBlocks(content, 'migration.ts')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.name).toBe('foo')
    expect(blocks[1]!.name).toBe('bar')
  })

  it('returns an empty array when there are no KPP markers', () => {
    const content = `import type { Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // nothing here
}`
    const blocks = parseKppBlocks(content, 'migration.ts')
    expect(blocks).toHaveLength(0)
  })
})

describe('parseKppDownBlocks', () => {
  it('parses a single down block and returns the correct fields', () => {
    const content = `-- [KPP:DOWN:BEGIN name="foo"]
DROP FUNCTION IF EXISTS foo();
-- [KPP:DOWN:END name="foo"]`

    const blocks = parseKppDownBlocks(content, 'migration.ts')
    expect(blocks).toHaveLength(1)
    const block = blocks[0]!
    expect(block.name).toBe('foo')
    expect(block.content).toContain('DROP FUNCTION IF EXISTS foo()')
    expect(block.migrationFile).toBe('migration.ts')
  })
})

describe('generateKppUpBlock', () => {
  it('contains BEGIN and END markers with the correct attributes', () => {
    const sql = 'CREATE FUNCTION foo() RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;'
    const hash = hashSql(sql)
    const block = generateKppUpBlock('foo', 'function', hash, sql)

    expect(block).toContain(`-- [KPP:BEGIN name="foo" kind="function" hash="${hash}"]`)
    expect(block).toContain(`-- [KPP:END name="foo"]`)
    expect(block).toContain(sql)
  })
})

describe('generateKppDownBlock', () => {
  it('contains DOWN:BEGIN and DOWN:END markers', () => {
    const sql = 'DROP FUNCTION IF EXISTS foo();'
    const block = generateKppDownBlock('foo', sql)

    expect(block).toContain('-- [KPP:DOWN:BEGIN name="foo"]')
    expect(block).toContain('-- [KPP:DOWN:END name="foo"]')
    expect(block).toContain(sql)
  })
})

describe('round-trip', () => {
  it('generateKppUpBlock → parseKppBlocks → same name/hash/content', () => {
    const sql = 'CREATE FUNCTION my_proc() RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;'
    const hash = hashSql(sql)
    const block = generateKppUpBlock('my_proc', 'function', hash, sql)

    const parsed = parseKppBlocks(block, 'generated.ts')
    expect(parsed).toHaveLength(1)
    const entry = parsed[0]!
    expect(entry.name).toBe('my_proc')
    expect(entry.hash).toBe(hash)
    expect(entry.content).toBe(sql)
  })
})
