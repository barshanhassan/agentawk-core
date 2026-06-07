// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotesService {
  private readonly logger = new Logger(NotesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Workspace isolation helper — the `notes` table has no `workspace_id`
   * column. Instead, ownership is scoped through the parent contact (which
   * does carry workspace_id). We validate the contact belongs to the caller's
   * workspace before touching any note row.
   */
  private async assertContactInWorkspace(
    contactId: bigint,
    workspaceId: bigint,
  ) {
    const contact = await this.prisma.contacts.findFirst({
      where: { id: contactId, workspace_id: workspaceId },
      select: { id: true },
    });
    if (!contact) throw new NotFoundException('Contact not found');
  }

  /**
   * Author helper — schema has first_name/last_name/full_name (NO `name`).
   * We compose a display name client-side so the UI gets one consistent field.
   */
  private async attachAuthors(rows: any[]) {
    const userIds = Array.from(
      new Set(
        rows
          .map((n) => n.user_id)
          .filter((x): x is bigint => !!x)
          .map((b) => b.toString()),
      ),
    ).map((s) => BigInt(s));
    if (!userIds.length) return rows;
    const users = await this.prisma.users.findMany({
      where: { id: { in: userIds } },
      select: { id: true, first_name: true, last_name: true, full_name: true, email: true },
    });
    const byId = new Map(users.map((u) => [u.id.toString(), u]));
    return rows.map((n) => {
      const u = n.user_id ? byId.get(n.user_id.toString()) : null;
      const name =
        u?.full_name ||
        [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim() ||
        u?.email ||
        null;
      return { ...n, author: u ? { name, email: u.email } : null };
    });
  }

  /**
   * Create a standard CRM text note attached to a contact. Schema reality:
   * `notes` has no workspace_id (scoped via contact_id), the text column is
   * `text` (not `note`), and there are no channel/chat_id/message_id columns —
   * any per-channel chat reference is stuffed into the polymorphic
   * `modelable_type`/`modelable_id` pair plus the JSON `data` blob.
   */
  async createNote(data: any, workspaceId: bigint, userId: bigint) {
    if (!data.contact_id) throw new BadRequestException('contact_id required');
    const contactId = BigInt(data.contact_id);
    await this.assertContactInWorkspace(contactId, workspaceId);

    // Channel-tagged notes (from the NoteAddDropdown) get persisted with the
    // channel name in `data` so the UI can render the right icon later. Plain
    // text notes default to type='NOTE'.
    const channel = data.channel ?? null;
    const note = await this.prisma.notes.create({
      data: {
        user_id: userId,
        contact_id: contactId,
        type: channel ? 'CHANNEL_NOTE' : data.type || 'NOTE',
        text: data.text ?? data.note ?? '',
        icon: data.icon ?? 'note',
        data: channel ? JSON.stringify({ channel }) : null,
        // Polymorphic: when no chat target is given, point the note at the
        // contact itself so the index covers it.
        modelable_type: 'App\\Models\\Contact',
        modelable_id: contactId,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });

    return { success: true, note, message: 'Note created successfully' };
  }

  /**
   * Add a chat-context note. The chat is identified by modelable_type +
   * modelable_id (mirrors how replyagent links notes to a specific
   * conversation/message via Laravel's polymorphic morph). Any extra context
   * (channel name, message_id) is JSON-encoded into `data`.
   */
  async addChatNote(data: any, workspaceId: bigint, userId: bigint) {
    if (!data.contact_id || !data.modelable_type || !data.modelable_id) {
      throw new BadRequestException(
        'contact_id, modelable_type, modelable_id are required',
      );
    }
    const contactId = BigInt(data.contact_id);
    await this.assertContactInWorkspace(contactId, workspaceId);

    const note = await this.prisma.notes.create({
      data: {
        user_id: userId,
        contact_id: contactId,
        type: 'CHAT_NOTE',
        text: data.text ?? data.note ?? '',
        icon: data.icon ?? 'message',
        data: JSON.stringify({
          channel: data.channel ?? null,
          message_id: data.message_id ?? null,
        }),
        modelable_type: String(data.modelable_type),
        modelable_id: BigInt(data.modelable_id),
        created_at: new Date(),
        updated_at: new Date(),
      },
    });

    return { success: true, note, message: 'Chat context note attached' };
  }

  /**
   * Delete a note securely. Scoped via the note's contact_id → workspace.
   */
  async deleteNote(noteId: bigint, workspaceId: bigint, userId: bigint) {
    const note = await this.prisma.notes.findFirst({
      where: { id: noteId },
    });
    if (!note) throw new NotFoundException('Note not found');

    if (note.contact_id) {
      await this.assertContactInWorkspace(note.contact_id, workspaceId);
    }

    await this.prisma.notes.delete({ where: { id: noteId } });
    return { success: true, message: 'Note deleted securely' };
  }

  /**
   * Paginated retrieval of notes for a specific contact.
   */
  async getNotes(contactId: bigint, workspaceId: bigint, filters: any) {
    await this.assertContactInWorkspace(contactId, workspaceId);

    const page = parseInt(filters.page || '1');
    const limit = parseInt(filters.limit || '20');

    const where: any = { contact_id: contactId };
    if (filters.type) where.type = filters.type;

    const [notes, total] = await Promise.all([
      this.prisma.notes.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notes.count({ where }),
    ]);

    const enriched = await this.attachAuthors(notes);

    return {
      notes: enriched,
      total,
      page,
      limit,
      last_page: Math.ceil(total / limit),
    };
  }

  /**
   * Full CRM notes export/backup for compliance.
   */
  async getNotesBackup(contactId: bigint, workspaceId: bigint) {
    await this.assertContactInWorkspace(contactId, workspaceId);
    const notes = await this.prisma.notes.findMany({
      where: { contact_id: contactId },
      orderBy: { created_at: 'desc' },
    });
    const enriched = await this.attachAuthors(notes);
    return { success: true, count: enriched.length, data: enriched };
  }

  /**
   * Activity timeline — replyagent parity for `/note/timeline/{slug}`. Returns
   * a date-sorted feed combining CRM notes with the contact's actual inbox
   * messages across all channels. Used by ContactProfileModal's middle column.
   *
   * filters: { date_from, date_to, search, channels[], page, limit }
   */
  async getTimeline(
    contactId: bigint,
    workspaceId: bigint,
    filters: any = {},
  ) {
    const page = parseInt(filters.page || '1');
    const limit = parseInt(filters.limit || '30');
    const offset = (page - 1) * limit;

    const dateFrom = filters.date_from ? new Date(filters.date_from) : null;
    const dateTo = filters.date_to ? new Date(filters.date_to) : null;
    const search = filters.search ? String(filters.search).toLowerCase() : '';

    // 1. CRM notes — scoped by contact_id (the notes table has no
    //    workspace_id column). We already validated contact ownership via
    //    assertContactInWorkspace, so this is safe.
    await this.assertContactInWorkspace(contactId, workspaceId);

    const noteWhere: any = { contact_id: contactId };
    if (dateFrom || dateTo) {
      noteWhere.created_at = {};
      if (dateFrom) noteWhere.created_at.gte = dateFrom;
      if (dateTo) noteWhere.created_at.lte = dateTo;
    }
    if (search) {
      noteWhere.text = { contains: search };
    }
    const rawNotes = await this.prisma.notes
      .findMany({
        where: noteWhere,
        orderBy: { created_at: 'desc' },
        take: 100,
      })
      .catch(() => [] as any[]);
    const notes = await this.attachAuthors(rawNotes);

    // 2. Per-channel messages — the schema has no unified `inbox_messages`
    //    table. Each channel has its own `{x}_chats` (with contact_id) and
    //    `{x}_messages` (keyed by `{x}_chat_id`). We gather chats per
    //    channel, then pull recent messages per channel.
    const idSelect = { select: { id: true } } as any;
    const [waC, tgC, fbC, igC, evoC, zapiC, twC] = await Promise.all([
      this.prisma.wa_chats.findMany({ where: { contact_id: contactId }, ...idSelect }).catch(() => [] as any[]),
      this.prisma.telegram_chats.findMany({ where: { contact_id: contactId }, ...idSelect }).catch(() => [] as any[]),
      this.prisma.fb_chats.findMany({ where: { contact_id: contactId }, ...idSelect }).catch(() => [] as any[]),
      this.prisma.insta_chats.findMany({ where: { contact_id: contactId }, ...idSelect }).catch(() => [] as any[]),
      this.prisma.evolution_chats.findMany({ where: { contact_id: contactId }, ...idSelect }).catch(() => [] as any[]),
      this.prisma.zapi_chats.findMany({ where: { contact_id: contactId }, ...idSelect }).catch(() => [] as any[]),
      this.prisma.twilio_chats.findMany({ where: { contact_id: contactId }, ...idSelect }).catch(() => [] as any[]),
    ]);

    const buildMsgWhere = (key: string, ids: bigint[]) => {
      if (!ids.length) return null;
      const w: any = { [key]: { in: ids } };
      if (dateFrom || dateTo) {
        w.created_at = {};
        if (dateFrom) w.created_at.gte = dateFrom;
        if (dateTo) w.created_at.lte = dateTo;
      }
      if (search) w.text = { contains: search };
      return w;
    };

    const fetchMsgs = async (
      table: any,
      key: string,
      ids: bigint[],
      channelLabel: string,
    ) => {
      const where = buildMsgWhere(key, ids);
      if (!where) return [] as any[];
      try {
        const rows = await table.findMany({
          where,
          orderBy: { created_at: 'desc' },
          take: 100,
        });
        return rows.map((m: any) => ({ ...m, _channel: channelLabel }));
      } catch {
        return [] as any[];
      }
    };

    const messages: any[] = (
      await Promise.all([
        fetchMsgs(this.prisma.wa_messages, 'wa_chat_id', waC.map((c: any) => c.id), 'whatsapp'),
        fetchMsgs(this.prisma.telegram_messages, 'telegram_chat_id', tgC.map((c: any) => c.id), 'telegram'),
        fetchMsgs(this.prisma.fb_messages, 'fb_chat_id', fbC.map((c: any) => c.id), 'messenger'),
        fetchMsgs(this.prisma.insta_messages, 'insta_chat_id', igC.map((c: any) => c.id), 'instagram'),
        fetchMsgs(this.prisma.evolution_messages, 'evolution_chat_id', evoC.map((c: any) => c.id), 'evolution'),
        fetchMsgs(this.prisma.zapi_messages, 'zapi_chat_id', zapiC.map((c: any) => c.id), 'zapi'),
        fetchMsgs(this.prisma.twilio_messages, 'twilio_chat_id', twC.map((c: any) => c.id), 'sms'),
      ])
    ).flat();

    // 3. Merge + sort + paginate. The shape mirrors replyagent's timeline
    // entries closely enough that the frontend's ContactHistory can render
    // both note and message types from a single feed.
    const items: any[] = [];
    for (const n of notes) {
      // `data` is a JSON blob carrying channel/message_id when present.
      let parsedData: any = null;
      if (n.data) {
        try {
          parsedData = JSON.parse(n.data);
        } catch {
          parsedData = null;
        }
      }
      items.push({
        kind: 'note',
        id: n.id.toString(),
        created_at: n.created_at,
        text: n.text,
        type: n.type ?? 'NOTE',
        channel: parsedData?.channel ?? null,
        author: n.author
          ? {
              name: n.author.name,
              email: n.author.email,
            }
          : null,
      });
    }
    for (const m of messages) {
      const channel = m._channel ?? 'unknown';
      const dir = String(m.direction ?? '').toUpperCase();
      const direction =
        dir === 'OUTGOING' || dir === 'OUTBOUND' ? 'outgoing' : 'incoming';

      items.push({
        kind: 'message',
        id: m.id.toString(),
        created_at: m.created_at,
        text: m.text ?? null,
        type: m.type ?? 'text',
        channel,
        direction,
        media: m.media ?? null,
        author_id: m.sender_id?.toString() ?? null,
      });
    }

    // Sort desc by created_at
    items.sort((a, b) => {
      const ad = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bd = b.created_at ? new Date(b.created_at).getTime() : 0;
      return bd - ad;
    });

    const total = items.length;
    const paginated = items.slice(offset, offset + limit);

    return {
      timeline: paginated,
      total,
      page,
      limit,
      has_more: offset + paginated.length < total,
    };
  }
}
