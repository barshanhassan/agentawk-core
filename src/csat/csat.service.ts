import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';

/**
 * Customer-facing CSAT copy, keyed by the same language codes the frontend's
 * i18n locales use. `contacts.language` (set by whatever channel/import flow
 * populates it — may be null) picks the entry; unknown/missing codes fall
 * back to English. This is a plain backend string table, not react-i18next —
 * these messages are sent straight to WhatsApp, outside the React app.
 */
const CSAT_COPY: Record<string, { prompt: string; great: string; average: string; poor: string; thanks: string }> = {
  en: { prompt: 'How was your experience with us today?', great: '😊 Great', average: '😐 Average', poor: '😞 Poor', thanks: 'Thanks for your feedback! 🙏' },
  ar: { prompt: 'كيف كانت تجربتك معنا اليوم؟', great: '😊 ممتاز', average: '😐 متوسط', poor: '😞 ضعيف', thanks: 'شكرًا لملاحظاتك! 🙏' },
  de: { prompt: 'Wie war Ihre Erfahrung mit uns heute?', great: '😊 Sehr gut', average: '😐 Durchschnittlich', poor: '😞 Schlecht', thanks: 'Danke für Ihr Feedback! 🙏' },
  es: { prompt: '¿Cómo fue tu experiencia con nosotros hoy?', great: '😊 Excelente', average: '😐 Promedio', poor: '😞 Deficiente', thanks: '¡Gracias por tu opinión! 🙏' },
  fr: { prompt: "Comment s'est passée votre expérience avec nous aujourd'hui ?", great: '😊 Excellent', average: '😐 Moyen', poor: '😞 Mauvais', thanks: 'Merci pour votre avis ! 🙏' },
  hi: { prompt: 'आज हमारे साथ आपका अनुभव कैसा रहा?', great: '😊 बहुत अच्छा', average: '😐 औसत', poor: '😞 खराब', thanks: 'आपकी प्रतिक्रिया के लिए धन्यवाद! 🙏' },
  id: { prompt: 'Bagaimana pengalaman Anda dengan kami hari ini?', great: '😊 Bagus', average: '😐 Rata-rata', poor: '😞 Buruk', thanks: 'Terima kasih atas masukan Anda! 🙏' },
  it: { prompt: 'Come è stata la tua esperienza con noi oggi?', great: '😊 Ottimo', average: '😐 Medio', poor: '😞 Scarso', thanks: 'Grazie per il tuo feedback! 🙏' },
  ja: { prompt: '本日のご利用はいかがでしたか？', great: '😊 良い', average: '😐 普通', poor: '😞 悪い', thanks: 'フィードバックありがとうございます！🙏' },
  pt: { prompt: 'Como foi sua experiência conosco hoje?', great: '😊 Ótimo', average: '😐 Médio', poor: '😞 Ruim', thanks: 'Obrigado pelo seu feedback! 🙏' },
  ru: { prompt: 'Как прошло ваше сегодняшнее общение с нами?', great: '😊 Отлично', average: '😐 Средне', poor: '😞 Плохо', thanks: 'Спасибо за ваш отзыв! 🙏' },
  tr: { prompt: 'Bugün bizimle deneyiminiz nasıldı?', great: '😊 Harika', average: '😐 Ortalama', poor: '😞 Kötü', thanks: 'Geri bildiriminiz için teşekkürler! 🙏' },
  ur: { prompt: 'آج ہمارے ساتھ آپ کا تجربہ کیسا رہا؟', great: '😊 بہترین', average: '😐 اوسط', poor: '😞 ناقص', thanks: 'آپ کی رائے کا شکریہ! 🙏' },
  vi: { prompt: 'Trải nghiệm của bạn với chúng tôi hôm nay thế nào?', great: '😊 Tuyệt vời', average: '😐 Trung bình', poor: '😞 Kém', thanks: 'Cảm ơn phản hồi của bạn! 🙏' },
  zh: { prompt: '您今天的体验如何？', great: '😊 很好', average: '😐 一般', poor: '😞 差', thanks: '感谢您的反馈！🙏' },
};

