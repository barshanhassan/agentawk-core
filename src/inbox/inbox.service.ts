// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from './chat.gateway';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RabbitMqService } from '../rabbitmq/rabbitmq.service';
import { S3Service } from '../s3/s3.service';
import OpenAI from 'openai';
import { Readable, PassThrough } from 'stream';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpeg = require('fluent-ffmpeg');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpegPath: string = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chatGateway: ChatGateway,
    private readonly eventEmitter: EventEmitter2,
    private readonly rabbit: RabbitMqService,
    private readonly config: ConfigService,
    private readonly s3: S3Service,
  ) {}

  // In-memory signed URL cache — key: s3Key, value: {url, expiresAt ms}
  private readonly signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

  private async getCachedSignedUrl(s3Key: string, ttlSeconds = 604800): Promise<string> {
    const now = Date.now();
    const cached = this.signedUrlCache.get(s3Key);
    if (cached && cached.expiresAt > now + 3600_000) return cached.url; // >1hr left → reuse
    const url = await this.s3.getSignedUrl(s3Key, ttlSeconds);
    if (url) this.signedUrlCache.set(s3Key, { url, expiresAt: now + ttlSeconds * 1000 });
    return url ?? '';
  }

  // Convert WebM/Opus (browser MediaRecorder default) to M4A (AAC in MP4 container).
  // Instagram Platform API supports 'audio' type outbound for AAC/M4A format.
  private async convertWebmToM4a(buffer: Buffer): Promise<Buffer> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('os');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const ts = Date.now();
    const tmpIn = path.join(os.tmpdir(), `ig_audio_in_${ts}.webm`);
    const tmpOut = path.join(os.tmpdir(), `ig_audio_out_${ts}.m4a`);
    fs.writeFileSync(tmpIn, buffer);
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(tmpIn)
        .noVideo()
        .audioCodec('aac')
        .audioBitrate('128k')
        .output(tmpOut)
        .on('end', () => {
          try {
            const data = fs.readFileSync(tmpOut);
            resolve(data);
          } catch (e) { reject(e); }
          finally {
            try { fs.unlinkSync(tmpIn); } catch {}
            try { fs.unlinkSync(tmpOut); } catch {}
          }
        })
        .on('error', (err) => {
          try { fs.unlinkSync(tmpIn); } catch {}
          try { fs.unlinkSync(tmpOut); } catch {}
          reject(err);
        })
        .run();
    });
  }

  /**
   * Unified Inbox Listing with advanced filtering logic matching Laravel parity.
   */
  async getInboxList(workspaceId: bigint, filters: any) {
    const {
      status,
      assigned_to,
      folder_id,
      search,
      mode,
      page = 1,
      limit = 20,
      is_read,         // 0/1 — Read / Unread tabs
      is_upcoming,     // true — Upcoming tab (snooze in the future)
      channel_types,   // string[] — channels filter chips
      current_user_id, // bigint — used for the "my chats" tab (NOT a tab now, but kept for future)
    } = filters;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where: any = { workspace_id: workspaceId };

    // Map frontend status to database enums. Falling through to `not: DELETED`
    // is the "All" behaviour — every other tab sets a specific filter below.
    if (status === 'closed' || status === 'completed') {
      where.status = 'COMPLETED';
    } else if (status === 'queued') {
      where.status = 'UNASSIGNED';
    } else if (status === 'active') {
      where.status = 'ACTIVE';
    } else if (status === 'all' || !status) {
      where.status = { not: 'DELETED' };
    } else {
      where.status = 'ACTIVE';
    }

    // Read / Unread — drives the Read + Unread tabs. Accept both 0/1 and
    // boolean inputs because the frontend ships JSON `1` not `"1"`.
    if (is_read === 1 || is_read === '1' || is_read === true) {
      where.is_read = 1;
    } else if (is_read === 0 || is_read === '0' || is_read === false) {
      where.is_read = 0;
    }

    // Upcoming — snoozed conversations whose snooze datetime is still in the
    // future. Schema uses `snooze` (NOT NULL DATETIME); rows that were never
    // snoozed have snooze=1970-01-01, so `> now` cleanly excludes them.
    if (is_upcoming === true || is_upcoming === 'true') {
      where.snooze = { gt: new Date() };
    } else if (status === 'all' || !status) {
      // Hide rows currently snoozed away from the All view. Because `snooze`
      // is NOT NULL in the schema (epoch sentinel for "never snoozed"), a
      // single `<= NOW()` clause covers both never-snoozed and past-snooze
      // rows — no `{ snooze: null }` (which Prisma rejects for non-nullable).
      where.snooze = { lte: new Date() };
    }

    // Channels filter (multi-select chip row in the filter popover). Each
    // channel maps to one or more `modelable_type` patterns.
    if (Array.isArray(channel_types) && channel_types.length > 0) {
      const modelablePatterns: string[] = [];
      for (const c of channel_types) {
        const lc = String(c).toLowerCase();
        if (lc === 'whatsapp') modelablePatterns.push('WhatsappChat');
        else if (lc === 'zapi') modelablePatterns.push('ZapiChat');
        else if (lc === 'telegram') modelablePatterns.push('TelegramChat');
        else if (lc === 'messenger' || lc === 'fb' || lc === 'facebook')
          modelablePatterns.push('FbChat', 'FacebookChat');
        else if (lc === 'instagram') modelablePatterns.push('InstaChat', 'InstagramChat');
        else if (lc === 'sms') modelablePatterns.push('TwilioChat');
        else if (lc === 'webchat') modelablePatterns.push('WcChat', 'WebchatChat');
      }
      if (modelablePatterns.length) {
        where.OR = modelablePatterns.map((p) => ({
          modelable_type: { contains: p },
        }));
      }
    }

    // Mode-based filtering
    if (mode === 'ASSIGNED') {
      where.user_id = { not: null };
    } else if (mode === 'UNASSIGNED') {
      where.user_id = null;
    } else if (mode === 'FOLDER' && folder_id) {
      where.folder_id = BigInt(folder_id);
    }
    if (folder_id) {
      where.folder_id = BigInt(folder_id);
    }

    // Specific agent assignment filter
    if (assigned_to) {
      where.user_id = BigInt(assigned_to);
    }

    // Text search: find contacts matching the query, then restrict inbox to
    // their chat rows. Runs two rounds of lookups but stays fully accurate
    // for pagination (the WHERE clause is complete before findMany runs).
    if (search?.trim()) {
      const term = search.trim();
      const matchingContacts = await this.prisma.contacts.findMany({
        where: {
          workspace_id: workspaceId,
          deleted_at: null,
          OR: [
            { full_name: { contains: term } },
            { first_name: { contains: term } },
            { last_name: { contains: term } },
          ],
        },
        select: { id: true },
        take: 300,
      });
      const contactIds = matchingContacts.map((c) => c.id);

      if (contactIds.length === 0) {
        return { inbox: [], total: 0, page: parseInt(page), limit: take, pages: 0 };
      }

      const [waIds, tgIds, fbIds, igIds, wcIds, zapiIds] = await Promise.all([
        this.prisma.wa_chats.findMany({ where: { contact_id: { in: contactIds } }, select: { id: true } }),
        this.prisma.telegram_chats.findMany({ where: { contact_id: { in: contactIds } }, select: { id: true } }),
        this.prisma.fb_chats.findMany({ where: { contact_id: { in: contactIds } }, select: { id: true } }),
        this.prisma.insta_chats.findMany({ where: { contact_id: { in: contactIds } }, select: { id: true } }),
        this.prisma.wc_chats.findMany({ where: { contact_id: { in: contactIds } }, select: { id: true } }),
        this.prisma.zapi_chats.findMany({ where: { contact_id: { in: contactIds } }, select: { id: true } }),
      ]);

      const searchOrConditions: any[] = [];
      if (waIds.length)   searchOrConditions.push({ modelable_type: { contains: 'WhatsappChat' }, modelable_id: { in: waIds.map((c) => c.id) } });
      if (tgIds.length)   searchOrConditions.push({ modelable_type: { contains: 'TelegramChat' }, modelable_id: { in: tgIds.map((c) => c.id) } });
      if (fbIds.length)   searchOrConditions.push({ modelable_type: { contains: 'FacebookChat' }, modelable_id: { in: fbIds.map((c) => c.id) } });
      if (igIds.length)   searchOrConditions.push({ modelable_type: { contains: 'InstaChat' }, modelable_id: { in: igIds.map((c) => c.id) } });
      if (wcIds.length)   searchOrConditions.push({ modelable_type: { contains: 'WcChat' }, modelable_id: { in: wcIds.map((c) => c.id) } });
      if (zapiIds.length) searchOrConditions.push({ modelable_type: { contains: 'ZapiChat' }, modelable_id: { in: zapiIds.map((c) => c.id) } });

      if (searchOrConditions.length === 0) {
        return { inbox: [], total: 0, page: parseInt(page), limit: take, pages: 0 };
      }

      // Merge with any existing channel OR so both constraints apply together
      if (where.OR) {
        where.AND = [{ OR: where.OR }, { OR: searchOrConditions }];
        delete where.OR;
      } else {
        where.OR = searchOrConditions;
      }
    }

    const [inboxes, total] = await Promise.all([
      this.prisma.inbox.findMany({
        where,
        orderBy: { updated_at: 'desc' },
        skip,
        take,
      }),
      this.prisma.inbox.count({ where }),
    ]);

    // Dedup by modelable_id: if same chat has multiple inbox rows, keep most-recently-updated.
    const chatSeen = new Map<string, typeof inboxes[0]>();
    for (const inv of inboxes) {
      const key = `${inv.modelable_type}:${String(inv.modelable_id)}`;
      const existing = chatSeen.get(key);
      if (!existing || (inv.updated_at && (!existing.updated_at || inv.updated_at > existing.updated_at))) {
        chatSeen.set(key, inv);
      }
    }
    const dedupedInboxes = Array.from(chatSeen.values());

    // ─── Batch-load all related data (replaces per-item N+1 queries) ───────────
    const waIds: bigint[] = [], tgIds: bigint[] = [], fbIds: bigint[] = [],
          igIds: bigint[] = [], wcIds: bigint[] = [];
    for (const inv of dedupedInboxes) {
      const t = (inv.modelable_type ?? '').toLowerCase();
      if (t.includes('whatsapp')) waIds.push(inv.modelable_id);
      else if (t.includes('telegram')) tgIds.push(inv.modelable_id);
      else if (t.includes('facebook') || t.includes('fbchat')) fbIds.push(inv.modelable_id);
      else if (t.includes('insta')) igIds.push(inv.modelable_id);
      else if (t.includes('wc') || t.includes('webchat')) wcIds.push(inv.modelable_id);
    }

    const [waChats, tgChats, fbChats, igChats, wcChats] = await Promise.all([
      waIds.length ? this.prisma.wa_chats.findMany({ where: { id: { in: waIds } } }) : Promise.resolve([]),
      tgIds.length ? this.prisma.telegram_chats.findMany({ where: { id: { in: tgIds } } }) : Promise.resolve([]),
      fbIds.length ? this.prisma.fb_chats.findMany({ where: { id: { in: fbIds } } }) : Promise.resolve([]),
      igIds.length ? this.prisma.insta_chats.findMany({ where: { id: { in: igIds } } }) : Promise.resolve([]),
      wcIds.length ? this.prisma.wc_chats.findMany({ where: { id: { in: wcIds } } }) : Promise.resolve([]),
    ]);

    const waMap = new Map((waChats as any[]).map((c: any) => [String(c.id), c]));
    const tgMap = new Map((tgChats as any[]).map((c: any) => [String(c.id), c]));
    const fbMap = new Map((fbChats as any[]).map((c: any) => [String(c.id), c]));
    const igMap = new Map((igChats as any[]).map((c: any) => [String(c.id), c]));
    const wcMap = new Map((wcChats as any[]).map((c: any) => [String(c.id), c]));

    // Collect contact IDs from all chats
    const allContactIds = new Set<bigint>();
    for (const c of [...waChats, ...tgChats, ...fbChats, ...igChats, ...wcChats] as any[]) {
      if (c.contact_id) allContactIds.add(c.contact_id);
    }
    const contactIdArr = Array.from(allContactIds);

    // Which channel types appear in this page (for mobile-number lookup)
    const neededChannels = new Set<string>();
    for (const inv of dedupedInboxes) {
      const t = (inv.modelable_type ?? '').toLowerCase();
      if (t.includes('whatsapp')) neededChannels.add('whatsapp');
      else if (t.includes('telegram')) neededChannels.add('telegram');
      else if (t.includes('insta')) neededChannels.add('instagram');
    }

    const assignedUserIds = (dedupedInboxes as any[]).filter((i: any) => i.user_id).map((i: any) => i.user_id as bigint);
    const assignedFolderIds = (dedupedInboxes as any[]).filter((i: any) => i.folder_id).map((i: any) => i.folder_id as bigint);

    const chatablePairs = (dedupedInboxes as any[])
      .filter((inv: any) => inv.modelable_type && inv.modelable_id)
      .map((inv: any) => ({ chatable_type: inv.modelable_type as string, chatable_id: inv.modelable_id as bigint }));

    const [allContacts, allUsers, allFolders, allLastMsgs, allMobiles] = await Promise.all([
      contactIdArr.length
        ? this.prisma.contacts.findMany({ where: { id: { in: contactIdArr } } })
        : Promise.resolve([]),
      assignedUserIds.length
        ? this.prisma.users.findMany({ where: { id: { in: assignedUserIds } } })
        : Promise.resolve([]),
      assignedFolderIds.length
        ? this.prisma.inbox_folders.findMany({ where: { id: { in: assignedFolderIds } } })
        : Promise.resolve([]),
      chatablePairs.length
        ? this.prisma.contact_last_messages.findMany({
            where: { OR: chatablePairs },
            orderBy: { created_at: 'desc' },
            select: { message: true, message_type: true, created_at: true, chatable_type: true, chatable_id: true },
          })
        : Promise.resolve([]),
      contactIdArr.length && neededChannels.size
        ? this.prisma.contact_mobiles.findMany({
            where: {
              modelable_type: 'App\\Models\\Contact',
              modelable_id: { in: contactIdArr },
              ownership_type: 'App\\Models\\Workspace',
              ownership_id: workspaceId,
              type: { in: Array.from(neededChannels) },
            },
            orderBy: { is_primary: 'desc' },
          })
        : Promise.resolve([]),
    ]);

    const contactMap = new Map((allContacts as any[]).map((c: any) => [String(c.id), c]));
    const userMap    = new Map((allUsers    as any[]).map((u: any) => [String(u.id), u]));
    const folderMap  = new Map((allFolders  as any[]).map((f: any) => [String(f.id), f]));

    // last message per (chatable_type, chatable_id) — already ordered DESC, first = most recent
    const lastMsgMap = new Map<string, any>();
    for (const msg of allLastMsgs as any[]) {
      const k = `${msg.chatable_type}:${String(msg.chatable_id)}`;
      if (!lastMsgMap.has(k)) lastMsgMap.set(k, msg);
    }

    // mobile per "contactId:channelType" — primary first due to orderBy
    const mobileMap = new Map<string, string>();
    for (const m of allMobiles as any[]) {
      const k = `${String(m.modelable_id)}:${m.type}`;
      if (!mobileMap.has(k)) mobileMap.set(k, m.full_mobile_number ?? '');
    }

    // ─── Enrich synchronously — zero extra DB queries ───────────────────────────
    const enrichedInboxes = (dedupedInboxes as any[]).map((inbox: any) => {
      const item = { ...inbox } as any;
      const mType = inbox.modelable_type ?? '';
      const mId   = String(inbox.modelable_id);
      const t     = mType.toLowerCase();

      let chat: any = null;
      let channelType: string | null = null;
      if      (t.includes('whatsapp'))                    { chat = waMap.get(mId); channelType = 'whatsapp'; }
      else if (t.includes('telegram'))                    { chat = tgMap.get(mId); channelType = 'telegram'; }
      else if (t.includes('facebook') || t.includes('fb')) { chat = fbMap.get(mId); }
      else if (t.includes('insta'))                       { chat = igMap.get(mId); channelType = 'instagram'; }
      else if (t.includes('wc') || t.includes('webchat')) { chat = wcMap.get(mId); }

      if (chat?.contact_id) {
        const contact = contactMap.get(String(chat.contact_id));
        if (contact) {
          item.contacts = { ...contact } as any;
          if (channelType) {
            const mobile = mobileMap.get(`${String(chat.contact_id)}:${channelType}`);
            if (mobile) item.contacts.mobile_number = mobile;
          }
        }
      }

      const lastMsg = lastMsgMap.get(`${mType}:${String(inbox.modelable_id)}`);
      item.last_message_text = lastMsg?.message ?? null;
      item.last_message_type = lastMsg?.message_type ?? null;
      item.unread_count = inbox.is_read === 0 ? 1 : 0;

      if (inbox.user_id)   item.users          = userMap.get(String(inbox.user_id))     ?? null;
      if (inbox.folder_id) item.inbox_folders  = folderMap.get(String(inbox.folder_id)) ?? null;

      return item;
    });

    // ─── Secondary dedup for Instagram ─────────────────────────────────────────
    // Legacy race-condition may have created multiple insta_chat rows per customer.
    // Group by contact_id; keep the most-recently-updated inbox per contact.
    const igContactSeen = new Map<string, any>();
    const nonIgResult: any[] = [];
    for (const item of enrichedInboxes) {
      const t = (item.modelable_type ?? '').toLowerCase();
      if (t.includes('insta')) {
        const cKey = item.contacts?.id ? `ig:${String(item.contacts.id)}` : null;
        if (!cKey) { nonIgResult.push(item); continue; }
        const existing = igContactSeen.get(cKey);
        if (!existing || (item.updated_at && (!existing.updated_at || item.updated_at > existing.updated_at))) {
          igContactSeen.set(cKey, item);
        }
      } else {
        nonIgResult.push(item);
      }
    }
    const finalInboxes = [...nonIgResult, ...igContactSeen.values()].sort(
      (a: any, b: any) => (b.updated_at?.getTime?.() ?? 0) - (a.updated_at?.getTime?.() ?? 0),
    );

    return {
      inbox: finalInboxes,
      total,
      page: parseInt(page),
      limit: take,
      pages: Math.ceil(total / take),
    };
  }

  /**
   * Get counts for different inbox statuses (Active, Unread, Snoozed, Completed, Unassigned)
   */
  async getInboxCounts(workspaceId: bigint, filters: any) {
    const now = new Date();
    const userIds = filters.users ? filters.users.map(id => id === 'NULL' ? null : BigInt(id)) : [];
    
    // Base where clause for counts
    const baseWhere: any = { workspace_id: workspaceId };

    // Function to get count for a specific set of conditions
    const getCount = async (additionalWhere: any) => {
      return this.prisma.inbox.count({
        where: { ...baseWhere, ...additionalWhere }
      });
    };

    const counts = {
      inbox: 0,
      unread: 0,
      read: 0,
      future: 0,
      completed: 0,
      unassigned: 0,
    };

    // Tab counts feed the frontend's All / Read / Unread / Queue / Upcoming /
    // Done labels. They are WORKSPACE-wide (not assigned-only) so the badges
    // match replyagent's behaviour where the chip beside each tab shows the
    // global total, not just what the current agent owns.
    //
    // `snooze` is NOT NULL in the schema (epoch sentinel = never snoozed), so
    // a plain `<= NOW()` clause covers both cases. Using `{ snooze: null }`
    // here would crash Prisma with "Argument `snooze` is missing".
    const notSnoozed = { snooze: { lte: now } };

    // 1. Inbox (ACTIVE, not snoozed) — base for the All tab
    counts.inbox = await getCount({
      status: 'ACTIVE',
      ...notSnoozed,
    });

    // 2. Unread (is_read = 0, ACTIVE, not snoozed)
    counts.unread = await getCount({
      status: 'ACTIVE',
      is_read: 0,
      ...notSnoozed,
    });

    // 3. Read (is_read = 1, ACTIVE, not snoozed)
    counts.read = await getCount({
      status: 'ACTIVE',
      is_read: 1,
      ...notSnoozed,
    });

    // 4. Future (Snoozed)
    counts.future = await getCount({
      status: 'ACTIVE',
      snooze: { gt: now },
    });

    // 5. Completed
    counts.completed = await getCount({
      status: 'COMPLETED',
    });

    // 6. Unassigned (Queue tab)
    counts.unassigned = await getCount({
      status: 'UNASSIGNED',
    });

    // Folder counts
    const folderCounts = await this.prisma.inbox.groupBy({
      by: ['folder_id'],
      where: {
        workspace_id: workspaceId,
        folder_id: { not: null },
        status: { not: 'DELETED' }
      },
      _count: true
    });

    return {
      counts,
      folder_counts: folderCounts.map(f => ({
        folder_id: f.folder_id,
        chat_count: f._count
      }))
    };
  }

  async getInboxItem(id: bigint, workspaceId: bigint) {
    const item = await this.prisma.inbox.findFirst({
      where: { id, workspace_id: workspaceId },
    });
    if (!item) throw new NotFoundException('Inbox item not found');

    const enrichedItem = item as any;
    
    // Fetch related chat and contact
    let chat: any = null;
    const mType = item.modelable_type;
    const mId = item.modelable_id;

    try {
      if (mType?.includes('WhatsappChat')) {
        chat = await this.prisma.wa_chats.findUnique({ where: { id: mId } });
      } else if (mType?.includes('TelegramChat')) {
        chat = await this.prisma.telegram_chats.findUnique({ where: { id: mId } });
      } else if (mType?.includes('FacebookChat')) {
        chat = await this.prisma.fb_chats.findUnique({ where: { id: mId } });
      } else if (mType?.includes('InstagramChat') || mType?.includes('InstaChat')) {
        chat = await this.prisma.insta_chats.findUnique({ where: { id: mId } });
      } else if (mType?.includes('WebchatChat') || mType?.includes('WcChat')) {
        chat = await this.prisma.wc_chats.findUnique({ where: { id: mId } });
      } else if (mType?.includes('ZapiChat')) {
        chat = await this.prisma.zapi_chats.findUnique({ where: { id: mId } });
      }

      if (chat?.contact_id) {
        enrichedItem.contacts = await this.prisma.contacts.findUnique({
          where: { id: chat.contact_id },
        });
      }
    } catch (e) {}

    if (item.user_id) {
      enrichedItem.users = await this.prisma.users.findUnique({
        where: { id: item.user_id },
      });
    }

    return enrichedItem;
  }


  /**
   * Unified message retrieval for different providers
   */
  async getChatMessages(inboxId: bigint, filters: any) {
    const inbox = await this.prisma.inbox.findUnique({
      where: { id: inboxId },
    });
    if (!inbox) throw new NotFoundException('Inbox not found');

    const { page = 1, limit = 25 } = filters;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);
    const modelableId = inbox.modelable_id;
    const type = inbox.modelable_type?.toLowerCase();

    let messages = [];
    const query: any = { orderBy: { created_at: 'desc' }, skip, take };

    if (type.includes('whatsapp')) {
      messages = await this.prisma.wa_messages.findMany({
        ...query,
        where: { wa_chat_id: modelableId },
      });
    } else if (type.includes('messenger') || type.includes('fb')) {
      messages = await this.prisma.fb_messages.findMany({
        ...query,
        where: { fb_chat_id: modelableId },
      });
    } else if (type.includes('instagram') || type.includes('insta')) {
      messages = await this.prisma.insta_messages.findMany({
        ...query,
        where: { insta_chat_id: modelableId },
      });
    } else if (type.includes('telegram')) {
      messages = await this.prisma.telegram_messages.findMany({
        ...query,
        where: { telegram_chat_id: modelableId },
      });
    } else if (type.includes('webchat')) {
      messages = await this.prisma.wc_messages.findMany({
        ...query,
        where: { wc_chat_id: modelableId },
      });
    }

    // Batch-load gallery media — one query instead of N
    const galleryIds = messages
      .filter((m: any) => m.gallery_media_id)
      .map((m: any) => {
        try {
          return typeof m.gallery_media_id === 'string'
            ? BigInt((m.gallery_media_id as string).split(',')[0])
            : BigInt(m.gallery_media_id);
        } catch { return null; }
      })
      .filter(Boolean) as bigint[];

    const galleryMap = new Map<string, any>();
    if (galleryIds.length > 0) {
      const galleryItems = await this.prisma.media_gallery.findMany({ where: { id: { in: galleryIds } } });
      for (const gi of galleryItems) galleryMap.set(String(gi.id), gi);
    }

    // Enrich with Gallery Media and parse inline files JSON
    const enrichedMessages = await Promise.all(
      messages.map(async (msg) => {
        const item = msg as any;

        // Use batched gallery map — no per-message DB query
        if (msg.gallery_media_id) {
          try {
            const mediaId = typeof msg.gallery_media_id === 'string'
              ? BigInt((msg.gallery_media_id as string).split(',')[0])
              : BigInt(msg.gallery_media_id);
            item.gallery_media = galleryMap.get(String(mediaId)) ?? null;
          } catch (e) {
            this.logger.warn(`Failed to load gallery media for message ${msg.id}: ${e.message}`);
          }
        }

        // Parse inline files JSON — use cached signed URLs to avoid S3 API on every poll
        if (item.files && typeof item.files === 'string') {
          try {
            const rawFiles = JSON.parse(item.files);
            if (Array.isArray(rawFiles)) {
              item.parsed_files = await Promise.all(rawFiles.map(async (f: any) => {
                if (f.s3Key) {
                  const freshUrl = await this.getCachedSignedUrl(f.s3Key);
                  return { ...f, url: freshUrl || f.url };
                }
                return f;
              }));
            }
          } catch {}
        }
        // Instagram inbound/echo: payload has [{type, media:{fileUrl(direct S3 URL),...}}]
        if (!item.parsed_files && item.payload && typeof item.payload === 'string' && item.insta_chat_id) {
          try {
            const attachments = JSON.parse(item.payload);
            if (Array.isArray(attachments) && attachments.length && attachments[0]?.media?.fileUrl) {
              item.parsed_files = await Promise.all(attachments.map(async (a: any) => {
                const rawUrl: string = a.media.fileUrl ?? '';
                let url = rawUrl;
                if (rawUrl.includes('.amazonaws.com/')) {
                  const s3Key = rawUrl.split('.amazonaws.com/')[1];
                  url = (await this.getCachedSignedUrl(s3Key)) || rawUrl;
                }
                return {
                  url,
                  name: a.media.originalName ?? a.media.fileName ?? 'attachment',
                  size: Number(a.media.fileSize ?? 0),
                  mime: a.media.mimeType ?? a.media.contentType ?? 'application/octet-stream',
                };
              }));
            }
          } catch {}
        }
        // Instagram outbound from Ezconn: data has [{url(signed S3 URL), name, size, mime}]
        if (!item.parsed_files && item.data && typeof item.data === 'string' && item.insta_chat_id) {
          try {
            const dataFiles = JSON.parse(item.data);
            if (Array.isArray(dataFiles) && dataFiles.length && dataFiles[0]?.url) {
              item.parsed_files = dataFiles;
            }
          } catch {}
        }
        return item;
      })
    );

    // Batch-load reactions for all messages and attach
    const msgIds = enrichedMessages.map((m: any) => BigInt(m.id));
    if (msgIds.length > 0) {
      const messageType = this.messageTypeFor(type ?? '');
      const allReactions = await this.prisma.message_reactions.findMany({
        where: { message_type: messageType, message_id: { in: msgIds } },
      });
      const reactionsMap = new Map<string, any[]>();
      for (const r of allReactions) {
        const k = String(r.message_id);
        if (!reactionsMap.has(k)) reactionsMap.set(k, []);
        reactionsMap.get(k)!.push({ reaction: r.reaction, direction: r.direction });
      }
      for (const m of enrichedMessages) {
        (m as any).reactions = reactionsMap.get(String(m.id)) ?? [];
      }
    }

    return { messages: enrichedMessages.reverse(), page: parseInt(page), limit: take };
  }

  /**
   * Send message (Routes to respective social provider service)
   */
  /**
   * Send message (Routes to respective social provider service)
   */
  async sendMessage(
    inboxId: bigint,
    data: any,
    userId: bigint,
    files?: Express.Multer.File[],
  ) {
    const inbox = await this.prisma.inbox.findUnique({
      where: { id: inboxId },
    });
    if (!inbox) throw new NotFoundException('Inbox not found');

    const type = inbox.modelable_type || '';
    const modelableId = inbox.modelable_id;
    // Frontend (ConversationsInbox.tsx) sends `message_text`; older callers
    // used `text` / `message`. Accept all three so the body never silently
    // empties out.
    const text = data.message_text ?? data.text ?? data.message ?? '';

    // Compose mode comes from the Reply/Note tabs in the inbox composer.
    // Note mode persists the message as an internal annotation (type='note',
    // not dispatched to Meta) so it shows up in the chat thread without ever
    // leaving EZCONN — matches replyagent's Note tab behaviour exactly.
    const composeMode = String(data.compose_mode ?? 'reply').toLowerCase();
    const isNote = composeMode === 'note';

    // Reply-to context: when the agent used the reply-arrow on a specific
    // earlier message, the bubble id comes through here. We persist it as the
    // outgoing row's `replied_to_message_id` so the thread can render the
    // quoted-reply preview client-side, and so the customer sees the same
    // quoted reply on their end (WhatsApp `context.message_id`).
    const replyToMessageId = data.reply_to_message_id ? Number(data.reply_to_message_id) : null;

    this.logger.log(
      `Processing outgoing message for inbox ${inboxId} (Type: ${type}, ID: ${modelableId}, mode=${composeMode}${replyToMessageId ? `, reply_to=${replyToMessageId}` : ''})`,
    );

    // Upload any attached files to S3 and build URL list for the message payload.
    const uploadedFileUrls: { url: string; name: string; size: number; mime: string }[] = [];
    if (files && files.length > 0) {
      this.logger.log(`[UPLOAD] ${files.length} file(s): ${files.map(f => `${f.originalname}(${f.size}B)`).join(', ')}`);
      const uploadResults = await Promise.all(files.map(async (file, idx) => {
        // Instagram supports M4A (AAC) for audio type outbound — convert WebM to M4A
        if (
          type && type.toLowerCase().includes('insta') &&
          file.mimetype && file.mimetype.startsWith('audio/') &&
          (file.mimetype.includes('webm') || file.originalname?.toLowerCase().endsWith('.webm'))
        ) {
          try {
            this.logger.log(`[IG AUDIO] Converting ${file.originalname} (${file.mimetype}) → m4a`);
            file.buffer = await this.convertWebmToM4a(file.buffer);
            file.originalname = file.originalname.replace(/\.webm$/i, '.m4a');
            file.mimetype = 'audio/mp4';
            file.size = file.buffer.length;
            this.logger.log(`[IG AUDIO] Converted ok size=${file.size}B`);
          } catch (convErr) {
            this.logger.warn(`[IG AUDIO] WebM→M4a conversion failed (${convErr.message}) — uploading original`);
          }
        }
        // WhatsApp does not support audio/webm — convert to M4A (AAC) which WhatsApp supports
        if (
          type && type.toLowerCase().includes('whatsapp') &&
          file.mimetype && file.mimetype.startsWith('audio/') &&
          (file.mimetype.includes('webm') || file.originalname?.toLowerCase().endsWith('.webm'))
        ) {
          try {
            this.logger.log(`[WA AUDIO] Converting ${file.originalname} (${file.mimetype}) → m4a`);
            file.buffer = await this.convertWebmToM4a(file.buffer);
            file.originalname = file.originalname.replace(/\.webm$/i, '.m4a');
            file.mimetype = 'audio/mp4';
            file.size = file.buffer.length;
            this.logger.log(`[WA AUDIO] Converted ok size=${file.size}B`);
          } catch (convErr) {
            this.logger.warn(`[WA AUDIO] WebM→M4a conversion failed (${convErr.message}) — uploading original`);
          }
        }
        const key = `inbox/${inboxId}/attachments/${Date.now()}-${idx}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const s3Key = await this.s3.upload(file.buffer, key, file.mimetype);
        if (!s3Key) {
          throw new BadRequestException(
            `File upload to S3 failed: ${this.s3.lastError ?? 'check AWS credentials/bucket config'}`,
          );
        }
        const signedUrl = await this.s3.getSignedUrl(s3Key, 3600 * 24 * 7);
        if (!signedUrl) {
          throw new BadRequestException('Failed to generate signed URL after S3 upload');
        }
        return { url: signedUrl, name: file.originalname, size: file.size, mime: file.mimetype };
      }));
      uploadedFileUrls.push(...uploadResults);
    }

    if (!String(text).trim() && uploadedFileUrls.length === 0) {
      throw new BadRequestException('Message body is empty — provide message_text/text or attach a file');
    }

    let savedMessage = null;

    try {
      const lowerType = type.toLowerCase();
      if (lowerType.includes('whatsappchat')) {
        // Replyagent-mirror flow:
        //   1. wa_chats → wa_phone_numbers → wa_accounts (need wa_id + Meta phone_number_id + Mongo meta_account_id)
        //   2. wa_messages row at status='pending' (so the chat UI shows the bubble immediately)
        //   3. Publish WA_OUTBOUND_MESSAGE on ra/whatsapp — microservice calls Meta
        //   4. Microservice echoes WA_OUTBOUND_MESSAGE_STATUS → consumer updates row to sent/failed
        const chat = await this.prisma.wa_chats.findUnique({ where: { id: modelableId } });
        if (!chat) {
          this.logger.error(`No wa_chats record found for ID ${modelableId}`);
          throw new NotFoundException('WhatsApp chat not found');
        }
        // Parallel lookup — saves ~1s vs 3 sequential queries
        const [phone, account] = await Promise.all([
          this.prisma.wa_phone_numbers.findUnique({ where: { id: chat.wa_number_id } }),
          this.prisma.wa_accounts.findUnique({ where: { id: chat.wa_account_id } }),
        ]);
        if (!phone) throw new NotFoundException('WhatsApp phone number not found for this chat');
        if (!account) throw new NotFoundException('WhatsApp account not found for this chat');
        if (!account.meta_account_id) {
          throw new BadRequestException(
            'WhatsApp account is not registered with the microservice yet (meta_account_id missing). Re-run "Connect Manually" on the WhatsApp settings page so registration completes.',
          );
        }

        this.logger.log(
          `Found chat for WhatsApp. chat_id=${chat.id.toString()}, wa_id=${chat.wa_id}, meta_account_id=${account.meta_account_id}`,
        );

        const sentAt = new Date();
        const hasFiles = uploadedFileUrls.length > 0;
        const fileType = hasFiles
          ? (uploadedFileUrls[0].mime?.startsWith('image/') ? 'image'
            : uploadedFileUrls[0].mime?.startsWith('audio/') ? 'audio'
            : uploadedFileUrls[0].mime?.startsWith('video/') ? 'video'
            : 'document')
          : 'text';

        savedMessage = await this.prisma.wa_messages.create({
          data: {
            wa_chat_id: modelableId,
            wa_number_id: chat.wa_number_id,
            sender_id: userId,
            text: text || null,
            direction: 'OUTGOING',
            type: isNote ? 'note' : (hasFiles ? fileType : 'text'),
            mobile_number: chat.wa_id || '',
            status: isNote ? 'sent' : 'pending',
            ...(hasFiles ? { files: JSON.stringify(uploadedFileUrls) } : {}),
            ...(replyToMessageId ? { replied_to_message_id: replyToMessageId as any } : {}),
            created_at: sentAt,
            updated_at: sentAt,
          } as any,
        });

        // Internal notes never leave the platform — short-circuit the publish
        // step so they don't reach Meta/customer.
        if (isNote) {
          return { success: true, message: savedMessage, note: true };
        }

        // ── EMIT SOCKET IMMEDIATELY after DB save (before rabbit.publish) ──
        // This is what makes the message appear instantly in the sender's UI.
        // rabbit.publish runs in the background — the user doesn't need to wait.
        {
          const sm2 = savedMessage as any;
          let sm2Files: any = null;
          try { sm2Files = sm2?.files ? JSON.parse(sm2.files) : null; } catch {}
          this.chatGateway.emitToWorkspace(inbox.workspace_id, 'new_message', {
            inbox_id: inboxId.toString(),
            message: {
              id: sm2?.id?.toString?.() ?? null,
              direction: 'OUTGOING',
              text: sm2?.text ?? null,
              type: sm2?.type ?? 'text',
              status: 'pending',
              reactions: [],
              parsed_files: sm2Files,
              created_at: sm2?.created_at?.toISOString?.() ?? new Date().toISOString(),
              updated_at: sm2?.updated_at?.toISOString?.() ?? new Date().toISOString(),
            },
          });
        }

        const exchange = this.config.get<string>('RABBITMQ_EXCHANGE') || 'ra';
        const whatsappQueue = this.config.get<string>('RABBITMQ_WHATSAPP_QUEUE') || 'whatsapp';

        // Build waContext first (may involve one DB lookup for reply-to)
        const waContext: any = { messaging_product: 'whatsapp', to: chat.wa_id };
        if (hasFiles) {
          const mediaUrl = uploadedFileUrls[0].url;
          waContext.type = fileType;
          if (fileType === 'image') waContext.image = { link: mediaUrl };
          else if (fileType === 'audio') waContext.audio = { link: mediaUrl };
          else if (fileType === 'video') waContext.video = { link: mediaUrl };
          else waContext.document = { link: mediaUrl, filename: uploadedFileUrls[0].name };
        } else {
          waContext.type = 'text';
          waContext.text = { body: text };
          if (replyToMessageId) {
            try {
              const repliedTo = await this.prisma.wa_messages.findUnique({
                where: { id: BigInt(replyToMessageId) },
                select: { wamid: true } as any,
              });
              if ((repliedTo as any)?.wamid) waContext.context = { message_id: (repliedTo as any).wamid };
            } catch {}
          }
        }

        // Publish to RabbitMQ — fire-and-forget, mark failed on error
        this.rabbit.publish(exchange, whatsappQueue, {
          event: 'WA_OUTBOUND_MESSAGE',
          payload: {
            accountId: account.meta_account_id,
            phoneNumberId: phone.wa_number_id,
            context: waContext,
            meta: {
              backend_wa_message_id: savedMessage.id.toString(),
              backend_inbox_id: inboxId.toString(),
              workspace_id: account.workspace_id.toString(),
            },
          },
        }).then(() => {
          this.logger.log(`WA_OUTBOUND_MESSAGE published for wa_message_id=${savedMessage.id}`);
        }).catch(async (err: any) => {
          this.logger.error(`rabbit.publish failed: ${err?.message ?? err}`);
          await this.prisma.wa_messages.update({
            where: { id: savedMessage.id },
            data: { status: 'failed', error_data: String(err?.message ?? err) },
          }).catch(() => {});
          this.chatGateway.emitToWorkspace(inbox.workspace_id, 'message_status', {
            wa_message_id: savedMessage.id.toString(),
            inbox_id: inboxId.toString(),
            status: 'failed',
          });
        });
      } else if (type.includes('TelegramChat')) {
        savedMessage = await this.prisma.telegram_messages.create({
          data: {
            telegram_chat_id: modelableId,
            user_id: userId,
            text: text,
            direction: 'OUTGOING',
            type: 'text',
            message_id: `pending_${Date.now()}`,
            message_number: BigInt(Date.now()),
            seen: true,
            status: 'SENT',
          },
        });
      } else if (type.includes('FacebookChat')) {
        const chat = await this.prisma.fb_chats.findUnique({
          where: { id: modelableId },
        });
        if (chat) {
          savedMessage = await this.prisma.fb_messages.create({
            data: {
              fb_chat_id: modelableId,
              fb_page_id: chat.fb_page_id,
              sender_id: userId,
              text: text,
              direction: 'OUTGOING',
              type: 'text',
              status: 'sent',
            },
          });
        }
      } else if (type.includes('InstagramChat') || type.includes('InstaChat')) {
        const chat = await this.prisma.insta_chats.findUnique({ where: { id: modelableId } });
        if (!chat) throw new NotFoundException('Instagram chat not found');

        const instaPage = await this.prisma.insta_pages.findUnique({ where: { id: chat.insta_page_id } });

        const sentAt = new Date();
        const hasFiles = uploadedFileUrls.length > 0;
        const igFileType = hasFiles
          ? (uploadedFileUrls[0].mime?.startsWith('image/') ? 'image'
            : uploadedFileUrls[0].mime?.startsWith('audio/') ? 'audio'
            : uploadedFileUrls[0].mime?.startsWith('video/') ? 'video'
            : 'file')
          : 'text';

        // Instagram DM API limits: image 8 MB, video 25 MB; documents not supported
        if (hasFiles) {
          const fileSizeBytes = uploadedFileUrls[0].size;
          const isImage = igFileType === 'image';
          const isVideo = igFileType === 'video';
          if (igFileType === 'file') {
            throw new BadRequestException(
              `Instagram does not support document attachments. Only images, videos, and audio files can be sent via Instagram DM.`,
            );
          }
          if (isImage && fileSizeBytes > 8 * 1024 * 1024) {
            throw new BadRequestException(`Image too large for Instagram (${Math.round(fileSizeBytes / 1024)}KB). Instagram DM limit is 8MB.`);
          }
          if (isVideo && fileSizeBytes > 25 * 1024 * 1024) {
            throw new BadRequestException(`Video too large for Instagram (${Math.round(fileSizeBytes / 1024)}KB). Instagram DM limit is 25MB.`);
          }
        }

        savedMessage = await this.prisma.insta_messages.create({
          data: {
            insta_chat_id: modelableId,
            insta_page_id: chat.insta_page_id,
            sender_id: userId,
            text: text || null,
            direction: 'OUTGOING',
            type: isNote ? 'note' : igFileType,
            status: isNote ? 'sent' : 'pending',
            ...(hasFiles ? { data: JSON.stringify(uploadedFileUrls) } : {}),
            created_at: sentAt,
            updated_at: sentAt,
          },
        });

        if (!isNote) {
          if (!instaPage?.service_account_id) {
            await this.prisma.insta_messages.update({
              where: { id: savedMessage.id },
              data: { status: 'failed', updated_at: new Date() },
            });
            throw new BadRequestException(
              'Instagram account not linked to microservice. Please reconnect Instagram.',
            );
          }

          // Build Instagram message payload — text or media attachment
          let igMessage: any;
          if (hasFiles) {
            this.logger.log(`[IG OUTBOUND] type=${igFileType} size=${uploadedFileUrls[0].size} url=${uploadedFileUrls[0].url?.substring(0, 100)}...`);
            igMessage = {
              attachment: {
                type: igFileType,
                payload: { url: uploadedFileUrls[0].url, is_reusable: true },
              },
            };
          } else {
            igMessage = { text };
          }

          const exchange = this.config.get<string>('RABBITMQ_EXCHANGE') || 'ra';
          const igQueue = this.config.get<string>('RABBITMQ_INSTAGRAM_QUEUE') || 'instagram';
          try {
            await this.rabbit.publish(exchange, igQueue, {
              event: 'INSTA_OUTBOUND_MESSAGE',
              payload: {
                accountId: instaPage.service_account_id,
                context: {
                  recipient: { id: chat.sender_id },
                  message: igMessage,
                },
                meta: {
                  backend_insta_message_id: savedMessage.id.toString(),
                  backend_inbox_id: inboxId.toString(),
                  workspace_id: instaPage.workspace_id.toString(),
                },
              },
            });
            this.logger.log(
              `INSTA_OUTBOUND_MESSAGE published for insta_message_id=${savedMessage.id} inbox=${inboxId}`,
            );
          } catch (err: any) {
            await this.prisma.insta_messages.update({
              where: { id: savedMessage.id },
              data: { status: 'failed', updated_at: new Date() },
            });
            throw new BadRequestException(`Could not queue Instagram message: ${err?.message ?? err}`);
          }
        }
      } else if (type.includes('WebchatChat') || type.includes('WcChat')) {
        savedMessage = await this.prisma.wc_messages.create({
          data: {
            wc_chat_id: modelableId,
            sender_id: userId,
            text: text,
            direction: 'OUTGOING',
            type: 'text',
          },
        });
      }

      this.logger.log(`Message persisted for inbox ${inboxId} (channel: ${type})`);

      // Emit socket IMMEDIATELY after message is saved — before inbox.update so UI
      // updates as fast as possible (replyagent parity).
      const sm = savedMessage as any;
      let smParsedFiles: any = null;
      try { smParsedFiles = sm?.files ? JSON.parse(sm.files) : null; } catch { smParsedFiles = null; }
      this.chatGateway.emitToWorkspace(inbox.workspace_id, 'new_message', {
        inbox_id: inboxId.toString(),
        message: {
          id: sm?.id?.toString?.() ?? null,
          direction: 'OUTGOING',
          text: sm?.text ?? null,
          type: sm?.type ?? 'text',
          status: sm?.status ?? 'pending',
          reactions: [],
          parsed_files: smParsedFiles,
          created_at: sm?.created_at?.toISOString?.() ?? new Date().toISOString(),
          updated_at: sm?.updated_at?.toISOString?.() ?? new Date().toISOString(),
        },
      });

      // Fire-and-forget inbox timestamp update — don't block the response
      this.prisma.inbox.update({
        where: { id: inboxId },
        data: { updated_at: new Date(), last_updated: new Date() },
      }).catch((e) => this.logger.warn(`inbox.update failed for ${inboxId}: ${e.message}`));

      return {
        success: true,
        status: savedMessage?.status ?? 'sent',
        message: 'Message saved and queued for delivery',
        data: savedMessage,
      };
    } catch (error) {
      this.logger.error(`Error saving message for inbox ${inboxId}: ${error.message}`);
      throw new BadRequestException(`Failed to save message: ${error.message}`);
    }
  }

  /**
   * Profile Actions: Tags, Custom Fields, Contact Updates
   */
  async getProfileData(inboxId: bigint, workspaceId?: bigint) {
    const inbox = await this.prisma.inbox.findUnique({
      where: { id: inboxId },
    });
    if (!inbox) throw new NotFoundException('Inbox not found');

    const enrichedInbox = inbox as any;
    let contact: any = null;
    let chat: any = null;
    const mType = inbox.modelable_type;
    const mId = inbox.modelable_id;

    try {
      if (mType?.includes('WhatsappChat')) {
        chat = await this.prisma.wa_chats.findUnique({ where: { id: mId } });
      } else if (mType?.includes('TelegramChat')) {
        chat = await this.prisma.telegram_chats.findUnique({ where: { id: mId } });
      } else if (mType?.includes('FacebookChat')) {
        chat = await this.prisma.fb_chats.findUnique({ where: { id: mId } });
      } else if (mType?.includes('InstagramChat') || mType?.includes('InstaChat')) {
        chat = await this.prisma.insta_chats.findUnique({ where: { id: mId } });
      } else if (mType?.includes('WebchatChat') || mType?.includes('WcChat')) {
        chat = await this.prisma.wc_chats.findUnique({ where: { id: mId } });
      } else if (mType?.includes('ZapiChat')) {
        chat = await this.prisma.zapi_chats.findUnique({ where: { id: mId } });
      }

      if (chat?.contact_id) {
        contact = await this.prisma.contacts.findUnique({
          where: { id: chat.contact_id },
        });
      }
    } catch (e) {}

    enrichedInbox.contacts = contact;

    // Fetch contact's applied tags via tag_links
    let contactTags: any[] = [];
    if (contact?.id) {
      try {
        const tagLinks = await this.prisma.tag_links.findMany({
          where: { linkable_type: 'App\\Models\\Contact', linkable_id: contact.id },
        });
        if (tagLinks.length > 0) {
          const tagIds = tagLinks.map((tl) => tl.tag_id);
          const tags = await this.prisma.tags.findMany({
            where: { id: { in: tagIds } },
            select: { id: true, name: true, bg_color: true, text_color: true },
          });
          contactTags = tags;
        }
      } catch (e) {}
    }

    // Fetch ALL workspace CONTACT custom fields (always), then merge per-contact
    // values only when a contact is linked. Two separate try blocks so a value
    // fetch failure never collapses the field definitions themselves.
    // NOTE: schema has no explicit Prisma @relation between custom_field_entities
    // and custom_field_entity_values, so we must NOT use `include` — manual join.
    let customFields: any[] = [];
    try {
      const wsId = workspaceId ?? (inbox as any).workspace_id;
      if (wsId) {
        const allFields = await this.prisma.custom_fields.findMany({
          where: { workspace_id: wsId, for: 'CONTACT' },
          orderBy: { created_at: 'asc' },
        });
        const fieldIds = allFields.map((f: any) => f.id);
        const props = fieldIds.length
          ? await this.prisma.custom_field_properties.findMany({ where: { custom_field_id: { in: fieldIds } } })
          : [];

        // Build fields with null values first (always succeeds)
        customFields = (allFields as any[]).map((f) => ({
          id: f.id.toString(),
          label: f.label,
          slug: f.slug,
          content_type: f.content_type,
          input_type: f.input_type,
          has_properties: f.has_properties,
          properties: props.filter((p: any) => p.custom_field_id === f.id),
          value: null,
        }));

        // Overlay per-contact values in a separate try so any failure still
        // returns the field definitions (with null values).
        if (contact?.id && fieldIds.length) {
          try {
            const entities = await this.prisma.custom_field_entities.findMany({
              where: { entity_type: 'CONTACT', entity_id: contact.id, custom_field_id: { in: fieldIds } },
            });
            const entityIds = (entities as any[]).map((e) => e.id);
            const vals = entityIds.length
              ? await this.prisma.custom_field_entity_values.findMany({ where: { cf_entity_id: { in: entityIds } } })
              : [];
            const entityToField = new Map((entities as any[]).map((e) => [e.id.toString(), e.custom_field_id.toString()]));
            const valueMap = new Map<string, string>();
            for (const v of vals as any[]) {
              const fid = entityToField.get(v.cf_entity_id.toString());
              if (fid && v.value != null) valueMap.set(fid, v.value);
            }
            customFields = customFields.map((f) => ({ ...f, value: valueMap.get(f.id) ?? null }));
          } catch (_ve) {}
        }
      }
    } catch (e) {}

    // Fetch contact's opportunities with pipeline + step names
    let opportunities: any[] = [];
    if (contact?.id) {
      try {
        const wsId = workspaceId ?? (inbox as any).workspace_id;
        const opps = await this.prisma.pipeline_opportunities.findMany({
          where: { contact_id: contact.id, workspace_id: wsId },
          orderBy: { created_at: 'desc' },
          take: 20,
        });
        if (opps.length > 0) {
          const stepIds = [...new Set(opps.map((o: any) => o.pl_step_id))];
          const plIds = [...new Set(opps.map((o: any) => o.pl_id))];
          const [steps, pls] = await Promise.all([
            this.prisma.pipeline_steps.findMany({ where: { id: { in: stepIds } }, select: { id: true, name: true, bg_color: true, txt_color: true } }),
            this.prisma.pipelines.findMany({ where: { id: { in: plIds } }, select: { id: true, name: true, currency: true } }),
          ]);
          const stepMap = new Map((steps as any[]).map((s) => [s.id.toString(), s]));
          const plMap = new Map((pls as any[]).map((p) => [p.id.toString(), p]));
          opportunities = opps.map((o: any) => ({
            id: o.id.toString(),
            title: o.title,
            value: o.value,
            currency: o.currency,
            status: o.status,
            closing_date: o.closing_date,
            probability: o.probability,
            step: stepMap.get(o.pl_step_id.toString()) ?? null,
            pipeline: plMap.get(o.pl_id.toString()) ?? null,
          }));
        }
      } catch (e) {}
    }

    return {
      inbox: enrichedInbox,
      contact: contact,
      chat: chat,
      tags: contactTags,
      custom_fields: customFields,
      opportunities,
    };
  }

  async assignConversation(data: any, workspaceId: bigint, userId: bigint) {
    const { inbox_id, assigned_to } = data;

    // Defensive coercion — `inbox_id` arrives from req.params (string) and
    // `assigned_to` arrives from req.body (could be string, number, or even
    // the literal "Me" sentinel the frontend sends when picking the current
    // user). `BigInt()` on any non-numeric value throws, so we stringify-then-
    // try once and treat anything we can't parse as "assign to me".
    const inboxIdBig = this.toBigIntOrNull(inbox_id);
    if (inboxIdBig === null) {
      throw new BadRequestException(`Invalid inbox_id: ${inbox_id}`);
    }

    let assignedToId: bigint | null;
    if (assigned_to === null || assigned_to === undefined || assigned_to === '') {
      assignedToId = null;
    } else if (typeof assigned_to === 'string' && assigned_to.toLowerCase() === 'me') {
      // Frontend "Assign to Me" sends the literal — resolve to the caller.
      assignedToId = userId;
    } else {
      const parsed = this.toBigIntOrNull(assigned_to);
      assignedToId = parsed ?? userId; // fall back to the caller if the value isn't a valid user id
    }

    const inbox = await this.prisma.inbox.findFirst({
      where: { id: inboxIdBig, workspace_id: workspaceId },
    });
    if (!inbox) throw new NotFoundException('Inbox not found');

    const updated = await this.prisma.inbox.update({
      where: { id: inbox.id },
      data: {
        // Use `user_id` (the schema field) — `assigned_to` doesn't exist on the inbox row.
        user_id: assignedToId,
        assigned_by: userId,
        assigned_on: new Date(),
        is_assigned: assignedToId ? 1 : 0,
        status: assignedToId ? 'ACTIVE' : 'UNASSIGNED',
        updated_at: new Date(),
      },
    });

    // Fire conversation.assigned for any matching `conversation_assigned`
    // trigger activities. Contact resolution is best-effort — channel chat
    // tables hold the contact_id mapping.
    const contactId = await this.resolveInboxContact(updated);
    if (contactId) {
      this.eventEmitter.emit('conversation.assigned', {
        contactId,
        workspaceId,
        userId: assignedToId,
        inboxId: updated.id,
      });
    }

    return updated;
  }

  /**
   * Resolve the contact behind an inbox row. Walks the channel-specific chat
   * tables based on `modelable_type`. Centralised here so all the inbox
   * service methods that emit contact-scoped events resolve the same way.
   */
  private async resolveInboxContact(inbox: { modelable_type: string | null; modelable_id: bigint }): Promise<bigint | null> {
    const mType = inbox.modelable_type ?? '';
    const mId = inbox.modelable_id;
    if (!mId) return null;
    try {
      if (mType.includes('WhatsappChat')) {
        const chat = await this.prisma.wa_chats.findUnique({ where: { id: mId } });
        return chat?.contact_id ?? null;
      }
      if (mType.includes('TelegramChat')) {
        const chat = await this.prisma.telegram_chats.findUnique({ where: { id: mId } });
        return chat?.contact_id ?? null;
      }
      if (mType.includes('FacebookChat')) {
        const chat = await this.prisma.fb_chats.findUnique({ where: { id: mId } });
        return chat?.contact_id ?? null;
      }
      if (mType.includes('InstagramChat') || mType.includes('InstaChat')) {
        const chat = await this.prisma.insta_chats.findUnique({ where: { id: mId } });
        return chat?.contact_id ?? null;
      }
      if (mType.includes('WebchatChat') || mType.includes('WcChat')) {
        const chat = await this.prisma.wc_chats.findUnique({ where: { id: mId } });
        return chat?.contact_id ?? null;
      }
      if (mType.includes('App\\Models\\Contact')) {
        return mId;
      }
    } catch {}
    return null;
  }

  /**
   * Try to convert an unknown value to a BigInt. Returns null on anything
   * non-numeric (including objects, NaN, empty strings, the literal "Me",
   * or already-BigInt values that re-coerce cleanly).
   */
  private toBigIntOrNull(v: any): bigint | null {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'bigint') return v;
    try {
      const str = String(v).trim();
      if (!/^-?\d+$/.test(str)) return null;
      return BigInt(str);
    } catch {
      return null;
    }
  }

  /**
   * Bulk & Lifecycle Actions
   */
  async assignConversationBulk(
    inboxIds: bigint[],
    assignedTo: bigint | null,
    workspaceId: bigint,
  ) {
    return this.prisma.inbox.updateMany({
      where: { id: { in: inboxIds }, workspace_id: workspaceId },
      data: { user_id: assignedTo },
    });
  }

  async snoozeConversation(
    inboxId: bigint,
    until: Date | null,
    workspaceId: bigint,
  ) {
    // `null` clears the snooze (replyagent: passing schedule=null unsnoozes).
    return this.prisma.inbox.update({
      where: { id: inboxId, workspace_id: workspaceId },
      data: { snooze: until ?? new Date(0), status: 'ACTIVE' },
    });
  }

  async updateInboxStatus(
    inboxId: bigint,
    status: string,
    workspaceId: bigint,
    userId?: bigint,
  ) {
    const now = new Date();
    status = typeof status === 'string' ? status.toUpperCase() : status;
    const updateData: any = { status, updated_at: now };

    // Clear snooze sentinel when re-activating so the conversation
    // reappears in the "All" view immediately.
    if (status === 'ACTIVE') {
      updateData.snooze = new Date(0);
    }

    // Track when a conversation enters the unassigned queue.
    if (status === 'UNASSIGNED') {
      updateData.queued_at = now;
      updateData.user_id = null;
      updateData.is_assigned = 0;
    }

    // Record who closed it and when.
    if (status === 'COMPLETED') {
      updateData.closed_at = now;
      if (userId) updateData.closed_by = userId;
    }

    const updated = await this.prisma.inbox.update({
      where: { id: inboxId, workspace_id: workspaceId },
      data: updateData,
    });

    // When a conversation is marked done, fire the trigger event so any
    // `conversation_marked_as_done` automation activities can dispatch.
    if (status === 'COMPLETED') {
      const contactId = await this.resolveInboxContact(updated);
      if (contactId) {
        this.eventEmitter.emit('conversation.marked_as_done', {
          contactId,
          workspaceId,
          inboxId: updated.id,
        });
      }
    }

    return updated;
  }

  /** List conversation folders for a workspace (does NOT create — mirrors replyagent's getSettings folders). */
  async listFolders(workspaceId: bigint) {
    return this.prisma.inbox_folders.findMany({
      where: { workspace_id: workspaceId },
      orderBy: { id: 'asc' },
    });
  }

  async createFolder(
    workspaceId: bigint,
    data: { name: string; assign_to?: string | null; assigned_to?: bigint | null },
  ) {
    return this.prisma.inbox_folders.create({
      data: {
        workspace_id: workspaceId,
        name: (data.name || '').slice(0, 30),
        assign_to: data.assign_to ?? null,
        assigned_to: data.assigned_to ?? null,
      },
    });
  }

  async updateFolder(
    workspaceId: bigint,
    id: bigint,
    data: { name?: string; assign_to?: string | null; assigned_to?: bigint | null },
  ) {
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = (data.name || '').slice(0, 30);
    if (data.assign_to !== undefined) updateData.assign_to = data.assign_to ?? null;
    if (data.assigned_to !== undefined) updateData.assigned_to = data.assigned_to ?? null;
    // scoped by workspace so a tenant can't edit another workspace's folder
    return this.prisma.inbox_folders.updateMany({
      where: { id, workspace_id: workspaceId },
      data: updateData,
    });
  }

  async deleteFolder(workspaceId: bigint, id: bigint) {
    // detach conversations from the folder first so we don't orphan a folder_id
    await this.prisma.inbox.updateMany({
      where: { folder_id: id, workspace_id: workspaceId },
      data: { folder_id: null },
    });
    return this.prisma.inbox_folders.deleteMany({
      where: { id, workspace_id: workspaceId },
    });
  }

  async moveToFolder(
    inboxIds: bigint[],
    folderId: bigint | null,
    workspaceId: bigint,
  ) {
    return this.prisma.inbox.updateMany({
      where: { id: { in: inboxIds }, workspace_id: workspaceId },
      data: { folder_id: folderId },
    });
  }

  /**
   * Handle incoming messages from external providers (Webhooks)
   */
  async handleInboundMessage(provider: string, data: any) {
    this.logger.log(`Handling inbound message from ${provider}`);
    
    // This is a simplified logic. In production, you'd map provider-specific IDs.
    const { from, text, workspace_id, chat_id, modelable_type } = data;
    const workspaceId = BigInt(workspace_id || 1);
    const mId = BigInt(chat_id);
    const mType = modelable_type; // e.g. 'App\\Models\\WhatsappChat'

    // 1. Find or Update Inbox
    let inbox = await this.prisma.inbox.findFirst({
      where: { 
        workspace_id: workspaceId,
        modelable_id: mId,
        modelable_type: mType
      }
    });

    if (!inbox) {
      inbox = await this.prisma.inbox.create({
        data: {
          workspace_id: workspaceId,
          modelable_id: mId,
          modelable_type: mType,
          status: 'UNASSIGNED',
          last_updated: new Date(),
        }
      });
    } else {
      await this.prisma.inbox.update({
        where: { id: inbox.id },
        data: {
          updated_at: new Date(),
          last_updated: new Date(),
          status: inbox.status === 'COMPLETED' ? 'ACTIVE' : inbox.status,
        }
      });
    }

    // 2. Save Message to specific table
    if (provider === 'whatsapp') {
      await this.prisma.wa_messages.create({
        data: {
          wa_chat_id: mId,
          wa_number_id: BigInt(data.wa_number_id || 0),
          text: text,
          direction: 'INCOMING',
          type: 'text',
          mobile_number: from,
          status: 'received',
        }
      });
    } else if (provider === 'telegram') {
      await this.prisma.telegram_messages.create({
        data: {
          telegram_chat_id: mId,
          text: text,
          direction: 'INCOMING',
          type: 'text',
          message_id: data.message_id || `in_${Date.now()}`,
          message_number: BigInt(Date.now()),
          seen: false,
          status: 'RECEIVED',
        }
      });
    }

    // Real-time emission
    this.chatGateway.emitToWorkspace(workspaceId, 'new_message', {
      inbox_id: inbox.id.toString(),
      provider,
      data,
    });

    // Fire the domain event that AutomationTriggerService listens to. Any
    // automation whose trigger activity event is 'inbound_message' (optionally
    // narrowed by channel) will run.
    this.eventEmitter.emit('message.inbound', {
      workspaceId,
      inboxId: inbox.id,
      contactId: data.contact_id ? BigInt(data.contact_id) : undefined,
      channel: provider,
    });

    return { success: true, inbox_id: inbox.id };
  }

  /**
   * Used after a per-provider webhook parser has already persisted the channel
   * message rows (wa_messages, telegram_messages, etc.). Upserts the inbox row,
   * fires the realtime socket event, and emits the domain automation trigger.
   * Callers: WebhooksInboundController for parsed providers (currently WhatsApp).
   */
  async notifyInboundMessage(params: {
    workspaceId: bigint;
    modelableType: string; // e.g. 'App\\Models\\WhatsappChat'
    modelableId: bigint;   // chat row id
    contactId?: bigint;
    channel: string;       // 'whatsapp' | 'telegram' | ...
    messageId?: bigint;
  }) {
    let inbox = await this.prisma.inbox.findFirst({
      where: {
        workspace_id: params.workspaceId,
        modelable_id: params.modelableId,
        modelable_type: params.modelableType,
      },
    });
    if (!inbox) {
      inbox = await this.prisma.inbox.create({
        data: {
          workspace_id: params.workspaceId,
          modelable_id: params.modelableId,
          modelable_type: params.modelableType,
          status: 'UNASSIGNED',
          last_updated: new Date(),
        },
      });
    } else {
      await this.prisma.inbox.update({
        where: { id: inbox.id },
        data: {
          updated_at: new Date(),
          last_updated: new Date(),
          status: inbox.status === 'COMPLETED' ? 'ACTIVE' : inbox.status,
        },
      });
    }

    this.chatGateway.emitToWorkspace(params.workspaceId, 'new_message', {
      inbox_id: inbox.id.toString(),
      provider: params.channel,
      message_id: params.messageId?.toString(),
    });

    this.eventEmitter.emit('message.inbound', {
      workspaceId: params.workspaceId,
      inboxId: inbox.id,
      contactId: params.contactId,
      channel: params.channel,
    });

    return { success: true, inbox_id: inbox.id };
  }

  // ─── Read receipts ────────────────────────────────────────────────

  /**
   * Mark a conversation as read (`inbox.is_read = 1`). Mirrors replyagent's
   * `POST /inbox/seen/{inbox_id}`. Sends a socket event so other open tabs of
   * the same workspace can also clear their unread badge without a refetch.
   */
  async markAsSeen(inboxId: bigint, workspaceId: bigint) {
    const inbox = await this.prisma.inbox.findFirst({
      where: { id: inboxId, workspace_id: workspaceId },
    });
    if (!inbox) throw new NotFoundException('Inbox not found');
    if (inbox.is_read === 1) return { success: true, already_read: true };
    await this.prisma.inbox.update({
      where: { id: inboxId },
      data: { is_read: 1 },
    });
    this.chatGateway.emitToWorkspace(workspaceId, 'inbox_read', {
      inbox_id: inboxId.toString(),
    });
    return { success: true };
  }

  // ─── Reactions ────────────────────────────────────────────────────

  /**
   * Add / remove a reaction on a message. Uses the existing `message_reactions`
   * table (polymorphic: `message_type` + `message_id`). Replyagent's behaviour:
   * sending the same emoji clears it; a different emoji replaces it.
   */
  async reactToMessage(
    inboxId: bigint,
    messageId: bigint,
    workspaceId: bigint,
    userId: bigint,
    body: any,
  ) {
    const inbox = await this.prisma.inbox.findFirst({
      where: { id: inboxId, workspace_id: workspaceId },
    });
    if (!inbox) throw new NotFoundException('Inbox not found');

    const messageType = body?.message_type || this.messageTypeFor(inbox.modelable_type ?? '');
    const reaction = (body?.reaction || '').toString().slice(0, 24) || null;

    const existing = await this.prisma.message_reactions.findFirst({
      where: {
        message_type: messageType,
        message_id: messageId,
        sender_id: userId,
      },
    });

    const isInstagram = (inbox.modelable_type ?? '').toLowerCase().includes('insta');
    let result: any;
    let igOp: 'add' | 'remove' | null = null;
    let igEmoji: string | null = null;

    if (existing) {
      if (!reaction || existing.reaction === reaction) {
        await this.prisma.message_reactions.delete({ where: { id: existing.id } });
        result = { success: true, action: 'removed' };
        igOp = 'remove';
        igEmoji = existing.reaction;
      } else {
        const updated = await this.prisma.message_reactions.update({
          where: { id: existing.id },
          data: { reaction, updated_at: new Date() },
        });
        result = { success: true, action: 'updated', reaction: updated };
        igOp = 'add';
        igEmoji = reaction;
      }
    } else {
      if (!reaction) return { success: true, action: 'noop' };
      const created = await this.prisma.message_reactions.create({
        data: {
          workspace_id: workspaceId,
          sender_id: userId,
          message_type: messageType,
          message_id: messageId,
          reaction,
          direction: 'OUTGOING',
          communication_mode: 'INBOX',
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
      result = { success: true, action: 'added', reaction: created };
      igOp = 'add';
      igEmoji = reaction;
    }

    // Push reaction to Instagram Platform API (fire-and-forget)
    if (isInstagram && igOp && igEmoji) {
      this.pushInstagramReaction(inbox.modelable_id, messageId, igOp, igEmoji).catch((e: any) =>
        this.logger.warn(`[IG REACTION] push failed: ${e?.message ?? e}`),
      );
    }

    // Push reaction to WhatsApp Cloud API (fire-and-forget)
    const isWhatsApp = (inbox.modelable_type ?? '').toLowerCase().includes('whatsappchat');
    if (isWhatsApp && igOp && igEmoji) {
      this.pushWhatsAppReaction(inbox.modelable_id, messageId, igOp, igEmoji).catch((e: any) =>
        this.logger.warn(`[WA REACTION] push failed: ${e?.message ?? e}`),
      );
    }

    return result;
  }

  /** Map a raw emoji to Instagram's reaction name (matches webhook reaction field). */
  /** Map emoji to Instagram reaction payload fields.
   *  Standard reactions use the named type; everything else uses type="other" + emoji field
   *  (mirrors how Instagram's own webhooks report custom emoji reactions). */
  private emojiToIgReactionPayload(emoji: string): Record<string, string> {
    const standard: Record<string, string> = {
      '❤️': 'love', '❤': 'love', '😍': 'love', '🥰': 'love', '😘': 'love',
      '💕': 'love', '💖': 'love', '💗': 'love', '💓': 'love', '💞': 'love',
      '🧡': 'love', '💛': 'love', '💚': 'love', '💙': 'love', '💜': 'love',
      '😂': 'haha', '🤣': 'haha', '😆': 'haha', '😹': 'haha', '😁': 'haha',
      '😄': 'haha', '😃': 'haha', '😀': 'haha', '😅': 'haha', '🤭': 'haha',
      '😮': 'wow', '😲': 'wow', '😯': 'wow', '🤯': 'wow', '😱': 'wow',
      '🫢': 'wow', '🫣': 'wow', '😳': 'wow', '🥴': 'wow', '🤩': 'wow',
      '😢': 'sad', '😭': 'sad', '😔': 'sad', '😟': 'sad', '🙁': 'sad',
      '😞': 'sad', '😣': 'sad', '😩': 'sad', '😫': 'sad', '🥺': 'sad',
      '😠': 'angry', '😡': 'angry', '🤬': 'angry', '😤': 'angry', '👿': 'angry',
    };
    const named = standard[emoji];
    if (named) return { reaction: named };
    // For any other emoji, use Instagram's "other" type with the actual emoji character
    // (same format Instagram uses in its own reaction webhooks)
    return { reaction: 'other', emoji };
  }

  /** Forward agent reaction to Instagram via Graph API using sender_action format. */
  private async pushInstagramReaction(
    chatId: bigint,
    messageId: bigint,
    op: 'add' | 'remove',
    emoji: string,
  ): Promise<void> {
    const chat = await this.prisma.insta_chats.findUnique({ where: { id: chatId } });
    if (!chat) return;
    const page = await this.prisma.insta_pages.findUnique({ where: { id: chat.insta_page_id } });
    if (!page?.access_token || !page.ig_user_id) return;
    const msg = await this.prisma.insta_messages.findUnique({ where: { id: messageId } });
    if (!msg?.mid) {
      this.logger.warn(`[IG REACTION] no mid for insta_message ${messageId} — reaction not sent`);
      return;
    }
    const igVer = this.config.get<string>('META_GRAPH_API_VERSION') ?? 'v22.0';
    const apiBase = (page.platform ?? 'facebook') === 'facebook'
      ? 'https://graph.facebook.com'
      : 'https://graph.instagram.com';

    // Instagram Messaging API uses sender_action format (not message.reaction)
    const body: any = {
      recipient: { id: chat.sender_id },
      sender_action: op === 'remove' ? 'unreact' : 'react',
    };
    if (op !== 'remove') {
      body.payload = { message_id: msg.mid, ...this.emojiToIgReactionPayload(emoji) };
    } else {
      body.payload = { message_id: msg.mid };
    }

    this.logger.log(`[IG REACTION] sending: ${JSON.stringify(body)}`);

    const res = await fetch(`${apiBase}/${igVer}/me/messages?access_token=${encodeURIComponent(page.access_token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(JSON.stringify(err));
    }
    this.logger.log(`[IG REACTION] ${op} ${emoji} → ok`);
  }

  /** Forward agent reaction to WhatsApp Cloud API. */
  private async pushWhatsAppReaction(
    chatId: bigint,
    messageId: bigint,
    op: 'add' | 'remove',
    emoji: string,
  ): Promise<void> {
    const chat = await this.prisma.wa_chats.findUnique({ where: { id: chatId } });
    if (!chat) return;
    const account = await this.prisma.wa_accounts.findUnique({ where: { id: chat.wa_account_id } });
    if (!account?.access_token) return;
    const phone = await this.prisma.wa_phone_numbers.findFirst({ where: { wa_account_id: account.id } });
    if (!phone?.wa_number_id) return;
    const msg = await this.prisma.wa_messages.findUnique({ where: { id: messageId } });
    if (!msg?.wamid) {
      this.logger.warn(`[WA REACTION] no wamid for wa_message ${messageId} — reaction not sent`);
      return;
    }
    const version = this.config.get<string>('META_GRAPH_API_VERSION') ?? 'v22.0';
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: chat.wa_id,
      type: 'reaction',
      reaction: { message_id: msg.wamid, emoji: op === 'remove' ? '' : emoji },
    };
    const res = await fetch(`https://graph.facebook.com/${version}/${phone.wa_number_id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.access_token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message ?? `HTTP ${res.status}`);
    }
    this.logger.log(`[WA REACTION] ${op} ${emoji} on wamid ${msg.wamid} → ${chat.wa_id}`);
  }

  // ─── Reminders (24h-window WhatsApp + Telegram + Z-API) ────────────

  /**
   * Schedule a reminder by writing `remind_at` on a brand-new outbound message
   * row. The existing message cron sweep picks it up when `remind_at <= NOW()`
   * and dispatches via the regular send path. We use the channel-specific
   * message table so the reminder shows up in the chat thread just like a
   * normal message would — no separate reminders table required.
   */
  async scheduleReminder(workspaceId: bigint, userId: bigint, body: any) {
    if (!body?.inbox_id) throw new BadRequestException('inbox_id required');
    if (!body?.schedule_at) throw new BadRequestException('schedule_at required');

    const inbox = await this.prisma.inbox.findFirst({
      where: { id: BigInt(body.inbox_id), workspace_id: workspaceId },
    });
    if (!inbox) throw new NotFoundException('Inbox not found');

    const channel = String(inbox.modelable_type || '').toLowerCase();
    const allowedChannels = ['whatsapp', 'zapi', 'telegram'];
    const channelKey = allowedChannels.find((c) => channel.includes(c));
    if (!channelKey) {
      throw new BadRequestException(
        'Reminders are only available for WhatsApp, Z-API, and Telegram channels.',
      );
    }

    const remindAt = new Date(body.schedule_at);
    if (isNaN(remindAt.getTime()) || remindAt.getTime() <= Date.now()) {
      throw new BadRequestException('schedule_at must be a future timestamp');
    }

    const text = String(body.text_message || '').trim();
    if (!text && !body.template_id) {
      throw new BadRequestException('text_message or template_id required');
    }

    let messageRow: any = null;
    if (channelKey === 'whatsapp') {
      messageRow = await this.prisma.wa_messages.create({
        data: {
          wa_chat_id: inbox.modelable_id,
          wa_number_id: BigInt(0),
          sender_id: userId,
          text,
          direction: 'OUTGOING',
          type: body.template_id ? 'template' : 'text',
          mobile_number: '',
          status: 'pending',
          remind_at: remindAt,
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    } else if (channelKey === 'telegram') {
      messageRow = await this.prisma.telegram_messages.create({
        data: {
          telegram_chat_id: inbox.modelable_id,
          sender_id: userId,
          text,
          direction: 'OUTGOING',
          type: 'text',
          message_id: `rem_${Date.now()}`,
          message_number: BigInt(Date.now()),
          seen: false,
          status: 'PENDING',
          remind_at: remindAt,
        } as any,
      });
    } else if (channelKey === 'zapi') {
      messageRow = await (this.prisma as any).zapi_messages.create({
        data: {
          zapi_chat_id: inbox.modelable_id,
          sender_id: userId,
          text,
          direction: 'OUTGOING',
          type: 'text',
          status: 'pending',
          remind_at: remindAt,
        },
      });
    }

    return {
      success: true,
      message_id: messageRow?.id?.toString(),
      channel: channelKey,
      remind_at: remindAt,
    };
  }

  /** Move a scheduled reminder's `remind_at` to NOW so the cron picks it up immediately. */
  async sendReminderNow(workspaceId: bigint, body: any) {
    if (!body?.message_id || !body?.channel) {
      throw new BadRequestException('message_id and channel are required');
    }
    const channel = String(body.channel).toLowerCase();
    const id = BigInt(body.message_id);
    if (channel === 'whatsapp') {
      await this.prisma.wa_messages.update({
        where: { id },
        data: { remind_at: new Date() },
      });
    } else if (channel === 'telegram') {
      await this.prisma.telegram_messages.update({
        where: { id },
        data: { remind_at: new Date() } as any,
      });
    } else if (channel === 'zapi') {
      await (this.prisma as any).zapi_messages.update({
        where: { id },
        data: { remind_at: new Date() },
      });
    } else {
      throw new BadRequestException('Unsupported channel');
    }
    return { success: true };
  }

  /** Cancel a scheduled reminder by deleting the pending message row. */
  async cancelReminder(workspaceId: bigint, body: any) {
    if (!body?.message_id || !body?.channel) {
      throw new BadRequestException('message_id and channel are required');
    }
    const channel = String(body.channel).toLowerCase();
    const id = BigInt(body.message_id);
    if (channel === 'whatsapp') {
      await this.prisma.wa_messages.deleteMany({
        where: { id, status: 'pending' },
      });
    } else if (channel === 'telegram') {
      await this.prisma.telegram_messages.deleteMany({
        where: { id, status: 'PENDING' } as any,
      });
    } else if (channel === 'zapi') {
      await (this.prisma as any).zapi_messages.deleteMany({
        where: { id, status: 'pending' },
      });
    } else {
      throw new BadRequestException('Unsupported channel');
    }
    return { success: true };
  }

  // ─── Automate / start-chat / AI ────────────────────────────────────

  /**
   * Trigger an automation/Smart Flow against the conversation's contact. The
   * AutomationProcessor is the source of truth — we just dispatch an event the
   * processor listens for. Mirrors replyagent's `POST /inbox/automate`.
   */
  async automate(workspaceId: bigint, userId: bigint, body: any) {
    if (!body?.inbox_id || !body?.automation_id) {
      throw new BadRequestException('inbox_id and automation_id required');
    }
    const inbox = await this.prisma.inbox.findFirst({
      where: { id: BigInt(body.inbox_id), workspace_id: workspaceId },
    });
    if (!inbox) throw new NotFoundException('Inbox not found');
    const contactId = await this.resolveInboxContact(inbox);
    if (!contactId) throw new BadRequestException('Inbox has no resolvable contact');
    this.eventEmitter.emit('automation.manual_trigger', {
      workspaceId,
      userId,
      contactId,
      automationId: BigInt(body.automation_id),
      inboxId: inbox.id,
    });
    return { success: true };
  }

  /**
   * Open (or reuse) a WhatsApp conversation with a contact. Creates the
   * `wa_chats` row if missing, then upserts the inbox row so the new chat
   * shows up in the agent's list immediately.
   */
  async startWhatsappChat(workspaceId: bigint, userId: bigint, body: any) {
    if (!body?.contact_id) throw new BadRequestException('contact_id required');
    if (!body?.wa_number_id) {
      throw new BadRequestException('wa_number_id required');
    }
    const contactId = BigInt(body.contact_id);
    const waNumberId = BigInt(body.wa_number_id);
    // The /all-channels picker only carries the number id, so derive the account
    // from the number when the caller didn't pass wa_account_id explicitly.
    let waAccountId: bigint;
    if (body?.wa_account_id) {
      waAccountId = BigInt(body.wa_account_id);
    } else {
      const num = await this.prisma.wa_phone_numbers.findFirst({
        where: { id: waNumberId },
        select: { wa_account_id: true },
      });
      if (!num?.wa_account_id) throw new BadRequestException('Invalid wa_number_id');
      waAccountId = num.wa_account_id;
    }

    const mobile = await this.prisma.contact_mobiles.findFirst({
      where: {
        modelable_type: 'App\\Models\\Contact',
        modelable_id: contactId,
      },
      orderBy: [{ is_primary: 'desc' }],
    });
    const rawMobile = String(mobile?.full_mobile_number ?? mobile?.mobile_number ?? '').trim();
    const digits = rawMobile.replace(/[^0-9]/g, '');
    if (!digits) throw new BadRequestException('Contact has no phone number');
    // Inbound (onInboundMessage) stores wa_id WITH a leading "+". The old lookup
    // used digits-only, so it never matched the existing chat and created a
    // duplicate empty conversation. Match BOTH forms and create in the "+" form.
    const waIdPlus = `+${digits}`;

    let chat = await this.prisma.wa_chats.findFirst({
      where: {
        wa_account_id: waAccountId,
        wa_number_id: waNumberId,
        wa_id: { in: [waIdPlus, digits] },
      },
    });
    if (!chat) {
      chat = await this.prisma.wa_chats.create({
        data: {
          wa_account_id: waAccountId,
          wa_number_id: waNumberId,
          contact_id: contactId,
          user_id: userId,
          wa_id: waIdPlus,
          created_at: new Date(),
          updated_at: new Date(),
        } as any,
      });
    }

    // Look up by (type + chat id) — NOT by modelable_type. The old code used the
    // WRONG morph string ('App\Models\WhatsappChat'); inbound uses
    // 'App\Models\Whatsapp\WhatsappChat', so the lookup never matched the real
    // inbox and a duplicate empty conversation was created. type='WHATSAPP' +
    // modelable_id already identifies the row uniquely.
    let inbox = await this.prisma.inbox.findFirst({
      where: {
        workspace_id: workspaceId,
        type: 'WHATSAPP',
        modelable_id: chat.id,
      },
    });
    if (!inbox) {
      inbox = await this.prisma.inbox.create({
        data: {
          workspace_id: workspaceId,
          user_id: userId,
          type: 'WHATSAPP',
          status: 'ACTIVE',
          is_assigned: 1,
          assigned_by: userId,
          assigned_on: new Date(),
          snooze: new Date(0),
          // Correct morph string — matches whatsapp-events.consumer so the inbox
          // list renders this conversation the same as an inbound one.
          modelable_type: 'App\\Models\\Whatsapp\\WhatsappChat',
          modelable_id: chat.id,
          last_updated: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        } as any,
      });
    }
    return { success: true, inbox_id: inbox.id.toString(), chat_id: chat.id.toString() };
  }

  /**
   * Open a Z-API (unofficial WhatsApp QR) conversation. Same shape as
   * startWhatsappChat — different table set (zapi_chats).
   */
  async startZapiChat(workspaceId: bigint, userId: bigint, body: any) {
    if (!body?.contact_id || !body?.zapi_account_id) {
      throw new BadRequestException('contact_id and zapi_account_id required');
    }
    const contactId = BigInt(body.contact_id);
    const zapiAccountId = BigInt(body.zapi_account_id);

    const mobile = await this.prisma.contact_mobiles.findFirst({
      where: {
        modelable_type: 'App\\Models\\Contact',
        modelable_id: contactId,
      },
      orderBy: [{ is_primary: 'desc' }],
    });
    const phone = String(mobile?.full_mobile_number ?? '').replace(/[^0-9]/g, '');
    if (!phone) throw new BadRequestException('Contact has no phone number');

    let chat = await (this.prisma as any).zapi_chats.findFirst({
      where: { zapi_account_id: zapiAccountId, phone },
    });
    if (!chat) {
      chat = await (this.prisma as any).zapi_chats.create({
        data: {
          zapi_account_id: zapiAccountId,
          contact_id: contactId,
          phone,
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    }

    let inbox = await this.prisma.inbox.findFirst({
      where: {
        workspace_id: workspaceId,
        modelable_type: 'App\\Models\\ZapiChat',
        modelable_id: chat.id,
      },
    });
    if (!inbox) {
      inbox = await this.prisma.inbox.create({
        data: {
          workspace_id: workspaceId,
          user_id: userId,
          type: 'ZAPI',
          status: 'ACTIVE',
          is_assigned: 1,
          assigned_by: userId,
          assigned_on: new Date(),
          snooze: new Date(0),
          modelable_type: 'App\\Models\\ZapiChat',
          modelable_id: chat.id,
          last_updated: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        } as any,
      });
    }
    return { success: true, inbox_id: inbox.id.toString(), chat_id: chat.id.toString() };
  }

  /**
   * AI text transformer stub. Real replyagent calls an LLM with a system prompt
   * per `mode` (translate / correct / expand / shorten). We accept the same
   * envelope and return the input passthrough so the UI can wire end-to-end
   * even before the AI provider is bound; switching to a real call later only
   * touches this method.
   */
  async transformAi(workspaceId: bigint, body: any) {
    const text = String(body?.text ?? '').trim();
    const mode = String(body?.mode ?? 'correct').toLowerCase();
    if (!text) throw new BadRequestException('text required');

    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      // No key configured — return input unchanged so UI doesn't break
      return { success: true, mode, output: text };
    }

    const prompts: Record<string, string> = {
      correct: `Fix any grammar or spelling mistakes in the following message. Return only the corrected text, nothing else:\n\n${text}`,
      expand: `Expand the following message to make it more detailed and informative. Return only the expanded text:\n\n${text}`,
      shorten: `Make the following message shorter and more concise. Return only the shortened text:\n\n${text}`,
      translate: `Translate the following message to English. If it is already in English, translate it to Spanish. Return only the translated text:\n\n${text}`,
    };

    const prompt = prompts[mode] ?? prompts.correct;
    const openai = new OpenAI({ apiKey });
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
      temperature: 0.3,
    });

    const output = response.choices[0]?.message?.content?.trim() ?? text;
    return { success: true, mode, output };
  }

  // ─── Destructive ───────────────────────────────────────────────────

  /** Soft-delete (status=DELETED) a single inbox row. */
  async deleteInbox(inboxId: bigint, workspaceId: bigint) {
    const inbox = await this.prisma.inbox.findFirst({
      where: { id: inboxId, workspace_id: workspaceId },
    });
    if (!inbox) throw new NotFoundException('Inbox not found');
    await this.prisma.inbox.update({
      where: { id: inboxId },
      data: { status: 'DELETED' },
    });
    return { success: true };
  }

  /** Bulk soft-delete inbox rows (replyagent's `DELETE /inbox/chats`). */
  async deleteChats(workspaceId: bigint, inboxIds: bigint[]) {
    if (!inboxIds.length) return { success: true, count: 0 };
    const res = await this.prisma.inbox.updateMany({
      where: { id: { in: inboxIds }, workspace_id: workspaceId },
      data: { status: 'DELETED' },
    });
    return { success: true, count: res.count };
  }

  /**
   * Hard-delete a single message from the appropriate channel table. Replyagent
   * `POST /inbox/message/delete` accepts {message_id, message_type, channel}.
   */
  async deleteMessage(workspaceId: bigint, body: any) {
    if (!body?.message_id || !body?.channel) {
      throw new BadRequestException('message_id and channel required');
    }
    const id = BigInt(body.message_id);
    const channel = String(body.channel).toLowerCase();
    if (channel === 'whatsapp') {
      await this.prisma.wa_messages.deleteMany({ where: { id } });
    } else if (channel === 'telegram') {
      await this.prisma.telegram_messages.deleteMany({ where: { id } });
    } else if (channel === 'zapi') {
      await (this.prisma as any).zapi_messages.deleteMany({ where: { id } });
    } else if (channel === 'messenger' || channel === 'fb') {
      await this.prisma.fb_messages.deleteMany({ where: { id } });
    } else if (channel === 'instagram' || channel === 'insta') {
      await this.prisma.insta_messages.deleteMany({ where: { id } });
    } else if (channel === 'webchat') {
      await this.prisma.wc_messages.deleteMany({ where: { id } });
    } else {
      throw new BadRequestException('Unsupported channel');
    }
    return { success: true };
  }

  // ─── Profile action (tag / note / task from the inbox UI) ──────────

  /**
   * Generic profile-action endpoint mirroring replyagent's
   * `POST /inbox/profile-action/{inbox_id}`. The body's `action` field decides
   * what to do; we keep this purposefully thin so adding a new action type
   * (e.g. `archive_contact`) is a single switch case.
   */
  async profileAction(
    inboxId: bigint,
    workspaceId: bigint,
    userId: bigint,
    body: any,
  ) {
    const action = String(body?.action ?? '').toLowerCase();
    const inbox = await this.prisma.inbox.findFirst({
      where: { id: inboxId, workspace_id: workspaceId },
    });
    if (!inbox) throw new NotFoundException('Inbox not found');
    const contactId = await this.resolveInboxContact(inbox);

    switch (action) {
      case 'apply_tag': {
        if (!contactId) throw new BadRequestException('No contact');
        const tagName = String(body.tag ?? '').trim();
        if (!tagName) throw new BadRequestException('tag required');
        let tag = await this.prisma.tags.findFirst({
          where: { workspace_id: workspaceId, name: tagName },
        });
        if (!tag) {
          tag = await this.prisma.tags.create({
            data: {
              workspace_id: workspaceId,
              user_id: userId,
              taggable_type: 'App\\Models\\Workspace',
              taggable_id: workspaceId,
              name: tagName,
              display_inbox: 0,
              bg_color: '#d3c78d',
              text_color: '#c04d30',
            },
          });
        }
        const alreadyLinked = await this.prisma.tag_links.findFirst({
          where: { linkable_type: 'App\\Models\\Contact', linkable_id: contactId, tag_id: tag.id },
        });
        if (!alreadyLinked) {
          await this.prisma.tag_links.create({
            data: {
              linkable_type: 'App\\Models\\Contact',
              linkable_id: contactId,
              tag_id: tag.id,
              name: tag.name,
            },
          });
        }
        this.eventEmitter.emit('contact.tag_applied', {
          contactId,
          tagId: tag.id,
          workspaceId,
        });
        return { success: true, tag };
      }
      case 'remove_tag': {
        if (!contactId) throw new BadRequestException('No contact');
        const tagName = String(body.tag ?? '').trim();
        await this.prisma.tag_links.deleteMany({
          where: {
            linkable_type: 'App\\Models\\Contact',
            linkable_id: contactId,
            name: tagName,
          },
        });
        return { success: true };
      }
      case 'set_status': {
        const normalizedStatus = typeof body.status === 'string' ? body.status.toUpperCase() : body.status;
        return this.updateInboxStatus(inboxId, normalizedStatus, workspaceId);
      }
      case 'set_folder': {
        await this.prisma.inbox.update({
          where: { id: inboxId },
          data: { folder_id: body.folder_id ? BigInt(body.folder_id) : null },
        });
        return { success: true };
      }
      case 'pause_automation': {
        if (!contactId) throw new BadRequestException('No contact');
        const minutes = Math.max(1, Number(body.minutes ?? 15));
        const pausedTill = new Date(Date.now() + minutes * 60_000);
        await this.prisma.contacts.update({
          where: { id: contactId },
          data: { automations_paused_till: pausedTill },
        });
        return { success: true, paused_till: pausedTill.toISOString() };
      }
      case 'resume_automation': {
        if (!contactId) throw new BadRequestException('No contact');
        await this.prisma.contacts.update({
          where: { id: contactId },
          data: { automations_paused_till: null },
        });
        return { success: true };
      }
      default:
        throw new BadRequestException(`Unsupported action: ${action}`);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  /** Map an inbox's `modelable_type` to the message-table polymorphic key. */
  private messageTypeFor(modelableType: string): string {
    const t = modelableType.toLowerCase();
    if (t.includes('whatsapp')) return 'App\\Models\\Whatsapp\\WhatsappMessage';
    if (t.includes('telegram')) return 'App\\Models\\Telegram\\TelegramMessage';
    if (t.includes('zapi')) return 'App\\Models\\Zapi\\ZapiMessage';
    if (t.includes('messenger') || t.includes('fb')) return 'App\\Models\\Facebook\\FacebookMessage';
    if (t.includes('insta')) return 'App\\Models\\Instagram\\InstagramMessage';
    if (t.includes('webchat') || t.includes('wc')) return 'App\\Models\\Webchat\\WcMessage';
    return modelableType;
  }
}
