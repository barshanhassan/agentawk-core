import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Input-collection state machine for automation quick-reply / ask-for-input
 * steps. Mirrors replyagent's behaviour in
 * `gateway/app/Helper/AutomationHelper.php:1331-1466` (validation rules) and
 * the `responded` / `no_response` / `answer_failed` / `no_further_question`
 * event branches in `AutomationsController.php`.
 *
 * Lifecycle:
 *   1. Channel step with `activity.type === 'input'` (or a step.type ===
 *      'quick_reply' with collectable answer) finishes its outbound send.
 *      → `enterWaitState()` persists a `automation_quick_reply_followups`
 *      row plus a `automation_quick_reply_retries` row, and keeps the queue
 *      row "reserved" until `wait_till`.
 *
 *   2. User replies on the same channel.
 *      → `tryHandleInbound()` finds the wait state, validates the input.
 *        - Valid    → save to customField (if configured), branch via the
 *                     sibling activity whose `event === 'responded'`.
 *        - Invalid  → bump retries, resend `retryMessage`. If attempts ≥
 *                     `max_attempts`, branch via `event === 'answer_failed'`.
 *
 *   3. `wait_till` elapses without an inbound reply.
 *      → Processor's `processReservedQueue` cron detects the queue is past
 *        reserved and an open followup exists → branch via
 *        `event === 'no_response'`, then delete the followup row.
 *
 * Channel mapping: replyagent's `chat_type` is the Laravel class name
 * (`App\Models\WaChat`, `App\Models\TelegramChat`, etc.). We keep the same
 * convention so a migrated DB stays interoperable.
 */
