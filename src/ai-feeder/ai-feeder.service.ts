import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RagService } from '../ai/rag.service';

/**
 * AI Feeder — binds a channel instance (e.g. a WhatsApp number) + an AI agent +
 * an automation, so that an inbound ref-link message (wa.me/<num>?text=<trigger>)
 * starts that automation (which contains the AI-agent step).
 *
 * Mirrors replyagent `AIFeedersController::addFeeder` / `insertTriggers`:
 *   1. Persist an `ai_feeders` row (the binding + knowledge feed).
 *   2. Create a `wa_ref_start` trigger activity on the automation's trigger
 *      step(s), tagged `modelable = AIFeeder`, so inbound ref-links dispatch it
 *      (EZCONN already matches `wa_ref_start` end-to-end via AutomationTriggerService).
 *
 * NOTE: this is the channel→agent binding feeder — distinct from the existing
 * `/ai-feeders` (plural) module, which is a knowledge-topics / Q&A authoring CRUD
 * on `ai_topics`.
 */
@Injectable()
export class AiFeederService {
  private readonly logger = new Logger(AiFeederService.name);

  // replyagent morph strings.
  private readonly AI_FEEDER_MODELABLE = 'App\\Models\\AI\\AIFeeder';
  private readonly CHANNELABLE_TYPES: Record<string, string> = {
    whatsapp: 'App\\Models\\Whatsapp\\WhatsappNumber',
    whatsappqr: 'App\\Models\\Whatsapp\\WhatsappNumber',
    telegram: 'App\\Models\\Telegram\\TelegramBot',
    instagram: 'App\\Models\\Instagram\\InstaPage',
    facebook: 'App\\Models\\Facebook\\FacebookPage',
    evolution: 'App\\Models\\Evolution\\EvolutionInstance',
    twilio: 'App\\Models\\Twilio\\TwilioNumber',
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly rag: RagService,
  ) {}

