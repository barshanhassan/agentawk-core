import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { AiThemesService } from './ai-themes.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('ai-themes')
export class AiThemesController {
  constructor(private readonly aiThemesService: AiThemesService) {}

  // List + optional type filter — same endpoint shape as replyagent's
  // `index($type = null)`. Type comes through as a query param to keep the
  // path stable; replyagent overloads the route, we keep it RESTful.
  @Get()
  list(@Request() req: any, @Query('type') type?: string) {
    return this.aiThemesService.list(
      BigInt(req.user.workspace_id || 1),
      BigInt(req.user.sub || req.user.id || 0),
      req.user.role || 'agent',
      type || undefined,
    );
  }

  @Get(':id')
  show(@Param('id') id: string, @Request() req: any) {
    return this.aiThemesService.show(BigInt(req.user.workspace_id || 1), BigInt(id));
  }

  @Post()
  create(@Body() body: any, @Request() req: any) {
    return this.aiThemesService.create(BigInt(req.user.workspace_id || 1), body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.aiThemesService.update(BigInt(req.user.workspace_id || 1), BigInt(id), body);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @Request() req: any) {
    return this.aiThemesService.delete(BigInt(req.user.workspace_id || 1), BigInt(id));
  }

  // ─── User access management ──────────────────────────────────────────

  @Get(':id/users')
  listUsers(@Param('id') id: string, @Request() req: any) {
    return this.aiThemesService.listUsers(
      BigInt(req.user.workspace_id || 1),
      BigInt(id),
    );
  }

  @Post(':id/users/:userId/toggle')
  toggleUserAccess(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body('access') access: boolean,
    @Request() req: any,
  ) {
    return this.aiThemesService.toggleUserAccess(
      BigInt(req.user.workspace_id || 1),
      BigInt(id),
      BigInt(userId),
      !!access,
    );
  }

  // ─── Baserow fields proxy ────────────────────────────────────────────

  @Get(':id/fields')
  fields(@Param('id') id: string, @Request() req: any) {
    return this.aiThemesService.fetchBaserowFields(
      BigInt(req.user.workspace_id || 1),
      BigInt(id),
    );
  }
}
