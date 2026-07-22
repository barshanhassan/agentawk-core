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
} from '@nestjs/common';
import { AiFeederService } from './ai-feeder.service';
import { JwtAuthGuard } from '../auth/auth.guard';

/**
 * Channel→AI-agent feeder bindings (replyagent `/ai-feeder`). Distinct from the
 * `/ai-feeders` (plural) knowledge-topics CRUD.
 */
@UseGuards(JwtAuthGuard)
@Controller('ai-feeder')
export class AiFeederController {
  constructor(private readonly service: AiFeederService) {}

  @Get()
  async getFeeders(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getFeeders(workspaceId);
  }

  @Get(':id')
  async getFeeder(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getFeeder(workspaceId, BigInt(id));
  }

  @Post()
  async addFeeder(@Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const creatorId = BigInt(req.user.sub || req.user.id || 1);
    return this.service.addFeeder(workspaceId, creatorId, body);
  }

  @Patch(':id')
  async updateFeeder(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const updaterId = BigInt(req.user.sub || req.user.id || 1);
    return this.service.updateFeeder(workspaceId, BigInt(id), updaterId, body);
  }

  @Delete(':id')
  async deleteFeeder(@Param('id') id: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.deleteFeeder(workspaceId, BigInt(id));
  }
}
