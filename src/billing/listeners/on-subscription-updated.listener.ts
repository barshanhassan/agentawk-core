import { Injectable, Logger } from '@nestjs/common';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionUpdatedEvent } from '../events/subscription-updated.event';
import { AgencyUpdatedEvent } from '../../agency/events/agency-updated.event';

@Injectable()
export class OnSubscriptionUpdatedListener {
  private readonly logger = new Logger(OnSubscriptionUpdatedListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @OnEvent(SubscriptionUpdatedEvent.NAME)
  async handle(event: SubscriptionUpdatedEvent): Promise<void> {
    const subscription = await this.prisma.billing_subscriptions.findUnique({
      where: { id: event.subscriptionId },
    });
    if (!subscription) return;

    const agency = await this.prisma.agencies.findUnique({
      where: { id: subscription.agency_id },
    });
    if (!agency) return;

    // ─── Status change: cancelled → close workspaces ──────────────────
    if ('status' in event.dirtyAttributes) {
      const oldStatus = event.originalAttributes.status;

      if (subscription.status === 'cancelled') {
        await this.prisma.agency_logs.create({
          data: {
            agency_id: agency.id,
            event: 'subscription_cancelled',
            user_id: null,
            data: JSON.stringify({
              subscription_id: subscription.subscription_id,
            }),
          },
        });

        // Close all active workspaces
        await this.prisma.workspaces.updateMany({
          where: { agency_id: agency.id, status: 'ACTIVE' },
          data: { status: 'CLOSED' },
        });
      } else if (
        subscription.status === 'active' &&
        oldStatus === 'cancelled'
      ) {
        // Re-subscription: reactivate agency + workspaces
        if (agency.status === 'CLOSED') {
          await this.prisma.agencies.update({
            where: { id: agency.id },
            data: { status: 'ACTIVE', closed_at: null },
          });
        }
        await this.prisma.workspaces.updateMany({
          where: { agency_id: agency.id, status: 'SUSPENDED' },
          data: { status: 'ACTIVE' },
        });
      }
    }

    // ─── Plan change: upgrade/downgrade + free_agency_branding toggle ──
    if ('billing_plan_id' in event.dirtyAttributes) {
      const oldPlanId = event.originalAttributes.billing_plan_id;
      const oldPlan = oldPlanId
        ? await this.prisma.billing_plans.findUnique({
            where: { id: BigInt(oldPlanId) },
          })
        : null;
      const newPlan = subscription.billing_plan_id
        ? await this.prisma.billing_plans.findUnique({
            where: { id: subscription.billing_plan_id },
          })
        : null;

      if (oldPlan && newPlan) {
        const isUpgrade = (newPlan.plan_order || 0) > (oldPlan.plan_order || 0);
        await this.prisma.agency_logs.create({
          data: {
            agency_id: agency.id,
            event: isUpgrade
              ? 'subscription_upgraded'
              : 'subscription_downgraded',
            user_id: null,
            data: JSON.stringify({
              old_plan: oldPlan.name,
              new_plan: newPlan.name,
            }),
          },
        });

        // Free agency branding auto-enable on upgrade
        // (gateway: OnSubscriptionUpdated.php:144)
        if (newPlan.free_agency_branding && !agency.branding_enabled) {
          await this.prisma.agencies.update({
            where: { id: agency.id },
            data: { branding_enabled: true },
          });
          this.eventEmitter.emit(
            AgencyUpdatedEvent.NAME,
            new AgencyUpdatedEvent(
              agency.id,
              { branding_enabled: true },
              null,
            ),
          );
          this.logger.log(
            `Auto-enabled agency branding for agency ${agency.id} (plan ${newPlan.name} has free_agency_branding)`,
          );
        }

        // Reset workspace contact limits when leaving default-plan
        if (oldPlan.item_id === 'default-plan') {
          await this.prisma.workspaces.updateMany({
            where: { agency_id: agency.id },
            data: {
              limited_contacts: false,
              maximum_contacts: 0,
              chatgpt_assistant_limit: newPlan.free_ai_agents || 0,
            },
          });
        }
      }
    }
  }
}
