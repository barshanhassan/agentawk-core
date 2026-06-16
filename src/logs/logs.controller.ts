import { Controller, Get, Delete, Param, Query, UseGuards, Request } from '@nestjs/common';
import { LogsService } from './logs.service';
import { JwtAuthGuard } from '../auth/auth.guard';

/**
 * Unified `/api/logs/*` surface backing the ConversationLogsPage and
 * CallLogsPage. Each endpoint accepts the same date_from / date_to /
 * pagination contract so the React filter bar can stay simple.
 */
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
      date_from: q.date_from,
      date_to: q.date_to,
    });
  }

  @Delete('conversations/:id')
  async deleteConversation(@Param('id') id: string, @Request() req: any) {
    return this.service.deleteConversation(
      BigInt(req.user.workspace_id || 1),
      BigInt(id),
    );
  }

  @Get('conversations/:id')
  async conversationDetail(
    @Param('id') id: string,
    @Request() req: any,
    @Query() q: any,
  ) {
    return this.service.conversationDetail(
      BigInt(req.user.workspace_id || 1),
      BigInt(id),
      q.messages_limit ? parseInt(q.messages_limit, 10) : 50,
    );
  }

  @Get('calls')
  async calls(@Request() req: any, @Query() q: any) {
    return this.service.calls(BigInt(req.user.workspace_id || 1), {
      page: q.page ? parseInt(q.page, 10) : undefined,
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
      search: q.search,
      direction: q.direction,
      status: q.status,
      date_from: q.date_from,
      date_to: q.date_to,
    });
  }

  @Get('calls/:id')
  async callDetail(@Param('id') id: string, @Request() req: any) {
    return this.service.callDetail(BigInt(req.user.workspace_id || 1), BigInt(id));
  }

  @Get('stats')
  async stats(@Request() req: any, @Query() q: any) {
    return this.service.stats(BigInt(req.user.workspace_id || 1), {
      date_from: q.date_from,
      date_to: q.date_to,
    });
  }
}
