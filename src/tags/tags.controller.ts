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
import { TagsService } from './tags.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('tags')
export class TagsController {
  constructor(private readonly service: TagsService) {}

  @Get('list')
  async getTagList(@Query() query: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getTagList(workspaceId, query);
  }

  @Get('data')
  async getTagData(@Query() query: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getTagData(workspaceId, query);
  }

  @Post()
  async createTag(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 1);
    return this.service.createTag(workspaceId, userId, body);
  }

  @Post('link')
  async linkTag(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 0);
    return this.service.linkTag(workspaceId, userId, body);
  }

  @Get(':id/links')
  async getTagLinks(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getTagLinks(workspaceId, BigInt(id));
  }

  @Delete('unlink/:linkId')
  async unlinkTag(@Param('linkId') linkId: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 0);
    return this.service.unlinkTag(workspaceId, userId, BigInt(linkId));
  }

  @Patch(':id')
  async updateTag(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.updateTag(workspaceId, BigInt(id), body);
  }

  @Delete(':id')
  async deleteTag(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 0);
    return this.service.deleteTag(workspaceId, userId, BigInt(id));
  }

  // ─── Folder Management ──────────────────────────────────────────────

  @Get('folders')
  async getFolders(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getFolders(workspaceId);
  }

  @Post('folder')
  async createFolder(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.createFolder(workspaceId, body);
  }

  @Post('change-folder')
  async changeFolder(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.changeFolder(
      workspaceId,
      BigInt(body.tag_id),
      body.folder_id ? BigInt(body.folder_id) : null,
    );
  }

  @Delete('folder/:id')
  async deleteFolder(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.deleteFolder(workspaceId, BigInt(id));
  }
}
