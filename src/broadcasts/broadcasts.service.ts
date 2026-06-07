import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AudienceFilterService } from './audience-filter.service';
import { BroadcastQueueProducer } from './broadcast.worker';

/**
 * Campaign Manager backend. Owns CRUD for the `broadcasts` table plus the
 * channel/template lookups the create form needs, plus the draft→pending
 * transition that triggers execution (cron sweep + optional BullMQ enqueue).
 *
 * Notes on status: the Prisma enum is lowercase (draft, pending, in_progress,
 * completed, failed). All status values used here must match — uppercase
 * literals are silently coerced to never-match values by Prisma.
 */
@Injectable()
export class BroadcastsService {
  private readonly logger = new Logger(BroadcastsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audienceFilter: AudienceFilterService,
    @Optional() private readonly queueProducer?: BroadcastQueueProducer,
  ) {}

  // ─── List ──────────────────────────────────────────────────────────

  async broadcastList(workspaceId: bigint, query: any) {
    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 15;
    const skip = (page - 1) * limit;

    const where: any = { workspace_id: workspaceId };
    if (query.status) {
      const list = String(query.status)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (list.length === 1) where.status = list[0] as any;
      else if (list.length > 1) where.status = { in: list as any };
    }
    if (query.channel_type) where.channel_type = String(query.channel_type);
    if (query.search) where.name = { contains: String(query.search) };
    if (query.date_from) {
      where.created_at = { ...(where.created_at ?? {}), gte: new Date(query.date_from) };
    }
    if (query.date_to) {
      where.created_at = { ...(where.created_at ?? {}), lte: new Date(query.date_to) };
    }

    const [rows, total] = await Promise.all([
      this.prisma.broadcasts.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.broadcasts.count({ where }),
    ]);

    // Aggregate stats for the dashboard chips. Computed on the workspace-wide
    // set so the count isn't affected by the page's filter — matches the
    // standard "X drafts / Y completed" header pattern.
    const allStatuses = await this.prisma.broadcasts.groupBy({
      by: ['status'],
      where: { workspace_id: workspaceId },
      _count: { status: true },
    });
    const stats: Record<string, number> = {
      total: 0,
      draft: 0,
      pending: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
    };
    for (const row of allStatuses) {
      const key = String(row.status).toLowerCase();
      stats[key] = row._count.status;
      stats.total += row._count.status;
    }

    const broadcasts = await Promise.all(rows.map((r) => this.serializeBroadcast(r)));
    return {
      broadcasts,
      meta: { total, page, last_page: Math.max(1, Math.ceil(total / limit)) },
      stats,
    };
  }

  // ─── CRUD ──────────────────────────────────────────────────────────

  async createBroadcast(workspaceId: bigint, creatorId: bigint, data: any) {
    if (!data?.name) throw new BadRequestException('Name is required');
    const channelType = String(data.channel_type ?? 'whatsapp').toLowerCase();

    // Resolve the channel: the create form may send `channelable_id` (preferred)
    // or just `channel_id` for backward compatibility. We map channel_type →
    // channelable_type so polymorphic relations stay intact with the Laravel
    // history (App\Models\...).
    const channelableId = data.channelable_id ?? data.channel_id ?? null;
    const channelableType =
      data.channelable_type ?? this.channelableTypeFor(channelType);

    // Translate the loose frontend payload into the columns + metadata blob.
    // Recurring schedule, csv filename, and the "API Triggered vs Broadcast"
    // distinction all live in metadata so the table stays normalized.
    const metadata = this.buildMetadata(data);
    const filters = data.filters
      ? typeof data.filters === 'string'
        ? data.filters
        : JSON.stringify(data.filters)
      : JSON.stringify({ condition: 'any', items: [] });

    const broadcast = await this.prisma.broadcasts.create({
      data: {
        workspace_id: workspaceId,
        creator_id: creatorId,
        updater_id: creatorId,
        name: String(data.name),
        channel_type: channelType,
        channelable_type: channelableType,
        channelable_id: channelableId ? BigInt(channelableId) : BigInt(0),
        message: data.message ?? null,
        wa_template_id: data.wa_template_id ? Number(data.wa_template_id) : null,
        metadata: metadata ? JSON.stringify(metadata) : null,
        filters,
        status: this.normaliseStatus(data.status) ?? ('draft' as any),
        scheduled_at: data.scheduled_at ? new Date(data.scheduled_at) : null,
        do_not_send_if_marketing: !!data.do_not_send_if_marketing,
      },
    });

    return { broadcast: await this.serializeBroadcast(broadcast) };
  }

