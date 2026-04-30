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
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AgencyService } from './agency.service';
import { WhiteLabelBillingService } from '../billing/white-label-billing.service';
import { BrandingMediaService, LogoType } from './branding-media.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('agencies')
export class AgencyController {
  constructor(
    private readonly service: AgencyService,
    private readonly whiteLabelBilling: WhiteLabelBillingService,
    private readonly brandingMedia: BrandingMediaService,
  ) {}

  // ─── Agency Logo / Favicon (Gateway parity) ─────────────────────────

  @Post(':id/logo')
  @UseInterceptors(FileInterceptor('logo'))
  async uploadLogo(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
    @Request() req: any,
  ) {
    return this.brandingMedia.uploadLogo(
      file,
      body.logo_id as LogoType,
      body.canvas_data,
      'AGENCY',
      BigInt(id),
      BigInt(req.user.workspace_id || 1),
      BigInt(req.user.sub),
    );
  }

  @Post(':id/logo/update')
  async updateLogo(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    return this.brandingMedia.updateLogo(
      BigInt(body.media_id),
      body.logo_id as LogoType,
      'AGENCY',
      BigInt(id),
      BigInt(req.user.sub),
    );
  }

  @Delete(':id/logo/:logo_type')
  async removeLogo(
    @Param('id') id: string,
    @Param('logo_type') logoType: string,
  ) {
    return this.brandingMedia.removeLogo(
      logoType as LogoType,
      'AGENCY',
      BigInt(id),
    );
  }

  @Post(':id/favicon')
  @UseInterceptors(FileInterceptor('favicon'))
  async uploadFavicon(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
    @Request() req: any,
  ) {
    return this.brandingMedia.uploadFavicon(
      file,
      body.canvas_data,
      'AGENCY',
      BigInt(id),
      BigInt(req.user.workspace_id || 1),
      BigInt(req.user.sub),
    );
  }

  @Post(':id/favicon/update')
  async updateFavicon(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    return this.brandingMedia.updateFavicon(
      BigInt(body.media_id),
      'AGENCY',
      BigInt(id),
      BigInt(req.user.sub),
    );
  }

  @Delete(':id/favicon')
  async removeFavicon(@Param('id') id: string) {
    return this.brandingMedia.removeFavicon('AGENCY', BigInt(id));
  }

  // ─── Agency Profile ────────────────────────────────────────────────
  
  @Get(':id')
  async getAgency(@Param('id') id: string) {
    return this.service.getAgency(BigInt(id));
  }


  @Patch(':id')
  async updateAgency(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    body.user_id = BigInt(req.user.sub);
    return this.service.updateAgency(BigInt(id), body);
  }

  @Delete(':id')
  async deleteAgency(@Param('id') id: string) {
    return this.service.deleteAgency(BigInt(id));
  }

  @Patch(':id/billing')
  async updateBillingAddress(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    body.user_id = BigInt(req.user.sub);
    return this.service.updateBillingAddress(BigInt(id), body);
  }

  @Patch(':id/branding')
  async updateBranding(@Param('id') id: string, @Body() body: any) {
    return this.service.updateBranding(BigInt(id), body);
  }

  // ─── White-Label Billing ─────────────────────────────────────────────

  @Get('workspaces/:workspace_id/white-label/estimate')
  async estimateWhiteLabelCost(
    @Param('workspace_id') workspaceId: string,
  ) {
    return this.whiteLabelBilling.estimateWhiteLabelCost(BigInt(workspaceId));
  }

  @Post('workspaces/:workspace_id/white-label/enable')
  async enableWhiteLabel(
    @Param('workspace_id') workspaceId: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    return this.whiteLabelBilling.enableWhiteLabel(
      BigInt(workspaceId),
      body,
      BigInt(req.user.sub),
    );
  }

  @Delete('workspaces/:workspace_id/white-label')
  async disableWhiteLabel(
    @Param('workspace_id') workspaceId: string,
    @Request() req: any,
  ) {
    return this.whiteLabelBilling.disableWhiteLabel(
      BigInt(workspaceId),
      BigInt(req.user.sub),
    );
  }

  // ─── Workspace Branding (Gateway parity: /enable-branding /disable-branding) ──

  @Get(':id/workspaces/:workspace_id/enable-branding')
  async estimateBranding(
    @Param('id') id: string,
    @Param('workspace_id') workspaceId: string,
  ) {
    return this.whiteLabelBilling.estimateBrandingForWorkspace(
      BigInt(id),
      BigInt(workspaceId),
    );
  }

