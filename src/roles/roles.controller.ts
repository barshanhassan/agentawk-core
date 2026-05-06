import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, Request } from '@nestjs/common';
import { RolesService } from './roles.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('workspaces/roles') // Placing it under workspaces for semantic consistency
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  getRoles(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.rolesService.getRoles(workspaceId);
  }

  @Post()
  createRole(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.rolesService.createRole(workspaceId, 'App\\Models\\Workspace', body);
  }

  @Patch(':id')
  updateRole(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.rolesService.updateRole(workspaceId, 'App\\Models\\Workspace', BigInt(id), body);
  }

  @Delete(':id')
  deleteRole(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.rolesService.deleteRole(workspaceId, 'App\\Models\\Workspace', BigInt(id));
  }
}

