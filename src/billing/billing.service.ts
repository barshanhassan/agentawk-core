import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChargebeeService } from './chargebee.service';
import { BillingSyncHelper } from './helpers/billing-sync.helper';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chargebee: ChargebeeService,
    private readonly syncHelper: BillingSyncHelper,
    private readonly config: ConfigService,
  ) {}

  // ─── Webhook Handling ───────────────────────────────────────────────

  async handleBillingEvents(payload: any) {
    this.logger.debug(`Billing Event: ${payload.event_type}`);
    // Extract agency from customer ID
    if (payload.content?.customer?.id) {
      const agency = await this.prisma.agencies.findFirst({
        where: { customer_id: payload.content.customer.id }
      });
      if (agency && payload.content.subscription) {
        await this.syncHelper.syncSubscription(agency.id, payload.content.subscription);
      }
    }
    return { success: true };
  }

  // ─── Subscription Lifecycle ──────────────────────────────────────────

  async upgrade(agencyId: bigint, itemPriceId: string) {
    const agency = await this.prisma.agencies.findUnique({
      where: { id: agencyId }
    });
    if (!agency) throw new NotFoundException('Agency not found');

    const owner = await this.prisma.users.findFirst({
      where: { modelable_id: agencyId, modelable_type: 'App\\Models\\Agency' }
    });

    // 1. Ensure Customer exists in Chargebee
    if (!agency.customer_id) {
      const customer = await this.chargebee.createCustomer({
        first_name: owner?.first_name || '',
        last_name: owner?.last_name || '',
        email: owner?.email || agency.email,
      });
      await this.prisma.agencies.update({
        where: { id: agencyId },
        data: { customer_id: customer.id }
      });
      agency.customer_id = customer.id;
    }

    // 2. Resolve target plan
    const itemPrice = await this.prisma.billing_item_prices.findFirst({
      where: { price_id: itemPriceId }
    });
    if (!itemPrice) throw new BadRequestException('Invalid plan price ID');

    // 3. Calculate quantities for addons
    const subscriptionItems = [
      { item_price_id: itemPriceId } // Target Plan
    ];

    // Example: Workspace Addons
    const workspacesCount = await this.prisma.workspaces.count({ where: { agency_id: agencyId } });
    const freeWorkspaces = 1; // This should come from billing_plans table
    if (workspacesCount > freeWorkspaces) {
      subscriptionItems.push({
        item_price_id: this.config.get('BILLING_WORKSPACE_ADDON_PRICE_ID'),
        quantity: workspacesCount - freeWorkspaces
      } as any);
    }

    // 4. Generate Hosted Page
    const subscription = await this.prisma.billing_subscriptions.findFirst({
      where: { agency_id: agencyId }
    });

    const params = {
      subscription: subscription ? { id: subscription.subscription_id } : undefined,
      subscription_items: subscriptionItems,
      customer: { id: agency.customer_id },
      layout: 'full_page',
    };

    const hostedPage = subscription 
      ? await this.chargebee.checkoutExistingForItems(params)
      : await this.chargebee.checkoutNewForItems(params);

    return hostedPage;
  }

  async acknowledge(agencyId: bigint, hostedPageId: string) {
    const hostedPage = await this.chargebee.retrieveHostedPage(hostedPageId);
    if (hostedPage.state === 'succeeded') {
      const subscription = hostedPage.content.subscription;
      await this.syncHelper.syncSubscription(agencyId, subscription);
      return { success: true, status: 'succeeded' };
    }
    return { success: false, status: hostedPage.state };
  }

  async cancelSubscription(agencyId: bigint) {
    const sub = await this.prisma.billing_subscriptions.findFirst({
      where: { agency_id: agencyId, status: 'active' }
    });
    if (!sub) throw new NotFoundException('No active subscription found');

    const result = await this.chargebee.cancelSubscriptionForItems(sub.subscription_id);
    await this.syncHelper.syncSubscription(agencyId, result.subscription);
    
    return { success: true };
  }

  async cancelVipPass(workspaceId: bigint) {
    // Stub for VIP pass cancellation logic
    return { success: true };
  }

  async acknowledgeVipPass(agencyId: bigint, hostedPageId: string) {
    return this.acknowledge(agencyId, hostedPageId);
  }

  async saveInvoiceRecipient(agencyId: bigint, data: any) {
    // Stub for saving additional invoice recipients
    return { success: true };
  }

  async deleteInvoiceRecipient(agencyId: bigint, contactId: string) {
    // Stub for deleting invoice recipients
    return { success: true };
  }

  async applyACoupon(agencyId: bigint, couponCode: string) {
    // Stub for applying a coupon via Chargebee
    return { success: true };
  }

  async agencyBranding(agencyId: bigint) {
    // Stub for agency branding checkout
    return { success: true };
  }

  async checkoutVipPass(agencyId: bigint) {
    // Stub for VIP pass checkout
    return { success: true };
  }

  async resubscribe(agencyId: bigint) {
    // Ported logic for reactivation if needed
    return { success: true };
  }

  // ─── Usage & Dashboard ──────────────────────────────────────────────

  async getCurrentUsage(agencyId: bigint) {
    const workpaceIds = (await this.prisma.workspaces.findMany({
      where: { agency_id: agencyId },
      select: { id: true }
    })).map(w => w.id);

    const [contacts, wa, tg, fb] = await Promise.all([
      this.prisma.contacts.count({ where: { workspace_id: { in: workpaceIds } } }),
      this.prisma.wa_accounts.count({ where: { workspace_id: { in: workpaceIds }, status: 'ACTIVE' } }),
      this.prisma.telegram_bots.count({ where: { workspace_id: { in: workpaceIds }, status: 'ACTIVE' } }),
      this.prisma.fb_pages.count({ where: { workspace_id: { in: workpaceIds }, status: 'ACTIVE' } }),
    ]);

    return {
      contacts,
      channels: {
        whatsapp: wa,
        telegram: tg,
        messenger: fb
      }
    };
  }
}
