/**
 * Applies the wa_chats unique constraint to the live DB without using
 * `prisma migrate` (this repo runs introspection-only, no migration history).
 *
 * The constraint matches what `@@unique([wa_account_id, wa_number_id, wa_id])`
 * declares in schema.prisma. Prerequisite: run scripts/dedup-wa-chats.ts first
 * so the ALTER doesn't trip on existing duplicates.
 *
 * Usage (from backend folder):
 *   npx tsx scripts/migrate-add-wa-chats-unique.ts
 *   npx prisma generate   # regenerate client so consumer can use upsert
 *
 * Idempotent: skips if the index already exists.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const exists = await prisma.$queryRawUnsafe<{ idx: string }[]>(
    `SELECT INDEX_NAME AS idx
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'wa_chats'
        AND INDEX_NAME = 'uk_wa_chats_account_number_waid'
      LIMIT 1`,
  );

  if (exists.length > 0) {
    console.log('Index uk_wa_chats_account_number_waid already exists. Nothing to do.');
    return;
  }

  console.log('Applying unique constraint on wa_chats(wa_account_id, wa_number_id, wa_id)...');
  await prisma.$executeRawUnsafe(
    `ALTER TABLE wa_chats
       ADD UNIQUE INDEX uk_wa_chats_account_number_waid (wa_account_id, wa_number_id, wa_id)`,
  );
  console.log('Done.');

  console.log('\nNext step: run');
  console.log('  npx prisma generate');
  console.log('so the generated client knows about the new compound unique key (needed for upsert).');
}

main()
  .catch((err) => {
    console.error('Migration failed:', err);
    if (err?.message?.includes('Duplicate entry')) {
      console.error('Hint: duplicate rows still exist. Run scripts/dedup-wa-chats.ts first.');
    }
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