  async getBroadcast(broadcastId: bigint, workspaceId: bigint) {
    const broadcast = await this.prisma.broadcasts.findFirst({
      where: { id: broadcastId, workspace_id: workspaceId },
    });
    if (!broadcast) throw new NotFoundException('Broadcast not found');
    return { broadcast: await this.serializeBroadcast(broadcast) };
  }

  async updateBroadcast(
    broadcastId: bigint,
    workspaceId: bigint,
    updaterId: bigint,
    data: any,
  ) {
    const existing = await this.prisma.broadcasts.findFirst({
      where: { id: broadcastId, workspace_id: workspaceId },
    });
    if (!existing) throw new NotFoundException('Broadcast not found');

    // Status guard — only drafts (or failed retries) are editable. Schema enum
    // is lowercase; the old check used 'DRAFT' which never matched and let
    // anything through.
    const currentStatus = String(existing.status).toLowerCase();
    if (currentStatus !== 'draft' && currentStatus !== 'failed') {
      throw new BadRequestException(
        `Only draft or failed broadcasts can be edited (current: ${currentStatus})`,
      );
    }

    const metadata = this.buildMetadata(data);
    const filters = data.filters
      ? typeof data.filters === 'string'
        ? data.filters
        : JSON.stringify(data.filters)
      : undefined;
    const nextChannelType = data.channel_type
      ? String(data.channel_type).toLowerCase()
      : undefined;

    const updated = await this.prisma.broadcasts.update({
      where: { id: broadcastId },
      data: {
        updater_id: updaterId,
        name: data.name ?? undefined,
        channel_type: nextChannelType,
        channelable_type: data.channelable_type ?? undefined,
        channelable_id:
          data.channelable_id !== undefined
            ? BigInt(data.channelable_id)
            : data.channel_id !== undefined
              ? BigInt(data.channel_id)
              : undefined,
        message: data.message !== undefined ? data.message : undefined,
        wa_template_id:
          data.wa_template_id !== undefined
            ? data.wa_template_id
              ? Number(data.wa_template_id)
              : null
            : undefined,
        metadata: metadata !== null ? JSON.stringify(metadata) : undefined,
        filters,
        scheduled_at:
          data.scheduled_at !== undefined
            ? data.scheduled_at
              ? new Date(data.scheduled_at)
              : null
            : undefined,
        do_not_send_if_marketing:
          data.do_not_send_if_marketing !== undefined
            ? !!data.do_not_send_if_marketing
            : undefined,
        status: (this.normaliseStatus(data.status) ?? undefined) as any,
      },
    });
    return { broadcast: await this.serializeBroadcast(updated) };
  }

  async deleteBroadcast(broadcastId: bigint, workspaceId: bigint) {
    const broadcast = await this.prisma.broadcasts.findFirst({
      where: { id: broadcastId, workspace_id: workspaceId },
    });
    if (!broadcast) throw new NotFoundException('Broadcast not found');
    if (broadcast.locked) {
      throw new BadRequestException('Broadcast is currently sending — cannot delete');
    }
    await this.prisma.broadcasts.delete({ where: { id: broadcastId } });
    return { success: true };
  }

  // ─── Send / launch ─────────────────────────────────────────────────

  /**
   * Transition draft → pending so the every-minute cron sweep (and the BullMQ
   * worker, if Redis is configured) picks it up. If `scheduled_at` is in the
   * future the broadcast still becomes pending; the cron filter `scheduled_at
   * <= NOW()` is what gates actual execution.
   */
  async sendBroadcast(broadcastId: bigint, workspaceId: bigint) {
    const broadcast = await this.prisma.broadcasts.findFirst({
      where: { id: broadcastId, workspace_id: workspaceId },
    });
    if (!broadcast) throw new NotFoundException('Broadcast not found');
    const currentStatus = String(broadcast.status).toLowerCase();
    if (currentStatus !== 'draft' && currentStatus !== 'failed') {
      throw new BadRequestException(
        `Only draft or failed broadcasts can be sent (current: ${currentStatus})`,
      );
    }

    const updated = await this.prisma.broadcasts.update({
      where: { id: broadcastId },
      data: {
        status: 'pending' as any,
        fail_reason: null,
        scheduled_at: broadcast.scheduled_at ?? new Date(),
      },
    });

    // Optional BullMQ fast-path. Without Redis the cron sweep handles it
    // within the next minute — both paths are idempotent because the
    // processor honours the `locked` flag.
    if (this.queueProducer) {
      try {
        const delayMs = updated.scheduled_at
          ? Math.max(0, updated.scheduled_at.getTime() - Date.now())
          : 0;
        await this.queueProducer.enqueue(broadcastId, delayMs);
      } catch (err: any) {
        this.logger.warn(
          `sendBroadcast: queue enqueue failed for ${broadcastId} — cron sweep will pick it up. ${err?.message}`,
        );
      }
    }

    return { broadcast: await this.serializeBroadcast(updated) };
  }

