/**
 * Cleanup outbound wa_messages rows that were created before created_at was
 * being set + remove empty-text OUTGOING rows from earlier message_text bug.
 *
 * Two phases:
 *   1. Backfill NULL created_at on wa_messages so the chat sort order is correct
 *      (rows with NULL created_at currently render at the TOP of the chat
 *      because MySQL sorts NULL as "smallest" in ASC order).
 *   2. Optionally delete empty-text OUTGOING rows (artifacts from the earlier
 *      `data.text` bug — frontend was sending `message_text` so backend got '').
 *
 * Usage (from backend folder):
 *   # Dry run — just shows counts, makes no changes
 *   npx ts-node scripts/cleanup-wa-messages-outbound.ts
 *
 *   # Actually apply the changes
 *   npx ts-node scripts/cleanup-wa-messages-outbound.ts --apply
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

async function main() {
  console.log(APPLY ? '\n=== APPLY MODE ===\n' : '\n=== DRY RUN (no changes) ===\n');

  // 1. Find rows with NULL created_at
  const nullCreatedAt = await prisma.wa_messages.count({
    where: { created_at: null },
  });
  console.log(`[1] wa_messages rows with NULL created_at: ${nullCreatedAt}`);

  if (nullCreatedAt > 0 && APPLY) {
    // Use updated_at as fallback, then NOW() as last resort.
    const affected = await prisma.$executeRawUnsafe(
      `UPDATE wa_messages
          SET created_at = COALESCE(updated_at, NOW())
        WHERE created_at IS NULL`,
    );
    console.log(`    -> backfilled ${affected} rows from updated_at/NOW()`);
  }

  // 2. Find empty-text OUTGOING rows
  const emptyOutgoing = await prisma.wa_messages.findMany({
    where: {
      direction: 'OUTGOING',
      OR: [{ text: null }, { text: '' }],
    },
    select: { id: true, wa_chat_id: true, created_at: true, status: true, type: true },
    orderBy: { id: 'asc' },
  });
  console.log(`\n[2] Empty-text OUTGOING wa_messages: ${emptyOutgoing.length}`);
  if (emptyOutgoing.length > 0) {
    console.log('    First 10:');
    emptyOutgoing.slice(0, 10).forEach((m) => {
      console.log(
        `      id=${m.id} chat=${m.wa_chat_id} type=${m.type} status=${m.status} created_at=${m.created_at?.toISOString() ?? 'NULL'}`,
      );
    });
  }

  if (emptyOutgoing.length > 0 && APPLY) {
    const ids = emptyOutgoing.map((m) => m.id);
    const deleted = await prisma.wa_messages.deleteMany({
      where: { id: { in: ids } },
    });
    console.log(`    -> deleted ${deleted.count} empty-text OUTGOING rows`);
  }

  console.log(APPLY ? '\nDone.' : '\nDry run complete. Re-run with --apply to actually change the DB.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
