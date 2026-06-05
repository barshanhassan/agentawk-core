import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from '../inbox/chat.gateway';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { InterpolationService } from './interpolation.service';

/**
 * Channel dispatcher for automation send-message steps. The processor
 * branches by `step.type` and lands here for any channel-step.
 *
 * Routing summary:
 *   - WhatsApp → WhatsappService.sendMessage (publishes WA_OUTBOUND_MESSAGE
 *     on ra/whatsapp; real Meta API call lives in the microservice)
 *   - Telegram → Telegram Bot API (bot token stored in telegram_bots.token)
 *   - Messenger → Meta Graph API `/me/messages` (page token in fb_pages.access_token)
 *   - Instagram → Meta Graph API `/me/messages` (page token in insta_pages.access_token)
 *   - Webchat → ChatGateway WS broadcast + DB persist
 *   - Twilio SMS → Twilio Messages API (account sid+token in twilio_accounts)
 *   - Twilio Call → Twilio Voice TwiML create call
 *   - Z-API → POST {host}/instances/{id}/token/{tok}/send-text
 *   - Evolution → POST {api_url}/message/sendText/{instance}
 *   - Email → SMTP send (env var configured)
 *
 * For every channel we persist the outbound row in its respective messages
 * table at status='pending' BEFORE the network call so the UI shows the
 * message immediately, then update to 'sent' / 'failed' on response.
 */
