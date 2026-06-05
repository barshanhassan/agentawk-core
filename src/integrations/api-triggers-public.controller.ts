import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Public webhook receiver for "Visual API triggers". External systems POST
 * arbitrary JSON to /api-triggers/webhook/:slug; we persist the payload as
 * an api_trigger_requests row, resolve / create the matching contact (using
 * the api_trigger's index_field — primary_mobile, primary_whatsapp or
 * primary_email), then emit the `api_trigger` event so any automation
 * activity with `event = 'api_trigger'` can dispatch.
 *
 * Mirrors replyagent's `POST /api-triggers/{slug}` public webhook route.
 */
@Controller('api-triggers/webhook')
export class ApiTriggersPublicController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  @Post(':slug')
  async receive(@Param('slug') slug: string, @Body() body: any) {
    if (!slug) throw new BadRequestException('slug required');
    const trigger = await this.prisma.api_triggers.findFirst({
      where: { slug, live: true } as any,
    });
    if (!trigger) {
      // Silently 200 so external integrations don't retry-storm us on a
      // disabled trigger — replyagent does the same.
      return { received: false, reason: 'trigger_not_found_or_disabled' };
    }

    // 1. Persist the request.
    const request = await this.prisma.api_trigger_requests.create({
      data: {
        api_trigger_id: trigger.id,
        data_keys: this.summariseKeys(body),
        payload: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
        status: 'SUCCESS' as any,
      } as any,
    });

    // 2. Resolve / create the contact using the trigger's index_field.
    const contactId = await this.resolveOrCreateContact(trigger, body);
    if (!contactId) {
      await this.prisma.api_trigger_requests.update({
        where: { id: request.id },
        data: { status: 'FAILED' as any, error: 'contact_resolution_failed' as any } as any,
      });
      return { received: true, contact_resolved: false };
    }

    // 3. Emit the trigger event — AutomationTriggerService listens for
    //    `event = 'api_trigger'` activities with this trigger's id filter.
    this.events.emit('integration.api_trigger', {
      apiTriggerId: trigger.id,
      contactId,
      workspaceId: trigger.workspace_id,
      payload: body,
    });

    return { received: true, contact_id: contactId.toString() };
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private summariseKeys(body: any): string {
    if (!body || typeof body !== 'object') return '[]';
    return JSON.stringify(Object.keys(body));
  }

  private async resolveOrCreateContact(trigger: any, body: any): Promise<bigint | null> {
    const mapping = this.parseJSON(trigger.mapping);
    const indexField = trigger.index_field;

    // mapping example: { primary_mobile: "user.phone", first_name: "user.firstName" }
    const indexValue = this.resolvePath(body, mapping?.[indexField]);
    if (!indexValue) return null;

    try {
      let contactId: bigint | null = null;

      if (indexField === 'primary_email') {
        const existing = await this.prisma.contact_emails.findFirst({
          where: {
            email: String(indexValue),
            modelable_type: 'App\\Models\\Contact',
          },
        });
        if (existing) contactId = existing.modelable_id;
      } else {
        // mobile / whatsapp both look up via contact_mobiles
        const existing = await this.prisma.contact_mobiles.findFirst({
          where: {
            mobile_number: String(indexValue),
            modelable_type: 'App\\Models\\Contact',
          },
        });
        if (existing) contactId = existing.modelable_id;
      }

      if (!contactId) {
        // Create a fresh contact + relevant link row.
        const firstName = this.resolvePath(body, mapping?.first_name) ?? 'Webhook';
        const lastName = this.resolvePath(body, mapping?.last_name) ?? 'Lead';
        const contact = await this.prisma.contacts.create({
          data: {
            workspace_id: trigger.workspace_id,
            first_name: String(firstName),
            last_name: String(lastName),
            full_name: `${firstName} ${lastName}`.trim(),
            source: 'API_TRIGGER',
            status: 'PENDING',
          } as any,
        });
        if (indexField === 'primary_email') {
          await this.prisma.contact_emails.create({
            data: {
              ownership_id: trigger.workspace_id,
              ownership_type: 'App\\Models\\Workspace',
              modelable_id: contact.id,
              modelable_type: 'App\\Models\\Contact',
              email: String(indexValue),
              is_primary: 1,
            } as any,
          });
        } else {
          await this.prisma.contact_mobiles.create({
            data: {
              ownership_id: trigger.workspace_id,
              ownership_type: 'App\\Models\\Workspace',
              modelable_id: contact.id,
              modelable_type: 'App\\Models\\Contact',
              mobile_number: String(indexValue),
              full_mobile_number: String(indexValue),
              country_id: 1n,
              is_primary: 1,
            } as any,
          });
        }
        contactId = contact.id;

        // Fire the contact.created event so contact_added triggers can also
        // run on the freshly-created contact.
        this.events.emit('contact.created', {
          contactId,
          workspaceId: trigger.workspace_id,
          source: 'API_TRIGGER',
        });
      }

      return contactId;
    } catch {
      return null;
    }
  }

  private parseJSON(raw: any): any {
    if (raw == null) return null;
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** Lookup `body.foo.bar` from `"foo.bar"` path string. */
  private resolvePath(obj: any, path: string | undefined | null): any {
    if (!path) return null;
    let cur = obj;
    for (const part of String(path).split('.')) {
      if (cur == null) return null;
      cur = cur[part];
    }
    return cur;
  }
}
