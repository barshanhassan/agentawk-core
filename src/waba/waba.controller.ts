import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  Request,
  Query,
} from '@nestjs/common';
import { WabaService } from './waba.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('waba')
export class WabaController {
  constructor(private readonly service: WabaService) {}

  @Get('templates')
  async getTemplates(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getTemplates(workspaceId);
  }

  @Get('templates/stats')
  async getStats(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getTemplateStatistics(workspaceId);
  }

  @Get('templates/:id')
  async getTemplate(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getTemplate(BigInt(id), workspaceId);
  }

  @Delete('templates/:id')
  async deleteTemplate(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.deleteTemplate(BigInt(id), workspaceId);
  }

  /**
   * Fetch authoritative template list from Meta Graph API and upsert local
   * wa_templates rows. Idempotent — safe to call any time.
   */
  @Post('templates/sync')
  async syncTemplates(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.syncTemplatesFromMeta(workspaceId);
  }
}
