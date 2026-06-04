/**
 * One-off cleanup: collapse duplicate wa_chats rows that share the same
 * (wa_account_id, wa_number_id, wa_id) triple. Phase 5A had a race
 * window between findFirst + create that let parallel webhooks each
 * create a fresh chat for the same customer. Phase 5B adds a unique
 * constraint to make this impossible, but the constraint will refuse
 * to attach until duplicates are gone — that's what this script handles.
 *
 * For each duplicate group:
 *   1. Keep the chat with the lowest id (the "canonical" one)
 *   2. Re-point every wa_messages.wa_chat_id, contact_last_messages.chatable_id,
 *      and inbox.modelable_id from the duplicates to the canonical chat
 *   3. Delete the duplicate chat rows
 *
 * Usage (from backend folder):
 *   npx tsx scripts/dedup-wa-chats.ts
 *
 * Idempotent — safe to re-run; a clean DB results in "no duplicates".
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const WHATSAPP_CHAT_MODELABLE = 'App\\Models\\Whatsapp\\WhatsappChat';

async function main() {
  // 1. Find duplicate triples via raw SQL (Prisma can't groupBy + having across nullable+composite easily)
  const groups = await prisma.$queryRawUnsafe<
    { wa_account_id: bigint; wa_number_id: bigint; wa_id: string; cnt: bigint }[]
  >(
    `SELECT wa_account_id, wa_number_id, wa_id, COUNT(*) AS cnt
       FROM wa_chats
      GROUP BY wa_account_id, wa_number_id, wa_id
     HAVING COUNT(*) > 1`,
  );

  if (groups.length === 0) {
    console.log('No duplicates found — wa_chats is already unique on (wa_account_id, wa_number_id, wa_id).');
    return;
  }

  console.log(`Found ${groups.length} duplicate group(s). Collapsing...`);

  for (const g of groups) {
    const rows = await prisma.wa_chats.findMany({
      where: { wa_account_id: g.wa_account_id, wa_number_id: g.wa_number_id, wa_id: g.wa_id },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (rows.length < 2) continue;

    const [canonical, ...duplicates] = rows;
    const dupIds = duplicates.map((r) => r.id);

    console.log(`  wa_id=${g.wa_id}: keep chat id=${canonical.id}, merge ${dupIds.length} duplicate(s) (${dupIds.join(',')})`);

    // Re-point wa_messages
    const updatedMsgs = await prisma.wa_messages.updateMany({
      where: { wa_chat_id: { in: dupIds } },
      data: { wa_chat_id: canonical.id },
    });
    console.log(`    wa_messages re-pointed: ${updatedMsgs.count}`);

    // Re-point contact_last_messages (chatable_type must match WhatsappChat too)
    const updatedClm = await prisma.contact_last_messages.updateMany({
      where: { chatable_type: WHATSAPP_CHAT_MODELABLE, chatable_id: { in: dupIds } },
      data: { chatable_id: canonical.id },
    });
    console.log(`    contact_last_messages re-pointed: ${updatedClm.count}`);

    // Re-point inbox
    const updatedInbox = await prisma.inbox.updateMany({
      where: { modelable_type: WHATSAPP_CHAT_MODELABLE, modelable_id: { in: dupIds } },
      data: { modelable_id: canonical.id },
    });
    console.log(`    inbox re-pointed: ${updatedInbox.count}`);

    // Delete the duplicate chat rows
    const deleted = await prisma.wa_chats.deleteMany({ where: { id: { in: dupIds } } });
    console.log(`    duplicate wa_chats deleted: ${deleted.count}`);
  }

  // Some inbox rows may now collide if duplicates pointed at different inbox rows.
  // Surface that so the user knows. Phase 5C will add an upsert there too.
  const inboxDupes = await prisma.$queryRawUnsafe<
    { modelable_id: bigint; cnt: bigint }[]
  >(
    `SELECT modelable_id, COUNT(*) AS cnt
       FROM inbox
      WHERE modelable_type = ?
      GROUP BY modelable_id
     HAVING COUNT(*) > 1`,
    WHATSAPP_CHAT_MODELABLE,
  );
  if (inboxDupes.length > 0) {
    console.log('\nWarning: inbox now has duplicate rows pointing at the same WhatsappChat:');
    for (const d of inboxDupes) {
      console.log(`  modelable_id=${d.modelable_id} appears ${d.cnt} times`);
    }
    console.log('Collapsing inbox duplicates — keep earliest, delete the rest...');
    for (const d of inboxDupes) {
      const rows = await prisma.inbox.findMany({
        where: { modelable_type: WHATSAPP_CHAT_MODELABLE, modelable_id: d.modelable_id },
        orderBy: { id: 'asc' },
        select: { id: true },
      });
      const dupIds = rows.slice(1).map((r) => r.id);
      if (dupIds.length > 0) {
        const del = await prisma.inbox.deleteMany({ where: { id: { in: dupIds } } });
        console.log(`    inbox modelable_id=${d.modelable_id}: deleted ${del.count} extra row(s)`);
      }
    }
  }

  console.log('\nDedup complete. Safe to apply the wa_chats unique constraint now.');
}

main()
  .catch((err) => {
    console.error('Dedup failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