/**
 * CSAT collection — fires a rating request when a conversation is closed
 * (any of the three `conversation.marked_as_done` emit sites: automation
 * close_conversation action, single status update, bulk status update) and
 * captures the customer's reply.
 *
 * Reply capture has two entry points because inbound WhatsApp messages reach
 * this app through two different paths depending on deployment (RabbitMQ
 * consumer vs. the direct Cloud API webhook controller):
 *   - `message.inbound` (emitted with `text` by whatsapp-events.consumer.ts)
 *   - `csat.whatsapp_inbound` (emitted by WhatsappWebhookParserService, which
 *     backs the direct-webhook path where `message.inbound` carries no text)
 * Both funnel into `tryRecordReply`, which is idempotent — once a pending
 * request is answered, a duplicate delivery of the same inbound message
 * simply finds no pending row left and no-ops.
 */
@Injectable()
export class CsatService {
  private readonly logger = new Logger(CsatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
  ) {}

  @OnEvent('conversation.marked_as_done')
  async onConversationClosed(payload: { contactId: bigint; workspaceId: bigint; inboxId: bigint }) {
    const { contactId, workspaceId, inboxId } = payload;
    if (!contactId || !workspaceId || !inboxId) return;

    // Guard against the same close firing twice (e.g. a bulk action that
    // re-touches an already-COMPLETED row), while still allowing a fresh
    // CSAT request each time this conversation is genuinely closed again
    // later — a 24h cooldown tells apart "duplicate event for the same
    // close" from "customer came back and the conversation got resolved
    // again a day+ later".
    const cooldownStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const existing = await this.prisma.csat_responses.findFirst({
      where: { inbox_id: inboxId, requested_at: { gte: cooldownStart } },
    });
    if (existing) return;

    const chat = await this.prisma.wa_chats.findFirst({
      where: { contact_id: contactId },
      orderBy: { last_interacted_at: 'desc' },
    });
    if (!chat) return; // no WhatsApp channel for this contact — nothing to send the request on

    const inbox = await this.prisma.inbox.findUnique({ where: { id: inboxId } });
    const agentId = inbox?.user_id ?? inbox?.closed_by ?? null;

    await this.prisma.csat_responses.create({
      data: {
        workspace_id: workspaceId,
        inbox_id: inboxId,
        contact_id: contactId,
        agent_id: agentId,
        rating: null,
        requested_at: new Date(),
      },
    });

    const number = await this.prisma.wa_phone_numbers.findUnique({ where: { id: chat.wa_number_id } });
    const copy = await this.getCopy(contactId);
    try {
      await this.whatsapp.sendMessage(workspaceId, 0n, {
        to: chat.wa_id,
        phone_number_id: number?.wa_number_id,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: copy.prompt },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'csat_great', title: copy.great } },
              { type: 'reply', reply: { id: 'csat_average', title: copy.average } },
              { type: 'reply', reply: { id: 'csat_poor', title: copy.poor } },
            ],
          },
        },
        contact_id: contactId.toString(),
      });
    } catch (e: any) {
      this.logger.warn(`CSAT request send failed for contact ${contactId}: ${e?.message ?? e}`);
    }
  }

  /** Resolve customer-facing copy from the contact's `language` field, defaulting to English. */
  private async getCopy(contactId: bigint) {
    const contact = await this.prisma.contacts.findUnique({ where: { id: contactId }, select: { language: true } });
    const lang = (contact?.language ?? '').toLowerCase().slice(0, 2);
    return CSAT_COPY[lang] ?? CSAT_COPY.en;
  }

  /**
   * Called by AutomationTriggerService BEFORE it fans an inbound message out
   * to keyword/inbound-message automations — same short-circuit pattern as
   * QuickReplyInputService.tryHandleInbound. If this message is the reply to
   * a pending CSAT request, we consume it here (record rating + send a thank-
   * you) and tell the caller to skip normal automation processing entirely,
   * so a customer's "great" reply doesn't also fire keyword automations or
   * reopen the conversation.
   */
  async tryHandleInbound(payload: {
    workspaceId: bigint;
    contactId: bigint;
    text?: string | null;
    buttonReplyId?: string | null;
  }): Promise<boolean> {
    if (!payload?.workspaceId || !payload?.contactId) return false;
    return this.tryRecordReply(payload).catch((e: any) => {
      this.logger.warn(`CSAT reply capture failed: ${e?.message ?? e}`);
      return false;
    });
  }

  @OnEvent('csat.whatsapp_inbound')
  async onWhatsappInboundRaw(payload: {
    workspaceId: bigint;
    contactId: bigint;
    text?: string | null;
    buttonReplyId?: string | null;
  }) {
    // Direct Cloud API webhook path: `message.inbound` carries no text here
    // (see whatsapp-webhook-parser.service.ts), so AutomationTriggerService's
    // gate never sees this reply anyway — safe to consume standalone.
    if (!payload?.workspaceId || !payload?.contactId) return;
    await this.tryRecordReply(payload).catch((e: any) =>
      this.logger.warn(`CSAT reply capture failed: ${e?.message ?? e}`),
    );
  }

  /**
   * Match an inbound message against the contact's most recent unanswered
   * CSAT request (if any) and record the rating. Returns true when a pending
   * request was found and successfully parsed. On success, also sends a short
   * thank-you so the customer gets a reply instead of silence.
   */
  private async tryRecordReply(params: {
    workspaceId: bigint;
    contactId: bigint;
    text?: string | null;
    buttonReplyId?: string | null;
  }): Promise<boolean> {
    const pending = await this.prisma.csat_responses.findFirst({
      where: { workspace_id: params.workspaceId, contact_id: params.contactId, rating: null },
      orderBy: { requested_at: 'desc' },
    });
    if (!pending) return false;

    const rating = this.parseRating(params.buttonReplyId, params.text);
    if (!rating) return false;

    await this.prisma.csat_responses.update({
      where: { id: pending.id },
      data: { rating, responded_at: new Date() },
    });

    await this.sendThanks(params.workspaceId, params.contactId);
    return true;
  }

  private async sendThanks(workspaceId: bigint, contactId: bigint) {
    const chat = await this.prisma.wa_chats.findFirst({
      where: { contact_id: contactId },
      orderBy: { last_interacted_at: 'desc' },
    });
    if (!chat) return;
    const number = await this.prisma.wa_phone_numbers.findUnique({ where: { id: chat.wa_number_id } });
    const copy = await this.getCopy(contactId);
    try {
      await this.whatsapp.sendMessage(workspaceId, 0n, {
        to: chat.wa_id,
        phone_number_id: number?.wa_number_id,
        type: 'text',
        text: { body: copy.thanks },
        contact_id: contactId.toString(),
      });
    } catch (e: any) {
      this.logger.warn(`CSAT thank-you send failed for contact ${contactId}: ${e?.message ?? e}`);
    }
  }

  private parseRating(buttonReplyId?: string | null, text?: string | null): number | null {
    if (buttonReplyId === 'csat_great') return 3;
    if (buttonReplyId === 'csat_average') return 2;
    if (buttonReplyId === 'csat_poor') return 1;

    const t = (text ?? '').trim().toLowerCase();
    if (!t) return null;
    if (t === '3' || /great|excellent|amazing|😊/.test(t)) return 3;
    if (t === '2' || /average|okay|ok\b|fine|😐/.test(t)) return 2;
    if (t === '1' || /poor|bad|terrible|😞/.test(t)) return 1;
    return null;
  }
}