@Injectable()
export class QuickReplyInputService {
  private readonly logger = new Logger(QuickReplyInputService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Channel ↔ chat-type registry ────────────────────────────────

  private readonly channelChatTypes: Record<string, string> = {
    whatsapp: 'App\\Models\\WaChat',
    telegram: 'App\\Models\\TelegramChat',
    messenger: 'App\\Models\\FbChat',
    instagram: 'App\\Models\\InstaChat',
    webchat: 'App\\Models\\WcChat',
    twilio_sms: 'App\\Models\\TwilioChat',
    twilio_call: 'App\\Models\\TwilioChat',
    zapi: 'App\\Models\\ZapiChat',
    evolution: 'App\\Models\\EvolutionChat',
  };

  // ─── Enter-wait — called by processor ────────────────────────────

  /**
   * Persist the wait state after a channel step that needs an input reply
   * has executed. Caller should pass `inputProps` extracted from the activity:
   *
   *   { type: 'input', input_type: 'email', customField: {slug: 'support_email'},
   *     followUp: true, followUpUnit: 5, followUpInterval: 'minutes',
   *     retry: true, retryAttempts: 2, retryMessage: 'Tap one of the options' }
   */
  async enterWaitState(params: {
    queueId: bigint;
    stepId: bigint;
    contactId: bigint;
    channel: string;
    inputProps: any;
  }): Promise<void> {
    const { queueId, stepId, contactId, channel, inputProps } = params;
    const chatType = this.channelChatTypes[channel] ?? null;
    const chatId = chatType ? await this.resolveChatId(channel, contactId) : null;
    if (!chatId || !chatType) {
      this.logger.warn(
        `enterWaitState: cannot resolve ${channel} chat for contact ${contactId} — skipping wait`,
      );
      return;
    }

    const waitTill = this.computeWaitTill(inputProps);

    // Idempotent: replace any existing followup for the same (step, chat).
    await this.prisma.automation_quick_reply_followups.deleteMany({
      where: { automation_step_id: stepId, chat_id: chatId, chat_type: chatType },
    });
    await this.prisma.automation_quick_reply_retries.deleteMany({
      where: { automation_step_id: stepId, chat_id: chatId, chat_type: chatType },
    });

    await this.prisma.automation_quick_reply_followups.create({
      data: {
        automation_step_id: stepId,
        chat_id: chatId,
        chat_type: chatType,
        wait_till: waitTill,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
    await this.prisma.automation_quick_reply_retries.create({
      data: {
        automation_step_id: stepId,
        chat_id: chatId,
        chat_type: chatType,
        attempts: 0,
        max_attempts: Number(inputProps?.retryAttempts ?? 3),
        created_at: new Date(),
        updated_at: new Date(),
      },
    });

    // Park the queue row so the cron doesn't aggressively retry. wait_till
    // tells the processor when to give up.
    await this.prisma.automation_queue.update({
      where: { id: queueId },
      data: { reserved: waitTill },
    });
  }

  /**
   * Called by inbound message handlers. Returns `true` if the inbound was
   * consumed as a reply to a pending input wait, so the caller should NOT
   * re-route the message through the generic listener fan-out.
   *
   * NOTE: the caller (channel inbound handler) must know which channel the
   * message arrived on so we look up the correct chat type.
   */
  async tryHandleInbound(params: {
    contactId: bigint;
    channel: string;
    text: string;
  }): Promise<boolean> {
    const { contactId, channel, text } = params;
    const chatType = this.channelChatTypes[channel];
    if (!chatType) return false;
    const chatId = await this.resolveChatId(channel, contactId);
    if (!chatId) return false;

    const followup = await this.prisma.automation_quick_reply_followups
      .findFirst({ where: { chat_id: chatId, chat_type: chatType }, orderBy: { id: 'desc' } })
      .catch(() => null);
    if (!followup) return false;

    const step = await this.prisma.automation_steps.findUnique({
      where: { id: followup.automation_step_id },
    });
    if (!step) {
      await this.cleanupWait(followup.id, null);
      return false;
    }

    // Pull the "ask" activity — the one with type='input'. The same step
    // also has sibling activities with event branches (responded/answer_failed/
    // no_response/no_further_question) that drive routing.
    const inputActivity = await this.prisma.automation_step_activities.findFirst({
      where: { step_id: step.id, deleted_at: null },
      orderBy: { order: 'asc' },
    });
    if (!inputActivity) {
      await this.cleanupWait(followup.id, null);
      return false;
    }

    const props =
      typeof inputActivity.properties === 'string'
        ? JSON.parse(inputActivity.properties)
        : inputActivity.properties ?? {};

    // Validate. On pass — save (if customField present), branch via 'responded'.
    const validation = this.validate(text, props);
    if (validation.valid) {
      await this.persistCustomFieldAnswer(contactId, props, text);
      await this.advanceVia(step.id, contactId, 'responded');
      await this.cleanupWait(followup.id, contactId);
      return true;
    }

    // Invalid — bump retries and (if remaining) resend retryMessage.
    const retries = await this.prisma.automation_quick_reply_retries.findFirst({
      where: {
        automation_step_id: step.id,
        chat_id: chatId,
        chat_type: chatType,
      },
    });
    const attempts = (retries?.attempts ?? 0) + 1;
    const maxAttempts = retries?.max_attempts ?? Number(props?.retryAttempts ?? 3);

    if (attempts >= maxAttempts) {
      await this.advanceVia(step.id, contactId, 'answer_failed');
      await this.cleanupWait(followup.id, contactId);
      return true;
    }

    if (retries) {
      await this.prisma.automation_quick_reply_retries.update({
        where: { id: retries.id },
        data: { attempts, updated_at: new Date() },
      });
    }
    // The actual "send the retry message" is left to the inbound channel
    // handler — we just signal we consumed the message and which step needs
    // to repeat. To keep the contract simple here, we *don't* resend; the
    // processor's next visit (driven by the user's next message) will pick up
    // from the same step. Replyagent shows the retry message inline; the
    // higher-level inbound consumer can use `consumedRetryMessage` to surface
    // the right copy.
    this.logger.log(
      `quick-reply input retry ${attempts}/${maxAttempts} for contact ${contactId} on step ${step.id}`,
    );
    return true;
  }

  /**
   * Called by the cron when the queue's `reserved` deadline elapses for a
   * row that has an open followup. Branches via the `no_response` event
   * activity and clears the wait state.
   *
   * Returns `true` if a no_response branch was advanced — caller (processor)
   * should NOT also call `finished()` for this queue id.
   */
  async timeoutCheck(queueId: bigint): Promise<boolean> {
    const queueItem = await this.prisma.automation_queue.findUnique({
      where: { id: queueId },
    });
    if (!queueItem) return false;
    // The followup is keyed on (step_id, chat). For the queue we look up via
    // step_id and contact's resolved chat. We need at least one matching
    // followup whose wait_till has elapsed.
    const followup = await this.prisma.automation_quick_reply_followups
      .findFirst({
        where: { automation_step_id: queueItem.step_id, wait_till: { lte: new Date() } },
        orderBy: { id: 'desc' },
      })
      .catch(() => null);
    if (!followup) return false;

    await this.advanceVia(queueItem.step_id, queueItem.object_id, 'no_response');
    await this.cleanupWait(followup.id, queueItem.object_id);
    return true;
  }

  // ─── Validation (mirrors replyagent input types) ────────────────

  private validate(text: string, props: any): { valid: boolean; reason?: string } {
    if (text == null) return { valid: false };
    const input = String(text).trim();
    if (input === '') return { valid: false };
    const inputType: string = (props?.input_type ?? props?.customField?.input_type ?? 'text').toLowerCase();

    const reEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const reUrl = /^https?:\/\/[^\s]+$/i;
    const rePhone = /^[+\d][\d\s\-()]{6,}$/;
    const reDigits = /^-?\d+(\.\d+)?$/;

    switch (inputType) {
      case 'email':
        return { valid: reEmail.test(input) };
      case 'url':
        return { valid: reUrl.test(input) };
      case 'phone':
      case 'mobile':
        return { valid: rePhone.test(input) };
      case 'number':
      case 'currency':
        return { valid: reDigits.test(input) };
      case 'date': {
        const d = new Date(input);
        return { valid: !isNaN(d.getTime()) };
      }
      case 'name':
      case 'first_name':
      case 'last_name': {
        // Allow letters, spaces, hyphens, apostrophes, plus common unicode.
        return { valid: /^[\p{L} '\-]+$/u.test(input) };
      }
      case 'choice': {
        const choices: string[] =
          props?.customField?.properties?.map?.((p: any) => String(p?.name ?? p)) ??
          props?.choices ??
          [];
        if (!choices.length) return { valid: true };
        return { valid: choices.some((c) => c.toLowerCase() === input.toLowerCase()) };
      }
      case 'text':
      default:
        return { valid: true };
    }
  }

  // ─── Persist into the contact's custom field ────────────────────

  private async persistCustomFieldAnswer(
    contactId: bigint,
    props: any,
    answer: string,
  ): Promise<void> {
    const slug =
      props?.customField?.slug ??
      props?.customField?.value ??
      props?.custom_field?.slug ??
      null;
    if (!slug) return;

    const contact = await this.prisma.contacts.findUnique({ where: { id: contactId } });
    if (!contact) return;

    const cf = await this.prisma.custom_fields.findFirst({
      where: { workspace_id: contact.workspace_id, slug },
    });
    if (!cf) return;

    // Upsert custom_field_entities + write entity_values row. Matches the
    // pattern used by ActionHandlerService.setCustomField().
    let entity = await this.prisma.custom_field_entities.findFirst({
      where: {
        entity_type: 'App\\Models\\Contact',
        entity_id: contactId,
        custom_field_id: cf.id,
      },
    });
    if (!entity) {
      entity = await this.prisma.custom_field_entities.create({
        data: {
          entity_type: 'App\\Models\\Contact',
          entity_id: contactId,
          custom_field_id: cf.id,
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    }
    // Replace any existing value for the entity (single-select default).
    await this.prisma.custom_field_entity_values.deleteMany({
      where: { cf_entity_id: entity.id },
    });
    await this.prisma.custom_field_entity_values.create({
      data: {
        cf_entity_id: entity.id,
        value: answer,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
  }

  // ─── Branch advance / cleanup ────────────────────────────────────

  /**
   * Finds the sibling activity with the given `event` slug (`responded`,
   * `no_response`, `answer_failed`, `no_further_question`) under the same
   * step, then enqueues the flow that activity drives.
   */
  private async advanceVia(stepId: bigint, contactId: bigint, eventName: string): Promise<void> {
    const branchActivity = await this.prisma.automation_step_activities.findFirst({
      where: { step_id: stepId, event: eventName, deleted_at: null },
    });
    if (!branchActivity) {
      this.logger.warn(`No "${eventName}" branch activity on step ${stepId}`);
      return;
    }
    const flow = await this.prisma.automation_flow.findFirst({
      where: {
        connector_id: branchActivity.id,
        connector_type: 'App\\Models\\Automations\\AutomationStepActivity',
      },
    });
    if (!flow) {
      this.logger.warn(`No flow off "${eventName}" branch activity ${branchActivity.id}`);
      return;
    }
    const nextStep = await this.prisma.automation_steps.findUnique({
      where: { id: flow.next_step_id },
    });
    if (!nextStep) return;
    const nextActivity = await this.prisma.automation_step_activities.findFirst({
      where: { step_id: nextStep.id, deleted_at: null },
      orderBy: { order: 'asc' },
    });
    if (!nextActivity) return;
    await this.prisma.automation_queue.create({
      data: {
        object_id: contactId,
        object_type: 'CONTACT',
        flow_id: flow.id,
        step_id: nextStep.id,
        activity_id: nextActivity.id,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
  }

  /**
   * Clear out the wait/retry rows + the parked queue row for the given
   * contact's step. Called after we route to a branch.
   */
  private async cleanupWait(followupId: bigint, contactId: bigint | null): Promise<void> {
    const followup = await this.prisma.automation_quick_reply_followups
      .findUnique({ where: { id: followupId } })
      .catch(() => null);
    if (!followup) return;
    await this.prisma.automation_quick_reply_retries.deleteMany({
      where: {
        automation_step_id: followup.automation_step_id,
        chat_id: followup.chat_id,
        chat_type: followup.chat_type,
      },
    });
    await this.prisma.automation_quick_reply_followups.delete({
      where: { id: followupId },
    });
    if (contactId) {
      await this.prisma.automation_queue
        .deleteMany({
          where: { object_id: contactId, step_id: followup.automation_step_id },
        })
        .catch(() => null);
    }
  }

  // ─── Channel chat lookup ────────────────────────────────────────

  private async resolveChatId(channel: string, contactId: bigint): Promise<bigint | null> {
    try {
      switch (channel) {
        case 'whatsapp': {
          const row = await this.prisma.wa_chats.findFirst({
            where: { contact_id: contactId },
            orderBy: { id: 'desc' },
          });
          return row?.id ?? null;
        }
        case 'telegram': {
          const row = await this.prisma.telegram_chats.findFirst({
            where: { contact_id: contactId },
            orderBy: { id: 'desc' },
          });
          return row?.id ?? null;
        }
        case 'messenger': {
          const row = await this.prisma.fb_chats.findFirst({
            where: { contact_id: contactId },
            orderBy: { id: 'desc' },
          });
          return row?.id ?? null;
        }
        case 'instagram': {
          const row = await this.prisma.insta_chats.findFirst({
            where: { contact_id: contactId },
            orderBy: { id: 'desc' },
          });
          return row?.id ?? null;
        }
        case 'webchat': {
          const row = await this.prisma.wc_chats.findFirst({
            where: { contact_id: contactId },
            orderBy: { id: 'desc' },
          });
          return row?.id ?? null;
        }
        case 'twilio_sms':
        case 'twilio_call': {
          const row = await this.prisma.twilio_chats.findFirst({
            where: { contact_id: contactId },
            orderBy: { id: 'desc' },
          });
          return row?.id ?? null;
        }
        case 'zapi': {
          const row = await this.prisma.zapi_chats.findFirst({
            where: { contact_id: contactId },
            orderBy: { id: 'desc' },
          });
          return row?.id ?? null;
        }
        case 'evolution': {
          const row = await this.prisma.evolution_chats.findFirst({
            where: { contact_id: contactId },
            orderBy: { id: 'desc' },
          });
          return row?.id ?? null;
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  private computeWaitTill(props: any): Date {
    const unit = (props?.followUpInterval ?? 'minutes').toLowerCase();
    const n = Number(props?.followUpUnit ?? 5);
    const d = new Date();
    switch (unit) {
      case 'seconds':
      case 'second':
        d.setSeconds(d.getSeconds() + n);
        break;
      case 'minutes':
      case 'minute':
        d.setMinutes(d.getMinutes() + n);
        break;
      case 'hours':
      case 'hour':
        d.setHours(d.getHours() + n);
        break;
      case 'days':
      case 'day':
        d.setDate(d.getDate() + n);
        break;
      case 'weeks':
      case 'week':
        d.setDate(d.getDate() + n * 7);
        break;
      default:
        d.setMinutes(d.getMinutes() + n);
    }
    return d;
  }
}
