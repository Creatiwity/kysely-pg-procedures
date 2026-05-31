import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// [KPP:META generated="2026-05-31T22:41:52.497Z" changes="playground_audit_proc(new),playground_audit_trigger(new),playground_score_proc(new),playground_score_trigger(new)"]

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
-- [KPP:BEGIN name="playground_audit_proc" kind="function" hash="sha256:4fd139f90841ea0526a84163b89b4df8c76e7b776e541bf84f25f91e0c494797"]
CREATE OR REPLACE FUNCTION playground_audit_proc()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    _proc_instance_id UUID := gen_random_uuid();
BEGIN
    CREATE TEMP TABLE IF NOT EXISTS "PlaygroundModifiedItems" (
        "_proc_instance_id" UUID NOT NULL,
        "itemId" UUID NOT NULL,
        "oldScore" INTEGER,
        "newScore" INTEGER
    );

    INSERT INTO "PlaygroundModifiedItems" ("_proc_instance_id", "itemId", "oldScore", "newScore")
    SELECT _proc_instance_id, * FROM (
        select ins."id" as "itemId", rem."score" as "oldScore", ins."score" as "newScore" from "inserted" as "ins" inner join "removed" as "rem" on "ins"."id" = "rem"."id" where ins."score" IS DISTINCT FROM rem."score"
    ) _subq;
    IF NOT EXISTS (SELECT FROM "PlaygroundModifiedItems" AS t WHERE t."_proc_instance_id" = _proc_instance_id) THEN
        DELETE FROM "PlaygroundModifiedItems" AS t WHERE t."_proc_instance_id" = _proc_instance_id;
        RETURN NULL;
    END IF;
    update "playground_items" set "audit_flag" = TRUE from "PlaygroundModifiedItems" as "m" where "playground_items"."id" = "m"."itemId" and m."_proc_instance_id" = _proc_instance_id;

    DELETE FROM "PlaygroundModifiedItems" AS t WHERE t."_proc_instance_id" = _proc_instance_id;
    RETURN NULL;
END;
$$;
-- [KPP:END name="playground_audit_proc"]

-- [KPP:BEGIN name="playground_score_proc" kind="function" hash="sha256:350f43480a93b3b1ea3567172ef8ddead2815aff3d814e7f6d6911ade288bbae"]
CREATE OR REPLACE FUNCTION playground_score_proc()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW."score" := char_length(NEW."label") * 10;
    RETURN NEW;
END;
$$;
-- [KPP:END name="playground_score_proc"]

-- [KPP:BEGIN name="playground_audit_trigger" kind="trigger" hash="sha256:4bccbfc70b5a30b1dacb77e94f2c8439e3d67d3d0580d087df8913bf5ae767ac"]
CREATE OR REPLACE TRIGGER playground_audit_trigger
    AFTER UPDATE ON "playground_items"
    REFERENCING OLD TABLE AS removed NEW TABLE AS inserted
    FOR EACH STATEMENT
    EXECUTE FUNCTION playground_audit_proc();
-- [KPP:END name="playground_audit_trigger"]

-- [KPP:BEGIN name="playground_score_trigger" kind="trigger" hash="sha256:69248d9c18f70d82bf24c3fe6408a80ed6b16b7a800c2c9af6ba3fe7ef0aeefd"]
CREATE OR REPLACE TRIGGER playground_score_trigger
    BEFORE INSERT ON "playground_items"
    FOR EACH ROW
    EXECUTE FUNCTION playground_score_proc();
-- [KPP:END name="playground_score_trigger"]
  `).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`
-- [KPP:DOWN:BEGIN name="playground_score_trigger"]
DROP TRIGGER IF EXISTS "playground_score_trigger" ON "playground_items";
-- [KPP:DOWN:END name="playground_score_trigger"]

-- [KPP:DOWN:BEGIN name="playground_audit_trigger"]
DROP TRIGGER IF EXISTS "playground_audit_trigger" ON "playground_items";
-- [KPP:DOWN:END name="playground_audit_trigger"]

-- [KPP:DOWN:BEGIN name="playground_score_proc"]
DROP FUNCTION IF EXISTS playground_score_proc();
-- [KPP:DOWN:END name="playground_score_proc"]

-- [KPP:DOWN:BEGIN name="playground_audit_proc"]
DROP FUNCTION IF EXISTS playground_audit_proc();
-- [KPP:DOWN:END name="playground_audit_proc"]
  `).execute(db)
}
