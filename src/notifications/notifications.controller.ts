import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Request() req: any, @Query() q: any) {
    const notifiableType = 'App\\Models\\User';
    const notifiableId = BigInt(req.user.sub || req.user.id || 0);
    return this.notifications.list(notifiableType, notifiableId, {
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
      offset: q.offset ? parseInt(q.offset, 10) : undefined,
    });
  }

  @Post(':id/read')
  markRead(@Param('id') id: string, @Request() req: any) {
    const userId = BigInt(req.user.sub || req.user.id || 0);
    return this.notifications.markRead(id, 'App\\Models\\User', userId);
  }

  @Post('read-all')
  markAllRead(@Request() req: any) {
    const userId = BigInt(req.user.sub || req.user.id || 0);
    return this.notifications.markAllRead('App\\Models\\User', userId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: any) {
    const userId = BigInt(req.user.sub || req.user.id || 0);
    return this.notifications.deleteOne(id, 'App\\Models\\User', userId);
  }

  /**
   * Admin/internal use — directly create a notification. Useful for system
   * events generated outside the EventEmitter pipeline.
   */
  @Post()
  create(@Request() req: any, @Body() body: any) {
    return this.notifications.create({
      slug: body.slug,
      type: body.type,
      notifiableType: body.notifiable_type ?? 'App\\Models\\User',
      notifiableId: BigInt(body.notifiable_id ?? req.user.sub ?? req.user.id ?? 0),
      data: body.data ?? {},
      triggerableType: body.triggerable_type,
      triggerableId: body.triggerable_id ? BigInt(body.triggerable_id) : undefined,
    });
  }
}
