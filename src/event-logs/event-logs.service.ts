import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class EventLogsService {
  constructor(private readonly prisma: PrismaService) {}

  // List event logs scoped to a loggable (workspace, agency, contact, etc.).
  // Mirrors gateway pattern: filter by loggable_type + loggable_id, paginated.
  async list(filters: {
    loggable_type?: string;
    loggable_id?: bigint;
    user_id?: bigint;
    action?: string;
    limit?: number;
    offset?: number;
  }) {
    const where: any = {};
    if (filters.loggable_type) where.loggable_type = filters.loggable_type;
    if (filters.loggable_id) where.loggable_id = filters.loggable_id;
    if (filters.user_id) where.user_id = filters.user_id;
    if (filters.action) where.action = filters.action;

    const take = Math.min(filters.limit ?? 50, 200);
    const skip = filters.offset ?? 0;

    const [logs, total] = await Promise.all([
      this.prisma.event_logs.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take,
        skip,
      }),
      this.prisma.event_logs.count({ where }),
    ]);

    return {
      logs: logs.map((l) => this.serialize(l)),
      total,
      limit: take,
      offset: skip,
    };
  }

  // Write an event log entry. Used by other services emitting domain events.
  async log(params: {
    userId: bigint;
    loggableType: string;
    loggableId: bigint;
    action: string;
    details?: string;
    data?: any;
  }) {
    return this.prisma.event_logs.create({
      data: {
        user_id: params.userId,
        loggable_type: params.loggableType,
        loggable_id: params.loggableId,
        action: params.action,
        details: params.details ?? null,
        data: params.data ? JSON.stringify(params.data) : null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
  }

  private serialize<T extends Record<string, any>>(obj: T): any {
    return JSON.parse(
      JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
  }
}
