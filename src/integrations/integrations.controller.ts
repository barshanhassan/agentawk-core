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
import { IntegrationsService } from './integrations.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly service: IntegrationsService) {}

  @Get()
  async getAllIntegrations(@Request() req: any) {
    return this.service.getAllIntegrations(BigInt(req.user.workspace_id || 1));
  }

  @Get('type/:type')
  async getIntegrationByType(@Param('type') type: string, @Request() req: any) {
    return this.service.getIntegrationByType(
      BigInt(req.user.workspace_id || 1),
      type,
    );
  }

  @Post()
  async createIntegration(@Body() body: any, @Request() req: any) {
    return this.service.createIntegration(
      BigInt(req.user.workspace_id || 1),
      body,
    );
  }

  @Patch(':id')
  async updateIntegration(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    return this.service.updateIntegration(
      BigInt(req.user.workspace_id || 1),
      BigInt(id),
      body,
    );
  }

  @Delete(':id')
  async removeIntegration(@Param('id') id: string, @Request() req: any) {
    return this.service.removeIntegration(
      BigInt(req.user.workspace_id || 1),
      BigInt(id),
    );
  }

  // ─── Type Specific Endpoints ──────────────────────────────────────

  @Get('active-campaign/:account_id/data')
  async getActiveCampaignData(
    @Param('account_id') accountId: string,
    @Request() req: any,
  ) {
    return this.service.getActiveCampaignData(
      BigInt(req.user.workspace_id || 1),
      BigInt(accountId),
    );
  }

  @Get('cloudinary/folders')
  async getCloudinaryFolders(@Request() req: any) {
    return this.service.getCloudinaryFolders(
      BigInt(req.user.workspace_id || 1),
    );
  }

  @Get('channels')
  async getChannels(@Request() req: any) {
    return this.service.getChannels(BigInt(req.user.workspace_id || 1));
  }

  @Delete('channels/:type/:id')
  async deleteChannel(
    @Param('id') id: string,
    @Param('type') type: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    return this.service.deleteChannel(
      BigInt(req.user.workspace_id || 1),
      type,
      BigInt(id),
      !!body?.delete_media,
    );
  }

  // ─── API Keys ──────────────────────────────────────────────────────

  @Get('api-keys')
  async getApiKeys(@Request() req: any) {
    return this.service.getApiKeys(BigInt(req.user.workspace_id || 1));
  }

  @Post('api-keys')
  async generateApiKey(@Body('name') name: string, @Request() req: any) {
    return this.service.generateApiKey(BigInt(req.user.workspace_id || 1), name);
  }

  @Delete('api-keys/:id')
  async deleteApiKey(@Param('id') id: string, @Request() req: any) {
    return this.service.deleteApiKey(BigInt(id), BigInt(req.user.workspace_id || 1));
  }

  // ─── Visual API Triggers ───────────────────────────────────────────
  // Routes mirror replyagent's `ApiTriggersController.php`. We keep the
  // EZCONN paths RESTful (GET/POST/PATCH/DELETE on `/api-triggers`) and the
  // public webhook still lives at `/api-triggers/webhook/:slug` (see
  // ApiTriggersPublicController).

  @Get('api-triggers')
  async getApiTriggers(@Request() req: any) {
    return this.service.getApiTriggers(BigInt(req.user.workspace_id || 1));
  }

  /** Single-trigger fetch used by the Manage view to pull full
   *  mapping/mapped_keys/new_keys/tags. */
  @Get('api-triggers/:id')
  async getApiTrigger(@Param('id') id: string, @Request() req: any) {
    return this.service.getApiTrigger(BigInt(req.user.workspace_id || 1), BigInt(id));
  }

  @Post('api-triggers')
  async createApiTrigger(@Body() body: any, @Request() req: any) {
    return this.service.createApiTrigger(
      BigInt(req.user.workspace_id || 1),
      BigInt(req.user.sub || req.user.id || 0),
      body,
    );
  }

  @Patch('api-triggers/:id')
  async updateApiTrigger(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.service.updateApiTrigger(
      BigInt(id),
      BigInt(req.user.workspace_id || 1),
      BigInt(req.user.sub || req.user.id || 0),
      body,
    );
  }

  @Delete('api-triggers/:id')
  async deleteApiTrigger(@Param('id') id: string, @Request() req: any) {
    return this.service.deleteApiTrigger(BigInt(id), BigInt(req.user.workspace_id || 1));
  }

  @Get('api-triggers/:id/logs')
  async getApiTriggerLogs(
    @Param('id') id: string,
    @Query('page') page: string,
    @Query('limit') limit: string,
    @Request() req: any,
  ) {
    return this.service.getApiTriggerLogs(
      BigInt(id),
      BigInt(req.user.workspace_id || 1),
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }
}
