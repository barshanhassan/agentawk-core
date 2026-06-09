// @ts-nocheck
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import dayjs from 'dayjs';

@Injectable()
export class ChatStatisticsService {
  private readonly logger = new Logger(ChatStatisticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Real-time counters for the chat dashboard.
   */
  async getStats(workspaceId: bigint, filters: any) {
    const range = this.resolveDateRange(filters);
    const where: any = { workspace_id: workspaceId, created_at: range };

    const [total, open, closed, unassigned, snoozed] = await Promise.all([
      this.prisma.inbox.count({ where }),
      this.prisma.inbox.count({ where: { ...where, status: 'ACTIVE' } }),
      this.prisma.inbox.count({ where: { ...where, status: 'COMPLETED' } }),
      this.prisma.inbox.count({ where: { ...where, status: 'UNASSIGNED' } }),
      this.prisma.inbox.count({ where: { ...where, snooze: { gt: new Date() } } }),
    ]);

    return {
      total_conversations: total,
      open_conversations: open,
      closed_conversations: closed,
      unassigned_conversations: unassigned,
      snoozed_conversations: snoozed,
    };
  }

  /**
   * Aggregated message data across all provider tables.
   */
  async getMessagesData(workspaceId: bigint, filters: any) {
    const range = this.resolveDateRange(filters);

    // Parallel aggregation of outgoing messages across all provider tables
    const [wa, fb, tg, insta, twilio] = await Promise.all([
      this.prisma.wa_messages.count({
        where: { direction: 'OUTGOING', created_at: range },
      }),
      this.prisma.fb_messages.count({
        where: { direction: 'OUTGOING', created_at: range },
      }),
      this.prisma.telegram_messages.count({
        where: { direction: 'OUTGOING', created_at: range },
      }),
      this.prisma.insta_messages.count({
        where: { direction: 'OUTGOING', created_at: range },
      }),
      this.prisma.twilio_messages.count({
        where: { direction: 'OUTGOING', created_at: range },
      }),
    ]);

    return {
      whatsapp: wa,
      messenger: fb,
      telegram: tg,
      instagram: insta,
      sms: twilio,
      total: wa + fb + tg + insta + twilio,
    };
  }

  /**
   * Hourly distribution of messsages for heatmaps/charts.
   */
  async getHourlyMessagesData(workspaceId: bigint, filters: any) {
    const range = this.resolveDateRange(filters);
    // We use a simplified grouping by hour for the chart data
    // In a production environment with high volume, this might need a dedicated stats table.
    const conversations = await this.prisma.inbox.findMany({
      where: { workspace_id: workspaceId, created_at: range },
      select: { created_at: true },
    });

    const hourlyData = new Array(24).fill(0);
    conversations.forEach((c) => {
      const hour = dayjs(c.created_at).hour();
      hourlyData[hour]++;
    });

    return {
      labels: Array.from({ length: 24 }, (_, i) => `${i}:00`),
      dataset: hourlyData,
    };
  }

  /**
   * Response time analytics (First Response & Resolution).
   */
  async getTimeToConcludeData(workspaceId: bigint, filters: any) {
    const range = this.resolveDateRange(filters);
    const closedConversations = await this.prisma.inbox.findMany({
      where: {
        workspace_id: workspaceId,
        status: 'COMPLETED',
        closed_at: range,
      },
      select: { created_at: true, closed_at: true },
    });

    let totalSeconds = 0;
    closedConversations.forEach((c) => {
      totalSeconds += dayjs(c.closed_at).diff(dayjs(c.created_at), 'second');
    });

    const avgSeconds =
      closedConversations.length > 0
        ? totalSeconds / closedConversations.length
        : 0;
    return {
      avg_resolution_time_seconds: Math.round(avgSeconds),
      total_closed: closedConversations.length,
    };
  }

  /**
   * AI Performance Metrics.
   */
  async getAiStats(workspaceId: bigint, filters: any) {
    const range = this.resolveDateRange(filters);
    // Stub: In Laravel this often tracks tokens or specific AI-flagged messages
    const aiMessages = await this.prisma.inbox.count({
      where: {
        workspace_id: workspaceId,
        created_at: range,
        last_message_from: 'AI',
      },
    });

    return {
      total_ai_responses: aiMessages,
      total_tokens_used: 0, // Requires integration with billing/token logs
      auto_replies_sent: aiMessages,
    };
  }

  private resolveDateRange(filters: any) {
    const start = filters?.start_date
      ? dayjs(filters.start_date).startOf('day')
      : dayjs().subtract(7, 'days').startOf('day');
    const end = filters?.end_date
      ? dayjs(filters.end_date).endOf('day')
      : dayjs().endOf('day');
    return { gte: start.toDate(), lte: end.toDate() };
  }
}
