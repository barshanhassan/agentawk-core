/**
 * Idempotent migration: add `contact_opting` and `make_hooks` tables.
 *
 * - contact_opting       — per-contact opt-in/out state for each channel,
 *                          written by `*_opting` automation actions
 * - make_hooks           — workspace-scoped Make.com webhook destinations,
 *                          consumed by the `make_hook` automation action
 *
 * Run after editing schema.prisma:
 *   cd backend
 *   npx ts-node scripts/migrate-add-contact-opting-make-hooks.ts
 *   npx prisma generate
 *
 * Re-runnable — every step checks information_schema first.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function tableExists(table: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT COUNT(*) AS c FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = ?`,
    table,
  );
  return Number(rows?.[0]?.c ?? 0) > 0;
}

async function main() {
  if (!(await tableExists('contact_opting'))) {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE contact_opting (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        contact_id BIGINT UNSIGNED NOT NULL,
        channel VARCHAR(40) NOT NULL,
        opt_in TINYINT(1) NOT NULL DEFAULT 1,
        reason VARCHAR(255) NULL,
        created_at TIMESTAMP NULL,
        updated_at TIMESTAMP NULL,
        UNIQUE KEY uk_contact_opting_contact_channel (contact_id, channel),
        KEY idx_contact_opting_on_channel (channel)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('[+] Created contact_opting');
  } else {
    console.log('[=] contact_opting already exists, skipping');
  }

  if (!(await tableExists('make_hooks'))) {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE make_hooks (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        workspace_id BIGINT UNSIGNED NOT NULL,
        user_id BIGINT UNSIGNED NULL,
        name VARCHAR(150) NOT NULL,
        url VARCHAR(500) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMP NULL,
        updated_at TIMESTAMP NULL,
        deleted_at TIMESTAMP NULL,
        KEY idx_make_hooks_on_workspace_id (workspace_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('[+] Created make_hooks');
  } else {
    console.log('[=] make_hooks already exists, skipping');
  }

  console.log('\nDone. Run `npx prisma generate` to refresh the client.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
