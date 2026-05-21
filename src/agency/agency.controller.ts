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
import { AgencyService } from './agency.service';
import { RolesService } from '../roles/roles.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RequirePermission } from '../auth/permissions.decorator';

@UseGuards(JwtAuthGuard)
@Controller('agencies')
export class AgencyController {
  constructor(
    private readonly service: AgencyService,
    private readonly rolesService: RolesService,
  ) {}

  // ─── Agency Profile ────────────────────────────────────────────────
  
  @Get(':id')
  async getAgency(@Param('id') id: string) {
    return this.service.getAgency(BigInt(id));
  }


  @Patch(':id')
  @RequirePermission('agency.settings.branding')
  async updateAgency(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    body.user_id = BigInt(req.user.sub);
    return this.service.updateAgency(BigInt(id), body);
  }

  @Patch(':id/billing')
  @RequirePermission('agency.settings.billing')
  async updateBillingAddress(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    body.user_id = BigInt(req.user.sub);
    return this.service.updateBillingAddress(BigInt(id), body);
  }

  @Patch(':id/branding')
  @RequirePermission('agency.settings.branding')
  async updateBranding(@Param('id') id: string, @Body() body: any) {
    return this.service.updateBranding(BigInt(id), body);
  }

  @Post(':id/workspaces/checkout')
  @RequirePermission('agency.workspace.add')
  async workspaceCheckout(@Param('id') id: string, @Body() body: any) {
    return this.service.workspaceCheckout(BigInt(id), body);
  }

  @Get(':id/workspaces')
  @RequirePermission('agency.workspace.*')
  async getWorkspaces(@Param('id') id: string) {
    return this.service.getWorkspaces(BigInt(id));
  }


  @Post(':id/workspaces')
  @RequirePermission('agency.workspace.add')
  async createWorkspace(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const creatorId = req.user.sub || req.user.id || 0;
    return this.service.createWorkspace(BigInt(id), body, BigInt(creatorId));
  }

  @Patch(':id/workspaces/:workspace_id')
  @RequirePermission('agency.workspace.edit')
  async updateWorkspace(
    @Param('id') id: string,
    @Param('workspace_id') workspaceId: string,
    @Body() body: any,
  ) {
    return this.service.updateWorkspace(BigInt(workspaceId), BigInt(id), body);
  }

  @Post(':id/workspaces/:workspace_id/suspend')
  @RequirePermission('agency.workspace.edit')
  async suspendWorkspace(
    @Param('id') id: string,
    @Param('workspace_id') workspaceId: string,
  ) {
    return this.service.suspendWorkspace(BigInt(workspaceId), BigInt(id));
  }

  @Post(':id/workspaces/:workspace_id/activate')
  @RequirePermission('agency.workspace.edit')
  async activateWorkspace(
    @Param('id') id: string,
    @Param('workspace_id') workspaceId: string,
  ) {
    return this.service.activateWorkspace(BigInt(workspaceId), BigInt(id));
  }

  @Delete(':id/workspaces/:workspace_id')
  @RequirePermission('agency.workspace.delete')
  async deleteWorkspace(
    @Param('id') id: string,
    @Param('workspace_id') workspaceId: string,
  ) {
    return this.service.deleteWorkspace(BigInt(workspaceId), BigInt(id));
  }

  @Get(':id/workspaces/:workspace_id/usage')
  @RequirePermission('agency.workspace.*')
  async getWorkspaceUsage(
    @Param('id') id: string,
    @Param('workspace_id') workspaceId: string,
  ) {
    return this.service.getWorkspaceUsage(BigInt(workspaceId), BigInt(id));
  }

  // ─── Member Management ──────────────────────────────────────────────

  @Get(':id/members')
  @RequirePermission('agency.users.*')
  async members(@Param('id') id: string) {
    return this.service.members(BigInt(id));
  }

  @Get(':id/members/:member_id')
  @RequirePermission('agency.users.*')
  async getMember(
    @Param('id') id: string,
    @Param('member_id') memberId: string,
  ) {
    return this.service.getMember(BigInt(id), BigInt(memberId));
  }

  @Post(':id/members')
  @RequirePermission('agency.users.add')
  async addMember(@Param('id') id: string, @Body() body: any) {
    return this.service.addMember(BigInt(id), body);
  }

  @Patch(':id/members/:member_id')
  @RequirePermission('agency.users.edit')
  async updateMember(
    @Param('id') id: string,
    @Param('member_id') memberId: string,
    @Body() body: any,
  ) {
    return this.service.updateMember(BigInt(id), BigInt(memberId), body);
  }

  @Delete(':id/members/:member_id')
  @RequirePermission('agency.users.delete')
  async removeMember(
    @Param('id') id: string,
    @Param('member_id') memberId: string,
  ) {
    return this.service.removeMember(BigInt(id), BigInt(memberId));
  }

  @Post(':id/members/:member_id/suspend')
  @RequirePermission('agency.users.edit')
  async suspendMember(
    @Param('id') id: string,
    @Param('member_id') memberId: string,
  ) {
    return this.service.suspendMember(BigInt(id), BigInt(memberId));
  }

  @Post(':id/members/:member_id/activate')
  @RequirePermission('agency.users.edit')
  async activateMember(
    @Param('id') id: string,
    @Param('member_id') memberId: string,
  ) {
    return this.service.activateMember(BigInt(id), BigInt(memberId));
  }

  // ─── Logs ──────────────────────────────────────────────────────────

  @Get(':id/audit-logs')
  @RequirePermission('agency.settings.audit_logs')
  async getAuditLogs(@Param('id') id: string, @Query() q: any) {
    return this.service.getAuditLogs(BigInt(id), q);
  }

  @Get(':id/agency-logs')
  @RequirePermission('agency.settings.audit_logs')
  async getAgencyLogs(@Param('id') id: string, @Query() q: any) {
    return this.service.getAgencyLogs(BigInt(id), q);
  }

  @Get(':id/dashboard-stats')
  async getDashboardStats(@Param('id') id: string, @Request() req: any) {
    return this.service.getDashboardStats(BigInt(id), req.user);
  }

  // ─── Agency Permissions Tree ───────────────────────────────────────
  // Open to any authenticated agency user — needed by the role-edit UI itself,
  // so role-management users (acl.*) can see the full perm tree to assign.
  @Get(':id/permissions')
  async getPermissions(@Param('id') id: string) {
    return this.rolesService.getPermissionsTree('agency.*');
  }

  // ─── Agency Roles ──────────────────────────────────────────────────
  @Get(':id/roles')
  @RequirePermission('agency.acl.*')
  async getRoles(@Param('id') id: string) {
    return this.rolesService.getRoles(BigInt(id), 'App\\Models\\Agency');
  }

  @Post(':id/roles')
  @RequirePermission('agency.acl.add')
  async createRole(@Param('id') id: string, @Body() data: any) {
    console.log(`[DEBUG] Creating role for agency ${id}:`, data);
    return this.rolesService.createRole(BigInt(id), 'App\\Models\\Agency', data);
  }

  @Patch(':id/roles/:roleId')
  @RequirePermission('agency.acl.edit')
  async updateRole(@Param('id') id: string, @Param('roleId') roleId: string, @Body() data: any) {
    return this.rolesService.updateRole(BigInt(id), 'App\\Models\\Agency', BigInt(roleId), data);
  }

  @Delete(':id/roles/:roleId')
  @RequirePermission('agency.acl.delete')
  async deleteRole(@Param('id') id: string, @Param('roleId') roleId: string) {
    return this.rolesService.deleteRole(BigInt(id), 'App\\Models\\Agency', BigInt(roleId));
  }
}
