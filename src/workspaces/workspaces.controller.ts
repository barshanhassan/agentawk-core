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
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { WorkspacesService } from './workspaces.service';
import {
  BrandingMediaService,
  LogoType,
} from '../agency/branding-media.service';
import { DomainsService } from '../domains/domains.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Logger } from '@nestjs/common';

@UseGuards(JwtAuthGuard)
@Controller('workspaces')
export class WorkspacesController {
  private readonly logger = new Logger(WorkspacesController.name);
  constructor(
    private readonly service: WorkspacesService,
    private readonly brandingMedia: BrandingMediaService,
    private readonly domainsService: DomainsService,
  ) {}

  // ─── Workspace Domain (Gateway parity: POST /w/{workspace}/domain) ──

  @Post('domain')
  async addCustomDomain(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.domainsService.addCustomDomain(
      workspaceId,
      'WORKSPACE',
      body.sub_domain,
      body.root_domain,
      BigInt(req.user.sub),
    );
  }

  // ─── Workspace Logo / Favicon (Gateway parity: /w/{workspace}/logo etc.) ──

  @Post('logo')
  @UseInterceptors(FileInterceptor('logo'))
  async uploadLogo(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.brandingMedia.uploadLogo(
      file,
      body.logo_id as LogoType,
      body.canvas_data,
      'WORKSPACE',
      workspaceId,
      workspaceId,
      BigInt(req.user.sub),
    );
  }

  @Post('logo/update')
  async updateLogo(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.brandingMedia.updateLogo(
      BigInt(body.media_id),
      body.logo_id as LogoType,
      'WORKSPACE',
      workspaceId,
      BigInt(req.user.sub),
    );
  }

  @Delete('logo/:logo_type')
  async removeLogo(
    @Param('logo_type') logoType: string,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.brandingMedia.removeLogo(
      logoType as LogoType,
      'WORKSPACE',
      workspaceId,
    );
  }

  @Post('favicon')
  @UseInterceptors(FileInterceptor('favicon'))
  async uploadFavicon(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.brandingMedia.uploadFavicon(
      file,
      body.canvas_data,
      'WORKSPACE',
      workspaceId,
      workspaceId,
      BigInt(req.user.sub),
    );
  }

  @Post('favicon/update')
  async updateFavicon(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.brandingMedia.updateFavicon(
      BigInt(body.media_id),
      'WORKSPACE',
      workspaceId,
      BigInt(req.user.sub),
    );
  }

  @Delete('favicon')
  async removeFavicon(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.brandingMedia.removeFavicon('WORKSPACE', workspaceId);
  }

  @Get('current')
  async getWorkspace(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getWorkspace(workspaceId);
  }

  @Patch('current')
  async updateWorkspace(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.updateWorkspace(workspaceId, body);
  }

  @Get('live-chat-settings')
  async getLiveChatSettings(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getLiveChatSettings(workspaceId);
  }

  @Patch('live-chat-settings')
  async updateLiveChatSettings(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.updateLiveChatSettings(workspaceId, body);
  }

  @Get('branding')
  async getBranding(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getWorkspaceBranding(workspaceId);
  }

  @Patch('branding')
  async updateBranding(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.updateWorkspaceBranding(workspaceId, body);
  }

  @Get('members')
  async getMembers(@Query() query: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getMembers(workspaceId, query);
  }

  @Post('members')
  async addMember(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const creatorId = BigInt(req.user.id || 1);
    return this.service.addMember(workspaceId, creatorId, body);
  }

  @Delete('members/:id')
  async deleteMember(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.deleteMember(workspaceId, BigInt(id));
  }

  @Patch('members/:id')
  async updateMember(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.updateMember(workspaceId, BigInt(id), body);
  }

  @Get('all-roles')
  async getRoles(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getRoles(workspaceId);
  }

  @Post('create-role')
  async createRole(@Body() body: any, @Request() req: any) {
    this.logger.log('Create role called with body: ' + JSON.stringify(body));
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.createRole(workspaceId, body);
  }

  @Patch('roles/:id')
  async updateRole(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.updateRole(workspaceId, BigInt(id), body);
  }

  @Delete('roles/:id')
  async deleteRole(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.deleteRole(workspaceId, BigInt(id));
  }

  @Get('business-hours')
  async getBusinessHours(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.id || 1);
    return this.service.getBusinessHours(workspaceId, userId);
  }

  @Post('business-hours')
  async updateBusinessHours(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.id || 1);
    return this.service.updateBusinessHours(workspaceId, userId, body);
  }

  @Get('ai-assistant-settings')
  async getAIAssistantSettings(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.id || 1);
    return this.service.getAIAssistantSettings(workspaceId, userId);
  }

  @Post('ai-assistant-settings')
  async updateAIAssistantSettings(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.id || 1);
    return this.service.updateAIAssistantSettings(workspaceId, userId, body);
  }

  @Get('password-policy')
  async getPasswordPolicy(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.id || 1);
    return this.service.getPasswordPolicy(workspaceId, userId);
  }

  @Post('password-policy')
  async updatePasswordPolicy(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.id || 1);
    return this.service.updatePasswordPolicy(workspaceId, userId, body);
  }

  @Get('developer-settings')
  async getDeveloperSettings(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.id || 1);
    return this.service.getDeveloperSettings(workspaceId, userId);
  }

  @Post('developer-settings')
  async updateDeveloperSettings(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.id || 1);
    return this.service.updateDeveloperSettings(workspaceId, userId, body);
  }
}
