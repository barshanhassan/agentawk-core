import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { InstagramService } from './instagram.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('instagram')
export class InstagramController {
  constructor(private readonly service: InstagramService) {}

  private ws(req: any): bigint {
    return BigInt(req.user.workspace_id || 1);
  }
  private uid(req: any): bigint {
    return BigInt(req.user.sub || req.user.id || 0);
  }

  // ── Pages list ────────────────────────────────────────────────────
  @Get('pages')
  list(@Request() req: any) {
    return this.service.listPages(this.ws(req));
  }

  // ── Manual connect ────────────────────────────────────────────────
  @Post('pages')
  connect(@Request() req: any, @Body() body: any) {
    return this.service.connectPage(this.ws(req), this.uid(req), body);
  }

  // ── Disconnect page ───────────────────────────────────────────────
  @Delete('pages/:id')
  disconnect(@Param('id') id: string, @Request() req: any) {
    return this.service.disconnectPage(this.ws(req), BigInt(id));
  }

  // ── Send message ──────────────────────────────────────────────────
  @Post('pages/:id/send')
  send(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.service.sendMessage(this.ws(req), BigInt(id), body);
  }

  // ── OAuth: new Instagram Business API ────────────────────────────
  @Post('connect-business')
  connectBusiness(@Body() body: any, @Request() req: any) {
    const { code, redirect_uri } = body;
    return this.service.connectBusiness(this.ws(req), this.uid(req), code, redirect_uri);
  }

  // ── OAuth: reconnect / re-authorize an existing IG Business page ──
  // Mirrors replyagent's "Refresh" — same OAuth as connect, but carries the
  // page_id so the existing row's token is refreshed in place (not duplicated).
  @Post('reconnect-business')
  reconnectBusiness(@Body() body: any, @Request() req: any) {
    const { code, redirect_uri, page_id } = body;
    return this.service.connectBusiness(
      this.ws(req),
      this.uid(req),
      code,
      redirect_uri,
      page_id ? BigInt(page_id) : undefined,
    );
  }

  // ── OAuth: Facebook-managed pages — get available accounts ────────
  @Get('available-pages')
  getAvailablePages(@Query('token') token: string, @Request() req: any) {
    return this.service.getAvailablePages(this.ws(req), token);
  }

  // ── OAuth: connect a discovered Facebook-managed IG page ──────────
  @Post('connect-fb-page')
  connectFbPage(@Body() body: any, @Request() req: any) {
    return this.service.connectFbPage(this.ws(req), this.uid(req), body);
  }

  // ── Per-page: sync + feeder ───────────────────────────────────────
  @Post('pages/:id/sync')
  syncPage(@Param('id') id: string, @Request() req: any) {
    return this.service.syncPage(this.ws(req), BigInt(id));
  }

  @Post('pages/:id/toggle-feeder')
  toggleFeeder(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.service.toggleFeeder(this.ws(req), BigInt(id), !!body.enabled);
  }

  // ── Ice Breakers ──────────────────────────────────────────────────
  @Get('pages/:id/ice-breakers')
  getIceBreakers(@Param('id') id: string, @Request() req: any) {
    return this.service.getIceBreakers(this.ws(req), BigInt(id));
  }

  @Post('pages/:id/ice-breakers')
  saveIceBreakers(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.service.saveIceBreakers(this.ws(req), BigInt(id), body.items ?? []);
  }

  @Delete('pages/:id/ice-breakers')
  deleteIceBreakers(@Param('id') id: string, @Request() req: any) {
    return this.service.deleteIceBreakers(this.ws(req), BigInt(id));
  }

  // ── Persistent Menu ───────────────────────────────────────────────
  @Get('pages/:id/menu')
  getMenu(@Param('id') id: string, @Request() req: any) {
    return this.service.getMenu(this.ws(req), BigInt(id));
  }

  @Post('pages/:id/menu')
  saveMenu(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.service.saveMenu(this.ws(req), BigInt(id), body.items ?? []);
  }

  @Delete('pages/:id/menu')
  deleteMenu(@Param('id') id: string, @Request() req: any) {
    return this.service.deleteMenu(this.ws(req), BigInt(id));
  }

  // ── Auto Reply ────────────────────────────────────────────────────
  @Get('pages/:id/auto-reply')
  getAutoReply(@Param('id') id: string, @Request() req: any) {
    return this.service.getAutoReply(this.ws(req), BigInt(id));
  }

  @Post('pages/:id/auto-reply')
  setAutoReply(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.service.setAutoReply(
      this.ws(req),
      BigInt(id),
      body.automation_id ?? null,
      body.interval ?? '247',
    );
  }

  // ── Story Mention ─────────────────────────────────────────────────
  @Get('pages/:id/story-mention')
  getStoryMention(@Param('id') id: string, @Request() req: any) {
    return this.service.getStoryMention(this.ws(req), BigInt(id));
  }

  @Post('pages/:id/story-mention')
  setStoryMention(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.service.setStoryMention(this.ws(req), BigInt(id), {
      automationId: body.automation_id ?? null,
    });
  }

  @Delete('pages/:id/story-mention')
  deleteStoryMention(@Param('id') id: string, @Request() req: any) {
    return this.service.deleteStoryMention(this.ws(req), BigInt(id));
  }

  // ── Page Users ────────────────────────────────────────────────────
  @Get('pages/:id/users')
  getPageUsers(@Param('id') id: string, @Request() req: any) {
    return this.service.getPageUsers(this.ws(req), BigInt(id));
  }

  @Post('pages/:id/users')
  setPageUsers(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.service.setPageUsers(this.ws(req), BigInt(id), body.user_ids ?? []);
  }
}
