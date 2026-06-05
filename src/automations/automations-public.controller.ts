import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationProcessorService } from './automation-processor.service';

/**
 * Public (no-auth) endpoints for triggering automations from external systems —
 * e.g. wa.me deep links, ad landing pages, email click-throughs.
 *
 * Mirrors replyagent's `/trigger-automation/{activitySlug}` route which sat
 * outside the auth middleware so anyone with the slug could fire the flow.
 *
 * Contact resolution order (first hit wins):
 *   1. ?contact_id=<numeric>           — direct
 *   2. ?wa_id=<E.164>                  — looks up wa_chats.wa_id
 *   3. ?phone=<E.164>                  — looks up contact_mobiles.mobile_number
 *   4. ?email=<addr>                   — looks up contact_emails.email
 *
 * Returns 200 with { triggered: true } on success — never reveals automation
 * internals to the caller. If the slug or contact can't be resolved we still
 * 200 with { triggered: false, reason } so misconfigured links don't spam logs.
 */
@Controller('automations/public')
export class AutomationsPublicController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly processor: AutomationProcessorService,
  ) {}

  @Get('trigger/:slug')
  async triggerBySlug(
    @Param('slug') slug: string,
    @Query() query: any,
  ) {
    if (!slug) throw new BadRequestException('slug is required');

    const contactId = await this.resolveContactId(query);
    if (!contactId) {
      return {
        triggered: false,
        reason: 'contact_not_found',
      };
    }

    const activity = await this.prisma.automation_step_activities.findFirst({
      where: { slug, deleted_at: null },
    });
    if (!activity) {
      return {
        triggered: false,
        reason: 'activity_not_found',
      };
    }

    // Confirm the activity belongs to an active automation in the contact's
    // workspace — public endpoints must not cross workspace boundaries.
    const step = await this.prisma.automation_steps.findUnique({
      where: { id: activity.step_id },
    });
    if (!step) {
      return { triggered: false, reason: 'step_not_found' };
    }
    const version = await this.prisma.automation_versions.findUnique({
      where: { id: step.automation_version_id },
    });
    if (!version) return { triggered: false, reason: 'version_not_found' };
    const automation = await this.prisma.automations.findUnique({
      where: { id: version.automation_id },
    });
    if (!automation) return { triggered: false, reason: 'automation_not_found' };

    const contact = await this.prisma.contacts.findUnique({ where: { id: contactId } });
    if (!contact || contact.workspace_id !== automation.workspace_id) {
      return { triggered: false, reason: 'workspace_mismatch' };
    }
    if (automation.status !== 'active') {
      return { triggered: false, reason: 'automation_not_active' };
    }

    await this.processor.triggerAutomation(activity.id, contactId);
    return { triggered: true };
  }

  private async resolveContactId(query: any): Promise<bigint | null> {
    if (query?.contact_id) {
      try {
        return BigInt(query.contact_id);
      } catch {}
    }
    if (query?.wa_id) {
      const chat = await this.prisma.wa_chats.findFirst({
        where: { wa_id: String(query.wa_id) },
        orderBy: { last_interacted_at: 'desc' },
      });
      if (chat?.contact_id) return chat.contact_id;
    }
    if (query?.phone) {
      // contact_mobiles is polymorphic — modelable_type='App\\Models\\Contact'
      // pins the lookup to contacts (excluding companies, etc.).
      const mobile = await this.prisma.contact_mobiles.findFirst({
        where: {
          mobile_number: String(query.phone),
          modelable_type: 'App\\Models\\Contact',
        },
      });
      if (mobile?.modelable_id) return mobile.modelable_id;
    }
    if (query?.email) {
      const em = await this.prisma.contact_emails.findFirst({
        where: {
          email: String(query.email),
          modelable_type: 'App\\Models\\Contact',
        },
      });
      if (em?.modelable_id) return em.modelable_id;
    }
    return null;
  }
}
