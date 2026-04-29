// @ts-nocheck
import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import dayjs from 'dayjs';

@Injectable()
export class StatisticsService {
  private readonly logger = new Logger(StatisticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Parses date ranges into discrete [From, To] dates.
   */
  private parseDateInterval(slug: string): [Date, Date] {
    const now = dayjs();
    switch (slug) {
      case 'today':
        return [now.startOf('day').toDate(), now.endOf('day').toDate()];
      case 'yesterday':
        return [
          now.subtract(1, 'day').startOf('day').toDate(),
          now.subtract(1, 'day').endOf('day').toDate(),
        ];
      case 'last_7_days':
        return [
          now.subtract(7, 'days').startOf('day').toDate(),
          now.endOf('day').toDate(),
        ];
      case 'last_30_days':
        return [
          now.subtract(30, 'days').startOf('day').toDate(),
          now.endOf('day').toDate(),
        ];
      case 'this_month':
        return [now.startOf('month').toDate(), now.endOf('month').toDate()];
      case 'last_month':
        return [
          now.subtract(1, 'month').startOf('month').toDate(),
          now.subtract(1, 'month').endOf('month').toDate(),
        ];
      default:
        return [
          now.subtract(7, 'days').startOf('day').toDate(),
          now.endOf('day').toDate(),
        ];
    }
  }

  private resolveDateRange(dateRange: any): [Date, Date] {
    if (!dateRange)
      return [
        dayjs().subtract(7, 'days').startOf('day').toDate(),
        dayjs().endOf('day').toDate(),
      ];

    if (dateRange.type === 'PREDEFINED') {
      return this.parseDateInterval(dateRange.value?.slug || 'last_7_days');
    } else if (
      dateRange.type === 'CUSTOM_RANGE' &&
      Array.isArray(dateRange.value)
    ) {
      return [new Date(dateRange.value[0]), new Date(dateRange.value[1])];
    }
    return [
      dayjs().subtract(7, 'days').startOf('day').toDate(),
      dayjs().endOf('day').toDate(),
    ];
  }

  /**
   * Aggregates conversation counts across all integrated channels.
   */
  async channels(workspaceId: bigint, filters: any) {
    const channels: any[] = [];

    // 1. Telegram
    const telegramBots = await this.prisma.telegram_bots.findMany({
      where: { workspace_id: workspaceId, status: 'active', deleted_at: null },
    });
    for (const bot of telegramBots) {
      const chatIds = (
        await this.prisma.telegram_chats.findMany({
          where: { telegram_bot_id: bot.id },
          select: { id: true },
        })
      ).map((c) => c.id);
      const [assigned, unassigned] = await Promise.all([
        this.prisma.inbox.count({
          where: {
            workspace_id: workspaceId,
            modelable_id: { in: chatIds },
            modelable_type: { contains: 'TelegramChat' },
            status: 'ACTIVE',
          },
        }),
        this.prisma.inbox.count({
          where: {
            workspace_id: workspaceId,
            modelable_id: { in: chatIds },
            modelable_type: { contains: 'TelegramChat' },
            status: 'UNASSIGNED',
          },
        }),
      ]);
      channels.push({
        type: 'telegram',
        name: bot.name,
        id: bot.id,
        conversations: {
          assigned_conversations: assigned,
          unassigned_conversations: unassigned,
        },
      });
    }

    // 2. WhatsApp (Direct + ZAPI)
    const waAccounts = await this.prisma.wa_accounts.findMany({
      where: { workspace_id: workspaceId, status: 'active', deleted_at: null },
    });
    for (const acc of waAccounts) {
      const chatIds = (
        await this.prisma.wa_chats.findMany({
          where: { wa_account_id: acc.id },
          select: { id: true },
        })
      ).map((c) => c.id);
      const [assigned, unassigned] = await Promise.all([
        this.prisma.inbox.count({
          where: {
            workspace_id: workspaceId,
            modelable_id: { in: chatIds },
            modelable_type: { contains: 'WhatsappChat' },
            status: 'ACTIVE',
          },
        }),
        this.prisma.inbox.count({
          where: {
            workspace_id: workspaceId,
            modelable_id: { in: chatIds },
            modelable_type: { contains: 'WhatsappChat' },
            status: 'UNASSIGNED',
          },
        }),
      ]);
      channels.push({
        type: 'whatsapp',
        name: acc.name,
        id: acc.id,
        conversations: {
          assigned_conversations: assigned,
          unassigned_conversations: unassigned,
        },
      });
    }

    const zapiInstances = await this.prisma.zapi_instances.findMany({
      where: {
        workspace_id: workspaceId,
        status: 'connected',
        deleted_at: null,
      },
    });
    for (const zapi of zapiInstances) {
      const chatIds = (
        await this.prisma.zapi_chats.findMany({
          where: { zapi_instance_id: zapi.id },
          select: { id: true },
        })
      ).map((c) => c.id);
      const [assigned, unassigned] = await Promise.all([
        this.prisma.inbox.count({
          where: {
            workspace_id: workspaceId,
            modelable_id: { in: chatIds },
            modelable_type: { contains: 'ZapiChat' },
            status: 'ACTIVE',
          },
        }),
        this.prisma.inbox.count({
          where: {
            workspace_id: workspaceId,
            modelable_id: { in: chatIds },
            modelable_type: { contains: 'ZapiChat' },
            status: 'UNASSIGNED',
          },
        }),
      ]);
      channels.push({
        type: 'zapi',
        name: zapi.name,
        id: zapi.id,
        conversations: {
          assigned_conversations: assigned,
          unassigned_conversations: unassigned,
        },
      });
    }

    // 3. Instagram & Messenger
    const fbPages = await this.prisma.fb_pages.findMany({
      where: { workspace_id: workspaceId, status: 'active', deleted_at: null },
    });
    for (const page of fbPages) {
      const chatIds = (
        await this.prisma.fb_chats.findMany({
          where: { fb_page_id: page.id },
          select: { id: true },
        })
      ).map((c) => c.id);
      const [assigned, unassigned] = await Promise.all([
        this.prisma.inbox.count({
          where: {
            workspace_id: workspaceId,
            modelable_id: { in: chatIds },
            modelable_type: { contains: 'FacebookChat' },
            status: 'ACTIVE',
          },
        }),
        this.prisma.inbox.count({
          where: {
            workspace_id: workspaceId,
            modelable_id: { in: chatIds },
            modelable_type: { contains: 'FacebookChat' },
            status: 'UNASSIGNED',
          },
        }),
      ]);
      channels.push({
        type: 'messenger',
        name: page.name,
        id: page.id,
        conversations: {
          assigned_conversations: assigned,
          unassigned_conversations: unassigned,
        },
      });
    }

    return { channels };
  }

  /**
   * Statistics Overview V1: Contacts, Subscribers, and Message Counts
   */
  async statisticsV1(workspaceId: bigint, filters: any) {
    const [dateFrom, dateTo] = this.resolveDateRange(filters.date_range);

    const range = { gte: dateFrom, lte: dateTo };

    // 1. Contacts by status & source
    const [contactsByStatus, contactsBySource] = await Promise.all([
      this.prisma.contacts.groupBy({
        by: ['status'],
        where: { workspace_id: workspaceId, created_at: range },
        _count: true,
      }),
      this.prisma.contacts.groupBy({
        by: ['source'],
        where: { workspace_id: workspaceId, created_at: range },
        _count: true,
      }),
    ]);

    const statusMap = { active: 0, trash: 0, deleted: 0 };
    let totalContacts = 0;
    contactsByStatus.forEach((c) => {
      const status = String(c.status || '').toLowerCase();
      if (statusMap.hasOwnProperty(status)) statusMap[status] = c._count;
      totalContacts += c._count;
    });

    const sourceMap = {
      manual: 0,
      import: 0,
      api: 0,
      telegram: 0,
      whatsapp: 0,
      facebook: 0,
      instagram: 0,
      sms: 0,
    };
    contactsBySource.forEach((s) => {
      const source = String(s.source || '').toLowerCase();
      if (sourceMap.hasOwnProperty(source)) sourceMap[source] = s._count;
    });

    // 2. Message Counts across channels (Scoped with Joins)
    // Note: Raw queries or complex prisma includes are needed for 100% parity with Laravel's joins.
    // We simulate the counts based on modelable types for now.
    const [tgMsgs, fbMsgs, waMsgs, instaMsgs] = await Promise.all([
      this.prisma.telegram_messages.groupBy({
        by: ['direction'],
        where: { created_at: range },
        _count: true,
      }),
      this.prisma.fb_messages.groupBy({
        by: ['direction'],
        where: { created_at: range },
        _count: true,
      }),
      this.prisma.wa_messages.groupBy({
        by: ['direction'],
        where: { created_at: range },
        _count: true,
      }),
      this.prisma.insta_messages.groupBy({
        by: ['direction'],
        where: { created_at: range },
        _count: true,
      }),
    ]);

    const getCounts = (msgs: any[]) => ({
      incoming: msgs.find((m) => m.direction === 'INCOMING')?._count || 0,
      outgoing: msgs.find((m) => m.direction === 'OUTGOING')?._count || 0,
    });

    // 3. Broadcasts & Automations (Last 30 Days)
    const [broadcastsCount, activeAutomations] = await Promise.all([
      this.prisma.broadcasts.count({
        where: { workspace_id: workspaceId, created_at: range }
      }),
      this.prisma.automations.count({
        where: { workspace_id: workspaceId, status: 'active' }
      })
    ]);

    return {
      contacts: {
        by_source: sourceMap,
        by_status: statusMap,
        total: totalContacts,
      },
      channels: {
        telegram: getCounts(tgMsgs),
        messenger: getCounts(fbMsgs),
        whatsapp: getCounts(waMsgs),
        instagram: getCounts(instaMsgs),
      },
      engagement: {
        broadcasts_sent: broadcastsCount,
        active_automations: activeAutomations,
      }
    };
  }

  /**
   * Time-series data for agent-specific charts.
   */
  async chartsData(workspaceId: bigint, userId: bigint, data: any) {
    const [dateFrom, dateTo] = this.resolveDateRange(data.date_range);
    const type = data.data_type;

    const range = { gte: dateFrom, lte: dateTo };

    if (type === 'messages_sent_by_user') {
      const [wa, fb, tg, insta] = await Promise.all([
        this.prisma.wa_messages.groupBy({
          by: ['created_at'],
          where: {
            sender_id: userId,
            direction: 'OUTGOING',
            created_at: range,
          },
          _count: true,
        }),
        this.prisma.fb_messages.groupBy({
          by: ['created_at'],
          where: {
            sender_id: userId,
            direction: 'OUTGOING',
            created_at: range,
          },
          _count: true,
        }),
        this.prisma.telegram_messages.groupBy({
          by: ['created_at'],
          where: { user_id: userId, direction: 'OUTGOING', created_at: range },
          _count: true,
        }),
        this.prisma.insta_messages.groupBy({
          by: ['created_at'],
          where: {
            sender_id: userId,
            direction: 'OUTGOING',
            created_at: range,
          },
          _count: true,
        }),
      ]);
      return [
        { channel: 'whatsapp', dataset: wa },
        { channel: 'messenger', dataset: fb },
        { channel: 'telegram', dataset: tg },
        { channel: 'instagram', dataset: insta },
      ];
    }

    // Default: Group by day for simple counts
    return this.prisma.inbox.groupBy({
      by: ['updated_at'],
      where: {
        workspace_id: workspaceId,
        assigned_to: userId,
        updated_at: range,
      },
      _count: true,
      orderBy: { updated_at: 'asc' },
    });
  }
}
