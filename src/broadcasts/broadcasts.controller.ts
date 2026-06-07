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
import { BroadcastsService } from './broadcasts.service';
import { JwtAuthGuard } from '../auth/auth.guard';

/**
 * `/api/broadcasts` — Campaign Manager backend surface. The lookup endpoints
 * (`/channels`, `/templates`) are declared BEFORE the parameterised routes so
 * NestJS's router doesn't mistake them for an `:id`.
 */
@UseGuards(JwtAuthGuard)
@Controller('broadcasts')
export class BroadcastsController {
  constructor(private readonly service: BroadcastsService) {}

  @Get()
  async broadcastList(@Request() req: any, @Query() query: any) {
    return this.service.broadcastList(
      BigInt(req.user.workspace_id || 1),
      query,
    );
  }

  @Get('channels')
  async listChannels(@Request() req: any) {
    return this.service.listChannels(BigInt(req.user.workspace_id || 1));
  }

  @Get('templates')
  async listTemplates(@Request() req: any, @Query() query: any) {
    return this.service.listTemplates(
      BigInt(req.user.workspace_id || 1),
      query,
    );
  }

  @Post()
  async createBroadcast(@Request() req: any, @Body() body: any) {
    return this.service.createBroadcast(
      BigInt(req.user.workspace_id || 1),
      BigInt(req.user.sub),
      body,
    );
  }

  @Get(':id')
  async getBroadcast(@Param('id') id: string, @Request() req: any) {
    return this.service.getBroadcast(
      BigInt(id),
      BigInt(req.user.workspace_id || 1),
    );
  }

  @Patch(':id')
  async updateBroadcast(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    return this.service.updateBroadcast(
      BigInt(id),
      BigInt(req.user.workspace_id || 1),
      BigInt(req.user.sub),
      body,
    );
  }

  @Delete(':id')
  async deleteBroadcast(@Param('id') id: string, @Request() req: any) {
    return this.service.deleteBroadcast(
      BigInt(id),
      BigInt(req.user.workspace_id || 1),
    );
  }

  @Post(':id/send')
  async sendBroadcast(@Param('id') id: string, @Request() req: any) {
    return this.service.sendBroadcast(
      BigInt(id),
      BigInt(req.user.workspace_id || 1),
    );
  }

  @Get(':id/audience')
  async getBroadcastAudience(
    @Param('id') id: string,
    @Request() req: any,
    @Query() query: any,
  ) {
    return this.service.getBroadcastAudience(
      BigInt(id),
      BigInt(req.user.workspace_id || 1),
      query,
    );
  }

  @Post(':id/export')
  async exportBroadcastAudience(@Param('id') id: string, @Request() req: any) {
    return this.service.exportBroadcastAudience(
      BigInt(id),
      BigInt(req.user.workspace_id || 1),
    );
  }
}
