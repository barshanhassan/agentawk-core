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

  /**
   * Create a WhatsApp message template on Meta + persist it locally.
   * Body: { wa_account_id?, name, category, language, header?, body, footer?,
   *         buttons?, examples? }.
   */
  @Post('templates')
  async createTemplate(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.createTemplate(workspaceId, body);
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

  /**
   * Edit + resubmit a rejected/paused template for re-approval.
   * Body mirrors createTemplate (body, header?, footer?, buttons?, examples?);
   * name + language are immutable and taken from the stored template.
   */
  @Patch('templates/:id')
  async updateTemplate(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.updateTemplate(workspaceId, BigInt(id), body);
  }

  /**
   * Persist an edited authoring structure (variable → value mapping, media
   * record) and rebuild the send payload from it. Mirrors replyagent
   * `POST /wa/template/structure/{template_id}`. Does NOT resubmit to Meta —
   * this is how an imported/approved template gets made sendable.
   * Body: `{ structure: { ...components, header_component, body_component, … } }`
   */
  @Post('templates/:id/structure')
  async saveStructure(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.saveStructure(workspaceId, BigInt(id), body?.structure ?? body);
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
