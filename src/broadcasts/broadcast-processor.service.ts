import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AudienceFilterService } from './audience-filter.service';
import { AutomationProcessorService } from '../automations/automation-processor.service';
import { RabbitMqService } from '../rabbitmq/rabbitmq.service';

/**
 * Marks a template variable value as personalised, e.g. "[CONTACT_FIRST_NAME]".
 * Kept in sync with the token picker in the frontend broadcast composer.
 */
const TOKEN_PATTERN = /\[[A-Z_]+\]/;

@Injectable()
export class BroadcastProcessorService {
  private readonly logger = new Logger(BroadcastProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audienceFilter: AudienceFilterService,
    private readonly automationProcessor: AutomationProcessorService,
    private readonly rabbit: RabbitMqService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async processBroadcasts() {
    // Find broadcasts that are PENDING or SCHEDULED and due
    const broadcasts = await this.prisma.broadcasts.findMany({
      where: {
        status: { in: ['pending', 'in_progress'] as any },
        locked: false,
        OR: [
          { scheduled_at: { lte: new Date() } },
          { scheduled_at: null }
        ]
      },
      take: 5
    });

    for (const broadcast of broadcasts) {
      await this.executeBroadcast(broadcast);
    }
  }

  /**
   * Public entrypoint used by the BullMQ worker. Loads the broadcast by id and
   * delegates to the same private executor — keeps cron + queue paths sharing
   * the same body of work.
   */
  async executeBroadcastById(broadcastId: bigint) {
    const broadcast = await this.prisma.broadcasts.findUnique({
      where: { id: broadcastId },
    });
    if (!broadcast) {
      this.logger.warn(`executeBroadcastById: broadcast ${broadcastId} not found`);
      return { skipped: true, reason: 'not_found' };
    }
    if (broadcast.locked) {
      this.logger.warn(`executeBroadcastById: broadcast ${broadcastId} is locked — already running`);
      return { skipped: true, reason: 'locked' };
    }
    await this.executeBroadcast(broadcast);
    return { processed: true };
  }

  private async executeBroadcast(broadcast: any) {
    this.logger.log(`Executing broadcast: ${broadcast.name} (${broadcast.id})`);

    // Lock the broadcast
    await this.prisma.broadcasts.update({
      where: { id: broadcast.id },
      data: { locked: true, started_at: new Date(), status: 'in_progress' as any }
    });

    try {
      // Two send paths: template broadcasts (the create-form flow, which sets
      // `wa_template_id`) send the WhatsApp template straight to the audience;
      // legacy broadcasts that reference an automation trigger keep working.
      let result: { audience: number; sent: number };
      if (broadcast.wa_template_id) {
        result = await this.sendTemplateBroadcast(broadcast);
      } else if (broadcast.automation_id) {
        result = await this.executeAutomationBroadcast(broadcast);
      } else {
        throw new Error('Broadcast has no WhatsApp template or automation to send');
      }

      await this.prisma.broadcasts.update({
        where: { id: broadcast.id },
        data: {
          status: 'completed' as any,
          finished_at: new Date(),
          total_audience: result.audience,
          total_sent: result.sent,
          locked: false,
        },
      });

      this.logger.log(
        `Broadcast ${broadcast.id} completed — audience ${result.audience}, sent ${result.sent}`,
      );
    } catch (error: any) {
      // fail_reason is VARCHAR(255); Prisma error messages can be far longer, so
      // truncate before persisting — otherwise this very UPDATE throws P2000 and
      // the broadcast is left stuck at `in_progress` + `locked`, unable to retry.
      const reason = String(error?.message ?? error).slice(0, 255);
      this.logger.error(`Broadcast ${broadcast.id} failed: ${reason}`);
      await this.prisma.broadcasts
        .update({
          where: { id: broadcast.id },
          data: { status: 'failed' as any, fail_reason: reason, locked: false },
        })
        .catch((e: any) =>
          this.logger.error(
            `Broadcast ${broadcast.id}: could not persist failure state — ${e?.message ?? e}`,
          ),
        );
    }
  }

  /**
   * Legacy path — a broadcast bound to an automation with a `broadcast` trigger
   * activity. Bulk-triggers that automation for the resolved audience.
   */
  private async executeAutomationBroadcast(
    broadcast: any,
  ): Promise<{ audience: number; sent: number }> {
    const automation = await this.prisma.automations.findUnique({
      where: { id: broadcast.automation_id },
    });
    if (!automation) throw new Error(`Automation ${broadcast.automation_id} not found`);

    const versionId = automation.published_version_id || automation.draft_version_id;
    if (!versionId) throw new Error(`No version found for automation ${automation.id}`);

    const steps = await this.prisma.automation_steps.findMany({
      where: { automation_version_id: versionId, type: 'trigger' },
    });

    let triggerActivity: any = null;
    for (const step of steps) {
      const activity = await this.prisma.automation_step_activities.findFirst({
        where: { step_id: step.id, event: 'broadcast', deleted_at: null },
      });
      if (activity) {
        triggerActivity = activity;
        break;
      }
    }
    if (!triggerActivity) {
      throw new Error(`No broadcast trigger activity found for automation ${automation.id}`);
    }

    const contactIds = await this.audienceFilter.getAudienceContactIds(
      broadcast.workspace_id,
      broadcast.filters || '{}',
    );
    if (contactIds.length > 0) {
      await this.automationProcessor.triggerAutomationBulk(triggerActivity.id, contactIds);
    }
    return { audience: contactIds.length, sent: contactIds.length };
  }

  /**
   * Template broadcast — send the WhatsApp template to every reachable contact
   * in the audience. Mirrors the inbox outbound path: publish one
   * WA_OUTBOUND_MESSAGE per recipient on `ra/whatsapp`; the meta microservice
   * forwards each to Meta's `/{phone_number_id}/messages`.
   *
   * Body variables ({{1}}, {{2}}…) come from metadata.templateParams. A value
   * may be plain text (same for everyone) or contain [CONTACT_*] tokens, which
   * are resolved per recipient — mirroring replyagent, which bakes the tokens
   * into the template payload and swaps them for each contact at send time.
   */
  private async sendTemplateBroadcast(
    broadcast: any,
  ): Promise<{ audience: number; sent: number }> {
    // 1. Template
    const template = await this.prisma.wa_templates.findUnique({
      where: { id: BigInt(broadcast.wa_template_id) },
    });
    if (!template) throw new Error(`WhatsApp template ${broadcast.wa_template_id} not found`);
    if (String(template.status).toUpperCase() !== 'APPROVED') {
      throw new Error(`Template "${template.name}" is not APPROVED (status: ${template.status})`);
    }

    // 2. Sending account + an ACTIVE phone number (channelable_id = wa_accounts.id)
    const account = await this.prisma.wa_accounts.findUnique({
      where: { id: broadcast.channelable_id },
    });
    if (!account) throw new Error(`WhatsApp account ${broadcast.channelable_id} not found`);
    if (!account.meta_account_id) {
      throw new Error(
        'WhatsApp account is not registered with the microservice yet (meta_account_id missing)',
      );
    }
    const phone = await this.prisma.wa_phone_numbers.findFirst({
      where: { wa_account_id: account.id, status: 'ACTIVE' },
      orderBy: { id: 'asc' },
    });
    if (!phone) throw new Error('No ACTIVE phone number on the selected WhatsApp account');

    // 3. Audience
    const contactIds = await this.audienceFilter.getAudienceContactIds(
      broadcast.workspace_id,
      broadcast.filters || '{}',
    );
    if (contactIds.length === 0) return { audience: 0, sent: 0 };

    // 4. Template message body (name + language). Values for the body
    //    placeholders ({{1}}, {{2}}…) are stored as metadata.templateParams by
    //    the composer and attached as a BODY component so Meta accepts variable
    //    templates.
    let templateParams: string[] = [];
    try {
      const md = broadcast.metadata ? JSON.parse(broadcast.metadata) : {};
      if (Array.isArray(md?.templateParams)) {
        templateParams = md.templateParams.map((v: any) => String(v ?? ''));
      }
    } catch {
      /* metadata isn't valid JSON — treat as no params */
    }

    const buildTemplate = (params: string[]) => {
      const payload: any = {
        name: template.name,
        language: { code: template.language || 'en' },
      };
      if (params.length > 0) {
        payload.components = [
          { type: 'body', parameters: params.map((text) => ({ type: 'text', text })) },
        ];
      }
      return payload;
    };

    // Personalised only when a value actually carries a [CONTACT_*] token —
    // otherwise the payload is identical for everyone and is built once.
    const isPersonalised = templateParams.some((p) => TOKEN_PATTERN.test(p));
    const staticTemplate = isPersonalised ? null : buildTemplate(templateParams);

    const contactsById = new Map<string, any>();
    if (isPersonalised) {
      const rows = await this.prisma.contacts.findMany({
        where: { id: { in: contactIds } },
        select: {
          id: true,
          first_name: true,
          last_name: true,
          full_name: true,
          title: true,
          created_at: true,
        },
      });
      for (const c of rows) contactsById.set(c.id.toString(), c);
    }

    const exchange = process.env.RABBITMQ_EXCHANGE || 'ra';
    const whatsappQueue = process.env.RABBITMQ_WHATSAPP_QUEUE || 'whatsapp';

    // 5. One WA_OUTBOUND_MESSAGE per reachable contact.
    let sent = 0;
    for (const contactId of contactIds) {
      const mobile = await this.prisma.contact_mobiles.findFirst({
        where: { modelable_type: 'App\\Models\\Contact', modelable_id: contactId },
        orderBy: [{ is_primary: 'desc' }, { id: 'asc' }],
      });
      const to = (mobile?.full_mobile_number ?? '').replace(/[^\d]/g, '');
      if (!to) continue;

      const contactTemplate = isPersonalised
        ? buildTemplate(
            templateParams.map((p) =>
              this.resolveTokens(p, contactsById.get(contactId.toString())),
            ),
          )
        : staticTemplate;

      try {
        await this.rabbit.publish(exchange, whatsappQueue, {
          event: 'WA_OUTBOUND_MESSAGE',
          payload: {
            accountId: account.meta_account_id,
            phoneNumberId: phone.wa_number_id,
            context: {
              messaging_product: 'whatsapp',
              to,
              type: 'template',
              template: contactTemplate,
            },
            meta: {
              workspace_id: account.workspace_id.toString(),
              broadcast_id: broadcast.id.toString(),
            },
          },
        });
        sent++;
      } catch (err: any) {
        this.logger.warn(
          `Broadcast ${broadcast.id}: publish failed for contact ${contactId} — ${err?.message ?? err}`,
        );
      }
    }

    return { audience: contactIds.length, sent };
  }

  /**
   * Swap [CONTACT_*] tokens in a template variable value for this recipient's
   * own data. Mirrors replyagent's ContactHelper::replaceKeys — a plain
   * substring replace, so a token can sit inside a sentence ("Hi
   * [CONTACT_FIRST_NAME]"). Meta rejects empty parameters, so a value that
   * resolves to nothing (e.g. contact has no first name) falls back to "-".
   */
  private resolveTokens(text: string, contact: any): string {
    const stamp = (value: any) => {
      const date = value ? new Date(value) : null;
      if (!date || Number.isNaN(date.getTime())) return '';
      return date.toISOString().slice(0, 16).replace('T', ' ');
    };
    const values: Record<string, string> = {
      '[CONTACT_FIRST_NAME]': contact?.first_name ?? '',
      '[CONTACT_LAST_NAME]': contact?.last_name ?? '',
      '[CONTACT_FULL_NAME]': contact?.full_name ?? '',
      '[CONTACT_TITLE]': contact?.title ?? '',
      '[CREATED_AT]': stamp(contact?.created_at),
      '[CURRENT_DATETIME]': stamp(new Date()),
    };
    let out = text;
    for (const [token, value] of Object.entries(values)) {
      out = out.split(token).join(value);
    }
    out = out.trim();
    return out === '' ? '-' : out;
  }
}
