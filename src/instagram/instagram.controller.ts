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
import { InstagramService } from './instagram.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('instagram')
export class InstagramController {
  constructor(private readonly service: InstagramService) {}

  @Get('pages')
  async list(@Request() req: any) {
    return this.service.listPages(BigInt(req.user.workspace_id || 1));
  }

  @Post('pages')
  async connect(@Request() req: any, @Body() body: any) {
    return this.service.connectPage(
      BigInt(req.user.workspace_id || 1),
      BigInt(req.user.sub || req.user.id || 0),
      body,
    );
  }

  @Delete('pages/:id')
  async disconnect(@Param('id') id: string, @Request() req: any) {
    return this.service.disconnectPage(BigInt(req.user.workspace_id || 1), BigInt(id));
  }

  @Post('pages/:id/send')
  async send(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.service.sendMessage(BigInt(req.user.workspace_id || 1), BigInt(id), body);
  }
}
