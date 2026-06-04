/**
 * One-off seed: register the Meta test WhatsApp account (the same WABA the
 * Node.js microservice is bound to) into MySQL so Phase 5A's inbound
 * consumer can resolve it.
 *
 * Mirrors what Phase 5B's manual onboarding endpoint will do — without the
 * REST surface. Idempotent: re-running just refreshes access_token / status.
 *
 * Usage (from backend folder):
 *   npx tsx scripts/seed-test-whatsapp-account.ts
 *
 * Optional env overrides:
 *   WS_ID=42                 # workspace_id; defaults to first non-deleted workspace
 *   WABA_ID=681754671655525  # WhatsApp Business Account ID from Meta dashboard
 *   PHONE_NUMBER_ID=769635746243474
 *   DISPLAY_PHONE_NUMBER=15551414305
 *   ACCESS_TOKEN=EAAxxx...   # current Meta access token (24h temp token is fine for testing)
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const wabaId = process.env.WABA_ID || '681754671655525';
  const phoneNumberId = process.env.PHONE_NUMBER_ID || '769635746243474';
  const displayPhoneNumber = process.env.DISPLAY_PHONE_NUMBER || '15551414305';
  const accessToken = process.env.ACCESS_TOKEN || 'PASTE_META_ACCESS_TOKEN_HERE';

  // 1. Resolve workspace + owning user
  let wsId: bigint;
  if (process.env.WS_ID) {
    wsId = BigInt(process.env.WS_ID);
  } else {
    const ws = await prisma.workspaces.findFirst({
      where: { deleted_at: null },
      orderBy: { id: 'asc' },
    });
    if (!ws) {
      throw new Error('No workspace found. Create one first or pass WS_ID env var.');
    }
    wsId = ws.id;
  }
  console.log(`Using workspace_id=${wsId}`);

  const owner = await prisma.users.findFirst({
    where: { modelable_type: 'App\\Models\\Workspace', modelable_id: wsId },
    orderBy: { id: 'asc' },
  });
  if (!owner) {
    throw new Error(`No user found for workspace_id=${wsId}`);
  }
  console.log(`Using user_id=${owner.id} (${owner.email})`);

  const now = new Date();

  // 2. Upsert wa_accounts row keyed on (workspace_id, waba_id)
  let account = await prisma.wa_accounts.findFirst({
    where: { workspace_id: wsId, waba_id: wabaId, deleted_at: null },
  });
  if (account) {
    account = await prisma.wa_accounts.update({
      where: { id: account.id },
      data: {
        access_token: accessToken,
        status: 'ACTIVE',
        updated_at: now,
      },
    });
    console.log(`Updated existing wa_accounts.id=${account.id}`);
  } else {
    account = await prisma.wa_accounts.create({
      data: {
        workspace_id: wsId,
        user_id: owner.id,
        waba_id: wabaId,
        name: 'Test WhatsApp Business Account',
        currency: 'USD',
        timezone_id: '0',
        message_template_namespace: '',
        access_token: accessToken,
        status: 'ACTIVE',
        service_account_id: '',
        onboard_platform: 'whatsapp_business',
        is_migrated: 0,
        created_at: now,
        updated_at: now,
      },
    });
    console.log(`Created wa_accounts.id=${account.id}`);
  }

  // 3. Upsert wa_phone_numbers row keyed on (wa_account_id, wa_number_id)
  let phone = await prisma.wa_phone_numbers.findFirst({
    where: { wa_account_id: account.id, wa_number_id: phoneNumberId },
  });
  if (phone) {
    phone = await prisma.wa_phone_numbers.update({
      where: { id: phone.id },
      data: {
        display_phone_number: displayPhoneNumber,
        status: 'ACTIVE',
        updated_at: now,
      },
    });
    console.log(`Updated existing wa_phone_numbers.id=${phone.id}`);
  } else {
    phone = await prisma.wa_phone_numbers.create({
      data: {
        wa_account_id: account.id,
        wa_number_id: phoneNumberId,
        display_phone_number: displayPhoneNumber,
        phone_number: displayPhoneNumber.replace(/[^0-9]/g, ''),
        pin_code: '',
        verified_name: 'Test WhatsApp Business Account',
        name_status: 'APPROVED',
        code_verification_status: 'VERIFIED',
        status: 'ACTIVE',
        quality_rating: 'UNKNOWN',
        auto_reply_interval: '247',
        platform_type: 'CLOUD_API',
        smb_app_data: 0,
        created_at: now,
        updated_at: now,
      },
    });
    console.log(`Created wa_phone_numbers.id=${phone.id}`);
  }

  console.log('\nSeed complete. Backend can now resolve inbound messages for this WABA.');
  console.log(`  waba_id            = ${wabaId}`);
  console.log(`  phone_number_id    = ${phoneNumberId}`);
  console.log(`  workspace_id       = ${wsId}`);
  console.log(`  wa_accounts.id     = ${account.id}`);
  console.log(`  wa_phone_numbers.id= ${phone.id}`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
