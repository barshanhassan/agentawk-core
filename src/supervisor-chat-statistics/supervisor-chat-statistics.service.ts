// @ts-nocheck
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import dayjs from 'dayjs';

@Injectable()
export class SupervisorChatStatisticsService {
  private readonly logger = new Logger(SupervisorChatStatisticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Team workload and status overview.
   */
  async teamStatus(workspaceId: bigint) {
    const members = await this.prisma.workspace_members.findMany({
      where: { workspace_id: workspaceId },
      include: { users: { select: { id: true, name: true, email: true } } },
    });

    const stats = [];
    for (const member of members) {
      const [open, closed, snoozed] = await Promise.all([
        this.prisma.inbox.count({
          where: {
            workspace_id: workspaceId,
            user_id: member.user_id,
            status: 'ACTIVE',
          },
        }),
        this.prisma.inbox.count({
          where: {
            workspace_id: workspaceId,
            user_id: member.user_id,
            status: 'COMPLETED',
          },
        }),
        this.prisma.inbox.count({
          where: {
            workspace_id: workspaceId,
            user_id: member.user_id,
            // inbox has no SNOOZED status — snoozed = a future `snooze` datetime.
            snooze: { gt: new Date() },
          },
        }),
      ]);

      stats.push({
        user: member.users,
        role: member.role,
        status: member.status,
        workload: { open, closed, snoozed, total: open + closed + snoozed },
      });
    }

    return { team: stats };
  }

  /**
   * Leads (Contacts) distribution per channel.
   */
  async getLeadsPerChannelData(workspaceId: bigint, filters: any) {
    const range = this.resolveDateRange(filters);
    const contacts = await this.prisma.contacts.groupBy({
      by: ['source'],
      where: { workspace_id: workspaceId, created_at: range },
      _count: true,
    });

    return {
      breakdown: contacts.map((c) => ({
        channel: c.source || 'unknown',
        count: c._count,
      })),
    };
  }

  /**
   * Agent productivity charts (Conversations assigned vs resolved).
   */
  async getAgentPerformance(workspaceId: bigint, filters: any) {
    const range = this.resolveDateRange(filters);
    const performance = await this.prisma.inbox.groupBy({
      by: ['assigned_to', 'status'],
      where: {
        workspace_id: workspaceId,
        updated_at: range,
        assigned_to: { not: null },
      },
      _count: true,
    });

    return { performance };
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
