import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WhatsappService } from './whatsapp.service';

/**
 * Self-healing webhook subscription keeper (Gap 6).
 *
 * Meta occasionally drops a WABA's `subscribed_apps` entry — after a token
 * rotation, an app review change, or a transient outage during onboarding
 * (where the subscribe call is best-effort). When that happens inbound
 * messages silently stop reaching our webhook. replyagent re-subscribes on
 * demand via a WA_SUBSCRIBE event but has no periodic guard; this cron adds
 * one so a dropped subscription re-establishes itself without admin action.
 *
 * Every 6 hours it walks all ACTIVE WhatsApp accounts and re-issues the
 * (idempotent) `POST /{waba_id}/subscribed_apps` call. Subscribing an already
 * subscribed app is a no-op on Meta's side, so re-running is safe.
 */
@Injectable()
export class WhatsappWebhookSubscriptionService {
  private readonly logger = new Logger(WhatsappWebhookSubscriptionService.name);

  constructor(private readonly whatsapp: WhatsappService) {}

  @Cron(CronExpression.EVERY_6_HOURS)
  async tick(): Promise<void> {
    try {
      const { total, ok } = await this.whatsapp.resubscribeAllActive();
      if (total > 0) {
        this.logger.log(`Webhook re-subscription sweep: ${ok}/${total} active WABAs re-subscribed`);
      }
    } catch (e: any) {
      this.logger.error(`Webhook re-subscription sweep failed: ${e?.message ?? e}`);
    }
  }
}
