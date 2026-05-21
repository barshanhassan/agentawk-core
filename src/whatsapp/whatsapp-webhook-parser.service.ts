import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Parses Meta WhatsApp Cloud API webhook payloads into normalized inbound
 * message records (wa_chats + wa_messages + contact). Mirrors the gateway's
 * WebhookListener pattern: one webhook event from Meta can carry multiple
 * `entry[]` envelopes, each with `changes[].value.messages[]` and/or
 * `changes[].value.statuses[]` (delivery receipts).
 *
 * Returns an array of normalized message-receipt summaries that downstream
 * code (inbox handler, automation triggers) can iterate over.
 */
@Injectable()
export class WhatsappWebhookParserService {
  private readonly logger = new Logger(WhatsappWebhookParserService.name);

  constructor(private readonly prisma: PrismaService) {}

  async parse(payload: any) {
    const results: Array<{
      type: 'message' | 'status';
      wa_account_id?: bigint;
      wa_phone_number_id?: bigint;
      wa_chat_id?: bigint;
      wa_message_id?: bigint;
      contact_id?: bigint;
      workspace_id?: bigint;
      wamid?: string;
      status?: string;
    }> = [];

    if (!payload || !Array.isArray(payload.entry)) {
      this.logger.warn('WhatsApp webhook: missing entry[] — payload ignored');
      return results;
    }

    for (const entry of payload.entry) {
      const wabaId: string | undefined = entry.id;
      if (!wabaId) continue;

      const account = await this.prisma.wa_accounts.findFirst({
        where: { waba_id: wabaId, deleted_at: null },
      });
      if (!account) {
        this.logger.warn(`WhatsApp webhook: no wa_account found for waba_id=${wabaId}`);
        continue;
      }

      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;
        const value = change.value ?? {};
        const phoneNumberIdStr: string | undefined = value?.metadata?.phone_number_id;
        if (!phoneNumberIdStr) continue;

        const phoneNumber = await this.prisma.wa_phone_numbers.findFirst({
          where: { wa_account_id: account.id, wa_number_id: phoneNumberIdStr },
        });
        if (!phoneNumber) {
          this.logger.warn(
            `WhatsApp webhook: no wa_phone_number for phone_number_id=${phoneNumberIdStr}`,
          );
          continue;
        }

        // Inbound messages
        for (const msg of (value.messages ?? []) as any[]) {
          const persisted = await this.persistInboundMessage(account, phoneNumber, value, msg);
          if (persisted) results.push({ type: 'message', ...persisted });
        }

        // Delivery / read statuses
        for (const s of (value.statuses ?? []) as any[]) {
          const updated = await this.applyStatusUpdate(s);
          if (updated) results.push({ type: 'status', ...updated });
        }
      }
    }

