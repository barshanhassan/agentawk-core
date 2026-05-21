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
import { WebchatService } from './webchat.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('webchat')
export class WebchatController {
  constructor(private readonly service: WebchatService) {}

  @Get('instances')
  async list(@Request() req: any) {
    return this.service.listInstances(BigInt(req.user.workspace_id || 1));
  }

  @Post('instances')
  async save(@Request() req: any, @Body() body: any) {
    return this.service.saveInstance(
      BigInt(req.user.workspace_id || 1),
      BigInt(req.user.sub || req.user.id || 0),
      body,
    );
  }

  @Delete('instances/:id')
  async remove(@Param('id') id: string, @Request() req: any) {
    return this.service.deleteInstance(BigInt(req.user.workspace_id || 1), BigInt(id));
  }

  @Get('instances/:id/embed')
  async embed(@Param('id') id: string, @Request() req: any) {
    return this.service.getEmbedScript(BigInt(req.user.workspace_id || 1), BigInt(id));
  }

  @Post('chats/:chatId/send')
  async send(@Param('chatId') chatId: string, @Body() body: any, @Request() req: any) {
    return this.service.sendAgentMessage(
      BigInt(req.user.workspace_id || 1),
      BigInt(req.user.sub || req.user.id || 0),
      BigInt(chatId),
      body,
    );
  }
}

/**
 * Public, unauthenticated route used by the embedded widget. Token in the URL
 * is the auth — no JWT. Mounted at a distinct path so the JwtAuthGuard above
 * doesn't apply.
 */
@Controller('public/webchat')
export class WebchatPublicController {
  constructor(private readonly service: WebchatService) {}

  @Post(':token/messages')
  async visitorPost(@Param('token') token: string, @Body() body: any) {
    return this.service.receiveVisitorMessage(token, body);
  }
}
