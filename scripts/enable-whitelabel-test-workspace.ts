/**
 * One-off script: turn ON allow_branding (White Label) for the single test
 * workspace whose admin user is "Workspace Admin". Scopes the update by joining
 * users → workspaces, so it cannot bleed onto other workspaces.
 *
 * Usage: from backend folder: npx tsx scripts/enable-whitelabel-test-workspace.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // 1. Find the admin user(s) named "Workspace Admin" (or close) who live in
  //    a workspace (not the agency). Their modelable_id is the workspace id.
  const admins = await prisma.users.findMany({
    where: {
      modelable_type: 'App\\Models\\Workspace',
      OR: [
        { full_name: { contains: 'Workspace Admin' } },
        { first_name: { contains: 'Workspace' }, last_name: { contains: 'Admin' } },
      ],
      status: 'ACTIVE',
    },
    select: {
      id: true,
      full_name: true,
      first_name: true,
      last_name: true,
      email: true,
      modelable_id: true,
    },
  });

  if (admins.length === 0) {
    console.error('[abort] No user matching "Workspace Admin" found.');
    process.exit(1);
  }

  const workspaceIds = [...new Set(admins.map((a) => a.modelable_id))];
  const workspaces = await prisma.workspaces.findMany({
    where: { id: { in: workspaceIds } },
    select: { id: true, name: true, allow_branding: true, agency_id: true },
  });

  console.log('Matched workspace(s):');
  for (const w of workspaces) {
    const admin = admins.find((a) => a.modelable_id === w.id);
    console.log(
      `  - workspace id=${w.id} name="${w.name}" agency_id=${w.agency_id} ` +
        `allow_branding=${w.allow_branding} (admin: ${admin?.full_name} / ${admin?.email})`,
    );
  }

  if (workspaces.length !== 1) {
    console.error(
      `[abort] Expected exactly 1 matching workspace, got ${workspaces.length}. ` +
        `Re-run with a more specific name filter (edit the script).`,
    );
    process.exit(1);
  }

  const target = workspaces[0];
  if (target.allow_branding) {
    console.log(`Workspace already has allow_branding=true — nothing to do.`);
    return;
  }

  // 2. Surgical update — only this workspace, only this field.
  const updated = await prisma.workspaces.update({
    where: { id: target.id },
    data: { allow_branding: true },
    select: { id: true, name: true, allow_branding: true },
  });

  console.log(
    `[ok] Updated workspace id=${updated.id} name="${updated.name}" ` +
      `allow_branding=${updated.allow_branding}`,
  );
}

main()
  .catch((e) => {
    console.error('[error]', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
