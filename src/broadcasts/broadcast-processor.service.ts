import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AudienceFilterService } from './audience-filter.service';
import { AutomationProcessorService } from '../automations/automation-processor.service';

@Injectable()
export class BroadcastProcessorService {
  private readonly logger = new Logger(BroadcastProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audienceFilter: AudienceFilterService,
    private readonly automationProcessor: AutomationProcessorService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async processBroadcasts() {
    // Find broadcasts that are PENDING or SCHEDULED and due
    const broadcasts = await this.prisma.broadcasts.findMany({
      where: {
        status: { in: ['pending', 'in_progress'] as any },
        locked: false,
        OR: [
          { scheduled_at: { lte: new Date() } },
          { scheduled_at: null }
        ]
      },
      take: 5
    });

    for (const broadcast of broadcasts) {
      await this.executeBroadcast(broadcast);
    }
  }

  /**
   * Public entrypoint used by the BullMQ worker. Loads the broadcast by id and
   * delegates to the same private executor — keeps cron + queue paths sharing
   * the same body of work.
   */
  async executeBroadcastById(broadcastId: bigint) {
    const broadcast = await this.prisma.broadcasts.findUnique({
      where: { id: broadcastId },
    });
    if (!broadcast) {
      this.logger.warn(`executeBroadcastById: broadcast ${broadcastId} not found`);
      return { skipped: true, reason: 'not_found' };
    }
    if (broadcast.locked) {
      this.logger.warn(`executeBroadcastById: broadcast ${broadcastId} is locked — already running`);
      return { skipped: true, reason: 'locked' };
    }
    await this.executeBroadcast(broadcast);
    return { processed: true };
  }

  private async executeBroadcast(broadcast: any) {
    this.logger.log(`Executing broadcast: ${broadcast.name} (${broadcast.id})`);

    // Lock the broadcast
    await this.prisma.broadcasts.update({
      where: { id: broadcast.id },
      data: { locked: true, started_at: new Date(), status: 'in_progress' as any }
    });

    try {
      // 1. Find the broadcast trigger activity
      // Manual join because of missing Prisma relations
      const automation = await this.prisma.automations.findUnique({
        where: { id: broadcast.automation_id }
      });

      if (!automation) throw new Error(`Automation ${broadcast.automation_id} not found`);

      const versionId = automation.published_version_id || automation.draft_version_id;
      if (!versionId) throw new Error(`No version found for automation ${automation.id}`);

      const steps = await this.prisma.automation_steps.findMany({
        where: { automation_version_id: versionId, type: 'trigger' }
      });

      let triggerActivity: any = null;
      for (const step of steps) {
        const activity = await this.prisma.automation_step_activities.findFirst({
          where: { step_id: step.id, event: 'broadcast', deleted_at: null }
        });
        if (activity) {
          triggerActivity = activity;
          break;
        }
      }

      if (!triggerActivity) throw new Error(`No broadcast trigger activity found for automation ${automation.id}`);

      // 2. Get the audience
      const contactIds = await this.audienceFilter.getAudienceContactIds(broadcast.workspace_id, broadcast.filters || '{}');

      // 3. Bulk trigger
      if (contactIds.length > 0) {
        await this.automationProcessor.triggerAutomationBulk(triggerActivity.id, contactIds);
      }

      // 4. Complete
      await this.prisma.broadcasts.update({
        where: { id: broadcast.id },
        data: {
          status: 'completed' as any,
          finished_at: new Date(),
          total_audience: contactIds.length,
          total_sent: contactIds.length, // Simplified
          locked: false
        }
      });

      this.logger.log(`Broadcast ${broadcast.id} completed successfully`);

    } catch (error) {
      this.logger.error(`Broadcast ${broadcast.id} failed: ${error.message}`);
      await this.prisma.broadcasts.update({
        where: { id: broadcast.id },
        data: { status: 'failed' as any, fail_reason: error.message, locked: false }
      });
    }
  }
}
