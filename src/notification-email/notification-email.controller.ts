import { Controller, Get, Post, Delete, Body, Param, Request, UseGuards } from '@nestjs/common';
import { NotificationEmailService } from './notification-email.service';
import { JwtAuthGuard } from '../auth/auth.guard';

/**
 * White Label → Email tab. Mirrors replyagent's notification-email routes:
 *   GET    /notification-email           — current custom email domain (or null)
 *   POST   /notification-email           — add { prefix, domain } via SMTP2GO
 *   GET    /notification-email/verify/:id — re-check DKIM/Return-Path verification
 *   DELETE /notification-email/:id       — remove the custom email domain
 */
@Controller('notification-email')
@UseGuards(JwtAuthGuard)
export class NotificationEmailController {
  constructor(private readonly service: NotificationEmailService) {}

  @Get()
  async get(@Request() req: any) {
    return this.service.get(BigInt(req.user.workspace_id || 1));
  }

  @Post()
  async add(@Body() body: any, @Request() req: any) {
    return this.service.add(BigInt(req.user.workspace_id || 1), body);
  }

  @Get('verify/:id')
  async verify(@Param('id') id: string, @Request() req: any) {
    return this.service.verify(BigInt(req.user.workspace_id || 1), BigInt(id));
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Request() req: any) {
    return this.service.remove(BigInt(req.user.workspace_id || 1), BigInt(id));
  }
}
