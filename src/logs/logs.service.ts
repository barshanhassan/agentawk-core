import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Aggregated logs surface — unifies conversation history (across all channels)
 * and call history (Twilio) under a single `/api/logs/*` route group that the
 * frontend ConversationLogsPage and CallLogsPage already query.
 *
 * Why a wrapper instead of pulling from each channel's own table directly:
 * the frontend pages need a single, normalized response shape with a
 * consistent set of fields (contact, channel, last_message, status, etc.).
 * Channels' own tables differ — this layer projects them to one shape.
 */
@Injectable()
export class LogsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Conversation logs — list inbox rows in the workspace with the latest
   * message and contact derived from the underlying channel chat table.
   * Filters: page, limit, search, status.
   */
  async conversations(
    workspaceId: bigint,
    q: { page?: number; limit?: number; search?: string; status?: string } = {},
  ) {
    const limit = Math.min(q.limit ?? 25, 200);
    const page = Math.max(q.page ?? 1, 1);
    const skip = (page - 1) * limit;

    const where: any = { workspace_id: workspaceId };
    if (q.status) where.status = q.status;

    const [rows, total] = await Promise.all([
      this.prisma.inbox.findMany({
        where,
        orderBy: { last_updated: 'desc' },
        take: limit,
        skip,
      }),
      this.prisma.inbox.count({ where }),
    ]);

    // Hydrate channel-specific name / number / preview from the chat row.
    const items = await Promise.all(
      rows.map(async (r) => {
        const preview = await this.channelPreview(r.modelable_type, r.modelable_id);
        return {
          id: r.id.toString(),
          workspace_id: r.workspace_id.toString(),
          status: r.status,
          channel: this.modelToChannel(r.modelable_type),
          contact: preview?.contact ?? null,
          last_message: preview?.lastMessage ?? null,
          last_updated: r.last_updated,
          created_at: r.created_at,
        };
      }),
    );

    // Apply search post-hydration (simple contains over contact name + last_message).
    const filtered = q.search
      ? items.filter((i) => {
          const hay = `${i.contact?.name ?? ''} ${i.last_message?.text ?? ''}`.toLowerCase();
          return hay.includes(q.search!.toLowerCase());
        })
      : items;

    return { logs: filtered, total, page, limit };
  }

  /**
   * Call logs — pulls from twilio_call_logs scoped to the workspace's twilio
   * accounts. Mirrors what the frontend CallLogsPage expects (page/limit
   * pagination + direction/status filters).
   */
  async calls(
    workspaceId: bigint,
    q: { page?: number; limit?: number; search?: string; direction?: string; status?: string } = {},
  ) {
    const accounts = await this.prisma.twilio_accounts.findMany({
      where: { workspace_id: workspaceId, deleted_at: null },
      select: { id: true },
    });
    const ids = accounts.map((a) => a.id);
    if (ids.length === 0) return { logs: [], total: 0, page: 1, limit: q.limit ?? 25 };

    const limit = Math.min(q.limit ?? 25, 200);
    const page = Math.max(q.page ?? 1, 1);
    const skip = (page - 1) * limit;

    const where: any = { twilio_account_id: { in: ids } };
    if (q.direction) where.call_type = q.direction;
    if (q.status) where.status = q.status;
    if (q.search) {
      where.OR = [
        { from_number: { contains: q.search } },
        { to_number: { contains: q.search } },
      ];
    }

    const [logs, total] = await Promise.all([
      this.prisma.twilio_call_logs.findMany({
        where,
        orderBy: { id: 'desc' },
        take: limit,
        skip,
      }),
      this.prisma.twilio_call_logs.count({ where }),
    ]);

    return { logs, total, page, limit };
  }

  /**
   * Lightweight stats for the ConversationLogs / CallLogs page headers.
   * Returns counts so the UI can show "X total, Y active, Z resolved".
   */
  async stats(workspaceId: bigint) {
    const [total, unassigned, active, completed] = await Promise.all([
      this.prisma.inbox.count({ where: { workspace_id: workspaceId } }),
      this.prisma.inbox.count({ where: { workspace_id: workspaceId, status: 'UNASSIGNED' as any } }),
      this.prisma.inbox.count({ where: { workspace_id: workspaceId, status: 'ACTIVE' as any } }),
      this.prisma.inbox.count({ where: { workspace_id: workspaceId, status: 'COMPLETED' as any } }),
    ]);

    const accountIds = (await this.prisma.twilio_accounts.findMany({
      where: { workspace_id: workspaceId, deleted_at: null },
      select: { id: true },
    })).map((a) => a.id);
    const totalCalls = accountIds.length
      ? await this.prisma.twilio_call_logs.count({ where: { twilio_account_id: { in: accountIds } } })
      : 0;

    return {
      conversations: { total, unassigned, active, completed },
      calls: { total: totalCalls },
    };
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private modelToChannel(modelableType: string): string {
    const lower = modelableType.toLowerCase();
    if (lower.includes('whatsapp')) return 'whatsapp';
    if (lower.includes('telegram')) return 'telegram';
    if (lower.includes('evolution')) return 'evolution';
    if (lower.includes('zapi')) return 'zapi';
    if (lower.includes('messenger') || lower.includes('facebook')) return 'messenger';
    if (lower.includes('instagram')) return 'instagram';
    if (lower.includes('webchat') || lower.includes('wcchat')) return 'webchat';
    if (lower.includes('twilio')) return 'sms';
    return 'unknown';
  }

  /**
   * Channel-specific preview lookup — returns the contact + most recent message
   * for the inbox's underlying chat. Best-effort: if the model isn't recognised
   * (or the row is gone), returns null.
   */
  private async channelPreview(modelableType: string, modelableId: bigint) {
    const lower = modelableType.toLowerCase();
    try {
      if (lower.includes('whatsapp')) {
        const chat = await this.prisma.wa_chats.findUnique({ where: { id: modelableId } });
        const msg = await this.prisma.wa_messages.findFirst({
          where: { wa_chat_id: modelableId },
          orderBy: { id: 'desc' },
        });
        const contact = chat?.contact_id ? await this.prisma.contacts.findUnique({ where: { id: chat.contact_id } }) : null;
        return {
          contact: contact ? { id: contact.id.toString(), name: contact.full_name ?? contact.first_name, profile_name: chat?.profile_name } : null,
          lastMessage: msg ? { text: msg.text, direction: msg.direction, at: (msg as any).created_at } : null,
        };
      }
      if (lower.includes('telegram')) {
        const chat = await this.prisma.telegram_chats.findUnique({ where: { id: modelableId } });
        const msg = await this.prisma.telegram_messages.findFirst({
          where: { telegram_chat_id: modelableId },
          orderBy: { id: 'desc' },
        });
        const contact = chat?.contact_id ? await this.prisma.contacts.findUnique({ where: { id: chat.contact_id } }) : null;
        return {
          contact: contact ? { id: contact.id.toString(), name: contact.full_name ?? contact.first_name } : null,
          lastMessage: msg ? { text: msg.text, direction: msg.direction, at: (msg as any).created_at } : null,
        };
      }
      // Other channels (evolution/zapi/messenger/instagram/webchat) — fall
      // through to a minimal preview. Extend as needed when those tables get
      // first-class hydrators.
      return null;
    } catch {
      return null;
    }
  }
}