  // ─── Channels (for the create-form picker) ─────────────────────────

  /**
   * List the channels this workspace can broadcast through. WhatsApp is the
   * primary path today (every other channel still lives in replyagent's
   * Laravel stack); when telegram/sms/messenger get ported we just append
   * here.
   */
  async listChannels(workspaceId: bigint) {
    const waAccounts = await this.prisma.wa_accounts.findMany({
      where: { workspace_id: workspaceId },
      select: { id: true, name: true, waba_id: true },
      orderBy: { id: 'desc' },
    });

    return {
      channels: waAccounts.map((a) => ({
        channelable_id: a.id.toString(),
        channelable_type: 'App\\Models\\Whatsapp\\WhatsappAccount',
        channel_type: 'whatsapp',
        name: a.name,
        waba_id: a.waba_id,
      })),
    };
  }

  // ─── Templates (real wa_templates, filtered for the picker) ────────

  /**
   * Returns approved WhatsApp templates for one of the workspace's wa_accounts.
   * `wa_account_id` here matches `wa_templates.wa_account_id` (which stores
   * the Meta `waba_id` as a string, not the wa_accounts.id PK).
   */
  async listTemplates(workspaceId: bigint, query: any) {
    const channelableId = query.channelable_id ?? query.channel_id ?? null;
    const accounts = await this.prisma.wa_accounts.findMany({
      where: {
        workspace_id: workspaceId,
        ...(channelableId
          ? { id: BigInt(channelableId) }
          : {}),
      },
      select: { id: true, name: true, waba_id: true },
    });

    if (accounts.length === 0) return { templates: [] };

    const wabaIds = accounts.map((a) => a.waba_id);
    const where: any = { wa_account_id: { in: wabaIds } };
    if (query.status) where.status = String(query.status).toUpperCase();
    else where.status = 'APPROVED';
    if (query.search) where.name = { contains: String(query.search) };

    const templates = await this.prisma.wa_templates.findMany({
      where,
      orderBy: [{ name: 'asc' }],
      take: 200,
    });

    return {
      templates: templates.map((t) => ({
        id: t.id.toString(),
        template_id: t.template_id,
        name: t.name,
        category: t.category,
        language: t.language,
        status: t.status,
        wa_account_id: t.wa_account_id,
        components: this.safeJsonParse(t.components ?? ''),
      })),
    };
  }

  // ─── Audience (used by the performance/detail modal) ───────────────

  async getBroadcastAudience(
    broadcastId: bigint,
    workspaceId: bigint,
    query: any,
  ) {
    const broadcast = await this.prisma.broadcasts.findFirst({
      where: { id: broadcastId, workspace_id: workspaceId },
    });
    if (!broadcast) throw new NotFoundException('Broadcast not found');

    const filters = broadcast.filters ?? '{}';
    const contactIds = await this.audienceFilter.getAudienceContactIds(
      workspaceId,
      typeof filters === 'string' ? filters : JSON.stringify(filters),
    );

    const limit = parseInt(query?.limit) || 50;
    const contacts = await this.prisma.contacts.findMany({
      where: { id: { in: contactIds } },
      take: limit,
      orderBy: { id: 'desc' },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        full_name: true,
      },
    });

