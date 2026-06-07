import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  UseGuards,
  Request,
  UseInterceptors,
  UploadedFile,
  ForbiddenException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { PlanFeaturesService } from '../workspaces/plan-features.service';

@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(
    private readonly service: UsersService,
    private readonly planFeatures: PlanFeaturesService,
  ) {}

  /**
   * List users in the current workspace. Used by the OpportunityForm
   * "Assigned to" dropdown. Returns lean rows (id + display name + email).
   */
  @Get()
  async listUsers(@Request() req: any) {
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.listWorkspaceUsers(workspaceId);
  }

  @Post('update')
  async updateProfile(@Body() body: any, @Request() req: any) {
    const userId = BigInt(req.user.sub || 1);
    return this.service.updateProfile(userId, body);
  }

  @Post('language')
  async updateLanguage(
    @Body('language') language: string,
    @Request() req: any,
  ) {
    const userId = BigInt(req.user.sub || 1);
    return this.service.updateLanguage(userId, language);
  }

  @Post('timezone')
  async updateDateTime(@Body() body: any, @Request() req: any) {
    const userId = BigInt(req.user.sub || 1);
    return this.service.updateDateTime(userId, body);
  }

  @Post('availability')
  async setAvailability(
    @Body('is_online') isOnline: number,
    @Request() req: any,
  ) {
    const userId = BigInt(req.user.sub || 1);
    return this.service.setAvailability(userId, isOnline);
  }

  @Post('logo')
  @UseInterceptors(FileInterceptor('file'))
  async uploadProfileLogo(
    @UploadedFile() file: Express.Multer.File,
    @Body('logo') base64Logo: string,
    @Request() req: any,
  ) {
    const userId = BigInt(req.user.sub || 1);
    // Handle both standard file upload OR base64 payload
    return this.service.uploadProfileLogo(
      userId,
      file || base64Logo,
      !!base64Logo,
    );
  }

  @Delete('logo')
  async removeProfileLogo(@Request() req: any) {
    const userId = BigInt(req.user.sub || 1);
    return this.service.removeProfileLogo(userId);
  }

  @Get('api-token')
  async getPublicAPIToken(@Request() req: any) {
    const userId = BigInt(req.user.sub || 1);
    const workspaceId = BigInt(req.user.workspace_id || 1);
    return this.service.getPublicAPIToken(userId, workspaceId);
  }

  @Post('api-token')
  async createPublicAPIToken(@Request() req: any) {
    const userId = BigInt(req.user.sub || 1);
    const workspaceId = BigInt(req.user.workspace_id || 1);

    // Plan gate — mirrors replyagent's
    // `agency.subscription.plan.allow_api` check. Surfacing 403 here
    // keeps the UI honest about why the regenerate button is disabled
    // even if the caller tries to bypass the frontend.
    const features = await this.planFeatures.getForWorkspace(workspaceId);
    if (!features.allow_api) {
      throw new ForbiddenException(
        'Your current plan does not include public API access.',
      );
    }

    const ip =
      (req.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.ip ||
      req.socket?.remoteAddress ||
      undefined;
    return this.service.createPublicAPIToken(userId, workspaceId, ip);
  }

  @Get('theme')
  async getTheme(@Request() req: any) {
    const userId = BigInt(req.user.sub || 1);
    return this.service.getTheme(userId);
  }

  @Post('theme')
  async updateTheme(@Body() body: any, @Request() req: any) {
    const userId = BigInt(req.user.sub || 1);
    return this.service.updateTheme(userId, body);
  }

  @Post('change-password')
  async changePassword(@Body() body: any, @Request() req: any) {
    const userId = BigInt(req.user.sub || 1);
    // Forward the request IP for the `password_changed` audit log row.
    // x-forwarded-for is honoured first so Cloud Run requests record the
    // real client IP rather than the load-balancer hop.
    const ip =
      (req.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.ip ||
      req.socket?.remoteAddress ||
      undefined;
    return this.service.changePassword(userId, body, ip);
  }
}
