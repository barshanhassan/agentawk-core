import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { TwilioService } from './twilio.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('twilio')
export class TwilioController {
  constructor(private readonly service: TwilioService) {}

  @Get('accounts')
  async list(@Request() req: any) {
    return this.service.listAccounts(BigInt(req.user.workspace_id || 1));
  }

  @Post('accounts')
  async save(@Request() req: any, @Body() body: any) {
    return this.service.saveAccount(
      BigInt(req.user.workspace_id || 1),
      BigInt(req.user.sub || req.user.id || 0),
      body,
    );
  }

  @Delete('accounts/:id')
  async remove(@Param('id') id: string, @Request() req: any) {
    return this.service.deleteAccount(
      BigInt(req.user.workspace_id || 1),
      BigInt(id),
    );
  }

  @Post('accounts/:id/send-sms')
  async sendSms(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.service.sendSms(
      BigInt(req.user.workspace_id || 1),
      BigInt(req.user.sub || req.user.id || 0),
      BigInt(id),
      body,
    );
  }

  @Get('call-logs')
  async callLogs(@Request() req: any, @Query() q: any) {
    return this.service.listCallLogs(BigInt(req.user.workspace_id || 1), {
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
      offset: q.offset ? parseInt(q.offset, 10) : undefined,
    });
  }
}
