import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Query, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { SwichService, SwichOwner } from './swich.service';

/**
 * Agency-scoped Swich PayIn — separate credential set from any tenant
 * workspace's. Used by the Agency's own Billing/Plans checkout (e.g. a plan
 * priced in PKR that settles through Swich instead of Chargebee), and by an
 * Agency-level Payments settings page. Same JwtAuthGuard as the workspace
 * controller, but resolves the owner via `modelable_id`/`modelable_type`
 * (the JWT's agency identity) instead of `workspace_id`.
 */
@UseGuards(JwtAuthGuard)
@Controller('swich/agency')
export class SwichAgencyController {
  constructor(private readonly swich: SwichService) {}

  private owner(req: any): SwichOwner {
    if (req.user.modelable_type !== 'App\\Models\\Agency') {
      throw new ForbiddenException('Agency-level Swich settings require an Agency Manager account');
    }
    return { agencyId: BigInt(req.user.modelable_id) };
  }

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

  /** Powers the Billing/Plans checkout — same Landing Page builder as the workspace flow. */
  @Post('landing-page')
  buildLandingPageUrl(@Body() body: any, @Request() req: any) {
    return this.swich.buildLandingPageUrl(this.owner(req), body);
  }

  @Get('transactions')
  listTransactions(@Query('limit') limit: string, @Request() req: any) {
    return this.swich.listTransactions(this.owner(req), limit ? Number(limit) : undefined);
  }

  /**
   * Section 13 — actively asks Swich for a transaction's real status instead
   * of waiting for the callback (Section 16). Useful right now since our
   * local dev backend can't receive callbacks (Swich can't reach localhost),
   * and generally useful as a manual "refresh" for any stuck transaction.
   */
  @Get('inquire/:customerTransactionId')
  inquire(@Param('customerTransactionId') id: string, @Request() req: any) {
    return this.swich.inquire(this.owner(req), id);
  }
}