  @Post(':id/workspaces/:workspace_id/enable-branding')
  async enableBranding(
    @Param('id') id: string,
    @Param('workspace_id') workspaceId: string,
    @Request() req: any,
  ) {
    return this.whiteLabelBilling.enableBrandingForWorkspace(
      BigInt(id),
      BigInt(workspaceId),
      BigInt(req.user.sub),
    );
  }

  @Get(':id/workspaces/:workspace_id/disable-branding')
  async disableBranding(
    @Param('id') id: string,
    @Param('workspace_id') workspaceId: string,
    @Request() req: any,
  ) {
    return this.whiteLabelBilling.disableBrandingForWorkspace(
      BigInt(id),
      BigInt(workspaceId),
      BigInt(req.user.sub),
    );
  }

  @Post(':id/workspaces/checkout')
  async workspaceCheckout(@Param('id') id: string, @Body() body: any) {
    return this.service.workspaceCheckout(BigInt(id), body);
  }

  @Get(':id/workspaces')
  async getWorkspaces(@Param('id') id: string) {
    return this.service.getWorkspaces(BigInt(id));
  }


  @Post(':id/workspaces')
  async createWorkspace(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    return this.service.createWorkspace(BigInt(id), body, BigInt(req.user.sub));
  }

  @Patch(':id/workspaces/:workspace_id')
  async updateWorkspace(
    @Param('id') id: string,
    @Param('workspace_id') workspaceId: string,
    @Body() body: any,
  ) {
    return this.service.updateWorkspace(BigInt(workspaceId), BigInt(id), body);
  }

  @Post(':id/workspaces/:workspace_id/suspend')
  async suspendWorkspace(
    @Param('id') id: string,
    @Param('workspace_id') workspaceId: string,
  ) {
    return this.service.suspendWorkspace(BigInt(workspaceId), BigInt(id));
  }

  @Post(':id/workspaces/:workspace_id/activate')
  async activateWorkspace(
    @Param('id') id: string,
    @Param('workspace_id') workspaceId: string,
  ) {
    return this.service.activateWorkspace(BigInt(workspaceId), BigInt(id));
  }

  @Delete(':id/workspaces/:workspace_id')
  async deleteWorkspace(
    @Param('id') id: string,
    @Param('workspace_id') workspaceId: string,
  ) {
    return this.service.deleteWorkspace(BigInt(workspaceId), BigInt(id));
  }

  @Get(':id/workspaces/:workspace_id/usage')
  async getWorkspaceUsage(
    @Param('id') id: string,
    @Param('workspace_id') workspaceId: string,
  ) {
    return this.service.getWorkspaceUsage(BigInt(workspaceId), BigInt(id));
  }

  // ─── Member Management ──────────────────────────────────────────────

  @Get(':id/members')
  async members(@Param('id') id: string) {
    return this.service.members(BigInt(id));
  }

  @Get(':id/members/:member_id')
  async getMember(
    @Param('id') id: string,
    @Param('member_id') memberId: string,
  ) {
    return this.service.getMember(BigInt(id), BigInt(memberId));
  }

  @Post(':id/members')
  async addMember(@Param('id') id: string, @Body() body: any) {
    return this.service.addMember(BigInt(id), body);
  }

  @Patch(':id/members/:member_id')
  async updateMember(
    @Param('id') id: string,
    @Param('member_id') memberId: string,
    @Body() body: any,
  ) {
    return this.service.updateMember(BigInt(id), BigInt(memberId), body);
  }

  @Delete(':id/members/:member_id')
  async removeMember(
    @Param('id') id: string,
    @Param('member_id') memberId: string,
  ) {
    return this.service.removeMember(BigInt(id), BigInt(memberId));
  }

  // ─── Logs ──────────────────────────────────────────────────────────

  @Get(':id/audit-logs')
  async getAuditLogs(
    @Param('id') id: string,
    @Query('workspace_id') workspaceId: string,
    @Query() query: any,
  ) {
    return this.service.getAuditLogs(BigInt(workspaceId || 1), query);
  }

  @Post(':id/audit-logs')
  async postAuditLogs(
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.service.getAuditLogs(BigInt(body.workspace_id || 1), body);
  }

  @Get(':id/agency-logs')
  async getAgencyLogs(
    @Param('id') id: string,
    @Query() query: any,
  ) {
    return this.service.getAgencyLogs(BigInt(id), query);
  }

  @Post(':id/agency-logs')
  async postAgencyLogs(
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.service.getAgencyLogs(BigInt(id), body);
  }
}
