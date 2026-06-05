// @ts-nocheck
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from '../inbox/chat.gateway';
import { RabbitMqService } from './rabbitmq.service';

const WHATSAPP_CHAT_MODELABLE = 'App\\Models\\Whatsapp\\WhatsappChat';
const WHATSAPP_MESSAGE_MODELABLE = 'App\\Models\\Whatsapp\\WhatsappMessage';
const WHATSAPP_NUMBER_MODELABLE = 'App\\Models\\Whatsapp\\WhatsappNumber';
const CONTACT_MODELABLE = 'App\\Models\\Contact';
const WORKSPACE_MODELABLE = 'App\\Models\\Workspace';
const FALLBACK_COUNTRY_ID = 1n; // TODO: derive from phone_code prefix; covered in Phase 5B.

/**
 * Subscribes to the `ra/gateway` queue and persists WhatsApp events arriving
 * from the Node.js microservice (d:/Ezconn/whatsapp).
 *
 * Mirrors gateway PHP's WhatsappMessageBroker + WhatsappHelper.inboundMessage()
 * pipeline. Phase 5A handles WA_INBOUND_MESSAGE only — status updates,
 * button clicks, media, and automation triggers ship in 5B.
 */
@Injectable()
export class WhatsappEventsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(WhatsappEventsConsumer.name);

  constructor(
    private readonly rabbit: RabbitMqService,
    private readonly prisma: PrismaService,
    private readonly chatGateway: ChatGateway,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  onApplicationBootstrap() {
    const exchange = this.config.get<string>('RABBITMQ_EXCHANGE') || 'ra';
    const queue = this.config.get<string>('RABBITMQ_GATEWAY_QUEUE') || 'gateway';
    this.rabbit.subscribe(exchange, queue, (payload) => this.handle(payload));
    this.logger.log(`Listening for WhatsApp events on ${exchange}/${queue}`);
  }

  private async handle(envelope: any): Promise<void> {
    const event = envelope?.event;
    if (!event) {
      this.logger.warn(`Envelope missing 'event' field — dropping. Keys: ${Object.keys(envelope ?? {}).join(',')}`);
      return;
    }

    switch (event) {
      case 'WA_INBOUND_MESSAGE':
        await this.onInboundMessage(envelope.payload);
        return;
      case 'WA_VERIFICATION_RESULT':
        await this.onVerificationResult(envelope.payload);
        return;
      case 'WA_OUTBOUND_MESSAGE_STATUS':
        await this.onOutboundMessageStatus(envelope.payload);
        return;
      case 'WA_MESSAGE_STATUS':
        await this.onMessageStatus(envelope.payload);
        return;
      default:
        // Defer other events to later phases. Log so we can see what's being skipped.
        this.logger.debug(`Skipping event ${event} (not handled yet)`);
        return;
    }
  }

  /**
   * Status progression for outbound WhatsApp messages, from earliest to
   * latest. Used to prevent out-of-order webhooks from downgrading a row
   * (e.g. a delayed "delivered" arriving AFTER "read" must not overwrite).
   * 'failed' is a terminal terminal-status that can land at any point.
   */
  private static readonly OUTBOUND_STATUS_RANK: Record<string, number> = {
    pending: 0,
    sent: 1,
    delivered: 2,
    read: 3,
  };

  /**
   * Meta webhook → microservice → ra/gateway as `WA_MESSAGE_STATUS`.
   * Payload shape (from MessageService.processMessage statuses branch):
   *   { messageId (wamid), status: 'sent'|'delivered'|'read'|'failed',
   *     timestamp, recipient_id, errors?, phone, account }
   *
   * We correlate by wamid (set on wa_messages when WA_OUTBOUND_MESSAGE_STATUS
   * came back from the immediate API call), apply a no-downgrade update, and
   * broadcast to the workspace so the UI flips the tick marks.
   */
  private async onMessageStatus(payload: any): Promise<void> {
    const wamid = payload?.messageId;
    const newStatus = payload?.status;
    if (!wamid || !newStatus) {
      this.logger.warn(
        `WA_MESSAGE_STATUS missing messageId or status — dropping. Payload keys: ${Object.keys(payload ?? {}).join(',')}`,
      );
      return;
    }

    const msg = await this.prisma.wa_messages.findFirst({ where: { wamid } });
    if (!msg) {
      // Most likely the row was created by a different backend instance or
      // wamid persistence is lagging behind. Log and bail — the next status
      // event will likely succeed once the row catches up.
      this.logger.warn(`WA_MESSAGE_STATUS for unknown wamid=${wamid} (status=${newStatus})`);
      return;
    }

    const currentRank = WhatsappEventsConsumer.OUTBOUND_STATUS_RANK[msg.status] ?? 0;
    const newRank = WhatsappEventsConsumer.OUTBOUND_STATUS_RANK[newStatus] ?? 0;
    const isTerminalFailure = newStatus === 'failed';

    // Allow only forward progression OR a failed-state takeover. This protects
    // against late "delivered" webhooks overwriting a confirmed "read".
    if (!isTerminalFailure && newRank <= currentRank) {
      this.logger.debug(
        `WA_MESSAGE_STATUS no-op for wa_message ${msg.id}: ${msg.status}(${currentRank}) >= ${newStatus}(${newRank})`,
      );
      return;
    }

    const now = new Date();
    const errorData =
      Array.isArray(payload.errors) && payload.errors[0]
        ? JSON.stringify(payload.errors[0])
        : null;

    await this.prisma.wa_messages.update({
      where: { id: msg.id },
      data: {
        status: newStatus,
        updated_at: now,
        ...(errorData ? { error_data: errorData } : {}),
      },
    });

    this.logger.log(
      `wa_message ${msg.id} status ${msg.status} → ${newStatus} (wamid=${wamid})`,
    );

    // Broadcast a status delta to the workspace so the open chat re-renders ticks.
    const chat = await this.prisma.wa_chats.findUnique({ where: { id: msg.wa_chat_id } });
    if (chat) {
      const account = await this.prisma.wa_accounts.findUnique({ where: { id: chat.wa_account_id } });
      if (account) {
        this.chatGateway.emitToWorkspace(account.workspace_id, 'message_status', {
          wa_message_id: msg.id.toString(),
          wamid,
          status: newStatus,
          error: errorData,
        });
      }
    }
  }

  /**
   * Microservice publishes this after processing our WA_REGISTER:
   *   { status: 'VERIFIED' | <error_code>, account: { id (Mongo), meta: {...}, ... } }
   *
   * We tagged the request with `meta.backend_wa_account_id` so the round-trip
   * tells us which MySQL row to flip from PENDING.
   */
  private async onVerificationResult(payload: any): Promise<void> {
    const backendId = payload?.account?.meta?.backend_wa_account_id;
    if (!backendId) {
      this.logger.warn(
        `WA_VERIFICATION_RESULT missing meta.backend_wa_account_id — cannot correlate. Status was: ${payload?.status}`,
      );
      return;
    }

    let waAccountId: bigint;
    try {
      waAccountId = BigInt(backendId);
    } catch {
      this.logger.warn(`WA_VERIFICATION_RESULT has unparseable backend_wa_account_id=${backendId}`);
      return;
    }

    const account = await this.prisma.wa_accounts.findUnique({ where: { id: waAccountId } });
    if (!account) {
      this.logger.warn(`WA_VERIFICATION_RESULT for missing wa_account_id=${waAccountId}`);
      return;
    }

    // Capture the microservice's Mongo _id so the outbound flow can address the
    // account when publishing WA_OUTBOUND_MESSAGE. The microservice (post-patch)
    // returns the existing doc on ACCOUNT_EXIST too, so this value is reliable
    // whether registration created a fresh doc or re-used one.
    const metaAccountId =
      payload?.account?.id != null ? String(payload.account.id) : null;

    const now = new Date();
    if (payload.status === 'VERIFIED') {
      await this.prisma.wa_accounts.update({
        where: { id: account.id },
        data: {
          status: 'ACTIVE',
          updated_at: now,
          ...(metaAccountId ? { meta_account_id: metaAccountId } : {}),
        },
      });
      // Flip the linked phone number too so the UI shows it as live.
      await this.prisma.wa_phone_numbers.updateMany({
        where: { wa_account_id: account.id, status: 'PENDING' },
        data: { status: 'ACTIVE', last_onboarded_time: now, updated_at: now },
      });
      this.logger.log(
        `wa_account ${account.id} (waba=${account.waba_id}) verified — status=ACTIVE, meta_account_id=${metaAccountId ?? '(none)'}`,
      );
    } else {
      const errorCode = typeof payload.status === 'string' ? payload.status : 'REGISTRATION_FAILED';
      await this.prisma.wa_accounts.update({
        where: { id: account.id },
        data: {
          status: 'FAILED',
          error_code: errorCode,
          updated_at: now,
          ...(metaAccountId ? { meta_account_id: metaAccountId } : {}),
        },
      });
      this.logger.warn(`wa_account ${account.id} registration FAILED — code=${errorCode}`);
    }
  }

  /**
   * Microservice publishes this after attempting an outbound Meta API call:
   *   { meta: { backend_wa_message_id }, status: 'sent' | 'failed', messageId?, error? }
   *
   * We tagged the outbound payload with `meta.backend_wa_message_id` (the
   * wa_messages.id we created at PENDING). On status arrival we flip the row
   * to `sent` (storing the Meta wamid for future webhook correlation) or
   * `failed` (with the error payload), then broadcast a delta to the workspace
   * so the chat UI updates its delivery tick.
   *
   * Mirrors gateway PHP's WhatsappMessageBroker → outboundMessageStatus().
   */
  private async onOutboundMessageStatus(payload: any): Promise<void> {
    const backendMsgId = payload?.meta?.backend_wa_message_id;
    if (!backendMsgId) {
      this.logger.warn(
        `WA_OUTBOUND_MESSAGE_STATUS missing meta.backend_wa_message_id — cannot correlate. Status was: ${payload?.status}`,
      );
      return;
    }

    let waMessageId: bigint;
    try {
      waMessageId = BigInt(backendMsgId);
    } catch {
      this.logger.warn(`WA_OUTBOUND_MESSAGE_STATUS unparseable backend_wa_message_id=${backendMsgId}`);
      return;
    }

    const msg = await this.prisma.wa_messages.findUnique({ where: { id: waMessageId } });
    if (!msg) {
      this.logger.warn(`WA_OUTBOUND_MESSAGE_STATUS for missing wa_message_id=${waMessageId}`);
      return;
    }

    const now = new Date();
    const status = String(payload?.status ?? '').toLowerCase();
    const wamid = payload?.messageId ?? null;
    const errorPayload = payload?.error ? JSON.stringify(payload.error) : null;

    if (status === 'sent') {
      await this.prisma.wa_messages.update({
        where: { id: msg.id },
        data: {
          status: 'sent',
          wamid: wamid ?? undefined,
          updated_at: now,
        },
      });
      this.logger.log(`wa_message ${msg.id} → sent (wamid=${wamid ?? 'unknown'})`);
    } else {
      await this.prisma.wa_messages.update({
        where: { id: msg.id },
        data: {
          status: 'failed',
          error_data: errorPayload,
          updated_at: now,
        },
      });
      this.logger.warn(`wa_message ${msg.id} → failed (${errorPayload ?? 'no error data'})`);
    }

    // Broadcast a status delta to the workspace so the open chat updates its tick.
    const chat = await this.prisma.wa_chats.findUnique({ where: { id: msg.wa_chat_id } });
    if (chat) {
      const account = await this.prisma.wa_accounts.findUnique({ where: { id: chat.wa_account_id } });
      if (account) {
        this.chatGateway.emitToWorkspace(account.workspace_id, 'message_status', {
          wa_message_id: msg.id.toString(),
          status: status === 'sent' ? 'sent' : 'failed',
          wamid: wamid ?? null,
          error: errorPayload,
        });
      }
    }
  }

  /**
   * Process a single inbound WhatsApp message:
   *   1. Resolve wa_account (waba_id) + wa_phone_number (wa_number_id).
   *   2. Resolve or create contact + contact_mobile.
   *   3. Resolve or create wa_chats (1:1 with a (account, number, wa_id) triple).
   *   4. Insert wa_messages row.
   *   5. Upsert contact_last_messages so unified inbox surfaces the chat.
   *   6. Ensure an `inbox` row exists for this WhatsappChat — create one if not.
   *   7. Broadcast via WebSocket so connected agents see the update.
   *
   * Payload shape (from microservice MessageService.processMessage):
   *   { account: { businessAccountId, ... }, phone_number_id, contact_id, contact_name,
   *     display_phone_number, message: { id, type, timestamp, text?, image?, ... } }
   */
  private async onInboundMessage(payload: any): Promise<void> {
    if (!payload?.account?.businessAccountId || !payload?.phone_number_id || !payload?.contact_id || !payload?.message) {
      this.logger.warn(`WA_INBOUND_MESSAGE missing required fields — dropping. Payload keys: ${Object.keys(payload ?? {}).join(',')}`);
      return;
    }

    const wabaId = String(payload.account.businessAccountId);
    const metaPhoneNumberId = String(payload.phone_number_id);
    const waId = String(payload.contact_id); // customer's WhatsApp ID (phone digits, no +)
    const profileName = payload.contact_name ? String(payload.contact_name) : null;
    const msg = payload.message;

    // 1. Account + phone number lookup
    const account = await this.prisma.wa_accounts.findFirst({
      where: { waba_id: wabaId, deleted_at: null },
    });
    if (!account) {
      this.logger.warn(`No wa_accounts row for waba_id=${wabaId} — message dropped. Run manual onboarding or wait for Phase 5B.`);
      return;
    }

    const phoneNumber = await this.prisma.wa_phone_numbers.findFirst({
      where: { wa_number_id: metaPhoneNumberId, wa_account_id: account.id },
    });
    if (!phoneNumber) {
      this.logger.warn(`No wa_phone_numbers row for wa_number_id=${metaPhoneNumberId} on account ${account.id} — message dropped.`);
      return;
    }

    // 2. Contact resolution
    const fullMobile = waId.startsWith('+') ? waId : `+${waId}`;
    const contact = await this.resolveContact({
      workspaceId: account.workspace_id,
      fullMobile,
      waId,
      profileName,
    });

    // 3. Chat upsert — atomic on (wa_account_id, wa_number_id, wa_id) thanks to the
    //    unique constraint added in scripts/migrate-add-wa-chats-unique.ts. Race-safe
    //    even under parallel Meta webhook retries.
    const now = new Date();
    const chat = await this.prisma.wa_chats.upsert({
      where: {
        wa_account_id_wa_number_id_wa_id: {
          wa_account_id: account.id,
          wa_number_id: phoneNumber.id,
          wa_id: fullMobile,
        },
      },
      update: {
        last_client_interaction: now,
        last_interacted_at: now,
        updated_at: now,
        // Refresh profile_name if Meta sent a newer one
        ...(profileName ? { profile_name: profileName } : {}),
      },
      create: {
        wa_account_id: account.id,
        wa_number_id: phoneNumber.id,
        user_id: account.user_id,
        contact_id: contact.id,
        profile_name: profileName ?? null,
        wa_id: fullMobile,
        is_primary: true,
        input_attempts: 0n,
        last_client_interaction: now,
        last_interacted_at: now,
        created_at: now,
        updated_at: now,
      },
    });

    // 4. Insert wa_messages row
    const messageType = String(msg.type ?? 'text').toLowerCase();
    const text = msg.text?.body ?? null;
    const insertedMessage = await this.prisma.wa_messages.create({
      data: {
        wa_number_id: phoneNumber.id,
        wa_chat_id: chat.id,
        mobile_number: fullMobile,
        type: messageType,
        direction: 'INCOMING',
        text,
        status: 'received',
        wamid: msg.id ? String(msg.id) : null,
        timestamp: msg.timestamp ? String(msg.timestamp) : null,
        payload: JSON.stringify(msg),
        communication_mode: 'INBOX',
        created_at: now,
        updated_at: now,
      },
    });

    // 5. contact_last_messages — drives the unified inbox ordering
    await this.prisma.contact_last_messages.create({
      data: {
        contact_id: contact.id,
        channel: 'whatsapp',
        messageable_type: WHATSAPP_MESSAGE_MODELABLE,
        messageable_id: insertedMessage.id,
        chatable_type: WHATSAPP_CHAT_MODELABLE,
        chatable_id: chat.id,
        channelable_type: WHATSAPP_NUMBER_MODELABLE,
        channelable_id: phoneNumber.id,
        message: text,
        message_type: messageType,
        created_at: now,
      },
    });

    // 6. Inbox row — create on first message, update last_updated otherwise
    const existingInbox = await this.prisma.inbox.findFirst({
      where: { modelable_type: WHATSAPP_CHAT_MODELABLE, modelable_id: chat.id },
    });
    let inboxRow: any;
    if (!existingInbox) {
      inboxRow = await this.prisma.inbox.create({
        data: {
          workspace_id: account.workspace_id,
          user_id: null,
          assigned_by: null,
          type: 'WHATSAPP',
          status: 'UNASSIGNED',
          is_read: 0,
          is_assigned: 0,
          snooze: new Date(0), // schema requires non-null DateTime
          modelable_type: WHATSAPP_CHAT_MODELABLE,
          modelable_id: chat.id,
          queued_at: now,
          last_updated: now,
          created_at: now,
          updated_at: now,
        },
      });
    } else {
      inboxRow = await this.prisma.inbox.update({
        where: { id: existingInbox.id },
        data: {
          is_read: 0,
          last_updated: now,
          updated_at: now,
          // Re-open if previously closed — a fresh inbound deserves attention.
          status: existingInbox.status === 'COMPLETED' ? 'UNASSIGNED' : existingInbox.status,
        },
      });
    }

    // 7. Real-time broadcast — frontend subscribes per workspace room.
    // We emit TWO events so future consumers can pick whichever shape they prefer:
    //   - `new_message`: generic event the existing ConversationsInbox page already listens to
    //     (payload shape: { inbox_id, message: { text } }) — drives inbox-list refresh
    //     and toast notifications.
    //   - `whatsapp.message.inbound`: WhatsApp-specific fan-out for future channel-aware
    //     UI (carries chat_id, wa_id, profile_name, message type/media).
    const inboxIdStr = inboxRow.id.toString();
    this.chatGateway.emitToWorkspace(account.workspace_id, 'new_message', {
      inbox_id: inboxIdStr,
      message: { text },
    });
    this.chatGateway.emitToWorkspace(account.workspace_id, 'whatsapp.message.inbound', {
      account_id: account.id.toString(),
      chat_id: chat.id.toString(),
      contact_id: contact.id.toString(),
      inbox_id: inboxIdStr,
      message_id: insertedMessage.id.toString(),
      wa_id: fullMobile,
      profile_name: profileName,
      type: messageType,
      text,
      timestamp: msg.timestamp ?? null,
    });

    // Automation trigger events — `message.inbound` is the catch-all that
    // AutomationTriggerService listens on. Channel-specific specialisations
    // (wa_ref_start, wa_ad_clicked) come from the same Meta payload shape:
    //   - Ref-link starts:   the inbound text body opens with a `ref_<code>`
    //     token because the user clicked a wa.me link with `?text=ref_<code>`.
    //   - Ad-click inbounds: Meta attaches a `referral` object with
    //     `source_type === 'ad'` and the ad/post identifiers.
    // Both shapes are documented at
    //   https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/
    this.events.emit('message.inbound', {
      workspaceId: account.workspace_id,
      inboxId: inboxRow.id,
      contactId: contact.id,
      channel: 'whatsapp',
      text,
    });

    const refMatch = typeof text === 'string' ? text.match(/^\s*ref[_:\-]([A-Za-z0-9_\-.]+)/i) : null;
    if (refMatch) {
      this.events.emit('message.wa_ref_start', {
        contactId: contact.id,
        workspaceId: account.workspace_id,
        refCode: refMatch[1],
      });
    }

    const referral = msg?.referral;
    if (referral && (referral.source_type === 'ad' || referral.source_type === 'ctwa_ad')) {
      this.events.emit('message.wa_ad_clicked', {
        contactId: contact.id,
        workspaceId: account.workspace_id,
        adId:
          referral.source_id ??
          referral.source?.id ??
          referral.ad_id ??
          null,
        referral,
      });
    }

    this.logger.log(`WA inbound saved: chat=${chat.id} message=${insertedMessage.id} from=${fullMobile}`);
  }

  /**
   * Find an existing contact by mobile number (workspace-scoped), otherwise create one.
   * Mirrors gateway PHP's WhatsappHelper::getChat() contact lookup, simplified — for
   * the country-detection logic we fall back to FALLBACK_COUNTRY_ID; proper parsing
   * lands in Phase 5B (mirrors gateway's parseMobileNumber helper).
   */
  private async resolveContact(args: {
    workspaceId: bigint;
    fullMobile: string;
    waId: string;
    profileName: string | null;
  }) {
    const { workspaceId, fullMobile, waId, profileName } = args;

    const altMobile = waId.startsWith('+') ? waId : `+${waId}`;
    const existingMobile = await this.prisma.contact_mobiles.findFirst({
      where: {
        ownership_type: WORKSPACE_MODELABLE,
        ownership_id: workspaceId,
        modelable_type: CONTACT_MODELABLE,
        OR: [{ full_mobile_number: fullMobile }, { full_mobile_number: altMobile }],
      },
    });

    if (existingMobile) {
      const c = await this.prisma.contacts.findUnique({
        where: { id: existingMobile.modelable_id },
      });
      if (c && !c.deleted_at) return c;
    }

    const countryId = await this.detectCountryId(waId);
    const now = new Date();
    const fallbackName = profileName?.trim() || waId;
    const contact = await this.prisma.contacts.create({
      data: {
        workspace_id: workspaceId,
        first_name: profileName ? profileName.split(' ')[0] : null,
        last_name: profileName && profileName.includes(' ') ? profileName.split(' ').slice(1).join(' ') : null,
        full_name: fallbackName,
        source: 'WHATSAPP',
        status: 'ACTIVE',
        created_at: now,
        updated_at: now,
      },
    });

    await this.prisma.contact_mobiles.create({
      data: {
        ownership_type: WORKSPACE_MODELABLE,
        ownership_id: workspaceId,
        modelable_type: CONTACT_MODELABLE,
        modelable_id: contact.id,
        country_id: countryId,
        country_code: this.guessCountryCode(waId),
        mobile_number: waId,
        national_mobile_number: waId,
        full_mobile_number: fullMobile,
        type: 'whatsapp',
        slug: 'whatsapp',
        is_primary: 1,
        created_at: now,
        updated_at: now,
      },
    });

    return contact;
  }

  /**
   * Best-effort country lookup by phone_code prefix on the raw wa_id digits.
   * Falls back to FALLBACK_COUNTRY_ID when nothing matches (e.g., countries table
   * empty or unusual phone code). A proper parser ships in Phase 5B.
   */
  private async detectCountryId(waId: string): Promise<bigint> {
    const digits = waId.replace(/[^0-9]/g, '');
    for (const len of [3, 2, 1]) {
      if (digits.length <= len) continue;
      const prefix = digits.slice(0, len);
      const match = await this.prisma.countries.findFirst({
        where: { phone_code: prefix },
        select: { id: true },
      });
      if (match) return match.id;
    }
    return FALLBACK_COUNTRY_ID;
  }

  private guessCountryCode(waId: string): string {
    const digits = waId.replace(/[^0-9]/g, '');
    // Prefer 3-digit codes (e.g., 234 Nigeria); fall back to 2 then 1.
    if (digits.length > 3) return digits.slice(0, 3);
    if (digits.length > 2) return digits.slice(0, 2);
    return digits.slice(0, 1);
  }
}
