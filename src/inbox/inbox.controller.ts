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

@UseGuards(JwtAuthGuard)
@Controller('inbox')
export class InboxController {
  constructor(private readonly service: InboxService) {}

  @Post('list')
  async getInboxList(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const filters = body || {};
    
    if (filters.mode === 'COUNT') {
      return this.service.getInboxCounts(workspaceId, filters);
    }
    
    return this.service.getInboxList(workspaceId, filters);
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

  @Post('send-message/:id')
  async sendMessage(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const userId = BigInt(req.user.sub || 1);
    return this.service.sendMessage(BigInt(id), body, userId);
  }

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
    const until = new Date(body.until);
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
    return this.service.assignConversation({ ...body, inbox_id: id }, workspaceId, userId);
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
    const userId = BigInt(req.user.sub || 1);
    const ids = body.inbox_ids.map((id: string) => BigInt(id));
    return this.service.assignConversationBulk(
      ids,
      body.assigned_to ? BigInt(body.assigned_to) : null,
      workspaceId,
    );
  }

  @Post('move-to-folder')
  async moveToFolder(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const ids = body.inbox_ids.map((id: string) => BigInt(id));
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
}
