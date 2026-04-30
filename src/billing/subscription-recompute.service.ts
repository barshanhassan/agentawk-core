import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChargebeeService } from './chargebee.service';

/**
 * Mirrors gateway's UpdateSubscriptionItems job (App\Jobs\Billing).
 *
 * Recomputes ALL chargeable subscription items from current DB state
 * (workspaces, brandings, vip_pass, mobile, etc.) and pushes a single
 * `replaceItemsList=true` update to Chargebee.
 *
 * Called whenever a billing-affecting change happens (branding off/on,
 * workspace deleted, vip_pass toggled, etc.) so Chargebee never drifts
 * from reality.
 */
@Injectable()
export class SubscriptionRecomputeService {
  private readonly logger = new Logger(SubscriptionRecomputeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chargebee: ChargebeeService,
  ) {}

  async recompute(subscriptionDbId: bigint): Promise<void> {
    const subscription = await this.prisma.billing_subscriptions.findUnique({
      where: { id: subscriptionDbId },
    });
    if (!subscription) {
      this.logger.warn(`Subscription ${subscriptionDbId} not found, skip`);
      return;
    }
    if (!subscription.billing_plan_id) {
      this.logger.warn(`Subscription ${subscriptionDbId} has no plan, skip`);
      return;
    }

    const plan = await this.prisma.billing_plans.findUnique({
      where: { id: subscription.billing_plan_id },
    });
    if (!plan) return;

    const agency = await this.prisma.agencies.findUnique({
      where: { id: subscription.agency_id },
    });
    if (!agency) return;

    const items: Array<{ item_price_id: string; quantity?: number }> = [];

    // ─── Plan ─────────────────────────────────────────────────────────
    const planPrice = await this.prisma.billing_item_prices.findFirst({
      where: {
        itemable_id: plan.id,
        itemable_type: 'App\\Models\\BillingPlan',
        currency_code: 'USD',
      },
    });
    if (planPrice) {
      items.push({ item_price_id: planPrice.price_id });
    }

    // ─── Agency Branding addon ────────────────────────────────────────
    if (agency.branding_enabled) {
      const price = await this.findAddonUsdPrice(
        process.env.BILLING_AGENCY_BRANDING_ADDON,
      );
      if (price) items.push({ item_price_id: price, quantity: 1 });
    }

    // ─── Workspaces (extra over free) ────────────────────────────────
    const totalWorkspaces = await this.prisma.workspaces.count({
      where: { agency_id: agency.id, deleted_at: null },
    });
    const extraWorkspaces = totalWorkspaces - (plan.free_workspaces || 0);
    if (extraWorkspaces > 0) {
      const price = await this.findAddonUsdPrice(
        process.env.BILLING_WORKSPACE_ADDON,
      );
      if (price)
        items.push({ item_price_id: price, quantity: extraWorkspaces });
    }

    // ─── Workspace Branding (count of allow_branding=true) ────────────
    if (!plan.free_workspace_branding) {
      const totalBrandings = await this.prisma.workspaces.count({
        where: {
          agency_id: agency.id,
          deleted_at: null,
          allow_branding: true,
        },
      });
      if (totalBrandings > 0) {
        const price = await this.findAddonUsdPrice(
          process.env.BILLING_BRANDING_ADDON,
        );
        if (price)
          items.push({ item_price_id: price, quantity: totalBrandings });
      }
    }

    // ─── VIP Pass ─────────────────────────────────────────────────────
    if (agency.vip_pass) {
      const price = await this.findAddonUsdPrice(
        process.env.BILLING_VIP_PASS_ADDON,
      );
      if (price) items.push({ item_price_id: price, quantity: 1 });
    }

    // ─── Mobile subscription (price_id stored on agency) ──────────────
    if (agency.mobile_app_subscription) {
      items.push({
        item_price_id: agency.mobile_app_subscription,
        quantity: 1,
      });
    }

    // NOTE: Gateway also re-computes agents/channels/zapi/ai/cal/support
    // addons via BillingTrait helpers. Those need DB joins across many tables
    // (agency_agents, channels, zapi_instances, ai_agents, cal_accounts) —
    // ported when those modules are migrated. Recompute is correct for
    // white-label scope (plan + workspaces + branding + vip + mobile).

    if (items.length === 0) {
      this.logger.warn(
        `Recompute produced empty items list for sub ${subscription.subscription_id} — skip`,
      );
      return;
    }

    try {
      await this.chargebee.updateSubscriptionForItems(
        subscription.subscription_id,
        {
          prorate: false,
          replace_items_list: true,
          subscription_items: items,
        },
      );
      this.logger.log(
        `Recomputed ${items.length} items for subscription ${subscription.subscription_id}`,
      );
    } catch (err) {
      this.logger.error(
        `Recompute failed for sub ${subscription.subscription_id}: ${err.message}`,
        err.stack,
      );
      // Non-fatal — caller should not see billing failure on cancel paths
    }
  }

  /**
   * Find USD price_id for an addon by name. Returns null if not configured.
   */
  private async findAddonUsdPrice(
    addonName: string | undefined,
  ): Promise<string | null> {
    if (!addonName) return null;
    const addon = await this.prisma.billing_addons.findFirst({
      where: { name: addonName },
    });
    if (!addon) return null;
    const price = await this.prisma.billing_item_prices.findFirst({
      where: {
        itemable_id: addon.id,
        itemable_type: 'App\\Models\\BillingAddon',
        currency_code: 'USD',
      },
    });
    return price?.price_id || null;
  }
}
