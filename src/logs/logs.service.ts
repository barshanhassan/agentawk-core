// @ts-nocheck
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Aggregated logs surface — unifies conversation history (across all channels)
 * and call history (Twilio) under a single `/api/logs/*` route group that the
 * frontend ConversationLogsPage and CallLogsPage already query.
 *
 * Why a wrapper instead of pulling from each channel's own table directly:
 * the frontend pages need a single, normalized response shape with a
 * consistent set of fields (contact, channel, last_message, status, agent,
 * duration, message_count etc.). Channels' own tables differ — this layer
 * projects them to one shape that the React components consume directly.
 */
@Injectable()
export class LogsService {
  private readonly logger = new Logger(LogsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Conversations list ─────────────────────────────────────────────

  /**
   * Conversation logs — list inbox rows in the workspace with the latest
   * message, contact, agent, channel, duration, message count and a
   * customer_number derived from the underlying channel chat / contact
   * tables.
   *
   * Filters honored:
   *   - page, limit       pagination
   *   - search            substring over contact name / mobile / agent name / last message
   *   - status            comma-separated (e.g. "ACTIVE,COMPLETED") or single
   *   - date_from/date_to ISO timestamps — clamps inbox.created_at
   */
  async conversations(
    workspaceId: bigint,
    q: {
      page?: number;
      limit?: number;
      search?: string;
      status?: string;
      date_from?: string;
      date_to?: string;
    } = {},
  ) {
    const limit = Math.min(q.limit ?? 25, 200);
    const page = Math.max(q.page ?? 1, 1);
    const skip = (page - 1) * limit;

    const where: any = { workspace_id: workspaceId };

    // Multi-status filter — frontend can send "ACTIVE,COMPLETED" to get the
    // union. Single value still works. Default excludes DELETED rows so they
    // only appear when the user explicitly filters for them.
    if (q.status) {
      const statuses = String(q.status)
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      if (statuses.length === 1) where.status = statuses[0];
      else if (statuses.length > 1) where.status = { in: statuses };
    } else {
      where.status = { not: 'DELETED' };
    }

    // Date range — clamps on inbox.created_at (the conversation's start).
    if (q.date_from || q.date_to) {
      where.created_at = {};
      if (q.date_from) where.created_at.gte = new Date(q.date_from);
      if (q.date_to) where.created_at.lte = new Date(q.date_to);
    }

    const [rows, total] = await Promise.all([
      this.prisma.inbox.findMany({
        where,
        orderBy: { last_updated: 'desc' },
        take: limit,
        skip,
      }),
      this.prisma.inbox.count({ where }),
    ]);

    // Hydrate per-row: contact / agent / message count / last message / duration.
    const items = await Promise.all(
      rows.map(async (r) => this.hydrate(workspaceId, r)),
    );

    // Apply search post-hydration — backend join surface is heterogenous,
    // so a single LIKE over the projected shape is the cleanest filter.
    const filtered = q.search
      ? items.filter((i) => {
          const hay = [
            i.customer ?? '',
            i.customer_number ?? '',
            i.agent ?? '',
            i.last_message?.text ?? '',
          ]
            .join(' ')
            .toLowerCase();
          return hay.includes(q.search!.toLowerCase());
        })
      : items;

    return { logs: filtered, total, page, limit };
  }

  /** Soft-delete a conversation log by marking it DELETED. */
  async deleteConversation(workspaceId: bigint, inboxId: bigint) {
    const row = await this.prisma.inbox.findFirst({
      where: { id: inboxId, workspace_id: workspaceId },
    });
    if (!row) {
      throw new NotFoundException({ success: false, message: 'Conversation not found' });
    }
    await this.prisma.inbox.update({
      where: { id: inboxId },
      data: { status: 'DELETED' },
    });
    return { success: true };
  }

  /**
   * Single conversation drill-down — used by the detail modal. Returns the
   * normalised row + the last `messages_limit` messages from the underlying
   * channel chat (default 50).
   */
  async conversationDetail(workspaceId: bigint, inboxId: bigint, messagesLimit = 50) {
    const row = await this.prisma.inbox.findFirst({
      where: { id: inboxId, workspace_id: workspaceId },
    });
    if (!row) {
      throw new NotFoundException({
        success: false,
        code: 'NOT_FOUND',
        message: 'Conversation not found',
      });
    }

    const normalised = await this.hydrate(workspaceId, row);
    const messages = await this.messagesFor(row.modelable_type, row.modelable_id, messagesLimit);

    return {
      conversation: normalised,
      messages,
    };
  }

  // ─── Calls list ─────────────────────────────────────────────────────

  /**
   * Call logs — pulls from twilio_call_logs scoped to the workspace's twilio
   * accounts and projects them into the flat shape the React CallLogsPage
   * reads directly: contact + contactNumber + agent + direction + startTime
   * + duration + status + recording. Mirrors the projection logic used for
   * conversation logs.
   */
  async calls(
    workspaceId: bigint,
    q: {
      page?: number;
      limit?: number;
      search?: string;
      direction?: string;
      status?: string;
      date_from?: string;
      date_to?: string;
    } = {},
  ) {
    const accounts = await this.prisma.twilio_accounts.findMany({
      where: { workspace_id: workspaceId, deleted_at: null },
      select: { id: true },
    });
    const ids = accounts.map((a) => a.id);
    if (ids.length === 0) {
      return { logs: [], total: 0, page: 1, limit: q.limit ?? 25 };
    }

    const limit = Math.min(q.limit ?? 25, 200);
    const page = Math.max(q.page ?? 1, 1);
    const skip = (page - 1) * limit;

    const where: any = { twilio_account_id: { in: ids } };

    // Multi-direction filter — comma-separated ("Inbound,Outbound") or single.
    if (q.direction) {
      const dirs = String(q.direction)
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean);
      // Match case-insensitively against call_type. We normalize both sides.
      if (dirs.length === 1) where.call_type = { equals: dirs[0], mode: 'insensitive' };
      else if (dirs.length > 1)
        where.OR = [
          ...(where.OR ?? []),
          ...dirs.map((d) => ({ call_type: { equals: d, mode: 'insensitive' } })),
        ];
    }

    // Multi-status filter — UI labels (Completed / Missed / Failed / Declined /
    // "In Progress") translate to Twilio's raw status values via uiToTwilioStatus().
    if (q.status) {
      const statuses = String(q.status)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .flatMap((ui) => this.uiToTwilioStatuses(ui));
      if (statuses.length === 1) where.status = statuses[0];
      else if (statuses.length > 1) {
        where.OR = [...(where.OR ?? []), ...statuses.map((s) => ({ status: s }))];
      }
    }

    if (q.date_from || q.date_to) {
      where.created_at = {};
      if (q.date_from) where.created_at.gte = new Date(q.date_from);
      if (q.date_to) where.created_at.lte = new Date(q.date_to);
    }

    if (q.search) {
      where.OR = [
        ...(where.OR ?? []),
        { from_number: { contains: q.search } },
        { to_number: { contains: q.search } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.twilio_call_logs.findMany({
        where,
        orderBy: { id: 'desc' },
        take: limit,
        skip,
      }),
      this.prisma.twilio_call_logs.count({ where }),
    ]);

    const logs = await Promise.all(rows.map((r) => this.projectCall(r)));

    return { logs, total, page, limit };
  }

  /**
   * Single-call detail — returns the projected row plus the parsed metadata
   * JSON so the modal can render the full Twilio response (recording URL,
   * voicemail URL, transcript, etc.).
   */
  async callDetail(workspaceId: bigint, callId: bigint) {
    const accounts = await this.prisma.twilio_accounts.findMany({
      where: { workspace_id: workspaceId, deleted_at: null },
      select: { id: true },
    });
    const ids = accounts.map((a) => a.id);
    if (ids.length === 0) {
      throw new NotFoundException({
        success: false,
        code: 'NOT_FOUND',
        message: 'Call log not found',
      });
    }
    const row = await this.prisma.twilio_call_logs.findFirst({
      where: { id: callId, twilio_account_id: { in: ids } },
    });
    if (!row) {
      throw new NotFoundException({
        success: false,
        code: 'NOT_FOUND',
        message: 'Call log not found',
      });
    }
    const call = await this.projectCall(row);
    return {
      call,
      metadata: this.safeJson(row.metadata),
      twilio_metadata: this.safeJson(row.twilio_metadata),
    };
  }

  // ─── Stats ───────────────────────────────────────────────────────────

  /**
   * Header KPI strip — total / queued (unassigned) / active / completed +
   * resolution_rate. Matches what the ConversationLogsPage displays so the
   * UI can pull straight from `conversations: {...}`.
   */
  async stats(workspaceId: bigint, q: { date_from?: string; date_to?: string } = {}) {
    const dateClause: any = {};
    if (q.date_from || q.date_to) {
      dateClause.created_at = {};
      if (q.date_from) dateClause.created_at.gte = new Date(q.date_from);
      if (q.date_to) dateClause.created_at.lte = new Date(q.date_to);
    }

    const [total, unassigned, active, completed] = await Promise.all([
      this.prisma.inbox.count({ where: { workspace_id: workspaceId, status: { not: 'DELETED' as any }, ...dateClause } }),
      this.prisma.inbox.count({
        where: { workspace_id: workspaceId, status: 'UNASSIGNED' as any, ...dateClause },
      }),
      this.prisma.inbox.count({
        where: { workspace_id: workspaceId, status: 'ACTIVE' as any, ...dateClause },
      }),
      this.prisma.inbox.count({
        where: { workspace_id: workspaceId, status: 'COMPLETED' as any, ...dateClause },
      }),
    ]);

    // Resolution rate = completed / (active + completed + unassigned) — i.e.
    // share of conversations that reached a resolved state. Returned as
    // ready-to-display string so the UI doesn't have to format.
    const resolvedCohort = active + completed + unassigned;
    const ratePct = resolvedCohort > 0 ? Math.round((completed / resolvedCohort) * 100) : 0;

    const accountIds = (
      await this.prisma.twilio_accounts.findMany({
        where: { workspace_id: workspaceId, deleted_at: null },
        select: { id: true },
      })
    ).map((a) => a.id);

    let callKpis: any = {
      total: 0,
      completed: 0,
      inbound: 0,
      outbound: 0,
      missed: 0,
      avg_duration_seconds: 0,
      avgDuration: '0m 0s',
    };
    if (accountIds.length) {
      const baseWhere: any = { twilio_account_id: { in: accountIds }, ...dateClause };
      // Stats fan out so the UI strip can show all 4 chips in one render.
      const [totalCalls, completedCalls, inboundCalls, outboundCalls, missedCalls, durationsAgg] =
        await Promise.all([
          this.prisma.twilio_call_logs.count({ where: baseWhere }),
          this.prisma.twilio_call_logs.count({
            where: { ...baseWhere, status: { in: ['success', 'completed'] } },
          }),
          this.prisma.twilio_call_logs.count({
            where: {
              ...baseWhere,
              OR: [
                { call_type: { equals: 'inbound', mode: 'insensitive' } },
                { call_type: { equals: 'Inbound', mode: 'insensitive' } },
              ],
            },
          }),
          this.prisma.twilio_call_logs.count({
            where: {
              ...baseWhere,
              OR: [
                { call_type: { equals: 'outbound', mode: 'insensitive' } },
                { call_type: { equals: 'Outbound', mode: 'insensitive' } },
              ],
            },
          }),
          this.prisma.twilio_call_logs.count({
            where: {
              ...baseWhere,
              status: { in: ['no-answer', 'busy', 'failed', 'canceled', 'missed'] },
            },
          }),
          this.prisma.twilio_call_logs.findMany({
            where: baseWhere,
            select: { call_duration: true },
          }),
        ]);

      // call_duration is stored as a string (seconds). Parse + average.
      let totalSec = 0;
      let count = 0;
      for (const row of durationsAgg) {
        const n = Number(row.call_duration ?? 0);
        if (!Number.isNaN(n) && n > 0) {
          totalSec += n;
          count++;
        }
      }
      const avgSec = count > 0 ? Math.round(totalSec / count) : 0;

      callKpis = {
        total: totalCalls,
        completed: completedCalls,
        inbound: inboundCalls,
        outbound: outboundCalls,
        missed: missedCalls,
        avg_duration_seconds: avgSec,
        avgDuration: this.formatCallDuration(avgSec),
      };
    }

    return {
      conversations: {
        total,
        // Frontend reads "queued" — alias unassigned so the existing UI label
        // matches without a code change.
        queued: unassigned,
        unassigned,
        active,
        completed,
        resolution_rate: ratePct,
        resolutionRate: `${ratePct}%`,
      },
      calls: callKpis,
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  /**
   * Build the projected row from an inbox record — joins agent + contact +
   * channel preview + message count + duration. Returns the exact shape
   * the React component renders.
   */
  private async hydrate(workspaceId: bigint, r: any) {
    const channel = this.modelToChannel(r.modelable_type);
    const preview = await this.channelPreview(r.modelable_type, r.modelable_id);

    // Agent join — `inbox.user_id` is the assignee. Null if unassigned.
    let agent: any = null;
    if (r.user_id) {
      const u = await this.prisma.users.findUnique({ where: { id: r.user_id } });
      if (u) {
        const name = u.full_name ?? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() ?? u.email;
        agent = { id: u.id.toString(), name: name || 'Unknown', email: u.email };
      }
    }

    // Customer mobile — best-effort lookup so we always have a phone string
    // on the row. Falls back to chat.profile_name's number if available.
    let customer_number: string | null = preview?.contact_number ?? null;
    if (!customer_number && preview?.contact?.id) {
      try {
        const mob = await this.prisma.contact_mobiles.findFirst({
          where: {
            modelable_id: BigInt(preview.contact.id),
            modelable_type: 'App\\Models\\Contact',
            is_primary: 1,
          },
        });
        if (mob) customer_number = mob.full_mobile_number ?? mob.mobile_number ?? null;
      } catch {
        // ignore — best-effort
      }
    }

    // Duration: closed_at − created_at (resolved), else last_updated − created_at.
    const startedAt = r.created_at ? new Date(r.created_at) : null;
    const endedAt = r.closed_at
      ? new Date(r.closed_at)
      : r.last_updated
        ? new Date(r.last_updated)
        : null;
    const durationMs = startedAt && endedAt ? Math.max(0, endedAt.getTime() - startedAt.getTime()) : 0;
    const duration = this.formatDuration(durationMs);

    // Message count for this conversation's underlying chat.
    const message_count = await this.countMessages(r.modelable_type, r.modelable_id);

    // Status — keep DB enum (UPPERCASE) AND offer a Title-Case alias so the
    // frontend can render either without mapping.
    const statusRaw = r.status ?? 'ACTIVE';
    const statusLabel = this.statusToLabel(statusRaw);

    return {
      id: r.id.toString(),
      workspace_id: r.workspace_id.toString(),
      // Backwards-compatible (existing UI fields):
      status: statusLabel, // "Active" / "Completed" / "Queued" / "Unassigned"
      status_raw: statusRaw, // "ACTIVE" / "COMPLETED" / "UNASSIGNED"
      channel,
      contact: preview?.contact ?? null,
      last_message: preview?.lastMessage ?? null,
      last_updated: r.last_updated,
      created_at: r.created_at,
      closed_at: r.closed_at ?? null,

      // ─── Flat shape the React table reads directly ──────────
      customer: preview?.contact?.name ?? preview?.contact?.profile_name ?? 'Unknown',
      customerNumber: customer_number ?? '',
      agent: agent?.name ?? 'Unassigned',
      agentId: agent?.id ?? '',
      startTime: r.created_at ? new Date(r.created_at).toISOString() : '',
      duration,
      duration_ms: durationMs,
      messages: message_count,
      timeline: '',
      sentiment: '',
      sentimentSummary: '',
    };
  }

  private modelToChannel(modelableType: string): string {
    const lower = (modelableType ?? '').toLowerCase();
    if (lower.includes('whatsapp') || lower.includes('wa_')) return 'whatsapp';
    if (lower.includes('telegram')) return 'telegram';
    if (lower.includes('evolution')) return 'evolution';
    if (lower.includes('zapi')) return 'zapi';
    if (lower.includes('messenger') || lower.includes('fbpage') || lower.includes('facebook'))
      return 'messenger';
    if (lower.includes('instagram') || lower.includes('insta')) return 'instagram';
    if (lower.includes('webchat') || lower.includes('wcchat')) return 'webchat';
    if (lower.includes('twilio')) return 'sms';
    return 'unknown';
  }

  /** Latest message + contact for the chat the inbox row points at. */
  private async channelPreview(modelableType: string, modelableId: bigint) {
    const lower = (modelableType ?? '').toLowerCase();
    try {
      if (lower.includes('whatsapp') || lower.includes('wa_')) {
        const chat = await this.prisma.wa_chats.findUnique({ where: { id: modelableId } });
        const msg = await this.prisma.wa_messages.findFirst({
          where: { wa_chat_id: modelableId },
          orderBy: { id: 'desc' },
        });
        const contact = chat?.contact_id
          ? await this.prisma.contacts.findUnique({ where: { id: chat.contact_id } })
          : null;
        return {
          contact: contact
            ? {
                id: contact.id.toString(),
                name: contact.full_name ?? contact.first_name,
                profile_name: chat?.profile_name,
              }
            : null,
          contact_number: chat?.mobile_number ?? null,
          lastMessage: msg ? { text: msg.text, direction: msg.direction, at: (msg as any).created_at } : null,
        };
      }
      if (lower.includes('telegram')) {
        const chat = await this.prisma.telegram_chats.findUnique({ where: { id: modelableId } });
        const msg = await this.prisma.telegram_messages.findFirst({
          where: { telegram_chat_id: modelableId },
          orderBy: { id: 'desc' },
        });
        const contact = chat?.contact_id
          ? await this.prisma.contacts.findUnique({ where: { id: chat.contact_id } })
          : null;
        return {
          contact: contact
            ? { id: contact.id.toString(), name: contact.full_name ?? contact.first_name }
            : null,
          contact_number: null,
          lastMessage: msg ? { text: msg.text, direction: msg.direction, at: (msg as any).created_at } : null,
        };
      }
      if (lower.includes('zapi')) {
        const chat = await this.prisma.zapi_chats.findUnique({ where: { id: modelableId } });
        const msg = await this.prisma.zapi_messages.findFirst({
          where: { zapi_chat_id: modelableId },
          orderBy: { id: 'desc' },
        });
        const contact = chat?.contact_id
          ? await this.prisma.contacts.findUnique({ where: { id: chat.contact_id } })
          : null;
        return {
          contact: contact
            ? { id: contact.id.toString(), name: contact.full_name ?? contact.first_name }
            : null,
          contact_number: chat?.mobile_number ?? null,
          lastMessage: msg ? { text: msg.text, direction: msg.direction, at: (msg as any).created_at } : null,
        };
      }
      if (lower.includes('instagram') || lower.includes('insta')) {
        const chat = await this.prisma.insta_chats.findUnique({ where: { id: modelableId } });
        const msg = await this.prisma.insta_messages.findFirst({
          where: { insta_chat_id: modelableId },
          orderBy: { id: 'desc' },
        });
        const contact = chat?.contact_id
          ? await this.prisma.contacts.findUnique({ where: { id: chat.contact_id } })
          : null;
        const contactName =
          contact?.full_name ??
          (contact ? `${contact.first_name ?? ''} ${contact.last_name ?? ''}`.trim() : null) ??
          (chat as any)?.name ??
          null;
        return {
          contact: contactName
            ? { id: contact?.id?.toString() ?? '', name: contactName }
            : chat
              ? { id: '', name: (chat as any).name ?? (chat as any).sender_id ?? 'Unknown' }
              : null,
          contact_number: null,
          lastMessage: msg
            ? { text: (msg as any).text ?? '', direction: (msg as any).direction, at: (msg as any).created_at }
            : null,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Best-effort message count — per-channel because each one has its own
   *  table. Returns 0 if the channel doesn't have a hydrator yet. */
  private async countMessages(modelableType: string, modelableId: bigint): Promise<number> {
    const lower = (modelableType ?? '').toLowerCase();
    try {
      if (lower.includes('whatsapp') || lower.includes('wa_')) {
        return this.prisma.wa_messages.count({ where: { wa_chat_id: modelableId } });
      }
      if (lower.includes('telegram')) {
        return this.prisma.telegram_messages.count({ where: { telegram_chat_id: modelableId } });
      }
      if (lower.includes('zapi')) {
        return this.prisma.zapi_messages.count({ where: { zapi_chat_id: modelableId } });
      }
      if (lower.includes('instagram') || lower.includes('insta')) {
        return this.prisma.insta_messages.count({ where: { insta_chat_id: modelableId } });
      }
      return 0;
    } catch {
      return 0;
    }
  }

  /** Last N messages (newest first) for the conversation detail modal. */
  private async messagesFor(modelableType: string, modelableId: bigint, limit = 50) {
    const lower = (modelableType ?? '').toLowerCase();
    try {
      if (lower.includes('whatsapp') || lower.includes('wa_')) {
        const rows = await this.prisma.wa_messages.findMany({
          where: { wa_chat_id: modelableId },
          orderBy: { id: 'desc' },
          take: limit,
        });
        return rows.map(this.projectMessage);
      }
      if (lower.includes('telegram')) {
        const rows = await this.prisma.telegram_messages.findMany({
          where: { telegram_chat_id: modelableId },
          orderBy: { id: 'desc' },
          take: limit,
        });
        return rows.map(this.projectMessage);
      }
      if (lower.includes('zapi')) {
        const rows = await this.prisma.zapi_messages.findMany({
          where: { zapi_chat_id: modelableId },
          orderBy: { id: 'desc' },
          take: limit,
        });
        return rows.map(this.projectMessage);
      }
      if (lower.includes('instagram') || lower.includes('insta')) {
        const rows = await this.prisma.insta_messages.findMany({
          where: { insta_chat_id: modelableId },
          orderBy: { id: 'desc' },
          take: limit,
        });
        return rows.map(this.projectMessage);
      }
      return [];
    } catch (e: any) {
      this.logger.warn(`messagesFor failed (${modelableType}): ${e?.message ?? e}`);
      return [];
    }
  }

  private projectMessage = (m: any) => ({
    id: m.id?.toString() ?? '',
    direction: m.direction ?? 'INCOMING',
    text: m.text ?? '',
    type: m.type ?? 'text',
    status: m.status ?? null,
    created_at: m.created_at ?? null,
  });

  /** Convert ms duration → "Xh Ym" or "Ym Zs" or "Zs". */
  private formatDuration(ms: number): string {
    if (ms <= 0) return '0s';
    const sec = Math.floor(ms / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  /** "ACTIVE" → "Active", "UNASSIGNED" → "Queued" (frontend's preferred label). */
  private statusToLabel(status: string): string {
    const s = String(status ?? '').toUpperCase();
    if (s === 'UNASSIGNED') return 'Queued';
    if (!s) return 'Active';
    return s.charAt(0) + s.slice(1).toLowerCase();
  }

  // ─── Call projection helpers ────────────────────────────────────────

  /**
   * Project a raw twilio_call_logs row into the shape the React CallLogsPage
   * reads directly (contact + agent + formatted duration + direction + status
   * + recording URL). Best-effort contact + recording extraction.
   */
  private async projectCall(r: any) {
    const direction = this.normaliseDirection(r.call_type);
    // The "other party" number depends on direction.
    const otherNumber = direction === 'Inbound' ? r.from_number : r.to_number;

    // Contact lookup — match the other number against contact_mobiles.
    let contactName = otherNumber ?? '';
    let contactId: string | null = null;
    if (otherNumber) {
      try {
        const stripped = String(otherNumber).replace(/[^0-9]/g, '');
        const mob = await this.prisma.contact_mobiles.findFirst({
          where: {
            OR: [
              { mobile_number: { contains: stripped } },
              { full_mobile_number: { contains: stripped } },
            ],
            modelable_type: 'App\\Models\\Contact',
          },
        });
        if (mob) {
          const c = await this.prisma.contacts.findUnique({ where: { id: mob.modelable_id } });
          if (c) {
            contactName = c.full_name ?? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() ?? otherNumber;
            contactId = c.id.toString();
          }
        }
      } catch {
        // best-effort
      }
    }

    // Recording URL — Twilio webhook payloads (saved as metadata JSON) carry
    // RecordingUrl on completed calls. Look in both metadata + twilio_metadata.
    const meta = this.safeJson(r.metadata);
    const tmeta = this.safeJson(r.twilio_metadata);
    const recordingUrl =
      meta?.recording_url ??
      meta?.RecordingUrl ??
      tmeta?.recording_url ??
      tmeta?.RecordingUrl ??
      null;

    const durationSec = Number(r.call_duration ?? 0);
    const safeDur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;

    const uiStatus = this.twilioStatusToUi(r.status);

    return {
      id: r.id.toString(),
      // Flat shape consumed by the React table:
      contact: contactName,
      contactNumber: otherNumber ?? '',
      contactId,
      agent: '', // No agent column on twilio_call_logs; surfaced empty.
      agentId: '',
      direction,
      startTime: r.created_at ? new Date(r.created_at).toISOString() : '',
      duration: this.formatCallDuration(safeDur),
      duration_seconds: safeDur,
      status: uiStatus,
      status_raw: r.status ?? null,
      sentiment: '',
      sentimentSummary: '',
      recording: !!recordingUrl,
      recordingUrl,
      from_number: r.from_number,
      to_number: r.to_number,
      call_sid: r.call_sid,
      created_at: r.created_at,
    };
  }

  /** "inbound" / "Inbound" / "INBOUND" → "Inbound" (Title Case). */
  private normaliseDirection(raw: string | null | undefined): 'Inbound' | 'Outbound' {
    const v = String(raw ?? '').toLowerCase();
    if (v === 'inbound' || v === 'in' || v === 'incoming') return 'Inbound';
    return 'Outbound';
  }

  /**
   * Twilio raw status → UI label:
   *   success / completed → Completed
   *   no-answer / busy / canceled → Missed
   *   failed → Failed
   *   in-progress / ringing / queued → In Progress
   *   declined → Declined
   */
  private twilioStatusToUi(raw: string | null | undefined): string {
    const v = String(raw ?? '').toLowerCase();
    if (v === 'success' || v === 'completed') return 'Completed';
    if (v === 'no-answer' || v === 'busy' || v === 'canceled' || v === 'missed') return 'Missed';
    if (v === 'failed') return 'Failed';
    if (v === 'declined' || v === 'rejected') return 'Declined';
    if (v === 'in-progress' || v === 'ringing' || v === 'queued') return 'In Progress';
    if (!v) return 'Completed';
    return v.charAt(0).toUpperCase() + v.slice(1);
  }

  /**
   * UI status label → Twilio raw statuses to query. Multiple raw statuses
   * can map to a single UI label (e.g. "Missed" = no-answer + busy + canceled),
   * hence the array return.
   */
  private uiToTwilioStatuses(ui: string): string[] {
    const v = String(ui ?? '').toLowerCase();
    if (v === 'completed') return ['success', 'completed'];
    if (v === 'missed') return ['no-answer', 'busy', 'canceled', 'missed'];
    if (v === 'failed') return ['failed'];
    if (v === 'declined') return ['declined', 'rejected'];
    if (v === 'in progress' || v === 'in-progress') return ['in-progress', 'ringing', 'queued'];
    return [v];
  }

  /** Seconds → "Xm Ys" (or "Yh Zm" if >= 1h, "Zs" if < 1m). */
  private formatCallDuration(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    if (s === 0) return '0m 0s';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m ${sec}s`;
  }

  /** Defensive JSON parse — returns null on garbage input. */
  private safeJson(raw: any): any {
    if (raw == null) return null;
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}
