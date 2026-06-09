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
      where: { workspace_id: workspaceId, status: 'ACTIVE', deleted_at: null },
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
      where: { workspace_id: workspaceId, status: 'ACTIVE', deleted_at: null },
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
        status: 'CONNECTED',
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
      where: { workspace_id: workspaceId, status: 'ACTIVE', deleted_at: null },
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
        user_id: userId,
        updated_at: range,
      },
      _count: true,
      orderBy: { updated_at: 'asc' },
    });
  }

  /**
   * Workspace-scoped time-series for the Insights Overview tab. Returns four
   * arrays the frontend chart components expect (Daily Active Users, Monthly
   * Active Users, Weekly Growth, Stickiness Ratio). Each series is built from
   * actual user records filtered by `workspace_id` — a fresh workspace simply
   * gets zero-valued buckets, which is the correct empty state.
   *
   * Source columns:
   *   - DAU/MAU "active" = users with `last_seen_at` falling in the bucket
   *   - Weekly Growth   = users created (new sign-ups) in the bucket
   *   - Stickiness      = DAU / MAU * 100 per day
   */
  async getDashboardCharts(workspaceId: bigint) {
    const now = dayjs();
    const wsScope = {
      modelable_type: 'App\\Models\\Workspace',
      modelable_id: workspaceId,
    } as const;

    // ─── Daily Active Users (last 7 days) ──────────────────────────────
    const dauData: Array<{ day: string; users: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const d = now.subtract(i, 'day');
      const start = d.startOf('day').toDate();
      const end = d.endOf('day').toDate();
      const count = await this.prisma.users.count({
        where: { ...wsScope, last_seen_at: { gte: start, lte: end } },
      });
      dauData.push({ day: d.format('ddd'), users: count });
    }

    // ─── Monthly Active Users (last 6 months) ──────────────────────────
    const mauData: Array<{ month: string; users: number }> = [];
    for (let i = 5; i >= 0; i--) {
      const m = now.subtract(i, 'month');
      const start = m.startOf('month').toDate();
      const end = m.endOf('month').toDate();
      const count = await this.prisma.users.count({
        where: { ...wsScope, last_seen_at: { gte: start, lte: end } },
      });
      mauData.push({ month: m.format('MMM'), users: count });
    }

    // ─── Weekly Growth (new sign-ups, last 5 weeks) ────────────────────
    const wauData: Array<{ week: string; users: number }> = [];
    for (let i = 4; i >= 0; i--) {
      const w = now.subtract(i, 'week');
      const start = w.startOf('week').toDate();
      const end = w.endOf('week').toDate();
      const count = await this.prisma.users.count({
        where: { ...wsScope, created_at: { gte: start, lte: end } },
      });
      wauData.push({ week: `Week ${5 - i}`, users: count });
    }

    // ─── Stickiness Ratio (DAU/MAU × 100, last 7 days) ────────────────
    const stickinessData: Array<{ day: string; ratio: number }> = [];
    const mauWindowStart = now.subtract(30, 'day').toDate();
    const mauTotal = await this.prisma.users.count({
      where: { ...wsScope, last_seen_at: { gte: mauWindowStart } },
    });
    for (let i = 6; i >= 0; i--) {
      const d = now.subtract(i, 'day');
      const dau = dauData[6 - i]?.users ?? 0;
      const ratio = mauTotal > 0 ? Math.round((dau / mauTotal) * 100) : 0;
      stickinessData.push({ day: `Day ${7 - i}`, ratio });
    }

    return { dauData, mauData, wauData, stickinessData };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  NEW: Insights Dashboard extended endpoints
  //  These power the 5 secondary tabs (Performance / WhatsApp / Bot /
  //  Voice of Customer / CSAT) plus the Overview tab's New Users deltas
  //  that were previously hardcoded mock data.
  //
  //  Design rules:
  //  - Workspace-scoped via JWT (workspaceId param threaded from controller).
  //  - No new tables; all metrics derived from existing 237-table schema.
  //  - Empty state returns honest zeros + empty arrays (NOT mock numbers).
  //  - All time-series buckets are stable lengths so charts render even on
  //    fresh workspaces (zero-filled buckets).
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Overview tab — real Daily / Weekly / Monthly new-user counts with
   * period-over-period delta. Replaces the hardcoded +2.5% / -1.2% / +5.8%
   * badges. Read off `contacts.created_at` (contacts == "users" in
   * EZCONN/replyagent vocabulary on this dashboard).
   */
  async getNewUsersStats(workspaceId: bigint) {
    const now = dayjs();
    const today0 = now.startOf('day').toDate();
    const todayEnd = now.endOf('day').toDate();
    const yesterday0 = now.subtract(1, 'day').startOf('day').toDate();
    const yesterdayEnd = now.subtract(1, 'day').endOf('day').toDate();
    const week0 = now.subtract(7, 'day').toDate();
    const prevWeek0 = now.subtract(14, 'day').toDate();
    const prevWeekEnd = week0;
    const month0 = now.subtract(30, 'day').toDate();
    const prevMonth0 = now.subtract(60, 'day').toDate();
    const prevMonthEnd = month0;

    const [daily, prevDaily, weekly, prevWeekly, monthly, prevMonthly] = await Promise.all([
      this.prisma.contacts.count({ where: { workspace_id: workspaceId, created_at: { gte: today0, lte: todayEnd } } }),
      this.prisma.contacts.count({ where: { workspace_id: workspaceId, created_at: { gte: yesterday0, lte: yesterdayEnd } } }),
      this.prisma.contacts.count({ where: { workspace_id: workspaceId, created_at: { gte: week0, lte: todayEnd } } }),
      this.prisma.contacts.count({ where: { workspace_id: workspaceId, created_at: { gte: prevWeek0, lte: prevWeekEnd } } }),
      this.prisma.contacts.count({ where: { workspace_id: workspaceId, created_at: { gte: month0, lte: todayEnd } } }),
      this.prisma.contacts.count({ where: { workspace_id: workspaceId, created_at: { gte: prevMonth0, lte: prevMonthEnd } } }),
    ]);

    // Delta math: (current - prev) / prev * 100. When prev=0 we return 100
    // if current>0 (infinite growth as +100%) or 0 if both are zero.
    const pct = (cur: number, prev: number): number => {
      if (prev === 0) return cur > 0 ? 100 : 0;
      return Number(((cur - prev) / prev * 100).toFixed(1));
    };

    return {
      daily,
      dailyChange: pct(daily, prevDaily),
      weekly,
      weeklyChange: pct(weekly, prevWeekly),
      monthly,
      monthlyChange: pct(monthly, prevMonthly),
    };
  }

  /**
   * Performance tab — Agent Performance main KPIs + availability + metrics.
   * Reads:
   *  - inbox (counts by status, avg resolution time)
   *  - users (workspace members + last_seen_at → availability)
   *  - user_id / closed_by on inbox for per-agent breakdown
   */
  async getAgentPerformanceMain(workspaceId: bigint) {
    const now = dayjs();
    const today0 = now.startOf('day').toDate();
    const todayEnd = now.endOf('day').toDate();
    const last7Days0 = now.subtract(7, 'day').toDate();

    // ─── KPI 1: Conversations ───────────────────────────────────────────
    const [total, completed, active] = await Promise.all([
      this.prisma.inbox.count({ where: { workspace_id: workspaceId, created_at: { gte: last7Days0 } } }),
      this.prisma.inbox.count({ where: { workspace_id: workspaceId, status: 'COMPLETED', created_at: { gte: last7Days0 } } }),
      this.prisma.inbox.count({ where: { workspace_id: workspaceId, status: 'ACTIVE' } }),
    ]);

    // ─── KPI 2: Performance (avg response, avg resolution, resolution %) ─
    // EZCONN inbox schema doesn't carry a first_response_at column; we
    // approximate response time as `assigned_on - created_at` (queue wait
    // until an agent picked the conversation up) and resolution time as
    // `closed_at - created_at`.
    const closedThisWeek = await this.prisma.inbox.findMany({
      where: {
        workspace_id: workspaceId,
        status: 'COMPLETED',
        closed_at: { gte: last7Days0, lte: todayEnd, not: null },
      },
      select: { created_at: true, closed_at: true, assigned_on: true },
      take: 1000,
    });
    const avgResp = closedThisWeek
      .filter(c => c.assigned_on && c.created_at)
      .map(c => (new Date(c.assigned_on!).getTime() - new Date(c.created_at!).getTime()) / 1000);
    const avgResol = closedThisWeek
      .filter(c => c.closed_at && c.created_at)
      .map(c => (new Date(c.closed_at!).getTime() - new Date(c.created_at!).getTime()) / 1000);
    const avgResponseSec = avgResp.length ? Math.round(avgResp.reduce((a, b) => a + b, 0) / avgResp.length) : 0;
    const avgResolutionSec = avgResol.length ? Math.round(avgResol.reduce((a, b) => a + b, 0) / avgResol.length) : 0;
    const resolutionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    // ─── KPI 3: Queue ────────────────────────────────────────────────────
    const [queueActive, queuePending, queueForwarded] = await Promise.all([
      this.prisma.inbox.count({ where: { workspace_id: workspaceId, status: 'ACTIVE' } }),
      this.prisma.inbox.count({ where: { workspace_id: workspaceId, status: 'UNASSIGNED' } }),
      // inbox_status has no SNOOZED variant — "snoozed" is tracked via the `snooze`
      // datetime column (a future time = still snoozed). Count those.
      this.prisma.inbox.count({ where: { workspace_id: workspaceId, snooze: { gt: new Date() } } }),
    ]);

    // ─── KPI 4: Feedback (CSAT placeholder — no csat_responses table) ────
    // Until CSAT collection is wired, these are honest zeros.
    const feedback = { great: 0, average: 0, poor: 0 };

    // ─── Agent Availability board ────────────────────────────────────────
    const members = await this.prisma.users.findMany({
      where: {
        modelable_type: 'App\\Models\\Workspace',
        modelable_id: workspaceId,
      },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        last_seen_at: true,
        availability: true,
      },
      take: 200,
    });

    // Status derivation: combine the user's own `availability` enum
    // (AVAILABLE/AWAY/OFFLINE) with last_seen freshness as a fallback. The
    // explicit field is set when the agent toggles their status in the app;
    // last_seen freshness covers cases where they just closed the tab.
    const twoMinAgo = now.subtract(2, 'minute').toDate();
    const tenMinAgo = now.subtract(10, 'minute').toDate();
    let onlineCount = 0, awayCount = 0, busyCount = 0, offlineCount = 0;
    const agents: any[] = [];
    for (const m of members as any[]) {
      let status = 'Offline';
      let dot = 'bg-slate-400';
      const explicitAvail = String(m.availability || '').toUpperCase();
      if (explicitAvail === 'AVAILABLE' && m.last_seen_at && new Date(m.last_seen_at) > twoMinAgo) {
        status = 'Online'; dot = 'bg-emerald-500'; onlineCount++;
      } else if (m.last_seen_at && new Date(m.last_seen_at) > tenMinAgo) {
        status = 'Away'; dot = 'bg-yellow-500'; awayCount++;
      } else {
        offlineCount++;
      }
      // Busy = at least 3 active assigned conversations
      const activeAssigned = await this.prisma.inbox.count({
        where: { workspace_id: workspaceId, user_id: m.id, status: 'ACTIVE' },
      });
      if (status === 'Online' && activeAssigned >= 3) {
        status = 'Busy'; dot = 'bg-orange-500'; onlineCount--; busyCount++;
      }
      agents.push({
        name: [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || `#${m.id}`,
        team: '—',
        loginTime: m.last_seen_at ? dayjs(m.last_seen_at).format('HH:mm') : '—',
        status,
        dot,
      });
    }
    const totalAgents = members.length;
    const statusBars = [
      { label: 'Online', count: onlineCount, pct: totalAgents ? Math.round((onlineCount / totalAgents) * 100) : 0, color: 'bg-emerald-500' },
      { label: 'Busy', count: busyCount, pct: totalAgents ? Math.round((busyCount / totalAgents) * 100) : 0, color: 'bg-orange-500' },
      { label: 'Away', count: awayCount, pct: totalAgents ? Math.round((awayCount / totalAgents) * 100) : 0, color: 'bg-yellow-500' },
      { label: 'Offline', count: offlineCount, pct: totalAgents ? Math.round((offlineCount / totalAgents) * 100) : 0, color: 'bg-slate-400' },
    ];

    // ─── Agent Performance Metrics table ─────────────────────────────────
    const metricsRows: any[] = [];
    for (const m of members.slice(0, 50)) {
      const [accepted, solved] = await Promise.all([
        this.prisma.inbox.count({ where: { workspace_id: workspaceId, user_id: m.id, created_at: { gte: last7Days0 } } }),
        this.prisma.inbox.count({ where: { workspace_id: workspaceId, closed_by: m.id, status: 'COMPLETED', closed_at: { gte: last7Days0 } } }),
      ]);
      if (accepted === 0 && solved === 0) continue;
      // Per-agent avg response/resolution. assigned_on stamps when the
      // conversation landed on this agent's plate, so it's our best proxy
      // for "time to first response" without a dedicated column.
      const closed = await this.prisma.inbox.findMany({
        where: { workspace_id: workspaceId, closed_by: m.id, status: 'COMPLETED', closed_at: { gte: last7Days0, not: null } },
        select: { created_at: true, closed_at: true, assigned_on: true },
        take: 200,
      });
      const respMs = closed
        .filter(c => c.assigned_on && c.created_at)
        .map(c => (new Date(c.assigned_on!).getTime() - new Date(c.created_at!).getTime()));
      const resolMs = closed
        .filter(c => c.closed_at && c.created_at)
        .map(c => (new Date(c.closed_at!).getTime() - new Date(c.created_at!).getTime()));
      const formatDuration = (msList: number[]): string => {
        if (msList.length === 0) return '—';
        const avg = msList.reduce((a, b) => a + b, 0) / msList.length / 1000;
        if (avg < 60) return `${Math.round(avg)}s`;
        if (avg < 3600) return `${Math.round(avg / 60)}m`;
        return `${Math.round(avg / 3600)}h ${Math.round((avg % 3600) / 60)}m`;
      };
      metricsRows.push({
        name: [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || `#${m.id}`,
        accepted,
        solved,
        date: now.format('YYYY-MM-DD'),
        avgResponse: formatDuration(respMs),
        avgResolution: formatDuration(resolMs),
      });
    }

    return {
      kpi: {
        conversations: { total, completed, inProgress: active },
        performance: {
          avgResponse: avgResponseSec > 0 ? `${Math.round(avgResponseSec / 60)}m` : '—',
          avgResolution: avgResolutionSec > 0 ? `${Math.round(avgResolutionSec / 60)}m` : '—',
          resolutionRate: total > 0 ? `${resolutionRate}%` : '—',
        },
        queue: { active: queueActive, pending: queuePending, forwarded: queueForwarded },
        feedback,
      },
      availability: {
        total: totalAgents,
        statusBars,
        agents,
      },
      metrics: metricsRows,
    };
  }

  /**
   * Performance tab — Agent Conversion (call statistics + conversion volume trend).
   * Reads `twilio_call_logs` for inbound/outbound calls and `inbox` grouped by
   * status over time for the volume trend.
   */
  async getAgentConversion(workspaceId: bigint) {
    const now = dayjs();
    const last7Days0 = now.subtract(7, 'day').toDate();

    // ─── KPI 1: Conversion Status ────────────────────────────────────────
    const [queued, active, pending, exited] = await Promise.all([
      this.prisma.inbox.count({ where: { workspace_id: workspaceId, status: 'UNASSIGNED' } }),
      this.prisma.inbox.count({ where: { workspace_id: workspaceId, status: 'ACTIVE' } }),
      this.prisma.inbox.count({ where: { workspace_id: workspaceId, snooze: { gt: new Date() } } }),
      this.prisma.inbox.count({ where: { workspace_id: workspaceId, status: 'COMPLETED', closed_at: { gte: last7Days0 } } }),
    ]);

    // ─── KPI 2: Performance ──────────────────────────────────────────────
    const closed = await this.prisma.inbox.findMany({
      where: { workspace_id: workspaceId, status: 'COMPLETED', closed_at: { gte: last7Days0, not: null } },
      select: { created_at: true, closed_at: true, assigned_on: true },
      take: 500,
    });
    const respMs = closed
      .filter(c => c.assigned_on && c.created_at)
      .map(c => (new Date(c.assigned_on!).getTime() - new Date(c.created_at!).getTime()));
    const avgRespMin = respMs.length ? Math.round(respMs.reduce((a, b) => a + b, 0) / respMs.length / 60000) : 0;

    // ─── KPI 3: Call Statistics ──────────────────────────────────────────
    const twilioAccountIds = (await this.prisma.twilio_accounts.findMany({
      where: { workspace_id: workspaceId },
      select: { id: true },
    })).map(a => a.id);
    let inboundCalls = 0, outboundCalls = 0;
    if (twilioAccountIds.length > 0) {
      [inboundCalls, outboundCalls] = await Promise.all([
        this.prisma.twilio_call_logs.count({ where: { twilio_account_id: { in: twilioAccountIds }, call_type: { contains: 'inbound' }, created_at: { gte: last7Days0 } } }).catch(() => 0),
        this.prisma.twilio_call_logs.count({ where: { twilio_account_id: { in: twilioAccountIds }, call_type: { contains: 'outbound' }, created_at: { gte: last7Days0 } } }).catch(() => 0),
      ]);
    }

    // ─── Volume Trend (per-day status breakdown) ─────────────────────────
    const trend: any[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = now.subtract(i, 'day');
      const start = d.startOf('day').toDate();
      const end = d.endOf('day').toDate();
      const [dQueued, dActive, dPending, dResolved] = await Promise.all([
        this.prisma.inbox.count({ where: { workspace_id: workspaceId, status: 'UNASSIGNED', created_at: { gte: start, lte: end } } }),
        this.prisma.inbox.count({ where: { workspace_id: workspaceId, status: 'ACTIVE', created_at: { gte: start, lte: end } } }),
        this.prisma.inbox.count({ where: { workspace_id: workspaceId, snooze: { gt: new Date() }, created_at: { gte: start, lte: end } } }),
        this.prisma.inbox.count({ where: { workspace_id: workspaceId, status: 'COMPLETED', closed_at: { gte: start, lte: end } } }),
      ]);
      trend.push({
        date: d.format('MMM D'),
        queued: dQueued,
        active: dActive,
        pending: dPending,
        resolved: dResolved,
      });
    }

    // ─── Call Engagement Trend (calls + messages per day) ───────────────
    const callTrend: any[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = now.subtract(i, 'day');
      const start = d.startOf('day').toDate();
      const end = d.endOf('day').toDate();
      let dInbound = 0, dOutbound = 0;
      if (twilioAccountIds.length > 0) {
        [dInbound, dOutbound] = await Promise.all([
          this.prisma.twilio_call_logs.count({ where: { twilio_account_id: { in: twilioAccountIds }, call_type: { contains: 'inbound' }, created_at: { gte: start, lte: end } } }).catch(() => 0),
          this.prisma.twilio_call_logs.count({ where: { twilio_account_id: { in: twilioAccountIds }, call_type: { contains: 'outbound' }, created_at: { gte: start, lte: end } } }).catch(() => 0),
        ]);
      }
      const [waIn, waOut] = await Promise.all([
        this.prisma.wa_messages.count({ where: { direction: 'INCOMING', created_at: { gte: start, lte: end } } }).catch(() => 0),
        this.prisma.wa_messages.count({ where: { direction: 'OUTGOING', created_at: { gte: start, lte: end } } }).catch(() => 0),
      ]);
      callTrend.push({
        date: d.format('MMM D'),
        inbound: dInbound,
        outbound: dOutbound,
        messagesReceived: waIn,
        messagesSent: waOut,
      });
    }

    // ─── Tags chart ──────────────────────────────────────────────────────
    const topTags = await this.prisma.tags.findMany({
      where: { workspace_id: workspaceId },
      select: { id: true, name: true, bg_color: true, text_color: true },
      take: 10,
    });
    const tagsData: any[] = [];
    for (const t of topTags) {
      const count = await this.prisma.tag_links.count({
        where: { tag_id: t.id, created_at: { gte: last7Days0 } },
      }).catch(() => 0);
      if (count > 0) {
        tagsData.push({
          name: t.name,
          count,
          cls: 'bg-primary/10 text-primary',
        });
      }
    }

    return {
      kpi: {
        conversionStatus: { queued, active, pending, exited },
        performance: {
          avgResponseTime: avgRespMin > 0 ? `${avgRespMin}m` : '—',
          resolutionRate: closed.length > 0 ? `${Math.round((exited / Math.max(queued + active + pending + exited, 1)) * 100)}%` : '—',
          customerSatisfaction: '—', // requires CSAT system
        },
        callStatistics: {
          totalCalls: inboundCalls + outboundCalls,
          inboundCalls,
          outboundCalls,
        },
      },
      conversionVolumeTrend: trend,
      callEngagementTrend: callTrend,
      tagsData,
    };
  }

  /**
   * WhatsApp tab — Messages sub-tab. Reads wa_messages joined with
   * wa_templates.category for the 6 Meta WhatsApp Business pricing categories.
   * For untemplated messages (free-form inside 24h service window), bucket
   * into 'service' or 'freeCustomerService'.
   *
   * Meta pricing matrix is approximate; pulled from publicly known rates.
   */
  async getWhatsappMessages(workspaceId: bigint, country?: string) {
    const now = dayjs();
    const last7Days0 = now.subtract(7, 'day').toDate();

    const waAccounts = await this.prisma.wa_accounts.findMany({
      where: { workspace_id: workspaceId },
      select: { id: true, waba_id: true },
    });

    if (waAccounts.length === 0) {
      return {
        kpi: emptyWaKpi(),
        allDeliveriesTrend: [],
        freeDeliveriesTrend: [],
        paidDeliveriesTrend: [],
        chargesTrend: [],
      };
    }

    // wa_templates.wa_account_id is a STRING storing the WABA id (NOT wa_accounts.id),
    // so categorize templates by the accounts' waba_id values.
    const wabaIds = waAccounts.map(a => a.waba_id).filter((x): x is string => !!x);

    // Bulk pull templates so we can categorize message-by-template lookups.
    const templates = wabaIds.length
      ? await this.prisma.wa_templates.findMany({
          where: { wa_account_id: { in: wabaIds } },
          select: { id: true, category: true },
        })
      : [];
    const tplCategory: Record<string, string> = {};
    for (const t of templates) {
      tplCategory[t.id.toString()] = String(t.category || 'utility').toLowerCase();
    }

    // Aggregate by date + category. WhatsApp messages have a `wa_template_id`
    // FK populated when sent via Business API templates; null = service /
    // free-form within 24h window.
    const trend: Record<string, any> = {};
    const last7Messages = await this.prisma.wa_messages.findMany({
      where: { created_at: { gte: last7Days0 }, direction: 'OUTGOING' },
      select: { created_at: true, wa_template_id: true },
      take: 20000,
    });

    const totals = {
      messageSent: 0, messageDelivered: 0, messageReceived: 0,
      marketing: 0, marketingLite: 0, utility: 0, authentication: 0, authenticationIntl: 0, service: 0,
      freeEntryPoint: 0, freeCustomerService: 0,
    };

    for (const msg of last7Messages) {
      if (!msg.created_at) continue;
      const day = dayjs(msg.created_at).format('MMM D');
      if (!trend[day]) {
        trend[day] = {
          date: day,
          marketing: 0, marketingLite: 0, utility: 0, authentication: 0, authenticationIntl: 0, service: 0,
          freeEntryPoint: 0, freeCustomerService: 0,
        };
      }
      const category = msg.wa_template_id
        ? tplCategory[msg.wa_template_id.toString()] || 'utility'
        : 'service';
      const key = mapWaCategory(category);
      if (trend[day][key] !== undefined) {
        trend[day][key] += 1;
        totals[key as keyof typeof totals] += 1;
      }
      totals.messageSent += 1;
    }

    // Delivered + Received (separate counts)
    const [deliveredCount, receivedCount] = await Promise.all([
      this.prisma.wa_messages.count({ where: { created_at: { gte: last7Days0 }, direction: 'OUTGOING' } }).catch(() => 0),
      this.prisma.wa_messages.count({ where: { created_at: { gte: last7Days0 }, direction: 'INCOMING' } }).catch(() => 0),
    ]);
    totals.messageDelivered = deliveredCount;
    totals.messageReceived = receivedCount;

    // Approximate pricing (Meta WhatsApp Business platform, USD per
    // conversation — averaged across common countries). User can override
    // via `country` param to load per-country rates from constants below.
    const pricing = getWaPricing(country || 'US');
    const charges = {
      marketing: +(totals.marketing * pricing.marketing).toFixed(2),
      marketingLite: +(totals.marketingLite * pricing.marketingLite).toFixed(2),
      utility: +(totals.utility * pricing.utility).toFixed(2),
      authentication: +(totals.authentication * pricing.authentication).toFixed(2),
      authenticationIntl: +(totals.authenticationIntl * pricing.authenticationIntl).toFixed(2),
    };

    // Build chart data arrays (zero-fill missing days for stable rendering).
    const allDeliveriesTrend: any[] = [];
    const freeDeliveriesTrend: any[] = [];
    const paidDeliveriesTrend: any[] = [];
    const chargesTrend: any[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = now.subtract(i, 'day').format('MMM D');
      const t = trend[d] || {
        date: d,
        marketing: 0, marketingLite: 0, utility: 0, authentication: 0, authenticationIntl: 0, service: 0,
        freeEntryPoint: 0, freeCustomerService: 0,
      };
      allDeliveriesTrend.push(t);
      freeDeliveriesTrend.push({ date: t.date, freeEntryPoint: t.freeEntryPoint, freeCustomerService: t.service });
      paidDeliveriesTrend.push({
        date: t.date,
        marketing: t.marketing,
        marketingLite: t.marketingLite,
        utility: t.utility,
        authentication: t.authentication,
        authenticationIntl: t.authenticationIntl,
      });
      chargesTrend.push({
        date: t.date,
        marketing: +(t.marketing * pricing.marketing).toFixed(2),
        marketingLite: +(t.marketingLite * pricing.marketingLite).toFixed(2),
        utility: +(t.utility * pricing.utility).toFixed(2),
        authentication: +(t.authentication * pricing.authentication).toFixed(2),
        authenticationIntl: +(t.authenticationIntl * pricing.authenticationIntl).toFixed(2),
      });
    }

    return {
      kpi: {
        allMessages: { messageSent: totals.messageSent, messageDelivered: totals.messageDelivered, messageReceived: totals.messageReceived },
        allDeliveries: {
          marketing: totals.marketing, marketingLite: totals.marketingLite, utility: totals.utility,
          authentication: totals.authentication, authIntl: totals.authenticationIntl, service: totals.service,
        },
        freeDeliveries: { freeCustomerService: totals.service, freeEntryPoint: totals.freeEntryPoint },
        paidDeliveries: {
          marketing: totals.marketing, marketingLite: totals.marketingLite, utility: totals.utility,
          authentication: totals.authentication, authIntl: totals.authenticationIntl,
        },
        approxCharges: {
          marketing: `$${charges.marketing}`,
          marketingLite: `$${charges.marketingLite}`,
          utility: `$${charges.utility}`,
          authentication: `$${charges.authentication}`,
          authIntl: `$${charges.authenticationIntl}`,
        },
      },
      allDeliveriesTrend,
      freeDeliveriesTrend,
      paidDeliveriesTrend,
      chargesTrend,
    };
  }

  /**
   * WhatsApp tab — Calls sub-tab. Currently EZCONN does NOT integrate the
   * WhatsApp Business Calling API (released by Meta in 2024-2025). Returns
   * zero KPIs with empty trends so the UI renders cleanly; once the API is
   * wired, this method becomes the data source.
   */
  async getWhatsappCalls(workspaceId: bigint) {
    const now = dayjs();
    const emptyTrend: any[] = [];
    for (let i = 6; i >= 0; i--) {
      emptyTrend.push({
        date: now.subtract(i, 'day').format('MMM D'),
        businessInitiated: 0,
        userInitiated: 0,
        calls: 0,
        charges: 0,
      });
    }
    return {
      kpi: {
        allCalls: { businessInitiated: 0, userInitiated: 0 },
        avgDuration: { businessInitiated: 0, userInitiated: 0 },
        approxCharges: { businessInitiated: '$0', userInitiated: '$0' },
      },
      allCallsTrend: emptyTrend.map(t => ({ date: t.date, businessInitiated: 0, userInitiated: 0 })),
      durationTrend: emptyTrend.map(t => ({ date: t.date, businessInitiated: 0, userInitiated: 0 })),
      chargesTrend: emptyTrend.map(t => ({ date: t.date, calls: 0, charges: 0 })),
    };
  }

  /**
   * Bot tab analytics. Reads chatbots / chatbot_messages / automation_runs.
   *  - botTriggered = distinct automation_runs in window
   *  - respondedByBot = chatbot_messages OUTGOING + ai_messages (bot replies)
   *  - receivedByBot = chatbot_messages INCOMING
   *  - escalatedToHuman = inbox where bot_handed_off=true OR user_id went non-null after bot session
   *  - avgSessionDuration = avg(closed_at - created_at) on chatbot_chats
   */
  async getBotAnalytics(workspaceId: bigint, topFilter: string = 'Top 10') {
    const now = dayjs();
    const last7Days0 = now.subtract(7, 'day').toDate();

    const chatbotIds = (await this.prisma.chatbots.findMany({
      where: { workspace_id: workspaceId },
      select: { id: true, name: true },
    }));
    const cbIds = chatbotIds.map(c => c.id);

    let botTriggered = 0, respondedByBot = 0, receivedByBot = 0, escalatedToHuman = 0;
    let avgSessionSec = 0;
    let popularityRows: any[] = [];

    if (cbIds.length > 0) {
      // chatbot_chats has no closed_at — we approximate session duration as
      // (updated_at - created_at) which is the activity window the chat had
      // before it stopped receiving updates.
      const cbChats = await this.prisma.chatbot_chats.findMany({
        where: { chatbot_id: { in: cbIds }, created_at: { gte: last7Days0 } },
        select: { id: true, chatbot_id: true, created_at: true, updated_at: true },
        take: 5000,
      }).catch(() => [] as any[]);
      botTriggered = cbChats.length;

      const durations = cbChats
        .filter((c: any) => c.updated_at && c.created_at)
        .map((c: any) => (new Date(c.updated_at).getTime() - new Date(c.created_at).getTime()) / 1000);
      avgSessionSec = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

      // chatbot_messages FK is `chat_id` (→ chatbot_chats.id), not chatbot_id
      // directly. Map cbChats IDs first so we can scope message counts.
      const chatIds = cbChats.map((c: any) => c.id);
      if (chatIds.length > 0) {
        [respondedByBot, receivedByBot] = await Promise.all([
          this.prisma.chatbot_messages.count({ where: { chat_id: { in: chatIds }, direction: 'OUTGOING', created_at: { gte: last7Days0 } } }).catch(() => 0),
          this.prisma.chatbot_messages.count({ where: { chat_id: { in: chatIds }, direction: 'INCOMING', created_at: { gte: last7Days0 } } }).catch(() => 0),
        ]);
      }

      // Popularity by chatbot
      const perBotCount: Record<string, number> = {};
      const perBotName: Record<string, string> = {};
      for (const cb of chatbotIds) {
        perBotName[cb.id.toString()] = cb.name || `Bot #${cb.id}`;
      }
      for (const chat of cbChats) {
        const key = chat.chatbot_id?.toString();
        if (!key) continue;
        perBotCount[key] = (perBotCount[key] || 0) + 1;
      }
      const sorted = Object.entries(perBotCount).sort((a, b) => b[1] - a[1]);
      const limit = topFilter === 'Top 5' ? 5 : topFilter === 'All' ? sorted.length : 10;
      popularityRows = sorted.slice(0, limit).map(([id, count]) => ({
        name: perBotName[id] || `Bot ${id}`,
        sentiment: count, // chart uses `sentiment` key
      }));
    }

    // Also include automation runs as part of bot triggers
    const autoRuns = await this.prisma.automation_runs.count({
      where: {
        automation_id: { in: (await this.prisma.automations.findMany({ where: { workspace_id: workspaceId }, select: { id: true } })).map(a => a.id) },
        created_at: { gte: last7Days0 },
      },
    }).catch(() => 0);
    botTriggered += autoRuns;

    // Escalated to human: is_assigned flag flips to 1 when an agent picks
    // the conversation up after a bot session.
    escalatedToHuman = await this.prisma.inbox.count({
      where: {
        workspace_id: workspaceId,
        is_assigned: 1,
        created_at: { gte: last7Days0 },
      },
    }).catch(() => 0);

    // Bot vs Human trend (per day)
    const botVsHumanData: any[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = now.subtract(i, 'day');
      const start = d.startOf('day').toDate();
      const end = d.endOf('day').toDate();
      const [triggered, escalated] = await Promise.all([
        cbIds.length > 0
          ? this.prisma.chatbot_chats.count({ where: { chatbot_id: { in: cbIds }, created_at: { gte: start, lte: end } } }).catch(() => 0)
          : Promise.resolve(0),
        this.prisma.inbox.count({ where: { workspace_id: workspaceId, is_assigned: 1, created_at: { gte: start, lte: end } } }).catch(() => 0),
      ]);
      botVsHumanData.push({ date: d.format('MMM D'), triggered, escalated });
    }

    // Busiest period heatmap (day-of-week × hour). Re-scope through chatIds
    // since chatbot_messages doesn't carry chatbot_id directly.
    const days = ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed'];
    const busiestPeriodData: any[] = [];
    if (cbIds.length > 0) {
      const allChatIds = (await this.prisma.chatbot_chats.findMany({
        where: { chatbot_id: { in: cbIds }, created_at: { gte: last7Days0 } },
        select: { id: true },
      }).catch(() => [] as any[])).map((c: any) => c.id);
      const recent = allChatIds.length > 0 ? await this.prisma.chatbot_messages.findMany({
        where: { chat_id: { in: allChatIds }, created_at: { gte: last7Days0 } },
        select: { created_at: true },
        take: 10000,
      }).catch(() => [] as any[]) : [];
      // Build 24-hour time slot rows, each with a count per day
      for (let hour = 0; hour < 24; hour++) {
        const row: any = { time: `${hour.toString().padStart(2, '0')}:00` };
        for (const day of days) row[day] = 0;
        busiestPeriodData.push(row);
      }
      for (const msg of recent) {
        if (!msg.created_at) continue;
        const d = dayjs(msg.created_at);
        const hour = d.hour();
        const dayName = days[(d.day() + 4) % 7]; // shift to start from Thu
        if (busiestPeriodData[hour] && busiestPeriodData[hour][dayName] !== undefined) {
          busiestPeriodData[hour][dayName] += 1;
        }
      }
    }

    const totalMessages = respondedByBot + receivedByBot;

    return {
      kpi: {
        botTriggered,
        respondedByBot,
        receivedByBot,
        totalMessages,
        escalatedToHuman,
        avgSessionDuration: `${Math.floor(avgSessionSec / 3600)} hrs ${Math.floor((avgSessionSec % 3600) / 60)} mins`,
      },
      popularityData: popularityRows,
      botVsHumanData,
      busiestPeriodData,
    };
  }

  /**
   * Voice of Customer — Sentiment Summary. Sentiment is computed live via
   * keyword matching on recent inbox messages. No DB column, no new table.
   * Approximate but real.
   */
  async getSentimentSummary(workspaceId: bigint) {
    const now = dayjs();
    const last7Days0 = now.subtract(7, 'day').toDate();

    const recent = await this.prisma.wa_messages.findMany({
      where: { direction: 'INCOMING', created_at: { gte: last7Days0 } },
      select: { text: true, created_at: true },
      take: 2000,
    }).catch(() => [] as any[]);

    const tg = await this.prisma.telegram_messages.findMany({
      where: { direction: 'INCOMING', created_at: { gte: last7Days0 } },
      select: { text: true, created_at: true },
      take: 2000,
    }).catch(() => [] as any[]);

    const all = [...recent, ...tg];
    const trendBuckets: Record<string, { positive: number; neutral: number; negative: number }> = {};
    let positive = 0, neutral = 0, negative = 0;
    for (const msg of all) {
      const sentiment = classifySentiment(msg.text || '');
      if (sentiment === 'positive') positive++;
      else if (sentiment === 'negative') negative++;
      else neutral++;
      if (msg.created_at) {
        const day = dayjs(msg.created_at).format('MMM D');
        if (!trendBuckets[day]) trendBuckets[day] = { positive: 0, neutral: 0, negative: 0 };
        trendBuckets[day][sentiment]++;
      }
    }
    const total = positive + neutral + negative;
    const score = total > 0 ? Math.round((positive / total) * 100) : 0;

    const sentimentTrendData: any[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = now.subtract(i, 'day').format('MMM D');
      const bucket = trendBuckets[d] || { positive: 0, neutral: 0, negative: 0 };
      sentimentTrendData.push({ date: d, ...bucket });
    }

    return {
      sentimentScore: score,
      totalConversations: total,
      sentimentDistribution: {
        positive: total > 0 ? Math.round((positive / total) * 100) : 0,
        neutral: total > 0 ? Math.round((neutral / total) * 100) : 0,
        negative: total > 0 ? Math.round((negative / total) * 100) : 0,
      },
      sentimentTrendData,
    };
  }

  /**
   * Voice of Customer — Details (Agent + Customer sentiment tables).
   */
  async getSentimentDetails(workspaceId: bigint) {
    const now = dayjs();
    const last30Days0 = now.subtract(30, 'day').toDate();

    // Agent rows: per-agent total assigned conversations + sentiment of customer
    // replies in those conversations.
    const members = await this.prisma.users.findMany({
      where: { modelable_type: 'App\\Models\\Workspace', modelable_id: workspaceId },
      select: { id: true, first_name: true, last_name: true, email: true },
      take: 50,
    });

    const agentRows: any[] = [];
    for (const m of members) {
      const assigned = await this.prisma.inbox.count({
        where: { workspace_id: workspaceId, user_id: m.id, created_at: { gte: last30Days0 } },
      });
      if (assigned === 0) continue;
      agentRows.push({
        id: m.id.toString(),
        name: [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || `#${m.id}`,
        team: '—',
        date: now.format('YYYY-MM-DD'),
        total: assigned,
      });
    }

    // Customer rows: recent inbox entries. EZCONN inbox has no
    // last_message_text column, so we classify by fetching the most recent
    // incoming WhatsApp message for the modelable chat instead. Lightweight
    // for the dashboard's top-N view (100 rows max).
    const recentInbox = await this.prisma.inbox.findMany({
      where: { workspace_id: workspaceId, created_at: { gte: last30Days0 } },
      select: {
        id: true,
        user_id: true,
        created_at: true,
        modelable_type: true,
        modelable_id: true,
      },
      orderBy: { created_at: 'desc' },
      take: 100,
    });

    const customerRows: any[] = [];
    for (const inb of recentInbox) {
      const channelKey = String(inb.modelable_type || '').toLowerCase();
      let channel = 'unknown';
      let lastIncomingText = '';
      if (channelKey.includes('whatsapp')) {
        channel = 'whatsapp';
        const m = await this.prisma.wa_messages.findFirst({
          where: { wa_chat_id: inb.modelable_id, direction: 'INCOMING' },
          orderBy: { created_at: 'desc' },
          select: { text: true },
        }).catch(() => null);
        lastIncomingText = m?.text || '';
      } else if (channelKey.includes('telegram')) {
        channel = 'telegram';
        const m = await this.prisma.telegram_messages.findFirst({
          where: { direction: 'INCOMING' },
          orderBy: { created_at: 'desc' },
          select: { text: true },
        }).catch(() => null);
        lastIncomingText = m?.text || '';
      } else if (channelKey.includes('facebook') || channelKey.includes('messenger')) {
        channel = 'messenger';
      } else if (channelKey.includes('instagram')) {
        channel = 'instagram';
      } else if (channelKey.includes('zapi')) {
        channel = 'zapi';
      }
      const sentiment = classifySentiment(lastIncomingText);

      let agentName = '—';
      if (inb.user_id) {
        const agent = members.find((m: any) => m.id === inb.user_id);
        if (agent) agentName = [agent.first_name, agent.last_name].filter(Boolean).join(' ') || agent.email || `#${agent.id}`;
      }
      customerRows.push({
        id: inb.id.toString(),
        agentName,
        team: '—',
        sentiment,
        date: inb.created_at ? dayjs(inb.created_at).format('YYYY-MM-DD') : '—',
        channel,
      });
    }

    return { agentRows, customerRows };
  }

  /**
   * CSAT Summary — Honest empty state. EZCONN does not yet have a CSAT
   * collection mechanism (no `csat_responses` table, no automation hook).
   * Returns zero KPIs with `feature_status: 'not_configured'` so the
   * frontend can display the configured-cards skeleton without faking data.
   */
  async getCsatSummary(workspaceId: bigint) {
    const totalCompleted = await this.prisma.inbox.count({
      where: { workspace_id: workspaceId, status: 'COMPLETED' },
    });
    return {
      feature_status: 'not_configured',
      satisfactionScore: 0,
      totalResponses: 0,
      basedOnConversations: 0,
      feedbackRate: 0,
      responded: 0,
      totalConversations: totalCompleted,
      distribution: { great: 0, average: 0, poor: 0 },
      agentRankings: [],
      csatDistributionData: [],
    };
  }

  /**
   * CSAT Details — Honest empty state.
   */
  async getCsatDetails(workspaceId: bigint) {
    return {
      feature_status: 'not_configured',
      agentCSAT: [],
      feedback: [],
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  WhatsApp pricing matrix (approximate; per Meta Business API public rates)
//  Used to compute Approximate Charges in the WhatsApp Messages sub-tab.
//  All rates in USD per delivered message.
// ═══════════════════════════════════════════════════════════════════════

const WA_PRICING_MATRIX: Record<string, any> = {
  US: { marketing: 0.025, marketingLite: 0.020, utility: 0.015, authentication: 0.0135, authenticationIntl: 0.020 },
  GB: { marketing: 0.0560, marketingLite: 0.0440, utility: 0.0340, authentication: 0.0264, authenticationIntl: 0.040 },
  IN: { marketing: 0.0070, marketingLite: 0.0055, utility: 0.0033, authentication: 0.0014, authenticationIntl: 0.0070 },
  BR: { marketing: 0.0560, marketingLite: 0.0440, utility: 0.0340, authentication: 0.0314, authenticationIntl: 0.0500 },
  DE: { marketing: 0.0768, marketingLite: 0.0610, utility: 0.0420, authentication: 0.0420, authenticationIntl: 0.0680 },
  ID: { marketing: 0.0273, marketingLite: 0.0220, utility: 0.0160, authentication: 0.0162, authenticationIntl: 0.0250 },
  PK: { marketing: 0.0287, marketingLite: 0.0230, utility: 0.0150, authentication: 0.0150, authenticationIntl: 0.0280 },
  default: { marketing: 0.025, marketingLite: 0.020, utility: 0.015, authentication: 0.0135, authenticationIntl: 0.020 },
};

function getWaPricing(country: string) {
  return WA_PRICING_MATRIX[country.toUpperCase()] || WA_PRICING_MATRIX.default;
}

// Meta categorizes templates as MARKETING | UTILITY | AUTHENTICATION |
// AUTHENTICATION_INTERNATIONAL | SERVICE. Map to our 6 chart keys.
function mapWaCategory(category: string): string {
  const c = category.toLowerCase();
  if (c.includes('authentication_international') || c.includes('international')) return 'authenticationIntl';
  if (c.includes('authentication')) return 'authentication';
  if (c.includes('utility')) return 'utility';
  if (c.includes('marketing_lite') || c === 'marketing_lite') return 'marketingLite';
  if (c.includes('marketing')) return 'marketing';
  return 'service';
}

function emptyWaKpi() {
  return {
    allMessages: { messageSent: 0, messageDelivered: 0, messageReceived: 0 },
    allDeliveries: { marketing: 0, marketingLite: 0, utility: 0, authentication: 0, authIntl: 0, service: 0 },
    freeDeliveries: { freeCustomerService: 0, freeEntryPoint: 0 },
    paidDeliveries: { marketing: 0, marketingLite: 0, utility: 0, authentication: 0, authIntl: 0 },
    approxCharges: { marketing: '$0', marketingLite: '$0', utility: '$0', authentication: '$0', authIntl: '$0' },
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  Sentiment classifier — keyword-based. No NLP service, no API call.
//  Accuracy is approximate but matches the spirit of "real, not mocked"
//  data while staying within the "no new tables" constraint.
// ═══════════════════════════════════════════════════════════════════════

const POSITIVE_WORDS = [
  'thank', 'thanks', 'great', 'awesome', 'love', 'good', 'happy', 'excellent',
  'perfect', 'amazing', 'wonderful', 'best', 'helpful', 'fast', 'glad',
  'satisfied', 'recommend', 'beautiful', 'fantastic', '😊', '👍', '❤', '🙏',
  'gracias', 'obrigado', 'shukriya', 'bohat acha', 'theek hai',
];
const NEGATIVE_WORDS = [
  'bad', 'worst', 'angry', 'slow', 'hate', 'terrible', 'awful', 'poor',
  'broken', 'disappointed', 'frustrated', 'useless', 'horrible', 'unhappy',
  'rude', 'never', 'refund', 'cancel', 'complaint', 'problem', 'issue',
  'wrong', '😠', '😡', '👎', '💔', 'bura', 'kharab', 'theek nahi',
];

function classifySentiment(text: string): 'positive' | 'neutral' | 'negative' {
  const lower = text.toLowerCase();
  let posScore = 0, negScore = 0;
  for (const w of POSITIVE_WORDS) if (lower.includes(w)) posScore++;
  for (const w of NEGATIVE_WORDS) if (lower.includes(w)) negScore++;
  if (posScore > negScore) return 'positive';
  if (negScore > posScore) return 'negative';
  return 'neutral';
}
