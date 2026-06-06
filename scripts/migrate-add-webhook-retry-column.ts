/**
 * Idempotent migration: add `pending_retries` column to the existing
 * `webhooks` table so outbound webhook deliveries can be retried with
 * exponential backoff without spinning up a separate deliveries table.
 *
 * The column stores a JSON array of pending attempts:
 *   [{ event, payload, attempt, next_retry_at, last_error }]
 *
 * A cron job (NestJS Schedule, every 60s) reads this column, retries
 * entries whose `next_retry_at <= NOW()`, and clears them on success or
 * after 5 attempts.
 *
 * Run:
 *   cd backend
 *   npx ts-node scripts/migrate-add-webhook-retry-column.ts
 *   npx prisma generate
 *   # Restart backend
 *
 * Re-runnable — information_schema check skips if column exists.
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

async function main() {
  if (!(await columnExists('webhooks', 'pending_retries'))) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE \`webhooks\` ADD COLUMN \`pending_retries\` LONGTEXT NULL`,
    );
    console.log('[+] Added webhooks.pending_retries');
  } else {
    console.log('[=] webhooks.pending_retries already exists, skipping');
  }

  console.log('\nDone. Next steps:');
  console.log('  1. Update prisma/schema.prisma — add `pending_retries String? @db.LongText` to webhooks model');
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
