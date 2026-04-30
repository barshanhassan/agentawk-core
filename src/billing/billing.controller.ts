import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  UseGuards,
  Request,
  Body,
  Query,
} from '@nestjs/common';
import { BillingService } from './billing.service';
import { WhiteLabelBillingService } from './white-label-billing.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller('billing')
export class BillingController {
  constructor(
    private readonly service: BillingService,
    private readonly whiteLabelBilling: WhiteLabelBillingService,
  ) {}

  // ─── Agency Branding (Gateway parity: /billing/agency-branding) ─────

  @UseGuards(JwtAuthGuard)
  @Get('agency-branding')
  async getAgencyBranding(@Request() req: any) {
    return this.whiteLabelBilling.getAgencyBrandingInfo(
      BigInt(req.user.modelable_id),
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('agency-branding')
  async enableAgencyBranding(@Request() req: any) {
    return this.whiteLabelBilling.enableAgencyBranding(
      BigInt(req.user.modelable_id),
      BigInt(req.user.sub),
    );
  }

  @UseGuards(JwtAuthGuard)
  @Delete('agency-branding')
  async disableAgencyBranding(@Request() req: any) {
    return this.whiteLabelBilling.disableAgencyBranding(
      BigInt(req.user.modelable_id),
      BigInt(req.user.sub),
    );
  }

  @Post('events')
  async handleBillingEvents(@Body() body: any) {
    return this.service.handleBillingEvents(body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('upgrade/:item_price_id')
  async upgrade(
    @Param('item_price_id') itemPriceId: string,
    @Request() req: any,
  ) {
    return this.service.upgrade(
      BigInt(req.user.workspace_id || 1),
      itemPriceId,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('cancel')
  async cancelSubscription(@Request() req: any) {
    return this.service.cancelSubscription(BigInt(req.user.workspace_id || 1));
  }

  @UseGuards(JwtAuthGuard)
  @Get('resubscribe')
  async resubscribe(@Request() req: any) {
    return this.service.resubscribe(BigInt(req.user.workspace_id || 1));
  }

  @UseGuards(JwtAuthGuard)
  @Get('acknowledge/:hosted_page_id')
  async acknowledge(
    @Param('hosted_page_id') hostedPageId: string,
    @Request() req: any,
  ) {
    return this.service.acknowledge(
      BigInt(req.user.workspace_id || 1),
      hostedPageId,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('current-usage')
  async getCurrentUsage(@Request() req: any) {
    return this.service.getCurrentUsage(BigInt(req.user.workspace_id || 1));
  }

  @UseGuards(JwtAuthGuard)
  @Post('invoice-recipient')
  async saveInvoiceRecipient(@Body() body: any, @Request() req: any) {
    return this.service.saveInvoiceRecipient(
      BigInt(req.user.workspace_id || 1),
      body,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Delete('invoice-recipient/:billing_customer_contact_id')
  async deleteInvoiceRecipient(
    @Param('billing_customer_contact_id') contactId: string,
    @Request() req: any,
  ) {
    return this.service.deleteInvoiceRecipient(
      BigInt(req.user.workspace_id || 1),
      contactId,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('coupon')
  async applyACoupon(
    @Body('coupon_code') couponCode: string,
    @Request() req: any,
  ) {
    return this.service.applyACoupon(
      BigInt(req.user.workspace_id || 1),
      couponCode,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('agency-branding')
  async agencyBranding(@Request() req: any) {
    return this.service.agencyBranding(BigInt(req.user.workspace_id || 1));
  }

  @UseGuards(JwtAuthGuard)
  @Get('vip-pass')
  async checkoutVipPass(@Request() req: any) {
    return this.service.checkoutVipPass(BigInt(req.user.workspace_id || 1));
  }

  @UseGuards(JwtAuthGuard)
  @Delete('vip-pass')
  async cancelVipPass(@Request() req: any) {
    return this.service.cancelVipPass(BigInt(req.user.workspace_id || 1));
  }

  @UseGuards(JwtAuthGuard)
  @Get('acknowledge-vip-pass/:hosted_page_id')
  async acknowledgeVipPass(
    @Param('hosted_page_id') hostedPageId: string,
    @Request() req: any,
  ) {
    return this.service.acknowledgeVipPass(
      BigInt(req.user.workspace_id || 1),
      hostedPageId,
    );
  }
}
