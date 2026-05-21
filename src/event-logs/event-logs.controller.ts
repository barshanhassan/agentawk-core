import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { EventLogsService } from './event-logs.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('event-logs')
export class EventLogsController {
  constructor(private readonly eventLogsService: EventLogsService) {}

  @Get()
  async list(@Query() q: any) {
    return this.eventLogsService.list({
      loggable_type: q.loggable_type,
      loggable_id: q.loggable_id ? BigInt(q.loggable_id) : undefined,
      user_id: q.user_id ? BigInt(q.user_id) : undefined,
      action: q.action,
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
      offset: q.offset ? parseInt(q.offset, 10) : undefined,
    });
  }

  // Backwards-compat: existing legacy route `GET /event-logs/get` kept for any
  // caller still on the stub. Delegates to the same list method.
  @Get('get')
  async getCompat(@Query() q: any) {
    return this.list(q);
  }
}
