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
import { TelegramService } from './telegram.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('telegram')
export class TelegramController {
  constructor(private readonly telegramService: TelegramService) {}

  @Get('bots')
  async getBots(@Request() req: any) {
    return this.telegramService.getBots(BigInt(req.user.workspace_id || 1));
  }

  @Post('bots')
  async addBot(@Body() body: any, @Request() req: any) {
    return this.telegramService.addBot(
      body,
      BigInt(req.user.workspace_id || 1),
      BigInt(req.user.sub),
    );
  }

  @Patch('bots/:id')
  async updateBot(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    return this.telegramService.updateBot(
      BigInt(id),
      body,
      BigInt(req.user.workspace_id || 1),
      BigInt(req.user.sub),
    );
  }

  @Post('bots/:id/reconnect')
  async reconnectBot(@Param('id') id: string, @Request() req: any) {
    return this.telegramService.reconnectBot(
      BigInt(id),
      BigInt(req.user.workspace_id || 1),
    );
  }

  @Delete('bots/:id')
  async deleteBot(
    @Param('id') id: string,
    @Query('delete_folder') deleteFolder: string,
    @Request() req: any,
  ) {
    return this.telegramService.deleteBot(
      BigInt(id),
      BigInt(req.user.workspace_id || 1),
      BigInt(req.user.sub),
      deleteFolder === 'true',
    );
  }

  @Patch('bots/:id/users')
  async updateBotUsers(
    @Param('id') id: string,
    @Body('users') users: string[],
    @Request() req: any,
  ) {
    return this.telegramService.updateBotUsers(
      BigInt(id),
      (users || []).map((u) => BigInt(u)),
      BigInt(req.user.workspace_id || 1),
      BigInt(req.user.sub),
    );
  }

  @Patch('chats/:chatId/status')
  async updateStatus(
    @Param('chatId') chatId: string,
    @Body('status') status: string,
    @Request() req: any,
  ) {
    return this.telegramService.updateStatus(
      BigInt(chatId),
      status,
      BigInt(req.user.workspace_id || 1),
    );
  }

  @Post('chats/:chatId/send')
  async sendMessage(
    @Param('chatId') chatId: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const userId = BigInt(req.user.sub || req.user.id || 0);
    return this.telegramService.sendMessage(BigInt(chatId), userId, body);
  }

  @Post('messages/:messageId/action')
  async messageAction(
    @Param('messageId') messageId: string,
    @Body('action') action: string,
  ) {
    return this.telegramService.messageAction(BigInt(messageId), action);
  }

  @Post('bots/:id/refresh-picture')
  async refreshBotPicture(@Param('id') id: string, @Request() req: any) {
    return this.telegramService.refreshBotPicture(
      BigInt(id),
      BigInt(req.user.workspace_id || 1),
    );
  }

  @Get('messages/:messageId')
  async getTelegramMessage(@Param('messageId') messageId: string) {
    return this.telegramService.getTelegramMessage(BigInt(messageId));
  }

  @Patch('bots/:id/auto-reply')
  async updateAutoReply(
    @Param('id') id: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    return this.telegramService.updateAutoReply(
      BigInt(id),
      body,
      BigInt(req.user.workspace_id || 1),
    );
  }

  @Post('auto-reply')
  async createAutoReply(@Body() body: any, @Request() req: any) {
    return this.telegramService.createAutoReply(
      body,
      BigInt(req.user.workspace_id || 1),
      BigInt(req.user.sub),
    );
  }

  @Delete('bots/:id/auto-reply')
  async deleteAutoReply(@Param('id') id: string, @Request() req: any) {
    return this.telegramService.deleteAutoReply(
      BigInt(id),
      BigInt(req.user.workspace_id || 1),
    );
  }

  @Post('bots/:id/toggle-feeder')
  async toggleFeeder(@Param('id') id: string) {
    return this.telegramService.toggleFeeder(BigInt(id));
  }
}
