/**
 * Idempotent migration: add wa_accounts.meta_account_id (VARCHAR(64), nullable)
 * to store the WhatsApp microservice's MongoDB _id, plus an index for lookups.
 *
 * Run after editing schema.prisma:
 *   cd backend
 *   npx ts-node scripts/migrate-add-wa-accounts-meta-id.ts
 *   npx prisma generate
 *
 * Safe to run multiple times — checks information_schema first.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT COUNT(*) AS c
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND column_name = ?`,
    table,
    column,
  );
  return Number(rows?.[0]?.c ?? 0) > 0;
}

async function indexExists(table: string, indexName: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT COUNT(*) AS c
       FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND index_name = ?`,
    table,
    indexName,
  );
  return Number(rows?.[0]?.c ?? 0) > 0;
}

async function main() {
  const hasCol = await columnExists('wa_accounts', 'meta_account_id');
  if (!hasCol) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE wa_accounts ADD COLUMN meta_account_id VARCHAR(64) NULL`,
    );
    console.log('[+] Added wa_accounts.meta_account_id');
  } else {
    console.log('[=] wa_accounts.meta_account_id already exists, skipping');
  }

  const hasIdx = await indexExists('wa_accounts', 'idx_wa_accounts_on_meta_account_id');
  if (!hasIdx) {
    await prisma.$executeRawUnsafe(
      `CREATE INDEX idx_wa_accounts_on_meta_account_id ON wa_accounts(meta_account_id)`,
    );
    console.log('[+] Created idx_wa_accounts_on_meta_account_id');
  } else {
    console.log('[=] idx_wa_accounts_on_meta_account_id already exists, skipping');
  }

  console.log('\nDone. Run `npx prisma generate` to refresh the Prisma client.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
