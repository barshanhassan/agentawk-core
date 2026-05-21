import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { EvolutionService } from './evolution.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('evolution')
export class EvolutionController {
  constructor(private readonly service: EvolutionService) {}

  @Get('instances')
  async list(@Request() req: any) {
    return this.service.listInstances(BigInt(req.user.workspace_id || 1));
  }

  @Post('instances')
  async create(@Request() req: any, @Body() body: any) {
    return this.service.createInstance(
      BigInt(req.user.workspace_id || 1),
      BigInt(req.user.sub || req.user.id || 0),
      body,
    );
  }

  @Get('instances/:id/qr')
  async qr(@Param('id') id: string, @Request() req: any) {
    return this.service.getConnectionQr(BigInt(req.user.workspace_id || 1), BigInt(id));
  }

  @Post('instances/:id/disconnect')
  async disconnect(@Param('id') id: string, @Request() req: any) {
    return this.service.disconnect(BigInt(req.user.workspace_id || 1), BigInt(id));
  }

  @Delete('instances/:id')
  async remove(@Param('id') id: string, @Request() req: any) {
    return this.service.deleteInstance(BigInt(req.user.workspace_id || 1), BigInt(id));
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
