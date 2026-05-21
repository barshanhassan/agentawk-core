import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ZapiService } from './zapi.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller('zapi')
@UseGuards(JwtAuthGuard)
export class ZapiController {
  constructor(private readonly service: ZapiService) {}

  @Get('instances')
  async getInstances(@Request() req: any) {
    return this.service.getInstances(BigInt(req.user.workspace_id || 1));
  }

  @Post('create-instance')
  async createInstance(@Request() req: any, @Body() body: any) {
    return this.service.createInstance(
      BigInt(req.user.workspace_id || 1),
      BigInt(req.user.sub),
      body,
    );
  }

  @Post('update-instance/:id')
  async updateInstance(
    @Request() req: any,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.service.updateInstance(
      BigInt(req.user.workspace_id || 1),
      BigInt(id),
      body,
    );
  }

  @Delete('delete-instance/:id')
  async deleteInstance(@Request() req: any, @Param('id') id: string) {
    return this.service.deleteInstance(
      BigInt(req.user.workspace_id || 1),
      BigInt(id),
    );
  }

  @Post('connect-instance/:id')
  async connectInstance(@Request() req: any, @Param('id') id: string) {
    return this.service.connectInstance(
      BigInt(req.user.workspace_id || 1),
      BigInt(id),
    );
  }

  @Post('disconnect-instance/:id')
  async disconnectInstance(@Request() req: any, @Param('id') id: string) {
    return this.service.disconnectInstance(
      BigInt(req.user.workspace_id || 1),
      BigInt(id),
    );
  }

  @Post('resubscribe-instance/:id')
  async resubscribeInstance(@Request() req: any, @Param('id') id: string) {
    return this.service.resubscribeInstance(
      BigInt(req.user.workspace_id || 1),
      BigInt(id),
    );
  }

  @Post('toggle-feeder/:id')
  async toggleFeeder(@Request() req: any, @Param('id') id: string) {
    return this.service.toggleFeeder(
      BigInt(req.user.workspace_id || 1),
      BigInt(id),
    );
  }

  @Get('refresh-avatar/:id')
  async refreshAvatar(@Request() req: any, @Param('id') id: string) {
    return this.service.refreshAvatar(
      BigInt(req.user.workspace_id || 1),
      BigInt(id),
    );
  }

  @Get('get-queue-items-count/:id')
  async getQueueItemsCount(@Request() req: any, @Param('id') id: string) {
    return this.service.getQueueItemsCount(
      BigInt(req.user.workspace_id || 1),
      BigInt(id),
    );
  }

  @Delete('delete-queue-items/:id')
  async deleteQueueItems(@Request() req: any, @Param('id') id: string) {
    return this.service.deleteQueueItems(
      BigInt(req.user.workspace_id || 1),
      BigInt(id),
    );
  }

  @Post('instances/:id/send')
  async send(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.service.sendMessage(
      BigInt(req.user.workspace_id || 1),
      BigInt(req.user.sub || req.user.id || 0),
      BigInt(id),
      body,
    );
  }
}
