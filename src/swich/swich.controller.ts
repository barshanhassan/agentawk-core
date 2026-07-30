import { Body, Controller, Delete, Get, Param, Post, Query, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { SwichService, SwichOwner } from './swich.service';

/** All routes here are workspace-authenticated — mirrors IntegrationsController's shape. */
@UseGuards(JwtAuthGuard)
@Controller('swich')
export class SwichController {
  constructor(private readonly swich: SwichService) {}

  private owner(req: any): SwichOwner {
    return { workspaceId: BigInt(req.user.workspace_id || 1) };
  }

  // ─── Credentials ─────────────────────────────────────────────────────

  @Get('credentials')
  getCredentials(@Request() req: any) {
    return this.swich.getAccountSummary(this.owner(req));
  }

  @Post('credentials')
  saveCredentials(@Body() body: any, @Request() req: any) {
    return this.swich.saveCredentials(this.owner(req), body);
  }

  @Delete('credentials')
  removeCredentials(@Request() req: any) {
    return this.swich.removeCredentials(this.owner(req));
  }

  // ─── Landing Page / PWA (Section 5) ──────────────────────────────────

  @Post('landing-page')
  buildLandingPageUrl(@Body() body: any, @Request() req: any) {
    return this.swich.buildLandingPageUrl(this.owner(req), body);
  }

  // ─── E-Wallet (Section 7) ─────────────────────────────────────────────

  @Post('ewallet')
  purchaseEwallet(@Body() body: any, @Request() req: any) {
    return this.swich.purchaseEwallet(this.owner(req), body);
  }

  // ─── Biller / 1Bill (Section 8) ───────────────────────────────────────

  @Post('biller')
  purchaseBiller(@Body() body: any, @Request() req: any) {
    return this.swich.purchaseBiller(this.owner(req), body);
  }

  // ─── Bank (Section 9) ─────────────────────────────────────────────────

  @Get('banks')
  getBanks(@Request() req: any) {
    return this.swich.getBanks(this.owner(req));
  }

  @Post('bank/otp')
  bankOtp(@Body() body: any, @Request() req: any) {
    return this.swich.bankOtp(this.owner(req), body);
  }

  @Post('bank/transfer')
  bankTransfer(@Body() body: any, @Request() req: any) {
    return this.swich.bankTransfer(this.owner(req), body);
  }

  // ─── QR (Section 10) ──────────────────────────────────────────────────

  @Post('qr/generate')
  qrGenerate(@Body() body: any, @Request() req: any) {
    return this.swich.qrGenerate(this.owner(req), body);
  }

  @Post('qr/cancel/:customerTransactionId')
  qrCancel(@Param('customerTransactionId') id: string, @Request() req: any) {
    return this.swich.qrCancel(this.owner(req), id);
  }

  @Get('qr/inquire/:customerTransactionId')
  qrInquire(@Param('customerTransactionId') id: string, @Request() req: any) {
    return this.swich.qrInquire(this.owner(req), id);
  }

  // ─── RTP / RAAST (Section 11) ─────────────────────────────────────────

  @Get('rtp/title')
  rtpTitle(@Query() query: any, @Request() req: any) {
    return this.swich.rtpTitle(this.owner(req), query);
  }

  @Get('rtp/now/banks')
  rtpNowBankList(@Request() req: any) {
    return this.swich.rtpNowBankList(this.owner(req));
  }

  @Post('rtp/now')
  rtpNow(@Body() body: any, @Request() req: any) {
    return this.swich.rtpNow(this.owner(req), body);
  }

  @Get('rtp/later/banks')
  rtpLaterBankList(@Request() req: any) {
    return this.swich.rtpLaterBankList(this.owner(req));
  }

  @Post('rtp/later')
  rtpLater(@Body() body: any, @Request() req: any) {
    return this.swich.rtpLater(this.owner(req), body);
  }

  @Post('rtp/cancel/:customerTransactionId')
  rtpCancel(@Param('customerTransactionId') id: string, @Request() req: any) {
    return this.swich.rtpCancel(this.owner(req), id);
  }

  @Get('rtp/inquire/:customerTransactionId')
  rtpInquire(@Param('customerTransactionId') id: string, @Request() req: any) {
    return this.swich.rtpInquire(this.owner(req), id);
  }

  // ─── Inquire (Section 12/13) ──────────────────────────────────────────

  @Get('inquire/:customerTransactionId')
  inquire(@Param('customerTransactionId') id: string, @Request() req: any) {
    return this.swich.inquire(this.owner(req), id);
  }

  // ─── Refund (Section 14) ──────────────────────────────────────────────

  @Post('refund')
  refund(@Body() body: any, @Request() req: any) {
    return this.swich.refund(this.owner(req), body);
  }

  // ─── Recurring Card Payment (Section 15) ──────────────────────────────

  @Get('card/recurring/instrument')
  getRecurringInstrument(@Query('msisdn') msisdn: string, @Request() req: any) {
    return this.swich.getRecurringInstrument(this.owner(req), msisdn);
  }

  @Post('card/recurring')
  initiateRecurringCardPayment(@Body() body: any, @Request() req: any) {
    return this.swich.initiateRecurringCardPayment(this.owner(req), body);
  }

  // ─── Local transaction history (not part of the Swich spec — our own bookkeeping) ──

  @Get('transactions')
  listTransactions(@Query('limit') limit: string, @Request() req: any) {
    return this.swich.listTransactions(this.owner(req), limit ? Number(limit) : undefined);
  }

  @Get('transactions/:customerTransactionId')
  getTransaction(@Param('customerTransactionId') id: string, @Request() req: any) {
    return this.swich.getTransaction(this.owner(req), id);
  }
}
