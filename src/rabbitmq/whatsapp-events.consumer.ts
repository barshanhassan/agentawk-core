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
      // ── Instagram events ───────────────────────────────────────────
      case 'INSTA_VERIFICATION_RESULT':
        await this.onInstaVerificationResult(envelope.payload);
        return;
      case 'INSTA_INBOUND_MESSAGE':
        await this.onInstaInboundMessage(envelope.payload);
        return;
      case 'INSTA_OUTBOUND_MESSAGE_STATUS':
        await this.onInstaOutboundMessageStatus(envelope.payload);
        return;
      case 'INSTA_DELIVERY_STATUS':
        await this.onInstaDeliveryStatus(envelope.payload);
        return;
      case 'INSTA_READ_STATUS':
        await this.onInstaReadStatus(envelope.payload);
        return;
      case 'INSTA_ACCOUNT_DELETED':
      case 'INSTA_ACCOUNT_DELETION_FAILED':
        await this.onInstaAccountDeleted(envelope.payload, event);
        return;
      case 'INSTA_COMMENT':
        await this.onInstaComment(envelope.payload);
        return;
      case 'INSTA_ECHO_MESSAGE':
        await this.onInstaEchoMessage(envelope.payload);
        return;
      case 'INSTA_REFERRAL':
      case 'INSTA_POSTBACK':
        this.logger.debug(`Instagram event ${event} received (automation triggers pending)`);
        return;
      default:
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

        // Notify outbound webhook subscribers (Developer Settings → Webhooks).
        // Map WhatsApp's `sent | delivered | read | failed` 1:1 to our event
        // slugs; anything else (e.g. accepted) is internal-only.
        const eventName =
          newStatus === 'sent'
            ? 'message.sent'
            : newStatus === 'delivered'
              ? 'message.delivered'
              : newStatus === 'read'
                ? 'message.read'
                : newStatus === 'failed'
                  ? 'message.failed'
                  : null;
        if (eventName) {
          this.events.emit(eventName, {
            workspaceId: account.workspace_id,
            wa_message_id: msg.id.toString(),
            wa_chat_id: chat.id.toString(),
            wamid,
            channel: 'whatsapp',
            status: newStatus,
            error: errorData,
            occurred_at: now.toISOString(),
          });
        }
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
    let updatedAccount: any = null;
    let updatedNumbers: any[] = [];
    if (payload.status === 'VERIFIED') {
      updatedAccount = await this.prisma.wa_accounts.update({
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
      updatedNumbers = await this.prisma.wa_phone_numbers.findMany({
        where: { wa_account_id: account.id },
      });
      this.logger.log(
        `wa_account ${account.id} (waba=${account.waba_id}) verified — status=ACTIVE, meta_account_id=${metaAccountId ?? '(none)'}`,
      );
    } else {
      const errorCode = typeof payload.status === 'string' ? payload.status : 'REGISTRATION_FAILED';
      updatedAccount = await this.prisma.wa_accounts.update({
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

    // Notify the workspace's connected clients so the WhatsApp settings page
    // (and any other listener) re-fetches the channels list and flips the
    // status badge from PENDING → ACTIVE / FAILED in real time. Without this
    // the user has to refresh the page to see the result.
    try {
      const serialize = (row: any) => ({
        ...row,
        id: row.id?.toString(),
        workspace_id: row.workspace_id?.toString(),
        user_id: row.user_id?.toString?.(),
        wa_account_id: row.wa_account_id?.toString?.(),
        auto_reply_automation_id: row.auto_reply_automation_id?.toString?.() ?? null,
      });
      this.chatGateway.emitToWorkspace(
        account.workspace_id,
        'whatsapp.account_updated',
        serialize(updatedAccount),
      );
      for (const n of updatedNumbers) {
        this.chatGateway.emitToWorkspace(
          account.workspace_id,
          'whatsapp.number_updated',
          serialize(n),
        );
      }
    } catch (e: any) {
      this.logger.debug(`onVerificationResult emit failed: ${e?.message ?? e}`);
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
    if (digits.length > 3) return digits.slice(0, 3);
    if (digits.length > 2) return digits.slice(0, 2);
    return digits.slice(0, 1);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Instagram event handlers
  // ═══════════════════════════════════════════════════════════════════

  /**
   * INSTA_VERIFY result from instagram-master.
   * Payload: { status: 'VERIFIED' | error_code, account: { id (Mongo), ig_user_id, username, meta: { backend_insta_page_id } } }
   */
  private async onInstaVerificationResult(payload: any): Promise<void> {
    const backendPageId = payload?.account?.meta?.backend_insta_page_id;
    if (!backendPageId) {
      this.logger.warn(`INSTA_VERIFICATION_RESULT missing meta.backend_insta_page_id`);
      return;
    }

    let pageId: bigint;
    try { pageId = BigInt(backendPageId); } catch {
      this.logger.warn(`INSTA_VERIFICATION_RESULT unparseable backend_insta_page_id=${backendPageId}`);
      return;
    }

    const page = await this.prisma.insta_pages.findUnique({ where: { id: pageId } });
    if (!page) {
      this.logger.warn(`INSTA_VERIFICATION_RESULT for missing insta_page id=${pageId}`);
      return;
    }

    const mongoId = payload?.account?.id ? String(payload.account.id) : null;
    const now = new Date();

    if (payload.status === 'VERIFIED') {
      await this.prisma.insta_pages.update({
        where: { id: page.id },
        data: { status: 'ACTIVE', service_account_id: mongoId, updated_at: now },
      });
      this.logger.log(`insta_page ${page.id} verified — ACTIVE, service_account_id=${mongoId}`);
    } else {
      const code = typeof payload.status === 'string' ? payload.status : 'VERIFICATION_FAILED';
      await this.prisma.insta_pages.update({
        where: { id: page.id },
        data: { status: 'FAILED', fail_reason: code, updated_at: now },
      });
      this.logger.warn(`insta_page ${page.id} verification FAILED — ${code}`);
    }

    this.chatGateway.emitToWorkspace(page.workspace_id, 'instagram.page_updated', {
      id: page.id.toString(),
      status: payload.status === 'VERIFIED' ? 'ACTIVE' : 'FAILED',
      service_account_id: mongoId,
    });
  }

  /**
   * Inbound Instagram message from instagram-master (already media-processed).
   * Payload: { account: { id, meta: { backend_insta_page_id } }, object: messaging }
   */
  private async onInstaInboundMessage(payload: any): Promise<void> {
    const backendPageId = payload?.account?.meta?.backend_insta_page_id;
    const messaging = payload?.object;
    if (!backendPageId || !messaging) {
      this.logger.warn(`INSTA_INBOUND_MESSAGE missing backend_insta_page_id or object`);
      return;
    }

    let pageId: bigint;
    try { pageId = BigInt(backendPageId); } catch {
      this.logger.warn(`INSTA_INBOUND_MESSAGE unparseable backend_insta_page_id=${backendPageId}`);
      return;
    }

    const page = await this.prisma.insta_pages.findUnique({ where: { id: pageId } });
    if (!page) { this.logger.warn(`INSTA_INBOUND_MESSAGE no insta_page id=${pageId}`); return; }

    const senderId: string = messaging.sender?.id;
    if (!senderId) { this.logger.warn(`INSTA_INBOUND_MESSAGE missing sender.id`); return; }

    // Skip echo messages
    if (messaging.message?.is_echo) return;

    // Delivery and read receipts are handled by onInstaDeliveryStatus / onInstaReadStatus
    if (messaging.delivery || messaging.read) return;

    // Reaction events — save to message_reactions and notify UI, but don't create a message row
    if (messaging.reaction) {
      const reactObj = messaging.reaction;
      if (reactObj.mid) {
        try {
          const now2 = new Date();
          const targetMsg = await this.prisma.insta_messages.findFirst({
            where: { mid: reactObj.mid },
          });
          if (targetMsg) {
            const msgType = 'App\\Models\\Instagram\\InstagramMessage';
            if (reactObj.action === 'unreact') {
              await this.prisma.message_reactions.deleteMany({
                where: { message_type: msgType, message_id: targetMsg.id, direction: 'INCOMING' },
              });
            } else {
              const existingReaction = await this.prisma.message_reactions.findFirst({
                where: { message_type: msgType, message_id: targetMsg.id, direction: 'INCOMING' },
              });
              if (existingReaction) {
                await this.prisma.message_reactions.update({
                  where: { id: existingReaction.id },
                  data: { reaction: reactObj.emoji ?? reactObj.reaction, updated_at: now2 },
                });
              } else {
                await this.prisma.message_reactions.create({
                  data: {
                    workspace_id: page.workspace_id,
                    message_type: msgType,
                    message_id: targetMsg.id,
                    reaction: reactObj.emoji ?? reactObj.reaction,
                    direction: 'INCOMING',
                    communication_mode: 'INBOX',
                    created_at: now2,
                    updated_at: now2,
                  },
                });
              }
            }
            // Emit socket so frontend refreshes the message thread
            const instaChat = await this.prisma.insta_chats.findFirst({
              where: { insta_page_id: page.id, sender_id: senderId },
            });
            if (instaChat) {
              const instaInbox = await this.prisma.inbox.findFirst({
                where: { modelable_type: 'App\\Models\\Instagram\\InstaChat', modelable_id: instaChat.id, status: { not: 'DELETED' } },
              });
              if (instaInbox) {
                this.chatGateway.emitToWorkspace(page.workspace_id, 'message_reaction', {
                  inbox_id: instaInbox.id.toString(),
                  message_id: targetMsg.id.toString(),
                  reaction: reactObj.emoji ?? reactObj.reaction,
                  action: reactObj.action,
                });
              }
            }
          }
        } catch (e: any) {
          this.logger.warn(`[IG REACTION] inbound save failed: ${e?.message}`);
        }
      }
      return;
    }

    const now = new Date();
    const msgObj = messaging.message ?? {};
    const mid: string | null = msgObj.mid ?? null;
    const text: string | null = msgObj.text ?? null;
    const msgType = msgObj.attachments?.length ? String(msgObj.attachments[0]?.type ?? 'attachment') : 'text';
    const attachmentsData = msgObj.attachments?.length ? JSON.stringify(msgObj.attachments) : null;

    // Instagram webhooks never include sender name — fetch from Graph API
    // Mirrors replyagent InstagramTrait::getInstaUserProfile($page, $sender_id)
    let senderName: string | null = messaging.sender?.name ?? null;
    if (!senderName && page.access_token) {
      try {
        const igVer = process.env.META_GRAPH_API_VERSION ?? 'v22.0';
        const isFbPlatform = (page.platform ?? 'facebook') === 'facebook';
        const profileApiBase = isFbPlatform ? 'https://graph.facebook.com' : 'https://graph.instagram.com';
        const profileFields = isFbPlatform ? 'name' : 'name,username';
        const profileRes = await fetch(
          `${profileApiBase}/${igVer}/${senderId}?fields=${profileFields}&access_token=${page.access_token}`,
        );
        const profileJson = await profileRes.json();
        this.logger.log(`IG sender profile fetch for ${senderId} (platform=${page.platform ?? 'facebook'}): ${JSON.stringify(profileJson)}`);
        if (profileRes.ok && !profileJson.error) {
          senderName = profileJson.name ?? profileJson.username ?? null;
          this.logger.log(`IG sender profile for ${senderId}: name=${senderName}`);
        } else {
          this.logger.warn(`IG sender profile error for ${senderId}: ${JSON.stringify(profileJson?.error ?? profileJson)}`);
        }
      } catch (e: any) {
        this.logger.warn(`Could not fetch IG sender profile for ${senderId}: ${e?.message}`);
      }
    }

    // Resolve or create contact
    const contact = await this.resolveInstaContact(page.workspace_id, senderId, senderName);

    // Update contact with real name if current name is a fallback (null, sender ID, numeric, or "Unknown")
    const needsNameUpdate = senderName && (
      !contact.full_name ||
      contact.full_name === senderId ||
      contact.full_name === 'Unknown' ||
      /^\d+$/.test(contact.full_name)
    );
    if (needsNameUpdate) {
      const nameParts = senderName!.trim().split(' ');
      await this.prisma.contacts.update({
        where: { id: contact.id },
        data: {
          first_name: nameParts[0] ?? null,
          last_name: nameParts.length > 1 ? nameParts.slice(1).join(' ') : null,
          full_name: senderName,
          updated_at: now,
        },
      });
      // Also update insta_chats that reference this contact
      await this.prisma.insta_chats.updateMany({
        where: { contact_id: contact.id },
        data: { name: senderName, updated_at: now },
      });
      contact.full_name = senderName!;
    }

    // Resolve or create insta_chat. Always pick the OLDEST record to handle any
    // duplicate chats that may exist from prior race conditions.
    let chat = await this.prisma.insta_chats.findFirst({
      where: { insta_page_id: page.id, sender_id: senderId },
      orderBy: { created_at: 'asc' },
    });
    if (!chat) {
      chat = await this.prisma.insta_chats.create({
        data: {
          insta_page_id: page.id,
          user_id: page.user_id,
          contact_id: contact.id,
          sender_id: senderId,
          name: contact.full_name ?? null,
          recipient_id: messaging.recipient?.id ?? page.ig_user_id ?? '',
          last_interacted_at: now,
          last_client_interaction: now,
          input_attempts: 0n,
          created_at: now,
          updated_at: now,
        },
      });
      // Race-condition guard: another concurrent handler may have created the chat
      // at the same time. If so, prefer the oldest record and discard ours.
      const oldest = await this.prisma.insta_chats.findFirst({
        where: { insta_page_id: page.id, sender_id: senderId },
        orderBy: { created_at: 'asc' },
      });
      if (oldest && oldest.id !== chat.id) {
        await this.prisma.insta_chats.delete({ where: { id: chat.id } }).catch(() => {});
        chat = oldest;
      }
    } else {
      await this.prisma.insta_chats.update({
        where: { id: chat.id },
        data: { last_interacted_at: now, last_client_interaction: now, updated_at: now,
                ...(contact.id ? { contact_id: contact.id } : {}) },
      });
    }

    // Save message
    const message = await this.prisma.insta_messages.create({
      data: {
        insta_page_id: page.id,
        insta_chat_id: chat.id,
        type: msgType,
        direction: 'IN',
        text,
        status: 'received',
        mid,
        payload: attachmentsData ?? JSON.stringify(messaging),
        timestamp: messaging.timestamp ? String(messaging.timestamp) : null,
        created_at: now,
        updated_at: now,
      },
    });

    // Inbox row — only reuse a non-DELETED inbox. If the previous inbox was
    // soft-deleted (user cleared it), create a fresh one so re-messaging
    // customer appears as a new conversation, not an invisible update.
    const INSTA_CHAT_MODELABLE = 'App\\Models\\Instagram\\InstaChat';
    const existingInbox = await this.prisma.inbox.findFirst({
      where: { modelable_type: INSTA_CHAT_MODELABLE, modelable_id: chat.id, status: { not: 'DELETED' } },
    });
    let inboxRow: any;
    if (!existingInbox) {
      inboxRow = await this.prisma.inbox.create({
        data: {
          workspace_id: page.workspace_id,
          user_id: null,
          assigned_by: null,
          type: 'INSTAGRAM',
          status: 'UNASSIGNED',
          is_read: 0,
          is_assigned: 0,
          snooze: new Date(0),
          modelable_type: INSTA_CHAT_MODELABLE,
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
          // COMPLETED = re-open as UNASSIGNED; ACTIVE/UNASSIGNED = keep current status
          status: existingInbox.status === 'COMPLETED' ? 'UNASSIGNED' : existingInbox.status,
        },
      });
    }

    // Broadcast
    this.chatGateway.emitToWorkspace(page.workspace_id, 'new_message', {
      inbox_id: inboxRow.id.toString(),
      message: { text },
    });
    this.chatGateway.emitToWorkspace(page.workspace_id, 'instagram.message.inbound', {
      page_id: page.id.toString(),
      chat_id: chat.id.toString(),
      contact_id: contact.id.toString(),
      inbox_id: inboxRow.id.toString(),
      message_id: message.id.toString(),
      sender_id: senderId,
      type: msgType,
      text,
      mid,
    });

    this.events.emit('message.inbound', {
      workspaceId: page.workspace_id,
      inboxId: inboxRow.id,
      contactId: contact.id,
      channel: 'instagram',
      text,
    });

    this.logger.log(`INSTA inbound saved: chat=${chat.id} message=${message.id} from=${senderId}`);
  }

  /**
   * INSTA_OUTBOUND_MESSAGE_STATUS — microservice result after sending via Meta API.
   * Payload includes meta.backend_insta_message_id for correlation.
   */
  private async onInstaOutboundMessageStatus(payload: any): Promise<void> {
    const backendMsgId = payload?.meta?.backend_insta_message_id;
    if (!backendMsgId) {
      this.logger.warn(`INSTA_OUTBOUND_MESSAGE_STATUS missing meta.backend_insta_message_id`);
      return;
    }

    let msgId: bigint;
    try { msgId = BigInt(backendMsgId); } catch { return; }

    const msg = await this.prisma.insta_messages.findUnique({ where: { id: msgId } });
    if (!msg) { this.logger.warn(`INSTA_OUTBOUND_MESSAGE_STATUS for missing message id=${msgId}`); return; }

    const status = String(payload?.status ?? '').toLowerCase();
    const mid = payload?.response?.message_id ?? null;
    const now = new Date();

    await this.prisma.insta_messages.update({
      where: { id: msg.id },
      data: {
        status: status === 'sent' ? 'sent' : 'failed',
        mid: mid ?? undefined,
        updated_at: now,
      },
    });

    const page = await this.prisma.insta_pages.findUnique({ where: { id: msg.insta_page_id } });
    if (page) {
      this.chatGateway.emitToWorkspace(page.workspace_id, 'message_status', {
        insta_message_id: msg.id.toString(),
        status: status === 'sent' ? 'sent' : 'failed',
        mid: mid ?? null,
      });
    }
    if (status !== 'sent') {
      this.logger.warn(`INSTA outbound message ${msg.id} FAILED — reason: ${payload?.reason ?? 'unknown'} | meta_error: ${JSON.stringify(payload?.response ?? null)}`);
    }
    this.logger.log(`INSTA outbound message ${msg.id} → ${status} (mid=${mid ?? 'unknown'})`);
  }

  /**
   * INSTA_ECHO_MESSAGE — message sent from the business's phone/Instagram app.
   * Meta fires is_echo=true; instagram-master now publishes this as INSTA_ECHO_MESSAGE.
   * We store it as an OUTGOING message so it appears in the Ezconn inbox.
   */
  private async onInstaEchoMessage(payload: any): Promise<void> {
    const backendPageId = payload?.account?.meta?.backend_insta_page_id;
    const messaging = payload?.object;
    if (!backendPageId || !messaging) {
      this.logger.warn(`INSTA_ECHO_MESSAGE missing backend_insta_page_id or object`);
      return;
    }

    let pageId: bigint;
    try { pageId = BigInt(backendPageId); } catch {
      this.logger.warn(`INSTA_ECHO_MESSAGE unparseable backend_insta_page_id=${backendPageId}`);
      return;
    }

    const page = await this.prisma.insta_pages.findUnique({ where: { id: pageId } });
    if (!page) { this.logger.warn(`INSTA_ECHO_MESSAGE no insta_page id=${pageId}`); return; }

    // For echo: sender = business IG user, recipient = customer
    const customerId: string = messaging.recipient?.id;
    if (!customerId) { this.logger.warn(`INSTA_ECHO_MESSAGE missing recipient.id`); return; }

    const msgObj = messaging.message ?? {};
    const mid: string | null = msgObj.mid ?? null;
    const text: string | null = msgObj.text ?? null;
    const msgType = msgObj.attachments?.length
      ? String(msgObj.attachments[0]?.type ?? 'attachment')
      : 'text';
    const attachmentsData = msgObj.attachments?.length ? JSON.stringify(msgObj.attachments) : null;

    const now = new Date();

    // Deduplicate by mid
    if (mid) {
      const existing = await this.prisma.insta_messages.findFirst({
        where: { mid, direction: 'OUTGOING' },
      });
      if (existing) {
        this.logger.log(`INSTA_ECHO_MESSAGE duplicate mid=${mid} — skipped`);
        return;
      }
    }

    // Resolve or create contact for the customer
    const contact = await this.resolveInstaContact(page.workspace_id, customerId, null);

    // Find or create insta_chat — customer is sender_id. Always pick the OLDEST record.
    let chat = await this.prisma.insta_chats.findFirst({
      where: { insta_page_id: page.id, sender_id: customerId },
      orderBy: { created_at: 'asc' },
    });
    if (!chat) {
      chat = await this.prisma.insta_chats.create({
        data: {
          insta_page_id: page.id,
          user_id: page.user_id,
          contact_id: contact.id,
          sender_id: customerId,
          name: contact.full_name ?? null,
          recipient_id: page.ig_user_id ?? '',
          last_interacted_at: now,
          last_client_interaction: now,
          input_attempts: 0n,
          created_at: now,
          updated_at: now,
        },
      });
      // Race-condition guard: prefer the oldest record if a concurrent create raced us.
      const oldest = await this.prisma.insta_chats.findFirst({
        where: { insta_page_id: page.id, sender_id: customerId },
        orderBy: { created_at: 'asc' },
      });
      if (oldest && oldest.id !== chat.id) {
        await this.prisma.insta_chats.delete({ where: { id: chat.id } }).catch(() => {});
        chat = oldest;
      }
    } else {
      await this.prisma.insta_chats.update({
        where: { id: chat.id },
        data: { last_interacted_at: now, updated_at: now },
      });
    }

    // If this echo matches a recently-sent Ezconn message, skip creating a duplicate.
    // Two sub-cases handled:
    //   (a) mid still null  — STATUS_UPDATE not yet processed (race: echo arrived first via HTTP,
    //       status update still queued in RabbitMQ)
    //   (b) mid already set — STATUS_UPDATE processed between CHECK 1 and here; CHECK 1 was
    //       evaluated while mid was still null so it passed, but by now the mid is set
    if (mid) {
      const cutoff = new Date(now.getTime() - 2 * 60 * 1000);
      const ezconnSent = await this.prisma.insta_messages.findFirst({
        where: {
          insta_chat_id: chat.id,
          direction: 'OUTGOING',
          sender_id: { not: null },
          created_at: { gte: cutoff },
          OR: [
            { mid: null },  // (a) pending — STATUS_UPDATE not yet processed
            { mid },        // (b) race — STATUS_UPDATE ran between CHECK 1 and here
          ],
        },
        orderBy: { created_at: 'desc' },
      });
      if (ezconnSent) {
        if (!ezconnSent.mid) {
          await this.prisma.insta_messages.update({
            where: { id: ezconnSent.id },
            data: { mid, updated_at: now },
          });
        }
        this.logger.log(`INSTA_ECHO_MESSAGE matched Ezconn msg=${ezconnSent.id} → skipping duplicate`);
        return;
      }
    }

    // Save as OUTGOING message
    const message = await this.prisma.insta_messages.create({
      data: {
        insta_page_id: page.id,
        insta_chat_id: chat.id,
        type: msgType,
        direction: 'OUTGOING',
        text,
        status: 'sent',
        mid,
        payload: attachmentsData ?? JSON.stringify(messaging),
        timestamp: messaging.timestamp ? String(messaging.timestamp) : null,
        created_at: now,
        updated_at: now,
      },
    });

    // Find or create inbox row — is_read=1 because we sent it
    const INSTA_CHAT_MODELABLE = 'App\\Models\\Instagram\\InstaChat';
    const existingInbox = await this.prisma.inbox.findFirst({
      where: { modelable_type: INSTA_CHAT_MODELABLE, modelable_id: chat.id },
    });
    let inboxRow: any;
    if (!existingInbox) {
      inboxRow = await this.prisma.inbox.create({
        data: {
          workspace_id: page.workspace_id,
          user_id: null,
          assigned_by: null,
          type: 'INSTAGRAM',
          status: 'UNASSIGNED',
          is_read: 1,
          is_assigned: 0,
          snooze: new Date(0),
          modelable_type: INSTA_CHAT_MODELABLE,
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
        data: { last_updated: now, updated_at: now, is_read: 1 },
      });
    }

    // Broadcast so UI updates live
    this.chatGateway.emitToWorkspace(page.workspace_id, 'new_message', {
      inbox_id: inboxRow.id.toString(),
      message: { text },
    });

    this.logger.log(`INSTA echo saved: chat=${chat.id} message=${message.id} mid=${mid} customer=${customerId}`);
  }

  /**
   * INSTA_DELIVERY_STATUS — Meta delivered our outgoing message to recipient.
   */
  private async onInstaDeliveryStatus(payload: any): Promise<void> {
    const mids: string[] = payload?.object?.mids ?? [];
    if (!mids.length) return;

    const messages = await this.prisma.insta_messages.findMany({
      where: { mid: { in: mids }, direction: 'OUTGOING' },
    });
    if (!messages.length) return;

    const now = new Date();
    await this.prisma.insta_messages.updateMany({
      where: { mid: { in: mids }, direction: 'OUTGOING', status: { notIn: ['read', 'failed'] } },
      data: { status: 'delivered', updated_at: now },
    });

    const pageCache = new Map<bigint, any>();
    for (const msg of messages) {
      let page = pageCache.get(msg.insta_page_id);
      if (!page) {
        page = await this.prisma.insta_pages.findUnique({ where: { id: msg.insta_page_id } });
        if (page) pageCache.set(msg.insta_page_id, page);
      }
      if (page) {
        this.chatGateway.emitToWorkspace(page.workspace_id, 'message_status', {
          insta_message_id: msg.id.toString(),
          status: 'delivered',
          mid: msg.mid,
        });
      }
    }
    this.logger.log(`INSTA delivery: ${mids.length} message(s) → delivered`);
  }

  /**
   * INSTA_READ_STATUS — recipient read our outgoing messages.
   *
   * Instagram now sends `read.mid` (specific message ID) rather than the older
   * `read.watermark` (bulk timestamp). We handle both formats:
   *   - mid present  → find that specific message + all earlier OUTGOING on same page → mark read
   *   - watermark    → mark all OUTGOING messages created on/before that timestamp
   *
   * We also try to retroactively resolve the contact's real name if it is still
   * a numeric fallback, since read receipts arrive with the sender_id.
   */
  private async onInstaReadStatus(payload: any): Promise<void> {
    const mid: string | null = payload?.object?.mid ?? null;
    const watermark: number = Number(payload?.object?.watermark ?? 0);
    const senderId: string | null = payload?.object?.sender_id ?? null;

    if (!mid && !watermark) {
      this.logger.warn(`INSTA_READ_STATUS: no mid or watermark in payload — dropping`);
      return;
    }

    let messages: any[] = [];
    let pageForNameUpdate: any = null;

    if (mid) {
      // Newer Instagram format: a specific message was confirmed read.
      const targetMsg = await this.prisma.insta_messages.findFirst({
        where: { mid, direction: 'OUTGOING' },
      });
      if (!targetMsg) {
        this.logger.warn(`INSTA_READ_STATUS: no OUTGOING message with mid=${mid}`);
      } else {
        messages = await this.prisma.insta_messages.findMany({
          where: {
            insta_page_id: targetMsg.insta_page_id,
            direction: 'OUTGOING',
            status: { notIn: ['read', 'failed'] },
            created_at: { lte: targetMsg.created_at },
          },
        });
        pageForNameUpdate = await this.prisma.insta_pages.findUnique({ where: { id: targetMsg.insta_page_id } });
      }
    } else {
      // Older watermark-based format.
      const backendPageId = payload?.account?.meta?.backend_insta_page_id;
      let pageIdFilter: bigint | undefined;
      if (backendPageId) {
        try { pageIdFilter = BigInt(backendPageId); } catch { /* ignore */ }
      }
      const watermarkDate = new Date(watermark);
      messages = await this.prisma.insta_messages.findMany({
        where: {
          direction: 'OUTGOING',
          status: { notIn: ['read', 'failed'] },
          created_at: { lte: watermarkDate },
          ...(pageIdFilter ? { insta_page_id: pageIdFilter } : {}),
        },
      });
      if (pageIdFilter) {
        pageForNameUpdate = await this.prisma.insta_pages.findUnique({ where: { id: pageIdFilter } });
      }
    }

    if (messages.length) {
      const now = new Date();
      await this.prisma.insta_messages.updateMany({
        where: { id: { in: messages.map(m => m.id) } },
        data: { status: 'read', updated_at: now },
      });

      const pageCache = new Map<bigint, any>();
      for (const msg of messages) {
        let page = pageCache.get(msg.insta_page_id);
        if (!page) {
          page = await this.prisma.insta_pages.findUnique({ where: { id: msg.insta_page_id } });
          if (page) pageCache.set(msg.insta_page_id, page);
        }
        if (page) {
          this.chatGateway.emitToWorkspace(page.workspace_id, 'message_status', {
            insta_message_id: msg.id.toString(),
            status: 'read',
            mid: msg.mid,
          });
        }
      }
      this.logger.log(`INSTA read receipt: ${messages.length} message(s) → read (mid=${mid ?? 'n/a'} watermark=${watermark || 'n/a'})`);
    }

    // Opportunistically refresh the contact's display name if it is still a
    // numeric sender-ID placeholder or "Unknown" — read receipts carry sender_id.
    if (senderId && pageForNameUpdate) {
      await this.tryUpdateInstaContactName(pageForNameUpdate, senderId);
    }
  }

  /**
   * Fetch the Instagram user's display name and update their contact row if the
   * current name is still a fallback value (null / numeric sender-ID / "Unknown").
   */
  private async tryUpdateInstaContactName(page: any, senderId: string): Promise<void> {
    const chat = await this.prisma.insta_chats.findFirst({
      where: { sender_id: senderId, insta_page_id: page.id },
    });
    if (!chat?.contact_id) return;

    const contact = await this.prisma.contacts.findUnique({ where: { id: chat.contact_id } });
    if (!contact || contact.deleted_at) return;

    const needsUpdate =
      !contact.full_name ||
      contact.full_name === senderId ||
      contact.full_name === 'Unknown' ||
      /^\d+$/.test(contact.full_name);
    if (!needsUpdate) return;

    if (!page.access_token) return;
    try {
      const igVer = process.env.META_GRAPH_API_VERSION ?? 'v22.0';
      const isFbPlatform = (page.platform ?? 'facebook') === 'facebook';
      const profileApiBase = isFbPlatform ? 'https://graph.facebook.com' : 'https://graph.instagram.com';
      const profileFields = isFbPlatform ? 'name' : 'name,username';
      const url = `${profileApiBase}/${igVer}/${senderId}?fields=${profileFields}&access_token=${page.access_token}`;
      const profileRes = await fetch(url);
      const profileJson = await profileRes.json();
      this.logger.log(`IG profile for ${senderId} (platform=${page.platform ?? 'facebook'}): ${JSON.stringify(profileJson)}`);

      if (profileRes.ok && !profileJson.error) {
        const newName = profileJson.name ?? profileJson.username ?? null;
        if (newName) {
          const nameParts = String(newName).trim().split(' ');
          const now = new Date();
          await this.prisma.contacts.update({
            where: { id: contact.id },
            data: {
              first_name: nameParts[0] ?? null,
              last_name: nameParts.length > 1 ? nameParts.slice(1).join(' ') : null,
              full_name: newName,
              updated_at: now,
            },
          });
          await this.prisma.insta_chats.updateMany({
            where: { contact_id: contact.id },
            data: { name: newName, updated_at: now },
          });
          this.logger.log(`Contact ${contact.id} name updated to "${newName}" (sender_id=${senderId})`);
        }
      } else {
        this.logger.warn(`IG profile fetch for ${senderId} failed: ${JSON.stringify(profileJson?.error ?? profileJson)}`);
      }
    } catch (e: any) {
      this.logger.warn(`IG profile fetch error for ${senderId}: ${e?.message}`);
    }
  }

  /**
   * INSTA_ACCOUNT_DELETED — microservice confirmed deletion.
   */
  private async onInstaAccountDeleted(payload: any, event: string): Promise<void> {
    const mongoId = payload?.account_id ?? payload?.id;
    if (!mongoId) return;
    const page = await this.prisma.insta_pages.findFirst({ where: { service_account_id: String(mongoId) } });
    if (!page) return;

    const newStatus = event === 'INSTA_ACCOUNT_DELETED' ? 'DELETED' : 'FAILED';
    await this.prisma.insta_pages.update({
      where: { id: page.id },
      data: { status: newStatus as any, updated_at: new Date() },
    });
    this.chatGateway.emitToWorkspace(page.workspace_id, 'instagram.page_updated', {
      id: page.id.toString(), status: newStatus,
    });
    this.logger.log(`insta_page ${page.id} → ${newStatus} (event=${event})`);
  }

  /**
   * INSTA_COMMENT — incoming Instagram comment event.
   */
  private async onInstaComment(payload: any): Promise<void> {
    const backendPageId = payload?.account?.meta?.backend_insta_page_id;
    if (!backendPageId) return;

    let pageId: bigint;
    try { pageId = BigInt(backendPageId); } catch { return; }

    const page = await this.prisma.insta_pages.findUnique({ where: { id: pageId } });
    if (!page) return;

    const change = payload?.object;
    const senderId = change?.value?.from?.id ?? null;
    if (!senderId) return;

    const contact = await this.resolveInstaContact(page.workspace_id, senderId, null);
    this.events.emit('message.ig_comment_reply', {
      contactId: contact.id,
      workspaceId: page.workspace_id,
      postId: change?.value?.media?.id ?? change?.value?.media_id ?? null,
      commentId: change?.value?.id ?? null,
      text: change?.value?.text ?? null,
    });
  }

  /**
   * Find or create an EZCONN contact from an Instagram sender_id.
   */
  private async resolveInstaContact(workspaceId: bigint, igUserId: string, name: string | null) {
    const INSTA_CHAT_MODELABLE = 'App\\Models\\Instagram\\InstaChat';
    const CONTACT_MODELABLE = 'App\\Models\\Contact';
    const WORKSPACE_MODELABLE = 'App\\Models\\Workspace';

    // Try to find existing contact via user_accesses or insta_chats
    const existingChat = await this.prisma.insta_chats.findFirst({
      where: { sender_id: igUserId },
      orderBy: { id: 'desc' },
    });
    if (existingChat?.contact_id) {
      const c = await this.prisma.contacts.findUnique({ where: { id: existingChat.contact_id } });
      if (c && !c.deleted_at) return c;
    }

    const now = new Date();
    const fallbackName = name?.trim() || igUserId;
    return this.prisma.contacts.create({
      data: {
        workspace_id: workspaceId,
        first_name: name ? name.split(' ')[0] : null,
        last_name: name && name.includes(' ') ? name.split(' ').slice(1).join(' ') : null,
        full_name: fallbackName,
        instagram_handler: igUserId,
        source: 'INSTAGRAM',
        status: 'ACTIVE',
        created_at: now,
        updated_at: now,
      },
    });
  }
}
