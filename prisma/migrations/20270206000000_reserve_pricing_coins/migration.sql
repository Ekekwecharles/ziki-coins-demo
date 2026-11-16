-- /pricing (the plans page) and /coins (the Ziks page) are top-level routes, so no organisation or project may take
-- either name (lib/project-slug.ts): its own address would open that page instead. Anything that already holds one is
-- renamed to <slug>-org / <slug>-project (then -2, -3, ... if that is taken), the rule new names follow.
--
-- Idempotent: once renamed, nothing holds a reserved name, so a second run changes nothing.
DO $$
DECLARE
  org RECORD;
  project RECORD;
  candidate TEXT;
  attempt INT;
BEGIN
  FOR org IN
    SELECT "id", "slug" FROM "Organisation" WHERE "slug" IN ('coins', 'pricing') ORDER BY "createdAt", "id"
  LOOP
    candidate := org."slug" || '-org';
    attempt := 2;
    WHILE EXISTS (SELECT 1 FROM "Organisation" WHERE "slug" = candidate) LOOP
      candidate := org."slug" || '-org-' || attempt;
      attempt := attempt + 1;
    END LOOP;
    UPDATE "Organisation" SET "slug" = candidate, "updatedAt" = NOW() WHERE "id" = org."id";
  END LOOP;

  FOR project IN
    SELECT "id", "organisationId", "slug" FROM "Project" WHERE "slug" IN ('coins', 'pricing') ORDER BY "createdAt", "id"
  LOOP
    candidate := project."slug" || '-project';
    attempt := 2;
    WHILE EXISTS (
      SELECT 1 FROM "Project" WHERE "organisationId" = project."organisationId" AND "slug" = candidate
    ) LOOP
      candidate := project."slug" || '-project-' || attempt;
      attempt := attempt + 1;
    END LOOP;
    UPDATE "Project" SET "slug" = candidate, "updatedAt" = NOW() WHERE "id" = project."id";
  END LOOP;
END $$;
