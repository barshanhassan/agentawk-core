import { Controller, Get, Patch, Post, Put, Delete, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { JwtAuthGuard } from '../auth/auth.guard';

// Vite dev proxy strips `/api` before hitting the backend, and the frontend's
// apiRequest helper does the same in production (when VITE_API_BASE_URL is set).
// Mirror the convention used by every other controller — bare path, no `api/` prefix.
@Controller('whatsapp')
@UseGuards(JwtAuthGuard)
export class WhatsappController {
  constructor(private readonly whatsappService: WhatsappService) {}

  // ─── Account list & detail ───────────────────────────────────────

  /**
   * GET /whatsapp/accounts?with=phoneNumbers,capi&onboard_platform=…
   * Mirrors replyagent `GET /wa/accounts`. The "Coex" 3-card selector page
   * filters by `onboard_platform=whatsapp_business_app`; the "Business API"
   * page filters by `whatsapp_business` (default).
   */
  @Get('accounts')
  async getAccounts(
    @Request() req: any,
    @Query('with') withRel?: string,
    @Query('onboard_platform') onboardPlatform?: string,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.whatsappService.getAccounts(workspaceId, {
      with: withRel,
      onboardPlatform,
    });
  }

  @Get('numbers')
  async getNumbers(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.whatsappService.getNumbers(workspaceId);
  }

  /**
   * GET /whatsapp/limits — workspace's WhatsApp channel allowance + current
   * usage. The settings page's "Add new" button consults this before opening
   * the Embed Signup popup to surface a limit-reached prompt instead of
   * having Meta reject the registration.
   */
  @Get('limits')
  async getLimits(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.whatsappService.getLimits(workspaceId);
  }

  /**
   * POST /whatsapp/profiles — exchange OAuth code + return access token
   * (replyagent contract preserves the `_c`/`_u` field names so the existing
   * onboard page works without translation).
   */
  @Post('profiles')
  async getProfiles(@Body() body: any) {
    return this.whatsappService.getProfiles(body);
  }

  /**
   * POST /whatsapp/verify — manual access-token verification flow used by
   * the "Connect manually" alternative onboarding.
   */
  @Post('verify')
  async verify(@Body() body: any) {
    return this.whatsappService.verifyToken(body);
  }

  // ─── Account / number lifecycle ──────────────────────────────────

  /**
   * POST /whatsapp/delete/:account_id — soft-delete a WABA account with
   * optional `delete_folder` (Gallery folder) + `delete_templates` (Meta
   * template cleanup) flags. Mirrors replyagent `POST /wa/delete/:id`.
   */
  @Post('delete/:account_id')
  async deleteAccount(
    @Param('account_id') accountId: string,
    @Body() body: { delete_folder?: boolean; delete_templates?: boolean },
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.whatsappService.deleteAccount(workspaceId, BigInt(accountId), {
      deleteFolder: body?.delete_folder,
      deleteTemplates: body?.delete_templates,
    });
  }

  @Post('delete-number/:number_id')
  async deleteNumber(@Param('number_id') numberId: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.whatsappService.deletePhoneNumber(workspaceId, BigInt(numberId));
  }

  /**
   * POST /whatsapp/reconnect/:number_id — refetch the number's profile from
   * Meta and patch our row with the latest verified_name / quality_rating /
   * name_status. Used by the "refresh status" button on disconnected /
   * locked / failed numbers.
   */
  @Post('reconnect/:number_id')
  async reconnect(@Param('number_id') numberId: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.whatsappService.reconnectNumber(workspaceId, BigInt(numberId));
  }

  @Post('synchronize/:number_id')
  async synchronize(@Param('number_id') numberId: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.whatsappService.synchronizeData(workspaceId, BigInt(numberId));
  }

  // ─── Auto-reply + AI Feeder ──────────────────────────────────────

  /**
   * POST /whatsapp/autoreply/:number_id — set or clear the per-number
   * default-reply automation. Body: { auto_reply_automation_id, auto_reply_interval }.
   * `auto_reply_interval` ∈ '0' (once) | '24' (once / 24h) | '247' (always).
   */
  @Post('autoreply/:number_id')
  async updateAutoReply(
    @Param('number_id') numberId: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.whatsappService.updateAutoReply(workspaceId, BigInt(numberId), body);
  }

  @Put('toggle-feeder/:number_id')
  async toggleFeeder(@Param('number_id') numberId: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.whatsappService.toggleFeeder(workspaceId, BigInt(numberId));
  }

  // ─── Messages ────────────────────────────────────────────────────

  @Get('get-message/:wamid')
  async getMessage(@Param('wamid') wamid: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.whatsappService.getMessage(workspaceId, wamid);
  }

  // ─── CAPI dataset binding ────────────────────────────────────────

  @Get('capi/:account_id')
  async getCapi(@Param('account_id') accountId: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.whatsappService.getCapiForAccount(workspaceId, BigInt(accountId));
  }

  @Post('capi/:account_id')
  async setupCapi(
    @Param('account_id') accountId: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || req.user.id || 0);
    return this.whatsappService.setupCapiForAccount(workspaceId, userId, BigInt(accountId), body);
  }

  @Delete('capi/:account_id')
  async deleteCapi(@Param('account_id') accountId: string, @Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.whatsappService.deleteCapiForAccount(workspaceId, BigInt(accountId));
  }

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

  /**
   * Manual onboarding (no Meta Embedded Signup). Frontend posts a form with
   * { waba_id, access_token, name, phone_number_id, display_phone_number, verified_name? }.
   * Backend persists wa_accounts + wa_phone_numbers (PENDING) and tells the
   * WhatsApp microservice to register the account via WA_REGISTER.
   */
  @Post('onboard-manual')
  async onboardManual(@Request() req, @Body() body) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    const userId = BigInt(req.user.sub || req.user.id || 0);
    return this.whatsappService.onboardManual(workspaceId, userId, body);
  }

  /**
   * Token health check — hits Meta's /debug_token to confirm the stored
   * access_token is valid and report expiry. Used by the WhatsApp settings
   * page to render a banner ("Token expires in 4 hours") or to nudge the
   * user toward a System User token.
   */
  @Get('token-status')
  async tokenStatus(@Request() req) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.whatsappService.tokenStatus(workspaceId);
  }
}
