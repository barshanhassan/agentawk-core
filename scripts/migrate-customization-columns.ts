/**
 * Idempotent migration: schema additions needed for the Customization
 * module full-mirror sweep (Iframes + Widgets sub-modules).
 *
 * - iframes.placement   — replyagent's 'settings_menu' | 'main_menu' switch
 * - iframes.icon        — icon name / asset path for the menu item
 * - iframes.menu_text   — sidebar label (separate from the menu group name)
 * - widgets.subtitle    — replyagent allows NULL; current schema is NOT NULL
 *
 * Re-runnable — every step checks information_schema first.
 *
 * Run:
 *   cd backend
 *   npx ts-node scripts/migrate-customization-columns.ts
 *   # Update schema.prisma to match, then:
 *   npx prisma generate
 *   # Restart backend
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT COUNT(*) AS c FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    table,
    column,
  );
  return Number(rows?.[0]?.c ?? 0) > 0;
}

async function columnIsNullable(
  table: string,
  column: string,
): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    table,
    column,
  );
  return rows?.[0]?.is_nullable === 'YES';
}

async function addColumn(table: string, column: string, definition: string) {
  if (await columnExists(table, column)) {
    console.log(`[=] ${table}.${column} already exists, skipping`);
    return;
  }
  await prisma.$executeRawUnsafe(
    `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`,
  );
  console.log(`[+] Added ${table}.${column}`);
}

async function main() {
  // ── iframes: replyagent parity columns ─────────────────────────────
  await addColumn(
    'iframes',
    'placement',
    `VARCHAR(20) NOT NULL DEFAULT 'settings_menu'`,
  );
  await addColumn('iframes', 'icon', 'VARCHAR(255) NULL');
  await addColumn('iframes', 'menu_text', 'VARCHAR(255) NULL');

  // ── widgets: make subtitle nullable (replyagent parity) ──────────
  if (!(await columnExists('widgets', 'subtitle'))) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE \`widgets\` ADD COLUMN \`subtitle\` TEXT NULL`,
    );
    console.log('[+] Added widgets.subtitle (nullable)');
  } else if (!(await columnIsNullable('widgets', 'subtitle'))) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE \`widgets\` MODIFY COLUMN \`subtitle\` TEXT NULL`,
    );
    console.log('[~] Made widgets.subtitle nullable');
  } else {
    console.log('[=] widgets.subtitle already nullable, skipping');
  }

  console.log('\nDone. Next steps:');
  console.log('  1. Update prisma/schema.prisma — match the column additions above');
  console.log('  2. npx prisma generate');
  console.log('  3. Restart backend');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
