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
import { WorkspacesService } from './workspaces.service';
import { PlanFeaturesService } from './plan-features.service';
import { RolesService } from '../roles/roles.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Logger } from '@nestjs/common';

const WORKSPACE_OWNER = 'App\\Models\\Workspace';

@UseGuards(JwtAuthGuard)
@Controller('workspaces')
export class WorkspacesController {
  private readonly logger = new Logger(WorkspacesController.name);
  constructor(
    private readonly service: WorkspacesService,
    private readonly rolesService: RolesService,
    private readonly planFeatures: PlanFeaturesService,
  ) {}

  @Get('current')
  async getWorkspace(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getWorkspace(workspaceId);
  }

  /**
   * Plan-level feature flags. Resolved by following the billing chain
   * (workspace → agency → active subscription → billing_plan). Frontend
   * calls this from Developer Settings to know whether to show the
   * upgrade-prompt card vs the live API token UI.
   */
  @Get('plan-features')
  async getPlanFeatures(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.planFeatures.getForWorkspace(workspaceId);
  }

  // Workspaces the logged-in user can switch to (for the workspace switcher).
  @Get('accessible')
  async getAccessibleWorkspaces(@Request() req: any) {
    return this.service.getAccessibleWorkspaces(req.user);
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

  // Roles & Permissions — delegated to the shared RolesService (same engine as agency),
  // scoped to this workspace. Real acl_permissions tree + acl_role_permissions persistence.
  @Get('all-roles')
  async getRoles(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.rolesService.getRoles(workspaceId, WORKSPACE_OWNER);
  }

  @Get('permissions')
  async getPermissions() {
    return this.rolesService.getPermissionsTree('workspace.*');
  }

  @Post('create-role')
  async createRole(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.rolesService.createRole(workspaceId, WORKSPACE_OWNER, body);
  }

  @Patch('roles/:id')
  async updateRole(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.rolesService.updateRole(workspaceId, WORKSPACE_OWNER, BigInt(id), body);
  }

  @Delete('roles/:id')
  async deleteRole(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.rolesService.deleteRole(workspaceId, WORKSPACE_OWNER, BigInt(id));
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

  // Note: the old `developer-settings` endpoints were removed — they
  // stored a JSON blob in user_states that the new flow doesn't need.
  // API key now lives in `users.api_token` (GET/POST /api/users/api-token)
  // and webhooks have their own dedicated `/api/webhooks` CRUD.
}
