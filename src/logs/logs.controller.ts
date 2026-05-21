import { Controller, Get, Query, UseGuards, Request } from '@nestjs/common';
import { LogsService } from './logs.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('logs')
export class LogsController {
  constructor(private readonly service: LogsService) {}

  @Get('conversations')
  async conversations(@Request() req: any, @Query() q: any) {
    return this.service.conversations(BigInt(req.user.workspace_id || 1), {
      page: q.page ? parseInt(q.page, 10) : undefined,
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
      search: q.search,
      status: q.status,
    });
  }

  @Get('calls')
  async calls(@Request() req: any, @Query() q: any) {
    return this.service.calls(BigInt(req.user.workspace_id || 1), {
      page: q.page ? parseInt(q.page, 10) : undefined,
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
      search: q.search,
      direction: q.direction,
      status: q.status,
    });
  }

  @Get('stats')
  async stats(@Request() req: any) {
    return this.service.stats(BigInt(req.user.workspace_id || 1));
  }
}
