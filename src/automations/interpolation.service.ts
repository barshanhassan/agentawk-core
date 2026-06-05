import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Token interpolation — mirrors replyagent's `AutomationHelper::replaceKeys()`
 * (see gateway/app/Helper/AutomationHelper.php:1481-1602).
 *
 * Replaces `{{<key>}}` tokens in arbitrary strings before a message is sent
 * to a channel, an AI prompt is dispatched, or an HTTP body is rendered.
 *
 * Supported tokens:
 *   - {{contact_id}}, {{first_name}}, {{last_name}}, {{full_name}}, {{gender},
 *     {{language}}, {{locale}}, {{timezone}}, {{title}}, {{instagram_handler}}
 *   - {{primary_email}}, {{primary_mobile}}, {{primary_whatsapp}}
 *   - {{<custom_field_slug>}} — workspace-defined custom fields
 *   - {{last_message_<channel>_<channelable_id>}} — contact_last_messages
 *   - {{support_number_<channel>_<channelable_id>}} — support_numbers
 *   - {{RefClicks_<TimeFrame>_<AdId|All>}} — referrals aggregate
 *     TimeFrame ∈ Today | Yesterday | PastWeek | CurrentWeek | PastMonth |
 *                 CurrentMonth
 *   - {{now.iso}}, {{now.epoch}}, {{now.date}} — system clock
 *
 * Fixed-value custom fields (is_fixed=1) get their workspace-static value
 * injected without lookups against per-contact storage.
 *
 * NEVER throws — missing tables / contact / fields just leave the token
 * un-replaced. Keeping the original behaviour from replyagent so a bad token
 * doesn't break the rest of the message.
 */
@Injectable()
export class InterpolationService {
  private readonly logger = new Logger(InterpolationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Public entry point — interpolates a single string. */
  async interpolate(
    text: string,
    contactId: bigint | null | undefined,
    workspaceId: bigint | null | undefined,
  ): Promise<string> {
    if (!text || typeof text !== 'string' || !text.includes('{{')) return text ?? '';
    try {
      const tokens = await this.buildTokenMap(contactId, workspaceId);
      let out = text;

      // 1. Static tokens — single-pass scan.
      for (const [k, v] of Object.entries(tokens)) {
        if (v === undefined || v === null) continue;
        const needle = `{{${k}}}`;
        if (out.includes(needle)) out = out.split(needle).join(String(v));
      }

      // 2. Dynamic tokens — RefClicks need parameter parsing.
      out = await this.replaceRefClicks(out, contactId, workspaceId);

      // 3. Time helpers.
      out = this.replaceTimeTokens(out);

      return out;
    } catch (e: any) {
      this.logger.warn(`interpolate failed: ${e?.message ?? e}`);
      return text;
    }
  }

  /** Walk arbitrary JSON-y values and interpolate every string in place. */
  async interpolateDeep(
    value: any,
    contactId: bigint | null | undefined,
    workspaceId: bigint | null | undefined,
  ): Promise<any> {
    if (value == null) return value;
    if (typeof value === 'string') return this.interpolate(value, contactId, workspaceId);
    if (Array.isArray(value)) {
      const out: any[] = [];
      for (const item of value) out.push(await this.interpolateDeep(item, contactId, workspaceId));
      return out;
    }
    if (typeof value === 'object') {
      const out: any = {};
      for (const k of Object.keys(value)) {
        out[k] = await this.interpolateDeep(value[k], contactId, workspaceId);
      }
      return out;
    }
    return value;
  }

  // ─── Token-map builder ───────────────────────────────────────────────

  private async buildTokenMap(
    contactId: bigint | null | undefined,
    workspaceId: bigint | null | undefined,
  ): Promise<Record<string, string>> {
    const tokens: Record<string, string> = {};

    if (contactId) {
      tokens['contact_id'] = String(contactId);
      await this.addContactTokens(tokens, contactId);
      await this.addPrimaryChannelTokens(tokens, contactId);
      if (workspaceId) {
        await this.addCustomFieldTokens(tokens, contactId, workspaceId);
        await this.addLastMessageTokens(tokens, contactId);
        await this.addSupportNumberTokens(tokens, contactId);
      }
    }

    if (workspaceId) {
      await this.addFixedValueTokens(tokens, workspaceId);
    }

    return tokens;
  }

  private async addContactTokens(tokens: Record<string, string>, contactId: bigint) {
    const c = await this.prisma.contacts
      .findUnique({
        where: { id: contactId },
        select: {
          first_name: true,
          last_name: true,
          full_name: true,
          gender: true,
          language: true,
          locale: true,
          timezone: true,
          title: true,
          instagram_handler: true,
          source_name: true,
        },
      })
      .catch(() => null);
    if (!c) return;
    tokens['first_name'] = c.first_name ?? '';
    tokens['last_name'] = c.last_name ?? '';
    tokens['full_name'] = c.full_name ?? '';
    tokens['name'] = c.full_name ?? c.first_name ?? '';
    tokens['gender'] = c.gender ?? '';
    tokens['language'] = c.language ?? '';
    tokens['locale'] = c.locale ?? '';
    tokens['timezone'] = c.timezone ?? '';
    tokens['title'] = c.title ?? '';
    tokens['instagram_handler'] = c.instagram_handler ?? '';
    tokens['source'] = c.source_name ?? '';
  }

  private async addPrimaryChannelTokens(tokens: Record<string, string>, contactId: bigint) {
    // contact_mobiles + contact_emails are polymorphic (modelable_type='App\\Models\\Contact').
    const mobile = await this.prisma.contact_mobiles
      .findFirst({
        where: { modelable_type: 'App\\Models\\Contact', modelable_id: contactId, is_primary: 1 },
        select: { mobile_number: true, country_code: true },
      })
      .catch(() => null);
    if (mobile?.mobile_number) {
      tokens['primary_mobile'] = `${mobile.country_code ?? ''}${mobile.mobile_number}`;
      tokens['primary_whatsapp'] = `${mobile.country_code ?? ''}${mobile.mobile_number}`;
    }

    const email = await this.prisma.contact_emails
      .findFirst({
        where: { modelable_type: 'App\\Models\\Contact', modelable_id: contactId, is_primary: 1 },
        select: { email: true },
      })
      .catch(() => null);
    if (email?.email) tokens['primary_email'] = email.email;
  }

  private async addCustomFieldTokens(
    tokens: Record<string, string>,
    contactId: bigint,
    workspaceId: bigint,
  ) {
    // custom_field_entities row links a contact (entity_type='App\\Models\\Contact')
    // to a custom_field; the value lives in custom_field_entity_values.
    const entities = await this.prisma.custom_field_entities
      .findMany({
        where: { entity_type: 'App\\Models\\Contact', entity_id: contactId },
        select: { id: true, custom_field_id: true },
      })
      .catch(() => [] as any[]);
    if (!entities.length) return;

    const fields = await this.prisma.custom_fields
      .findMany({
        where: {
          id: { in: entities.map((e: any) => e.custom_field_id) },
          workspace_id: workspaceId,
        },
        select: { id: true, slug: true, is_multiselect: true },
      })
      .catch(() => [] as any[]);
    const slugById = new Map<string, { slug: string; multi: boolean }>();
    for (const f of fields) {
      slugById.set(f.id.toString(), { slug: f.slug, multi: Boolean(f.is_multiselect) });
    }

    const values = await this.prisma.custom_field_entity_values
      .findMany({
        where: { cf_entity_id: { in: entities.map((e: any) => e.id) } },
        select: { cf_entity_id: true, value: true },
      })
      .catch(() => [] as any[]);

    const entityToField = new Map<string, string>();
    for (const e of entities) entityToField.set(e.id.toString(), e.custom_field_id.toString());

    const grouped = new Map<string, string[]>();
    for (const v of values) {
      const cfId = entityToField.get(v.cf_entity_id.toString());
      if (!cfId) continue;
      const meta = slugById.get(cfId);
      if (!meta) continue;
      if (!grouped.has(meta.slug)) grouped.set(meta.slug, []);
      grouped.get(meta.slug)!.push(v.value);
    }

    for (const [slug, vals] of grouped.entries()) {
      const meta = [...slugById.values()].find((m) => m.slug === slug);
      tokens[slug] = meta?.multi ? vals.join(', ') : vals[0] ?? '';
    }
  }

  private async addFixedValueTokens(tokens: Record<string, string>, workspaceId: bigint) {
    const fixed = await this.prisma.custom_fields
      .findMany({
        where: { workspace_id: workspaceId, is_fixed: 1 },
        select: { slug: true, fixed_value: true },
      })
      .catch(() => [] as any[]);
    for (const f of fixed) {
      // Don't overwrite per-contact values if both happen to share the slug.
      if (!(f.slug in tokens)) tokens[f.slug] = f.fixed_value ?? '';
    }
  }

  private async addLastMessageTokens(tokens: Record<string, string>, contactId: bigint) {
    const rows = await this.prisma.contact_last_messages
      .findMany({
        where: { contact_id: contactId },
        select: { channel: true, channelable_id: true, message: true },
      })
      .catch(() => [] as any[]);
    for (const r of rows) {
      if (!r.message) continue;
      const key = `last_message_${r.channel}_${r.channelable_id}`;
      tokens[key] = r.message;
    }
  }

  private async addSupportNumberTokens(tokens: Record<string, string>, contactId: bigint) {
    const rows = await this.prisma.support_numbers
      .findMany({
        where: { contact_id: contactId, is_open: 1 },
        select: { channel_type: true, channelable_id: true, sn_number: true },
      })
      .catch(() => [] as any[]);
    for (const r of rows) {
      const key = `support_number_${r.channel_type}_${r.channelable_id}`;
      tokens[key] = r.sn_number;
    }
  }

  // ─── RefClicks_<TimeFrame>_<Action> — runtime parse ─────────────────

  private async replaceRefClicks(
    text: string,
    contactId: bigint | null | undefined,
    workspaceId: bigint | null | undefined,
  ): Promise<string> {
    if (!workspaceId || !text.includes('RefClicks_')) return text;
    const re = /\{\{(RefClicks_[^}]+)\}\}/g;
    const matches = [...text.matchAll(re)];
    if (!matches.length) return text;

    let out = text;
    for (const m of matches) {
      const full = m[0];
      const key = m[1];
      const parts = key.split('_');
      if (parts.length !== 3) continue;
      const [, timeFrame, action] = parts;
      const range = this.timeFrameRange(timeFrame);
      try {
        const where: any = { workspace_id: workspaceId };
        if (range[0] && range[1]) where.created_at = { gte: range[0], lte: range[1] };
        if (action !== 'All') where.ad_id = action;
        const rows = await this.prisma.referrals.findMany({
          where,
          select: {
            ad_id: true,
            title: true,
            subtitle: true,
            created_at: true,
            contact_id: true,
          },
        });
        out = out.split(full).join(JSON.stringify(rows));
      } catch {
        // leave token un-replaced on error
      }
    }
    return out;
  }

  private timeFrameRange(tf: string): [Date | null, Date | null] {
    const now = new Date();
    const startOfDay = (d: Date) => {
      const x = new Date(d);
      x.setHours(0, 0, 0, 0);
      return x;
    };
    const endOfDay = (d: Date) => {
      const x = new Date(d);
      x.setHours(23, 59, 59, 999);
      return x;
    };
    switch (tf) {
      case 'Today':
        return [startOfDay(now), endOfDay(now)];
      case 'Yesterday': {
        const y = new Date(now);
        y.setDate(now.getDate() - 1);
        return [startOfDay(y), endOfDay(y)];
      }
      case 'PastWeek': {
        const start = new Date(now);
        start.setDate(now.getDate() - 7);
        const end = new Date(now);
        end.setDate(now.getDate() - 1);
        return [startOfDay(start), endOfDay(end)];
      }
      case 'CurrentWeek': {
        const start = new Date(now);
        start.setDate(now.getDate() - now.getDay());
        const end = new Date(start);
        end.setDate(start.getDate() + 6);
        return [startOfDay(start), endOfDay(end)];
      }
      case 'PastMonth': {
        const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const end = new Date(now.getFullYear(), now.getMonth(), 0);
        return [startOfDay(start), endOfDay(end)];
      }
      case 'CurrentMonth': {
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        return [startOfDay(start), endOfDay(end)];
      }
      default:
        return [null, null];
    }
  }

  // ─── Time helpers ───────────────────────────────────────────────────

  private replaceTimeTokens(text: string): string {
    if (!text.includes('{{now.')) return text;
    const now = new Date();
    return text
      .replaceAll('{{now.iso}}', now.toISOString())
      .replaceAll('{{now.epoch}}', String(Math.floor(now.getTime() / 1000)))
      .replaceAll('{{now.date}}', now.toISOString().slice(0, 10));
  }
}
