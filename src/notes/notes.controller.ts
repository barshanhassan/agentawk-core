import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Query,
  UseGuards,
  Request,
  Param,
} from '@nestjs/common';
import { NotesService } from './notes.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('notes')
export class NotesController {
  constructor(private readonly service: NotesService) {}

  @Post()
  async createNote(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 1);
    return this.service.createNote(body, workspaceId, userId);
  }

  @Post('chat')
  async addChatNote(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 1);
    return this.service.addChatNote(body, workspaceId, userId);
  }

  @Get('backup/:c_id')
  async getNotesBackup(@Param('c_id') contactId: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getNotesBackup(BigInt(contactId), workspaceId);
  }

  @Get(':c_id')
  async getNotes(
    @Param('c_id') contactId: string,
    @Query() params: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getNotes(BigInt(contactId), workspaceId, params);
  }

  @Delete(':id')
  async deleteNote(@Param('id') noteId: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 1);
    return this.service.deleteNote(BigInt(noteId), workspaceId, userId);
  }

  /**
   * Replyagent parity: GET /note/timeline/:c_id — activity feed combining
   * CRM notes + inbox messages across every channel for the contact.
   */
  @Get('timeline/:c_id')
  async getTimeline(
    @Param('c_id') contactId: string,
    @Query() params: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getTimeline(BigInt(contactId), workspaceId, params);
  }
}
