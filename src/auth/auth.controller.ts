import {
  Controller,
  Post,
  Body,
  Get,
  UseGuards,
  Request,
  Headers,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './auth.guard';
import { AppService } from '../app.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly appService: AppService,
  ) {}

  @Post('login')
  async login(
    @Body() body: any,
    @Headers('host') host: string,
    @Headers('origin') origin: string,
    @Headers('referer') referer: string,
  ) {
    const clientHost = origin || referer || host;
    const domainInfo = await this.appService.ignite(clientHost);
    return this.authService.login(body, domainInfo, clientHost);
  }

  @UseGuards(JwtAuthGuard)
  @Get('au')
  getProfile(@Request() req: any) {
    // Equivalent of the /au endpoint in Laravel Gateway
    return {
      user: req.user,
      agency: { id: req.user.modelable_id },
      workspace: null, // Workspace comes from active_workspace context usually
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('2fa/make')
  async makeTFA(@Request() req: any) {
    return this.authService.makeTFA(BigInt(req.user.sub));
  }

  @UseGuards(JwtAuthGuard)
  @Post('2fa/verify')
  async verifyTFA(@Request() req: any, @Body('otp') otp: string) {
    return this.authService.verifyTFA(BigInt(req.user.sub), otp);
  }

  @UseGuards(JwtAuthGuard)
  @Post('2fa/disable')
  async disableTFA(@Request() req: any, @Body('password') password: string) {
    return this.authService.disableTFA(BigInt(req.user.sub), password);
  }

  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  async changePassword(@Request() req: any, @Body() body: any) {
    return this.authService.changePassword(BigInt(req.user.sub), body);
  }

  @Post('forgot-password')
  async forgotPassword(
    @Body('email') email: string,
    @Headers('host') host: string,
    @Headers('origin') origin: string,
    @Headers('referer') referer: string,
  ) {
    const clientHost = origin || referer || host;
    const domainInfo = await this.appService.ignite(clientHost);
    return this.authService.forgotPassword(email, domainInfo);
  }

  @Post('reset-password')
  async resetPassword(
    @Body() body: any, 
    @Headers('host') host: string,
    @Headers('origin') origin: string,
    @Headers('referer') referer: string,
  ) {
    const clientHost = origin || referer || host;
    const domainInfo = await this.appService.ignite(clientHost);
    return this.authService.resetPassword(body, domainInfo);
  }

  @UseGuards(JwtAuthGuard)
  @Get('verify-mobile')
  async sendMobileOtp(@Request() req: any, @Body('mobile') mobile: string) {
    return this.authService.verifyMobile(BigInt(req.user.sub), mobile);
  }

  @UseGuards(JwtAuthGuard)
  @Post('verify-mobile')
  async verifyMobileCode(
    @Request() req: any,
    @Body('mobile') mobile: string,
    @Body('code') code: string,
  ) {
    return this.authService.verifyMobile(BigInt(req.user.sub), mobile, code);
  }

  @UseGuards(JwtAuthGuard)
  @Get('verify-email')
  async sendEmailOtp(
    @Request() req: any,
    @Body('email') email: string,
    @Headers('host') host: string,
    @Headers('origin') origin: string,
    @Headers('referer') referer: string,
  ) {
    const clientHost = origin || referer || host;
    const domainInfo = await this.appService.ignite(clientHost);
    return this.authService.verifyEmail(
      BigInt(req.user.sub),
      email,
      undefined,
      domainInfo,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('verify-email')
  async verifyEmailCode(
    @Request() req: any,
    @Body('email') email: string,
    @Body('code') code: string,
  ) {
    return this.authService.verifyEmail(BigInt(req.user.sub), email, code);
  }

  @Post('find-account')
  async findAccount(@Body('email') email: string) {
    return this.authService.findAccount(email);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  async logout(@Request() req: any) {
    return this.authService.logout(BigInt(req.user.sub));
  }

  @Get('init-registration')
  async initRegistration() {
    return this.authService.initRegistration();
  }

  @Post('validate-invitation')
  async validateInvitation(@Body('invitation_id') invitationId: string) {
    return this.authService.validateInvitation(invitationId);
  }

  @Post('accept-invitation')
  async acceptInvitation(@Body() body: any) {
    return this.authService.acceptInvitation(body);
  }
}
