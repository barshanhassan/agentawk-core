import { Controller, Get, Patch, Post, Body, UseGuards, Request } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller('api/whatsapp')
@UseGuards(JwtAuthGuard)
export class WhatsappController {
  constructor(private readonly whatsappService: WhatsappService) {}

  @Get('profile')
  async getProfile(@Request() req) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.whatsappService.getWhatsAppAccount(workspaceId);
  }

  @Get('profile/refresh')
  async refreshProfile(@Request() req) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.whatsappService.refreshBusinessProfile(workspaceId);
  }

  @Patch('profile')
  async updateProfile(@Request() req, @Body() body) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.whatsappService.updateBusinessProfile(workspaceId, body);
  }

  /**
   * Send an outbound WhatsApp message via Meta Graph API. Required body:
   *   { to, type, text|template|image|document|... }
   * See WhatsappService.sendMessage for full payload shape.
   */
  @Post('send')
  async send(@Request() req, @Body() body) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const senderId = BigInt(req.user.sub || req.user.id || 0);
    return this.whatsappService.sendMessage(workspaceId, senderId, body);
  }

  /**
   * Meta Embedded Signup completion. Frontend posts { code, waba_id, phone_number_id }
   * received from Meta's popup. Backend exchanges code → access_token → persists.
   */
  @Post('onboard')
  async onboard(@Request() req, @Body() body) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || req.user.id || 0);
    return this.whatsappService.onboard(workspaceId, userId, body);
  }
}
