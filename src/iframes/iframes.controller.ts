import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { IframesService } from './iframes.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('iframes')
export class IframesController {
  constructor(private readonly service: IframesService) {}

  @Get()
  async getIframes(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getIframes(workspaceId);
  }

  @Get(':id')
  async getIframe(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getIframe(workspaceId, BigInt(id));
  }

  @Post()
  async saveIframe(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 0);
    return this.service.saveIframe(workspaceId, userId, body);
  }

  @Patch(':id')
  async updateIframe(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 0);
    return this.service.saveIframe(workspaceId, userId, { ...body, id });
  }

  @Post('menu-title')
  async updateMenuTitle(@Body('title') title: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 0);
    return this.service.updateMenuTitle(workspaceId, userId, title);
  }

  @Post(':id/permissions')
  async setPermissions(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 0);
    const permissions = Array.isArray(body?.permissions) ? body.permissions : [];
    const userIds: bigint[] = permissions
      .map((p: any) => p?.user_id ?? p?.id ?? p)
      .filter((x: any) => x !== undefined && x !== null)
      .map((x: any) => BigInt(x));
    return this.service.setPermissions(workspaceId, userId, BigInt(id), userIds);
  }

  @Delete(':id')
  async deleteIframe(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || 0);
    return this.service.deleteIframe(workspaceId, userId, BigInt(id));
  }
}