  /**
   * Materialise the feeder's `feed` knowledge into an `ai_files` TEXT row owned
   * by the agent, then re-embed the agent's KB so it's retrievable at reply time.
   * Mirrors replyagent `UpdateAssistantFile` (which uploads to an OpenAI Assistant);
   * EZCONN's real knowledge layer is `ai_files` + the RAG embedding cache, so we
   * target that instead of the stubbed Assistants API. One file per feeder,
   * replaced on update (tracked via `ai_feeders.ai_file_id`).
   */
  private async syncFeederKnowledge(feeder: any): Promise<void> {
    const agentId = feeder.ai_agent_id as bigint;
    // Drop the feeder's previous knowledge file (replace-on-update).
    if (feeder.ai_file_id) {
      await this.prisma.ai_files.deleteMany({ where: { id: feeder.ai_file_id } }).catch(() => undefined);
    }
    const feed = String(feeder.feed ?? '').trim();
    if (!feed) {
      if (feeder.ai_file_id) {
        await this.prisma.ai_feeders
          .update({ where: { id: feeder.id }, data: { ai_file_id: null } })
          .catch(() => undefined);
      }
      this.rag.ingestAgentFiles(agentId).catch(() => undefined);
      return;
    }
    const tokens = feed.split(/\s+/).filter(Boolean).length;
    const file = await this.prisma.ai_files.create({
      data: {
        agent_id: agentId,
        type: 'TEXT',
        content: feed,
        tokens,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
    await this.prisma.ai_feeders
      .update({ where: { id: feeder.id }, data: { ai_file_id: file.id } })
      .catch(() => undefined);
    // Fire-and-forget re-embed — retrieval falls back to on-demand ingest anyway.
    this.rag
      .ingestAgentFiles(agentId)
      .catch((e) => this.logger.warn(`RAG ingest failed for agent ${agentId}: ${e?.message ?? e}`));
  }

  private slug(bytes = 20): string {
    return crypto.randomBytes(bytes).toString('hex');
  }

  private serialize(f: any) {
    if (!f) return null;
    return {
      ...f,
      id: f.id?.toString(),
      workspace_id: f.workspace_id?.toString(),
      ai_agent_id: f.ai_agent_id?.toString(),
      automation_id: f.automation_id?.toString(),
      channelable_id: f.channelable_id?.toString(),
      ai_file_id: f.ai_file_id?.toString?.() ?? null,
      creator_id: f.creator_id?.toString?.() ?? null,
      updater_id: f.updater_id?.toString?.() ?? null,
    };
  }

  async getFeeders(workspaceId: bigint) {
    const feeders = await this.prisma.ai_feeders.findMany({
      where: { workspace_id: workspaceId },
      orderBy: { id: 'desc' },
    });
    return { feeders: feeders.map((f) => this.serialize(f)) };
  }

  async getFeeder(workspaceId: bigint, id: bigint) {
    const feeder = await this.prisma.ai_feeders.findFirst({
      where: { id, workspace_id: workspaceId },
    });
    if (!feeder) throw new NotFoundException('Feeder not found');
    return { feeder: this.serialize(feeder) };
  }

  /**
   * Create the feeder binding + its ref-start trigger activities.
   * Body: { name, ai_agent_id, automation_id, channel_type, channelable_id,
   *         trigger_text, payload?, payload_field?, feed?, notes?, files? }.
   */
  async addFeeder(workspaceId: bigint, creatorId: bigint, dto: any) {
    const { name, ai_agent_id, automation_id, channel_type, channelable_id, trigger_text } = dto ?? {};
    if (!name || !ai_agent_id || !automation_id || !channel_type || !channelable_id || !trigger_text) {
      throw new BadRequestException(
        'name, ai_agent_id, automation_id, channel_type, channelable_id and trigger_text are required',
      );
    }
    const channelableType = this.CHANNELABLE_TYPES[String(channel_type)];
    if (!channelableType) throw new BadRequestException(`Unsupported channel_type: ${channel_type}`);

    // Ownership checks — agent + automation must belong to the workspace.
    const agent = await this.prisma.ai_agents.findFirst({
      where: { id: BigInt(ai_agent_id), workspace_id: workspaceId },
    });
    if (!agent) throw new NotFoundException('AI agent not found');
    const automation = await this.prisma.automations.findFirst({
      where: { id: BigInt(automation_id), workspace_id: workspaceId },
    });
    if (!automation) throw new NotFoundException('Automation not found');

    const triggerUrl = await this.buildTriggerUrl(String(channel_type), BigInt(channelable_id), String(trigger_text), dto.payload);

    const feeder = await this.prisma.ai_feeders.create({
      data: {
        workspace_id: workspaceId,
        name: String(name),
        ai_agent_id: BigInt(ai_agent_id),
        automation_id: BigInt(automation_id),
        channel_type: String(channel_type) as any,
        channelable_type: channelableType,
        channelable_id: BigInt(channelable_id),
        payload: dto.payload ?? null,
        payload_field: dto.payload_field ?? null,
        trigger_text: String(trigger_text),
        trigger_url: triggerUrl,
        feed: dto.feed ?? '',
        notes: dto.notes ?? null,
        files: dto.files ? JSON.stringify(dto.files) : null,
        creator_id: creatorId,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });

    await this.insertTriggers(feeder, automation).catch((e) =>
      this.logger.warn(`insertTriggers failed for feeder ${feeder.id}: ${e?.message ?? e}`),
    );
    await this.syncFeederKnowledge(feeder).catch((e) =>
      this.logger.warn(`syncFeederKnowledge failed for feeder ${feeder.id}: ${e?.message ?? e}`),
    );

    const fresh = await this.prisma.ai_feeders.findUnique({ where: { id: feeder.id } });
    return { success: true, feeder: this.serialize(fresh ?? feeder) };
  }

  async updateFeeder(workspaceId: bigint, id: bigint, updaterId: bigint, dto: any) {
    const existing = await this.prisma.ai_feeders.findFirst({
      where: { id, workspace_id: workspaceId },
    });
    if (!existing) throw new NotFoundException('Feeder not found');

    const channelType = dto.channel_type ? String(dto.channel_type) : String(existing.channel_type);
    const channelableId = dto.channelable_id != null ? BigInt(dto.channelable_id) : existing.channelable_id;
    const triggerText = dto.trigger_text != null ? String(dto.trigger_text) : existing.trigger_text;
    const channelableType = this.CHANNELABLE_TYPES[channelType] ?? existing.channelable_type;

    const triggerUrl = await this.buildTriggerUrl(channelType, channelableId, triggerText, dto.payload ?? existing.payload);

    const updated = await this.prisma.ai_feeders.update({
      where: { id: existing.id },
      data: {
        name: dto.name != null ? String(dto.name) : undefined,
        ai_agent_id: dto.ai_agent_id != null ? BigInt(dto.ai_agent_id) : undefined,
        automation_id: dto.automation_id != null ? BigInt(dto.automation_id) : undefined,
        channel_type: channelType as any,
        channelable_type: channelableType,
        channelable_id: channelableId,
        payload: dto.payload !== undefined ? dto.payload : undefined,
        payload_field: dto.payload_field !== undefined ? dto.payload_field : undefined,
        trigger_text: triggerText,
        trigger_url: triggerUrl,
        feed: dto.feed !== undefined ? dto.feed : undefined,
        notes: dto.notes !== undefined ? dto.notes : undefined,
        files: dto.files !== undefined ? (dto.files ? JSON.stringify(dto.files) : null) : undefined,
        updater_id: updaterId,
        updated_at: new Date(),
      },
    });

    // Re-point the trigger activities (automation / trigger_text may have changed).
    await this.removeTriggers(existing.id);
    const automation = await this.prisma.automations.findFirst({
      where: { id: updated.automation_id, workspace_id: workspaceId },
    });
    if (automation) {
      await this.insertTriggers(updated, automation).catch((e) =>
        this.logger.warn(`insertTriggers (update) failed for feeder ${updated.id}: ${e?.message ?? e}`),
      );
    }
    await this.syncFeederKnowledge(updated).catch((e) =>
      this.logger.warn(`syncFeederKnowledge (update) failed for feeder ${updated.id}: ${e?.message ?? e}`),
    );

    const fresh = await this.prisma.ai_feeders.findUnique({ where: { id: updated.id } });
    return { success: true, feeder: this.serialize(fresh ?? updated) };
  }

  async deleteFeeder(workspaceId: bigint, id: bigint) {
    const existing = await this.prisma.ai_feeders.findFirst({
      where: { id, workspace_id: workspaceId },
    });
    if (!existing) throw new NotFoundException('Feeder not found');
    await this.removeTriggers(existing.id);
    // Drop the feeder's knowledge file + re-embed the agent's KB.
    if (existing.ai_file_id) {
      await this.prisma.ai_files.deleteMany({ where: { id: existing.ai_file_id } }).catch(() => undefined);
      this.rag.ingestAgentFiles(existing.ai_agent_id).catch(() => undefined);
    }
    await this.prisma.ai_feeders.delete({ where: { id: existing.id } });
    return { success: true, message: 'Feeder deleted' };
  }

  /**
   * Build the wa.me / channel deep-link that starts the feeder. Mirrors
   * replyagent `getFeederData` trigger_url:
   *   https://wa.me/<digits>?text=<trigger_text>[--<payload>]
   */
  private async buildTriggerUrl(
    channelType: string,
    channelableId: bigint,
    triggerText: string,
    payload?: string | null,
  ): Promise<string | null> {
    const payloadPart = payload ? `--${payload}` : '';
    const text = encodeURIComponent(`${triggerText}${payloadPart}`);
    if (channelType === 'whatsapp' || channelType === 'whatsappqr') {
      const number = await this.prisma.wa_phone_numbers.findUnique({ where: { id: channelableId } });
      if (!number) throw new NotFoundException('WhatsApp number not found');
      const digits = String(number.display_phone_number ?? '').replace(/[^0-9]/g, '');
      return `https://wa.me/${digits}?text=${text}`;
    }
    // Other channels: leave the deep-link null (channel-specific link TBD).
    return null;
  }

  /**
   * Create a `wa_ref_start` trigger activity on each of the automation's trigger
   * steps (published + draft versions), tagged with the feeder morph. Mirrors
   * replyagent `insertTriggers`. Consumed by AutomationTriggerService.handleWaRefStart
   * which matches `props.ref_code === refCode`.
   */
  private async insertTriggers(feeder: any, automation: any): Promise<void> {
    const versionIds = [automation.published_version_id, automation.draft_version_id]
      .filter((v: any) => v != null) as bigint[];
    if (!versionIds.length) return;

    const triggerSteps = await this.prisma.automation_steps.findMany({
      where: { automation_version_id: { in: versionIds }, type: 'trigger', deleted_at: null },
    });

    for (const step of triggerSteps) {
      await this.prisma.automation_step_activities.create({
        data: {
          slug: this.slug(),
          step_id: step.id,
          parent_id: null,
          event: 'wa_ref_start',
          properties: JSON.stringify({
            event: 'wa_ref_start',
            ref_code: feeder.trigger_text,
            ai_feeder_id: feeder.id.toString(),
            payload: feeder.payload ?? null,
            payload_field: feeder.payload_field ?? null,
          }),
          order: 1,
          linkable: true,
          modelable_type: this.AI_FEEDER_MODELABLE,
          modelable_id: feeder.id,
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    }
  }

  private async removeTriggers(feederId: bigint): Promise<void> {
    await this.prisma.automation_step_activities
      .deleteMany({ where: { modelable_type: this.AI_FEEDER_MODELABLE, modelable_id: feederId } })
      .catch((e) => this.logger.warn(`removeTriggers failed for feeder ${feederId}: ${e?.message ?? e}`));
  }
}
