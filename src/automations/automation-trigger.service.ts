import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationProcessorService } from './automation-processor.service';

@Injectable()
export class AutomationTriggerService {
  private readonly logger = new Logger(AutomationTriggerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly processor: AutomationProcessorService,
  ) {}

  @OnEvent('contact.tag_applied')
  async handleTagApplied(payload: { contactId: bigint; tagId: bigint; workspaceId: bigint }) {
    this.logger.log(`Checking triggers for tag ${payload.tagId} on contact ${payload.contactId}`);

    // Find trigger activities for tag_applied
    const triggers = await this.prisma.automation_step_activities.findMany({
      where: {
        event: 'tag_applied',
        deleted_at: null,
      },
    });

    for (const trigger of triggers) {
      const step = await this.prisma.automation_steps.findUnique({
        where: { id: trigger.step_id }
      });
      if (!step) continue;

      const version = await this.prisma.automation_versions.findUnique({
        where: { id: step.automation_version_id }
      });
      if (!version) continue;

      const automation = await this.prisma.automations.findUnique({
        where: { id: version.automation_id }
      });

      if (!automation || automation.workspace_id !== payload.workspaceId || automation.status !== 'active') {
        continue;
      }

      const props = typeof trigger.properties === 'string' ? JSON.parse(trigger.properties) : trigger.properties;
      if (props?.tag?.id == payload.tagId.toString()) {
        this.logger.log(`Triggering automation ${automation.id} for contact ${payload.contactId}`);
        await this.processor.triggerAutomation(trigger.id, payload.contactId);
      }
    }
  }

  /**
   * Fires on every inbound channel message routed through the inbox. Matches
   * automation triggers whose activity.event === 'inbound_message' and whose
   * properties optionally narrow the channel (e.g. { channel: 'whatsapp' }).
   */
  @OnEvent('message.inbound')
  async handleInboundMessage(payload: {
    workspaceId: bigint;
    inboxId: bigint;
    contactId?: bigint;
    channel?: string;
  }) {
    if (!payload.contactId) {
      this.logger.debug('inbound message has no contactId — skipping automation triggers');
      return;
    }

    const triggers = await this.prisma.automation_step_activities.findMany({
      where: { event: 'inbound_message', deleted_at: null },
    });

    for (const trigger of triggers) {
      const step = await this.prisma.automation_steps.findUnique({
        where: { id: trigger.step_id },
      });
      if (!step) continue;

      const version = await this.prisma.automation_versions.findUnique({
        where: { id: step.automation_version_id },
      });
      if (!version) continue;

      const automation = await this.prisma.automations.findUnique({
        where: { id: version.automation_id },
      });

      if (
        !automation ||
        automation.workspace_id !== payload.workspaceId ||
        automation.status !== 'active'
      ) {
        continue;
      }

      // Optional channel narrowing — if the trigger specifies a channel and it
      // doesn't match the inbound message's channel, skip.
      const props = typeof trigger.properties === 'string'
        ? JSON.parse(trigger.properties)
        : trigger.properties;
      if (props?.channel && payload.channel && props.channel !== payload.channel) {
        continue;
      }

      this.logger.log(
        `Triggering automation ${automation.id} for inbound message in workspace ${payload.workspaceId}`,
      );
      await this.processor.triggerAutomation(trigger.id, payload.contactId);
    }
  }

  @OnEvent('opportunity.stage_moved')
  async handleOpportunityMoved(payload: { contactId: bigint; pipelineId: bigint; stageId: bigint; workspaceId: bigint }) {
    this.logger.log(`Checking triggers for opportunity move to stage ${payload.stageId}`);

    const triggers = await this.prisma.automation_step_activities.findMany({
      where: {
        event: 'opportunity_stage_moved',
        deleted_at: null,
      },
    });

    for (const trigger of triggers) {
      const step = await this.prisma.automation_steps.findUnique({
        where: { id: trigger.step_id }
      });
      if (!step) continue;

      const version = await this.prisma.automation_versions.findUnique({
        where: { id: step.automation_version_id }
      });
      if (!version) continue;

      const automation = await this.prisma.automations.findUnique({
        where: { id: version.automation_id }
      });

      if (!automation || automation.workspace_id !== payload.workspaceId || automation.status !== 'active') {
        continue;
      }

      const props = typeof trigger.properties === 'string' ? JSON.parse(trigger.properties) : trigger.properties;
      if (props?.stage?.id == payload.stageId.toString()) {
        this.logger.log(`Triggering automation ${automation.id} for contact ${payload.contactId}`);
        await this.processor.triggerAutomation(trigger.id, payload.contactId);
      }
    }
  }
}
