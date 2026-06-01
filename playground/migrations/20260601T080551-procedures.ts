import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// [KPP:META generated="2026-06-01T08:05:51.849Z" changes="policy:playground_items_tenant_isolation(new),rls:playground_items(new)"]

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
-- [KPP:BEGIN name="rls:playground_items" kind="rls-enable" hash="sha256:27c24cde9221cca5815e8c880747696a9a292fa51ee18fbdd8f5578165c0cef8"]
ALTER TABLE "playground_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "playground_items" FORCE ROW LEVEL SECURITY;
-- [KPP:END name="rls:playground_items"]

-- [KPP:BEGIN name="policy:playground_items_tenant_isolation" kind="rls-policy" hash="sha256:c1836daa39be6b8a4465a149854e81147fd854f0e7895e3bea1957bffd4687aa"]
DROP POLICY IF EXISTS "playground_items_tenant_isolation" ON "playground_items";
CREATE POLICY "playground_items_tenant_isolation" ON "playground_items" AS PERMISSIVE FOR ALL TO app_user
    USING ("id" IS NOT NULL AND "score" >= 0 AND current_setting('app.orgId', true)::uuid IS NOT NULL)
    WITH CHECK (current_setting('app.orgId', true)::uuid IS NOT NULL)
;
-- [KPP:END name="policy:playground_items_tenant_isolation"]
  `).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
-- [KPP:DOWN:BEGIN name="policy:playground_items_tenant_isolation"]
DROP POLICY IF EXISTS "playground_items_tenant_isolation" ON "playground_items";
-- [KPP:DOWN:END name="policy:playground_items_tenant_isolation"]

-- [KPP:DOWN:BEGIN name="rls:playground_items"]
ALTER TABLE "playground_items" DISABLE ROW LEVEL SECURITY;
-- [KPP:DOWN:END name="rls:playground_items"]
  `).execute(db)
}