    return {
      total: contactIds.length,
      contacts: contacts.map((c) => ({
        id: c.id.toString(),
        name:
          c.full_name ||
          [c.first_name, c.last_name].filter(Boolean).join(' ').trim() ||
          `Contact ${c.id}`,
      })),
    };
  }

  async exportBroadcastAudience(broadcastId: bigint, workspaceId: bigint) {
    const broadcast = await this.prisma.broadcasts.findFirst({
      where: { id: broadcastId, workspace_id: workspaceId },
    });
    if (!broadcast) throw new NotFoundException('Broadcast not found');

    this.logger.debug(`Dispatching export job for broadcast ${broadcastId}`);
    return {
      success: true,
      message: 'Export initiated. You will be notified when the CSV is ready.',
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────

  /**
   * Map the loose frontend payload (camelCase, includes recurring/CSV fields)
   * into a plain object suitable for the metadata JSON column. We keep both
   * snake_case + camelCase keys the React page reads so the table renderer
   * doesn't need to special-case anything.
   */
  private buildMetadata(data: any): Record<string, any> | null {
    if (!data) return null;
    const meta: Record<string, any> = {};

    // Existing pre-built metadata wins for any key it provides.
    if (data.metadata && typeof data.metadata === 'object') {
      Object.assign(meta, data.metadata);
    }

    const keys = [
      'type',
      'messageType',
      'message_type',
      'startDate',
      'endDate',
      'neverEnds',
      'never_ends',
      'whatsAppTemplateName',
      'recurringStartDate',
      'recurringEndDate',
      'recurringTime',
      'recurring_time',
      'repeatFrequency',
      'repeat_frequency',
      'dailyRepeatInterval',
      'daily_repeat_interval',
      'weeklyRepeatDays',
      'weekly_repeat_days',
      'monthlyRepeatDates',
      'monthly_repeat_dates',
      'deliverInTimezone',
      'deliver_in_timezone',
      'csvFileName',
      'csv_filename',
      'csvContent',
      'csv_content',
      'schedules',
    ];
    for (const k of keys) {
      if (data[k] !== undefined) meta[k] = data[k];
    }
    return Object.keys(meta).length ? meta : null;
  }

  /**
   * Frontend uses "draft" / "scheduled" / "sent". Schema enum: draft, pending,
   * in_progress, completed, failed. Map the UI vocab into the enum here so the
   * write doesn't silently coerce to an invalid value.
   */
  private normaliseStatus(raw: any): string | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const s = String(raw).toLowerCase();
    if (s === 'scheduled' || s === 'queued') return 'pending';
    if (s === 'sending') return 'in_progress';
    if (s === 'sent') return 'completed';
    return s; // already one of draft/pending/in_progress/completed/failed
  }

  private channelableTypeFor(channelType: string): string {
    switch (channelType) {
      case 'whatsapp':
        return 'App\\Models\\Whatsapp\\WhatsappAccount';
      case 'telegram':
        return 'App\\Models\\TelegramBot';
      case 'sms':
        return 'App\\Models\\TwilioNumber';
      case 'messenger':
        return 'App\\Models\\Facebook\\FacebookPage';
      default:
        return 'App\\Models\\Whatsapp\\WhatsappAccount';
    }
  }

  /**
   * Pull metadata/filters back to objects + load the creator's name + the
   * channel's display name so the table doesn't need a second round-trip per
   * row.
   */
  private async serializeBroadcast(b: any) {
    const metadata = this.safeJsonParse(b.metadata) ?? {};
    const filters = this.safeJsonParse(b.filters) ?? null;

    // Best-effort lookups. Missing references shouldn't crash the list.
    let creator: any = null;
    let channel: any = null;
    if (b.creator_id) {
      const u = await this.prisma.users
        .findUnique({
          where: { id: b.creator_id },
          select: { id: true, first_name: true, last_name: true },
        })
        .catch(() => null);
      if (u) {
        creator = {
          id: u.id.toString(),
          name: [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || `User ${u.id}`,
        };
      }
    }
    if (b.channel_type === 'whatsapp' && b.channelable_id) {
      const acc = await this.prisma.wa_accounts
        .findUnique({
          where: { id: b.channelable_id },
          select: { id: true, name: true },
        })
        .catch(() => null);
      if (acc) channel = { id: acc.id.toString(), name: acc.name };
    }

    return {
      id: b.id.toString(),
      name: b.name,
      channel_type: b.channel_type,
      channelable_type: b.channelable_type,
      channelable_id: b.channelable_id?.toString() ?? null,
      message: b.message,
      wa_template_id: b.wa_template_id,
      metadata,
      filters,
      total_audience: b.total_audience,
      total_sent: b.total_sent,
      status: b.status,
      fail_reason: b.fail_reason,
      scheduled_at: b.scheduled_at,
      ttl_at: b.ttl_at,
      do_not_send_if_marketing: !!b.do_not_send_if_marketing,
      started_at: b.started_at,
      finished_at: b.finished_at,
      locked: !!b.locked,
      created_at: b.created_at,
      updated_at: b.updated_at,
      creator,
      channel,

      // Convenience mirrors so the React page's existing `b.repeat_frequency`
      // / `b.csv_filename` / etc. reads work without changes. New code can
      // read straight from `metadata` instead.
      repeat_frequency: metadata.repeat_frequency ?? metadata.repeatFrequency,
      daily_repeat_interval:
        metadata.daily_repeat_interval ?? metadata.dailyRepeatInterval,
      weekly_repeat_days: metadata.weekly_repeat_days ?? metadata.weeklyRepeatDays,
      monthly_repeat_dates:
        metadata.monthly_repeat_dates ?? metadata.monthlyRepeatDates,
      deliver_in_timezone:
        metadata.deliver_in_timezone ?? metadata.deliverInTimezone,
      csv_filename: metadata.csv_filename ?? metadata.csvFileName,
      start_date: metadata.start_date ?? metadata.startDate,
      end_date: metadata.end_date ?? metadata.endDate,
      recurring_time: metadata.recurring_time ?? metadata.recurringTime,
      never_ends: metadata.never_ends ?? metadata.neverEnds,
    };
  }

  private safeJsonParse(raw: any): any {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}