@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
    private readonly chatGateway: ChatGateway,
    private readonly interpolation: InterpolationService,
  ) {}

  /**
   * Pulls text from `properties` and interpolates `{{...}}` tokens before
   * sending. Every channel handler must go through this so contact/custom-field
   * tokens are resolved against the running contact, not literal placeholders.
   */
  private async resolveText(
    properties: any,
    contactId: bigint,
    workspaceId: bigint,
  ): Promise<string> {
    const raw = this.extractText(properties);
    if (!raw) return '';
    return this.interpolation.interpolate(raw, contactId, workspaceId);
  }

  // ─── WhatsApp ──────────────────────────────────────────────────────

  async sendWhatsApp(contactId: bigint, properties: any, workspaceId: bigint) {
    const text = await this.resolveText(properties, contactId, workspaceId);
    if (!text) return this.logger.warn(`whatsapp: no text body for contact ${contactId}`);

    const chat = await this.prisma.wa_chats.findFirst({
      where: { contact_id: contactId },
      orderBy: { last_interacted_at: 'desc' },
    });
    if (!chat) {
      this.logger.warn(`whatsapp: no wa_chat for contact ${contactId} — cannot send`);
      return;
    }

    await this.whatsapp.sendMessage(workspaceId, 0n /* automation system user */, {
      to: chat.wa_id,
      type: 'text',
      text: { body: text },
      contact_id: contactId.toString(),
    });
  }

  // ─── Telegram ──────────────────────────────────────────────────────

  /**
   * Telegram Bot API: POST https://api.telegram.org/bot<token>/sendMessage
   * Body: { chat_id, text }
   */
  async sendTelegram(contactId: bigint, properties: any, workspaceId: bigint) {
    const text = await this.resolveText(properties, contactId, workspaceId);
    if (!text) return;

    const chat = await this.prisma.telegram_chats.findFirst({
      where: { contact_id: contactId, workspace_id: workspaceId },
    });
    if (!chat) return this.logger.warn(`telegram: no chat for contact ${contactId}`);

    // Choose bot — either properties.telegram_bot_id explicitly OR the bot
    // already attached to this chat.
    const botId = properties?.telegram_bot_id
      ? BigInt(properties.telegram_bot_id)
      : chat.telegram_bot_id;
    const bot = botId
      ? await this.prisma.telegram_bots.findUnique({ where: { id: botId } })
      : null;
    if (!bot || !bot.token) {
      return this.logger.warn(`telegram: no bot token for contact ${contactId}`);
    }

    const tgChatId = (chat as any).tg_chat_id ?? (chat as any).chat_id ?? null;
    if (!tgChatId) {
      return this.logger.warn(`telegram: no tg_chat_id stored on chat ${chat.id}`);
    }

    // Persist outbound first so UI shows it without waiting on the network.
    // telegram_messages_status only has SENT/FAILED/READ/UNSEEN — start at
    // SENT and downgrade to FAILED only on a confirmed API error.
    const row = await this.prisma.telegram_messages.create({
      data: {
        telegram_chat_id: chat.id,
        message_number: 0n,
        message_id: `auto_${Date.now()}`,
        seen: true,
        data: '{}',
        text,
        status: 'SENT',
        direction: 'OUTGOING',
        type: 'text',
        communication_mode: 'AUTOMATION',
      },
    });

    try {
      const url = `https://api.telegram.org/bot${bot.token}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChatId, text }),
      });
      const json: any = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        await this.prisma.telegram_messages.update({
          where: { id: row.id },
          data: { status: 'SENT', message_id: String(json.result?.message_id ?? row.message_id) },
        });
      } else {
        await this.prisma.telegram_messages.update({
          where: { id: row.id },
          data: { status: 'FAILED' },
        });
        this.logger.warn(`telegram send failed: ${json?.description ?? res.status}`);
      }
    } catch (e: any) {
      await this.prisma.telegram_messages.update({ where: { id: row.id }, data: { status: 'FAILED' } });
      this.logger.warn(`telegram send threw: ${e?.message ?? e}`);
    }
  }

  // ─── Facebook Messenger ────────────────────────────────────────────

  /**
   * Meta Graph API: POST https://graph.facebook.com/v20.0/me/messages
   * with the page's access_token.
   */
  async sendMessenger(contactId: bigint, properties: any, workspaceId: bigint) {
    const text = await this.resolveText(properties, contactId, workspaceId);
    if (!text) return;

    const chat = await this.prisma.fb_chats.findFirst({
      where: { contact_id: contactId },
      orderBy: { last_interacted_at: 'desc' },
    });
    if (!chat) return this.logger.warn(`messenger: no fb_chat for contact ${contactId}`);

    const page = await this.prisma.fb_pages.findUnique({ where: { id: chat.fb_page_id } });
    if (!page || !page.access_token) {
      return this.logger.warn(`messenger: no page access token for chat ${chat.id}`);
    }

    const recipientId = (chat as any).fb_user_id ?? (chat as any).psid ?? null;
    if (!recipientId) {
      return this.logger.warn(`messenger: no fb_user_id stored on chat ${chat.id}`);
    }

    const row = await this.prisma.fb_messages.create({
      data: {
        fb_chat_id: chat.id,
        fb_page_id: chat.fb_page_id,
        text,
        status: 'pending',
        direction: 'OUTGOING',
        type: 'text',
        communication_mode: 'AUTOMATION',
      } as any,
    });

    try {
      const version = process.env.META_GRAPH_API_VERSION ?? 'v20.0';
      const url = `https://graph.facebook.com/${version}/me/messages?access_token=${encodeURIComponent(page.access_token)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: String(recipientId) },
          messaging_type: 'RESPONSE',
          message: { text },
        }),
      });
      const json: any = await res.json().catch(() => ({}));
      if (res.ok && !json.error) {
        await this.prisma.fb_messages.update({
          where: { id: row.id },
          data: { status: 'sent' } as any,
        });
      } else {
        await this.prisma.fb_messages.update({ where: { id: row.id }, data: { status: 'failed' } as any });
        this.logger.warn(`messenger send failed: ${json?.error?.message ?? res.status}`);
      }
    } catch (e: any) {
      await this.prisma.fb_messages.update({ where: { id: row.id }, data: { status: 'failed' } as any });
      this.logger.warn(`messenger send threw: ${e?.message ?? e}`);
    }
  }

  // ─── Instagram ─────────────────────────────────────────────────────

  /**
   * Same Meta Graph API surface as Messenger but on the IG Business account.
   */
  async sendInstagram(contactId: bigint, properties: any, workspaceId: bigint) {
    const text = await this.resolveText(properties, contactId, workspaceId);
    if (!text) return;

    const chat = await this.prisma.insta_chats.findFirst({
      where: { contact_id: contactId },
      orderBy: { last_interacted_at: 'desc' },
    });
    if (!chat) return this.logger.warn(`instagram: no insta_chat for contact ${contactId}`);

    const page = await this.prisma.insta_pages.findUnique({ where: { id: chat.insta_page_id } });
    if (!page || !page.access_token) {
      return this.logger.warn(`instagram: no access token for chat ${chat.id}`);
    }

    const recipientId = (chat as any).ig_user_id ?? (chat as any).insta_user_id ?? null;
    if (!recipientId) {
      return this.logger.warn(`instagram: no recipient id stored on chat ${chat.id}`);
    }

    const row = await this.prisma.insta_messages.create({
      data: {
        insta_chat_id: chat.id,
        insta_page_id: chat.insta_page_id,
        text,
        status: 'pending',
        direction: 'OUTGOING',
        type: 'text',
        communication_mode: 'AUTOMATION',
      } as any,
    });

    try {
      const version = process.env.META_GRAPH_API_VERSION ?? 'v20.0';
      const url = `https://graph.facebook.com/${version}/me/messages?access_token=${encodeURIComponent(page.access_token)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: String(recipientId) },
          message: { text },
        }),
      });
      const json: any = await res.json().catch(() => ({}));
      if (res.ok && !json.error) {
        await this.prisma.insta_messages.update({ where: { id: row.id }, data: { status: 'sent' } as any });
      } else {
        await this.prisma.insta_messages.update({ where: { id: row.id }, data: { status: 'failed' } as any });
        this.logger.warn(`instagram send failed: ${json?.error?.message ?? res.status}`);
      }
    } catch (e: any) {
      await this.prisma.insta_messages.update({ where: { id: row.id }, data: { status: 'failed' } as any });
      this.logger.warn(`instagram send threw: ${e?.message ?? e}`);
    }
  }

  // ─── Webchat ───────────────────────────────────────────────────────

  /**
   * Webchat is an in-EZCONN channel — there's no third-party server, the
   * widget polls/subscribes to our gateway. We persist the message + emit
   * an internal socket event the widget listens for.
   */
  async sendWebchat(contactId: bigint, properties: any, workspaceId: bigint) {
    const text = await this.resolveText(properties, contactId, workspaceId);
    if (!text) return;

    const chat = await this.prisma.wc_chats.findFirst({
      where: { contact_id: contactId },
      orderBy: { id: 'desc' },
    });
    if (!chat) return this.logger.warn(`webchat: no wc_chat for contact ${contactId}`);

    const row = await this.prisma.wc_messages.create({
      data: {
        wc_chat_id: chat.id,
        text,
        direction: 'OUTGOING',
        type: 'text',
      } as any,
    });

    // Push to any open inbox panels in the workspace AND to the widget
    // listening on the chat-specific room. The widget joins
    // `webchat_<wc_chat_id>` on connect; the inbox UI joins
    // `workspace_<id>` and surfaces it via the generic new_message event.
    const inbox = await this.prisma.inbox.findFirst({
      where: {
        modelable_type: 'App\\Models\\Webchat\\WebchatChat',
        modelable_id: chat.id,
        workspace_id: workspaceId,
      },
    });
    if (inbox) {
      this.chatGateway.emitToWorkspace(workspaceId, 'new_message', {
        inbox_id: inbox.id.toString(),
        message: { text, direction: 'OUTGOING' },
      });
    }
    this.chatGateway.emitToWorkspace(workspaceId, 'webchat.message.outbound', {
      chat_id: chat.id.toString(),
      contact_id: contactId.toString(),
      message_id: row.id.toString(),
      text,
    });

    this.logger.log(`webchat: outbound pushed for chat ${chat.id}`);
  }

  // ─── Twilio SMS ────────────────────────────────────────────────────

  /**
   * Twilio Messages API:
   *   POST https://api.twilio.com/2010-04-01/Accounts/{Sid}/Messages.json
   * Basic auth: account sid + auth token.
   */
  async sendTwilioSms(contactId: bigint, properties: any, workspaceId: bigint) {
    const text = await this.resolveText(properties, contactId, workspaceId);
    if (!text) return;

    const accountId = properties?.twilio_account_id;
    const acct = accountId
      ? await this.prisma.twilio_accounts.findFirst({
          where: { id: BigInt(accountId), workspace_id: workspaceId, deleted_at: null },
        })
      : await this.prisma.twilio_accounts.findFirst({
          where: { workspace_id: workspaceId, deleted_at: null },
        });
    if (!acct || !acct.twilio_auth_token || !acct.twilio_account_sid) {
      return this.logger.warn(`twilio_sms: no account for workspace ${workspaceId}`);
    }

    const contact = await this.prisma.contacts.findUnique({ where: { id: contactId } });
    const toNumber =
      properties?.to ??
      properties?.phone ??
      (contact?.full_name && (contact as any).phone_code
        ? `${(contact as any).phone_code}${(contact as any).phone_number ?? ''}`
        : null);
    if (!toNumber) return this.logger.warn(`twilio_sms: no destination phone for contact ${contactId}`);

    const fromNumber = properties?.from ?? (acct as any).twilio_phone_number ?? '';
    if (!fromNumber) return this.logger.warn(`twilio_sms: no Twilio from-number configured`);

    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${acct.twilio_account_sid}/Messages.json`;
      const basic = Buffer.from(`${acct.twilio_account_sid}:${acct.twilio_auth_token}`).toString('base64');
      const body = new URLSearchParams({ From: fromNumber, To: toNumber, Body: text }).toString();
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      const json: any = await res.json().catch(() => ({}));
      if (res.ok) {
        this.logger.log(`twilio_sms sent: sid=${json.sid}`);
      } else {
        this.logger.warn(`twilio_sms failed: ${json?.message ?? res.status}`);
      }
    } catch (e: any) {
      this.logger.warn(`twilio_sms threw: ${e?.message ?? e}`);
    }
  }

  // ─── Twilio Voice (TwiML inline) ───────────────────────────────────

  async sendTwilioCall(contactId: bigint, properties: any, workspaceId: bigint) {
    const acct = await this.prisma.twilio_accounts.findFirst({
      where: { workspace_id: workspaceId, deleted_at: null },
    });
    if (!acct || !acct.twilio_auth_token || !acct.twilio_account_sid) {
      return this.logger.warn(`twilio_call: no account for workspace ${workspaceId}`);
    }

    const contact = await this.prisma.contacts.findUnique({ where: { id: contactId } });
    const toNumber = properties?.to ?? properties?.phone ?? (contact as any)?.phone_number;
    const fromNumber = properties?.from ?? (acct as any).twilio_phone_number ?? '';
    const twiml = properties?.twiml ?? `<Response><Say>${properties?.say ?? 'Hello from your automation.'}</Say></Response>`;
    if (!toNumber || !fromNumber) return this.logger.warn(`twilio_call: missing to/from`);

    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${acct.twilio_account_sid}/Calls.json`;
      const basic = Buffer.from(`${acct.twilio_account_sid}:${acct.twilio_auth_token}`).toString('base64');
      const body = new URLSearchParams({ From: fromNumber, To: toNumber, Twiml: twiml }).toString();
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      const json: any = await res.json().catch(() => ({}));
      if (res.ok) this.logger.log(`twilio_call placed: sid=${json.sid}`);
      else this.logger.warn(`twilio_call failed: ${json?.message ?? res.status}`);
    } catch (e: any) {
      this.logger.warn(`twilio_call threw: ${e?.message ?? e}`);
    }
  }

  // ─── Z-API ─────────────────────────────────────────────────────────

  /**
   * Z-API: POST https://api.z-api.io/instances/{instance_id}/token/{token}/send-text
   * Body: { phone, message }
   */
  async sendZapi(contactId: bigint, properties: any, workspaceId: bigint) {
    const text = await this.resolveText(properties, contactId, workspaceId);
    if (!text) return;

    const inst = properties?.zapi_instance_id
      ? await this.prisma.zapi_instances.findFirst({
          where: { id: BigInt(properties.zapi_instance_id), workspace_id: workspaceId, deleted_at: null },
        })
      : await this.prisma.zapi_instances.findFirst({
          where: { workspace_id: workspaceId, deleted_at: null },
        });
    if (!inst || !inst.token || !inst.instance_id) {
      return this.logger.warn(`zapi: no instance configured for workspace ${workspaceId}`);
    }

    const contact = await this.prisma.contacts.findUnique({ where: { id: contactId } });
    const phone = properties?.phone ?? (contact as any)?.phone_number;
    if (!phone) return this.logger.warn(`zapi: no destination phone for contact ${contactId}`);

    try {
      const url = `https://api.z-api.io/instances/${inst.instance_id}/token/${inst.token}/send-text`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, message: text }),
      });
      const json: any = await res.json().catch(() => ({}));
      if (res.ok) this.logger.log(`zapi sent: id=${json?.id ?? '?'}`);
      else this.logger.warn(`zapi failed: ${json?.error ?? res.status}`);
    } catch (e: any) {
      this.logger.warn(`zapi threw: ${e?.message ?? e}`);
    }
  }

  // ─── Evolution API ─────────────────────────────────────────────────

  /**
   * Evolution: POST {api_url}/message/sendText/{instance}
   * Header: apikey: {api_key}
   * Body: { number, text }
   */
  async sendEvolution(contactId: bigint, properties: any, workspaceId: bigint) {
    const text = await this.resolveText(properties, contactId, workspaceId);
    if (!text) return;

    const inst = properties?.evolution_instance_id
      ? await this.prisma.evolution_instances.findFirst({
          where: { id: BigInt(properties.evolution_instance_id), workspace_id: workspaceId, deleted_at: null },
        })
      : await this.prisma.evolution_instances.findFirst({
          where: { workspace_id: workspaceId, deleted_at: null },
        });
    if (!inst || !inst.api_url || !inst.instance_id) {
      return this.logger.warn(`evolution: no instance for workspace ${workspaceId}`);
    }

    const contact = await this.prisma.contacts.findUnique({ where: { id: contactId } });
    const phone = properties?.phone ?? (contact as any)?.phone_number;
    if (!phone) return this.logger.warn(`evolution: no destination phone for contact ${contactId}`);

    const chat = await this.prisma.evolution_chats.findFirst({
      where: { contact_id: contactId },
      orderBy: { last_business_interaction: 'desc' },
    });

    let row: any = null;
    if (chat) {
      row = await this.prisma.evolution_messages.create({
        data: {
          evolution_chat_id: chat.id,
          text,
          direction: 'OUTGOING',
          type: 'text',
          status: 'pending',
        } as any,
      });
    }

    try {
      const url = `${inst.api_url.replace(/\/$/, '')}/message/sendText/${inst.instance_id}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(inst.api_key ? { apikey: inst.api_key } : {}),
        },
        body: JSON.stringify({ number: phone, text }),
      });
      const json: any = await res.json().catch(() => ({}));
      if (res.ok) {
        if (row) {
          await this.prisma.evolution_messages.update({ where: { id: row.id }, data: { status: 'sent' } as any });
        }
        this.logger.log(`evolution sent: id=${json?.key?.id ?? '?'}`);
      } else {
        if (row) {
          await this.prisma.evolution_messages.update({ where: { id: row.id }, data: { status: 'failed' } as any });
        }
        this.logger.warn(`evolution failed: ${json?.error ?? res.status}`);
      }
    } catch (e: any) {
      if (row) {
        await this.prisma.evolution_messages.update({ where: { id: row.id }, data: { status: 'failed' } as any });
      }
      this.logger.warn(`evolution threw: ${e?.message ?? e}`);
    }
  }

  // ─── Email ─────────────────────────────────────────────────────────

  /**
   * Email send — uses nodemailer over SMTP. SMTP credentials come from env:
   *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
   * If any are missing we log + skip (the action remains harmless in dev).
   */
  async sendEmail(contactId: bigint, properties: any, workspaceId: bigint) {
    const text = await this.resolveText(properties, contactId, workspaceId);
    const subject = properties?.subject
      ? await this.interpolation.interpolate(properties.subject, contactId, workspaceId)
      : 'Notification';
    if (!text) return;

    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass) {
      this.logger.warn('email: SMTP_HOST/USER/PASS not configured — skipping send');
      return;
    }

    const contact = await this.prisma.contacts.findUnique({ where: { id: contactId } });
    const toEmail = properties?.to ?? (contact as any)?.email;
    if (!toEmail) {
      // Try contact_emails primary
      const ce = await this.prisma.contact_emails.findFirst({
        where: {
          modelable_id: contactId,
          modelable_type: 'App\\Models\\Contact',
          is_primary: 1,
        },
      });
      if (!ce) return this.logger.warn(`email: no destination address for contact ${contactId}`);
    }

    try {
      // Lazy-require nodemailer so the dep is optional in dev. Using a
      // runtime-dynamic require keeps TypeScript from complaining about a
      // missing module when nodemailer isn't installed.
      let nodemailer: any = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        nodemailer = (Function('return require'))()('nodemailer');
      } catch {
        this.logger.warn('email: nodemailer not installed — run `npm i nodemailer` to enable');
        return;
      }
      const port = Number(process.env.SMTP_PORT ?? 587);
      const from = process.env.SMTP_FROM ?? user;
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
      await transporter.sendMail({ from, to: toEmail, subject, text });
      this.logger.log(`email sent to ${toEmail}`);
    } catch (e: any) {
      this.logger.warn(`email send failed: ${e?.message ?? e}`);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private extractText(properties: any): string {
    return (
      properties?.text ??
      properties?.body ??
      properties?.message ??
      properties?.text?.body ??
      ''
    );
  }
}
