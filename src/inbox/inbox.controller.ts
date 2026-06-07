import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Query,
  UseGuards,
  Request,
  Param,
} from '@nestjs/common';
import { InboxService } from './inbox.service';
import { JwtAuthGuard } from '../auth/auth.guard';

/**
 * `/api/inbox/*` — full replyagent parity surface.
 *
 * Endpoint groups:
 *   - list / count / item / messages           → reads
 *   - send / react / seen                      → outbound + read receipts
 *   - status / assign / snooze / move-to-folder→ conversation lifecycle
 *   - reminder/* (schedule/send-now/cancel)    → 24h-window reminders
 *   - automate / start-whatsapp-chat /
 *     start-zapi-chat / transform-ai           → assist + new-chat flows
 *   - folders/*                                → user-defined groupings
 *   - delete (inbox/message/bulk)              → destructive ops
 *   - profile-action                           → tag/note/task from chat
 */
@UseGuards(JwtAuthGuard)
@Controller('inbox')
export class InboxController {
  constructor(private readonly service: InboxService) {}

  // ─── List + counts ─────────────────────────────────────────────────

  @Post('list')
  async getInboxList(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || req.user.id || 0);
    const filters = body || {};

    if (filters.mode === 'COUNT') {
      return this.service.getInboxCounts(workspaceId, filters);
    }
    return this.service.getInboxList(workspaceId, { ...filters, current_user_id: userId });
  }

  @Post('count')
  async getInboxCount(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getInboxCounts(workspaceId, body || {});
  }

  @Get('item/:id')
  async getInboxItem(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getInboxItem(BigInt(id), workspaceId);
  }

  @Post('messages/:id')
  async getChatMessages(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    return this.service.getChatMessages(BigInt(id), body);
  }

  @Get('get-profile-data/:id')
  async getProfileData(@Param('id') id: string) {
    return this.service.getProfileData(BigInt(id));
  }

  // ─── Send / react / seen ───────────────────────────────────────────

  @Post('send-message/:id')
  async sendMessage(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const userId = BigInt(req.user.sub || 1);
    return this.service.sendMessage(BigInt(id), body, userId);
  }

  @Post('seen/:id')
  async markAsSeen(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.markAsSeen(BigInt(id), workspaceId);
  }

  @Post('react/:inboxId/:messageId')
  async reactToMessage(
    @Param('inboxId') inboxId: string,
    @Param('messageId') messageId: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 1);
    return this.service.reactToMessage(
      BigInt(inboxId),
      BigInt(messageId),
      workspaceId,
      userId,
      body,
    );
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  @Post('update-inbox-status')
  async updateInboxStatus(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.updateInboxStatus(
      BigInt(body.inbox_id),
      body.status,
      workspaceId,
    );
  }

  @Patch('snooze/:id')
  async snoozeConversation(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const until = body.until ? new Date(body.until) : null;
    return this.service.snoozeConversation(BigInt(id), until, workspaceId);
  }

  @Patch('assign/:id')
  async assignConversation(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.id || req.user.sub || 1);
    return this.service.assignConversation(
      { ...body, inbox_id: id },
      workspaceId,
      userId,
    );
  }

  @Patch('status/:id')
  async updateStatus(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.updateInboxStatus(BigInt(id), body.status, workspaceId);
  }

  @Post('assign-conversation-bulk')
  async assignConversationBulk(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const ids = (body.inbox_ids ?? []).map((id: string) => BigInt(id));
    return this.service.assignConversationBulk(
      ids,
      body.assigned_to ? BigInt(body.assigned_to) : null,
      workspaceId,
    );
  }

  // ─── Folders ───────────────────────────────────────────────────────

  @Post('move-to-folder')
  async moveToFolder(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const ids = (body.inbox_ids ?? []).map((id: string) => BigInt(id));
    return this.service.moveToFolder(
      ids,
      body.folder_id ? BigInt(body.folder_id) : null,
      workspaceId,
    );
  }

  @Get('folders')
  async getFolders(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.listFolders(workspaceId);
  }

  @Post('folders')
  async createFolder(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.createFolder(workspaceId, {
      name: body.name,
      assign_to: body.assign_to ?? null,
      assigned_to: body.assigned_to ? BigInt(body.assigned_to) : null,
    });
  }

  @Patch('folders/:id')
  async updateFolder(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.updateFolder(workspaceId, BigInt(id), {
      name: body.name,
      assign_to: body.assign_to ?? null,
      assigned_to: body.assigned_to ? BigInt(body.assigned_to) : null,
    });
  }

  @Delete('folders/:id')
  async deleteFolder(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.deleteFolder(workspaceId, BigInt(id));
  }

  // ─── Reminders (24h-window WhatsApp + Telegram + Z-API) ────────────

  @Post('reminder')
  async scheduleReminder(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 1);
    return this.service.scheduleReminder(workspaceId, userId, body);
  }

  @Post('reminder/send')
  async sendReminderNow(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.sendReminderNow(workspaceId, body);
  }

  @Delete('reminder')
  async cancelReminder(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.cancelReminder(workspaceId, body);
  }

  // ─── Assist / new-chat / AI ────────────────────────────────────────

  @Post('automate')
  async automate(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 1);
    return this.service.automate(workspaceId, userId, body);
  }

  @Post('start-whatsapp-chat')
  async startWhatsappChat(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 1);
    return this.service.startWhatsappChat(workspaceId, userId, body);
  }

  @Post('start-zapi-chat')
  async startZapiChat(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 1);
    return this.service.startZapiChat(workspaceId, userId, body);
  }

  @Post('transform-ai')
  async transformAi(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.transformAi(workspaceId, body);
  }

  // ─── Destructive (inbox / messages / bulk) ─────────────────────────

  @Post('delete/:id')
  async deleteInbox(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.deleteInbox(BigInt(id), workspaceId);
  }

  @Delete('chats')
  async deleteChats(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const ids = (body.inbox_ids ?? []).map((id: string) => BigInt(id));
    return this.service.deleteChats(workspaceId, ids);
  }

  @Post('message/delete')
  async deleteMessage(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.deleteMessage(workspaceId, body);
  }

  // ─── Misc ──────────────────────────────────────────────────────────

  @Post('profile-action/:id')
  async profileAction(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 1);
    return this.service.profileAction(BigInt(id), workspaceId, userId, body);
  }
}