    return results;
  }

  private async persistInboundMessage(
    account: any,
    phoneNumber: any,
    value: any,
    msg: any,
  ) {
    const fromWaId: string = msg.from;
    const wamid: string = msg.id;
    const type: string = msg.type ?? 'text';

    // Body extraction by Meta message type
    let text: string | null = null;
    let media: string | null = null;
    if (type === 'text') text = msg.text?.body ?? null;
    else if (type === 'button') text = msg.button?.text ?? null;
    else if (type === 'interactive') text = JSON.stringify(msg.interactive ?? {});
    else if (type === 'image' || type === 'audio' || type === 'video' || type === 'document') {
      media = JSON.stringify(msg[type] ?? {});
      text = msg[type]?.caption ?? null;
    } else if (type === 'location') {
      media = JSON.stringify(msg.location ?? {});
    }

    // Find/create contact for this workspace
    const profileName: string | undefined = value.contacts?.[0]?.profile?.name;
    const contact = await this.findOrCreateContact(
      account.workspace_id,
      fromWaId,
      profileName,
    );

    // Find or create the wa_chat tying contact↔phone_number
    let chat = await this.prisma.wa_chats.findFirst({
      where: { wa_number_id: phoneNumber.id, wa_id: fromWaId, contact_id: contact.id },
    });
    if (!chat) {
      chat = await this.prisma.wa_chats.create({
        data: {
          wa_account_id: account.id,
          wa_number_id: phoneNumber.id,
          user_id: account.user_id,
          contact_id: contact.id,
          profile_name: profileName ?? null,
          wa_id: fromWaId,
          is_primary: true,
          last_interacted_at: new Date(),
          last_client_interaction: new Date(),
          input_attempts: BigInt(0),
        },
      });
    } else {
      await this.prisma.wa_chats.update({
        where: { id: chat.id },
        data: {
          last_interacted_at: new Date(),
          last_client_interaction: new Date(),
          profile_name: profileName ?? chat.profile_name,
        },
      });
    }

    // Idempotency: skip if we already persisted this wamid
    const existing = await this.prisma.wa_messages.findFirst({ where: { wamid } });
    if (existing) {
      return {
        wa_account_id: account.id,
        wa_phone_number_id: phoneNumber.id,
        wa_chat_id: chat.id,
        wa_message_id: existing.id,
        contact_id: contact.id,
        workspace_id: account.workspace_id,
        wamid,
      };
    }

    const message = await this.prisma.wa_messages.create({
      data: {
        wa_chat_id: chat.id,
        wa_number_id: phoneNumber.id,
        mobile_number: fromWaId,
        type,
        direction: 'INCOMING',
        text,
        media,
        status: 'received',
        wamid,
        timestamp: msg.timestamp ?? null,
      },
    });

    return {
      wa_account_id: account.id,
      wa_phone_number_id: phoneNumber.id,
      wa_chat_id: chat.id,
      wa_message_id: message.id,
      contact_id: contact.id,
      workspace_id: account.workspace_id,
      wamid,
    };
  }

  private async applyStatusUpdate(status: any) {
    const wamid: string | undefined = status.id;
    if (!wamid) return null;
    const newStatus: string = status.status ?? 'unknown'; // sent / delivered / read / failed
    const errorData: string | null = status.errors ? JSON.stringify(status.errors) : null;

    const message = await this.prisma.wa_messages.findFirst({ where: { wamid } });
    if (!message) return null;

    await this.prisma.wa_messages.update({
      where: { id: message.id },
      data: {
        status: newStatus,
        error_data: errorData ?? message.error_data,
      },
    });

    return { wamid, status: newStatus, wa_message_id: message.id };
  }

  /**
   * Locate or create a Contact for an incoming WhatsApp number, scoped to the
   * workspace. Uses `contact_mobiles.full_mobile_number` (without "+") as the
   * dedup key — matches gateway's pattern.
   */
  private async findOrCreateContact(
    workspaceId: bigint,
    waId: string,
    profileName?: string,
  ) {
    const fullMobile = waId.startsWith('+') ? waId.slice(1) : waId;

    const mobile = await this.prisma.contact_mobiles.findFirst({
      where: {
        full_mobile_number: fullMobile,
        ownership_type: 'App\\Models\\Workspace',
        ownership_id: workspaceId,
      },
    });
    if (mobile?.modelable_id) {
      const c = await this.prisma.contacts.findUnique({ where: { id: mobile.modelable_id } });
      if (c) return c;
    }

    // Create contact + mobile binding
    const contact = await this.prisma.contacts.create({
      data: {
        workspace_id: workspaceId,
        first_name: profileName ?? 'WhatsApp',
        last_name: null,
        source: 'WHATSAPP',
        status: 'ACTIVE',
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
    await this.prisma.contact_mobiles.create({
      data: {
        ownership_type: 'App\\Models\\Workspace',
        ownership_id: workspaceId,
        modelable_type: 'App\\Models\\Contact',
        modelable_id: contact.id,
        country_id: 0,
        mobile_number: fullMobile,
        national_mobile_number: fullMobile,
        full_mobile_number: fullMobile,
      },
    });
    return contact;
  }
}
