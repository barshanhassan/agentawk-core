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
    const trigger = await this.prisma.api_triggers.findFirst({ where: { slug } });
    if (!trigger) {
      // Silently 200 so external integrations don't retry-storm us on an
      // unknown trigger.
      return { received: false, reason: 'trigger_not_found' };
    }

    // Flatten the incoming payload into dot-notation leaf nodes — mirrors
    // replyagent's `extract_leaf_nodes_recursive` in PHP. The resulting dict
    // is what powers the Manage view's "Select a key to map" picker.
    const dataKeys = this.flattenLeaves(body ?? {});

    // ── Flow split (mirrors ApiTriggersController::triggerRequest) ──────
    //
    //  1. If trigger is LIVE → save a request row + run automation.
    //  2. If trigger is NOT live AND mapped_keys is empty → bootstrap the
    //     mapping picker by storing the incoming keys as `mapped_keys`.
    //  3. If trigger is NOT live AND mapped_keys exists but the incoming
    //     keys differ → stash them as `new_keys`; the Manage view will
    //     show an "Update Mapping" banner.
    //
    if (trigger.live) {
      const request = await this.prisma.api_trigger_requests.create({
        data: {
          api_trigger_id: trigger.id,
          data_keys: JSON.stringify(dataKeys),
          payload: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
          status: 'SUCCESS' as any,
          created_at: new Date(),
          updated_at: new Date(),
        } as any,
      });

      const contactId = await this.resolveOrCreateContact(trigger, body);
      if (!contactId) {
        await this.prisma.api_trigger_requests.update({
          where: { id: request.id },
          data: { status: 'FAILED' as any, error: 'contact_resolution_failed' as any } as any,
        });
        return { received: true, contact_resolved: false };
      }

      this.events.emit('integration.api_trigger', {
        apiTriggerId: trigger.id,
        contactId,
        workspaceId: trigger.workspace_id,
        payload: body,
      });

      return { success: 'Request received' };
    }

    // Not live: bootstrap or accumulate keys.
    if (!trigger.mapped_keys) {
      await this.prisma.api_triggers.update({
        where: { id: trigger.id },
        data: { mapped_keys: JSON.stringify(dataKeys), updated_at: new Date() } as any,
      });
    } else {
      // Only set new_keys if they differ from mapped_keys so we don't
      // pollute the Manage UI with redundant "Update mapping" banners.
      const existing = this.parseJSON(trigger.mapped_keys) ?? {};
      const sameShape = JSON.stringify(Object.keys(existing).sort()) === JSON.stringify(Object.keys(dataKeys).sort());
      if (!sameShape) {
        await this.prisma.api_triggers.update({
          where: { id: trigger.id },
          data: { new_keys: JSON.stringify(dataKeys), updated_at: new Date() } as any,
        });
      }
    }

    this.events.emit('api_trigger.updated', {
      apiTriggerId: trigger.id,
      workspaceId: trigger.workspace_id,
    });

    return { success: 'Request received' };
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  /** Recursively flatten an object into dot-notation leaves —
   *  `{a:{b:1}, c:2}` → `{"a.b":1, "c":2}`. Matches PHP
   *  `extract_leaf_nodes_recursive`. */
  private flattenLeaves(data: any, prefix = '', out: Record<string, any> = {}): Record<string, any> {
    if (data == null || typeof data !== 'object') return out;
    for (const [k, v] of Object.entries(data)) {
      const path = prefix === '' ? k : `${prefix}.${k}`;
      if (v != null && typeof v === 'object' && !Array.isArray(v)) {
        this.flattenLeaves(v, path, out);
      } else {
        out[path] = v;
      }
    }
    return out;
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
