import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Resolves plan-level feature flags from the billing chain. Public API
 * access (`allow_api`) gates Developer Settings → API Key generation,
 * mirroring replyagent's `workspace.agency.subscription.plan.allow_api`
 * check.
 *
 * Lookup path:
 *   workspace → agency → billing_subscriptions (status=ACTIVE, default=true)
 *     → billing_plan_id → billing_plans
 *
 * Returns sensible defaults if no active subscription is found so that
 * agencies running outside the billing flow (self-hosted, ezconn-managed,
 * etc.) don't get hard-blocked. Set EZCONN_DEFAULT_PLAN_FEATURES=strict
 * in env to require an explicit billing plan instead.
 */
@Injectable()
export class PlanFeaturesService {
  private readonly logger = new Logger(PlanFeaturesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getForWorkspace(workspaceId: bigint): Promise<{
    allow_api: boolean;
    allow_broadcasts: boolean;
    allow_contact_deletion: boolean;
    allow_contact_merge: boolean;
  }> {
    const workspace = await this.prisma.workspaces.findUnique({
      where: { id: workspaceId },
      select: { agency_id: true },
    });
    if (!workspace) {
      return this.defaults();
    }

    // Latest active subscription wins. `default=true` takes priority but we
    // fall back to any ACTIVE so a subscription mid-renewal doesn't surprise
    // anyone.
    // Enum is lowercase: future | in_trial | active | non_renewing | paused | cancelled.
    // We treat `active` and `in_trial` as live so trialing agencies aren't
    // hard-blocked from API access.
    const subscription: any = await this.prisma.billing_subscriptions.findFirst(
      {
        where: {
          agency_id: workspace.agency_id,
          status: { in: ['active', 'in_trial'] as any },
        },
        orderBy: [{ default: 'desc' }, { activated_at: 'desc' }],
        select: { billing_plan_id: true },
      },
    );
    if (!subscription?.billing_plan_id) {
      return this.defaults();
    }

    const plan: any = await this.prisma.billing_plans.findUnique({
      where: { id: subscription.billing_plan_id },
      select: {
        allow_api: true,
        allow_broadcasts: true,
        allow_contact_deletion: true,
        allow_contact_merge: true,
      },
    });
    if (!plan) {
      return this.defaults();
    }
    return {
      allow_api: !!plan.allow_api,
      allow_broadcasts: !!plan.allow_broadcasts,
      allow_contact_deletion: !!plan.allow_contact_deletion,
      allow_contact_merge: !!plan.allow_contact_merge,
    };
  }

  /**
   * When no subscription / plan is resolvable, default to permissive in
   * non-strict mode so self-hosted EZCONN instances aren't crippled by
   * missing billing rows. Production agencies that run on the SaaS plans
   * always have a billing_plan_id wired up by checkout, so this branch
   * isn't a foot-gun there.
   */
  private defaults(): {
    allow_api: boolean;
    allow_broadcasts: boolean;
    allow_contact_deletion: boolean;
    allow_contact_merge: boolean;
  } {
    const strict = process.env.EZCONN_DEFAULT_PLAN_FEATURES === 'strict';
    if (strict) {
      return {
        allow_api: false,
        allow_broadcasts: false,
        allow_contact_deletion: false,
        allow_contact_merge: false,
      };
    }
    return {
      allow_api: true,
      allow_broadcasts: true,
      allow_contact_deletion: true,
      allow_contact_merge: true,
    };
  }
}
