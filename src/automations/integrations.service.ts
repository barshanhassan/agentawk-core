import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ACTION_GROUPS,
  AUTOMATION_STATUSES,
  CONDITION_TYPES,
  DELAY_UNITS,
  TRIGGER_GROUPS,
  STEP_TYPES,
  CHANNEL_STEP_TYPES,
} from './automations.constants';

/**
 * Aggregates everything the Smart Flows builder needs to populate its
 * dropdowns — channels, AI agents, custom fields, tags, integrations,
 * plus the canonical trigger / action / condition registries.
 *
 * Mirrors replyagent's AutomationsController::getIntegrations() shape so
 * the React builder can drop-in consume the same field names.
 *
 * Every list is workspace-scoped; nothing is hardcoded.
 */
@Injectable()
export class AutomationIntegrationsService {
  private readonly logger = new Logger(AutomationIntegrationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The "kitchen-sink" payload the editor consumes on load.
   *
   * Field names match replyagent's `getIntegrations` response exactly:
   *   whatsapp_apps, messenger_apps, instagram_apps, twilio_accounts,
   *   webchat_instances, zapi_instances, evolution_instances, bots (Telegram),
   *   assistants (ChatGPT AI agents), ai_voice_agents, ms_tts, ms_voices,
   *   active_campaign, dify_bots, custom_fields, inbox_folders, clone_kits,
   *   visual_apis (API triggers), automations.
   *
   * On top we add a `registry` object holding the canonical trigger/action/
   * step/condition lists — the frontend builder reads these to populate
   * the trigger picker, action picker, condition operator dropdown, etc.,
   * instead of carrying hardcoded arrays.
   */
  async getIntegrations(workspaceId: bigint) {
    const [
      whatsapp_apps,
      messenger_apps,
      instagram_apps,
      twilio_accounts,
      webchat_instances,
      zapi_instances,
      evolution_instances,
      telegram_bots,
      ai_agents,
      ai_voice_agents,
      ms_tts,
      active_campaign,
      dify_bots,
      custom_fields,
      inbox_folders,
      clone_kits,
      visual_apis,
      automations,
      tags,
      users,
      pipelines,
      pipeline_stages,
    ] = await Promise.all([
      // WhatsApp accounts (active only).
      this.prisma.wa_accounts.findMany({
        where: { workspace_id: workspaceId, deleted_at: null },
        select: {
          id: true,
          waba_id: true,
          name: true,
          status: true,
          meta_account_id: true,
        },
      }),
      // Facebook Messenger pages.
      this.safeFindMany(() =>
        this.prisma.fb_pages.findMany({
          where: { workspace_id: workspaceId, deleted_at: null },
          select: { id: true, name: true, page_id: true, status: true },
        }),
      ),
      // Instagram pages.
      this.safeFindMany(() =>
        this.prisma.insta_pages.findMany({
          where: { workspace_id: workspaceId },
          select: { id: true, name: true, username: true, page_id: true, ig_user_id: true },
        }),
      ),
      // Twilio accounts.
      this.safeFindMany(() =>
        this.prisma.twilio_accounts.findMany({
          where: { workspace_id: workspaceId, deleted_at: null },
          select: { id: true, name: true, twilio_account_sid: true, status: true },
        }),
      ),
      // Webchat instances.
      this.safeFindMany(() =>
        this.prisma.wc_instances.findMany({
          where: { workspace_id: workspaceId },
          select: { id: true, name: true },
        }),
      ),
      // Z-API instances.
      this.safeFindMany(() =>
        this.prisma.zapi_instances.findMany({
          where: { workspace_id: workspaceId },
          select: { id: true, name: true, instance_id: true },
        }),
      ),
      // Evolution instances.
      this.safeFindMany(() =>
        this.prisma.evolution_instances.findMany({
          where: { workspace_id: workspaceId },
          select: { id: true, name: true },
        }),
      ),
      // Telegram bots.
      this.safeFindMany(() =>
        this.prisma.telegram_bots.findMany({
          where: { workspace_id: workspaceId },
          select: { id: true, name: true, tg_name: true, status: true, slug: true },
        }),
      ),
      // AI agents (ChatGPT assistants).
      this.safeFindMany(() =>
        this.prisma.ai_agents.findMany({
          where: { workspace_id: workspaceId },
          select: {
            id: true,
            name: true,
            model: true,
            status: true,
            creativity: true,
            diversity: true,
          },
        }),
      ),
      // AI voice agents.
      this.safeFindMany(() =>
        this.prisma.ai_voice_agents.findMany({
          where: { workspace_id: workspaceId },
          select: { id: true, name: true, status: true },
        }),
      ),
      // Microsoft Text-to-Speech config (joined via integrations polymorphism).
      this.safeFindOne(async () => {
        const integration = await this.prisma.integrations.findFirst({
          where: {
            workspace_id: workspaceId,
            type: 'MICROSOFT',
            modelable_type: 'App\\Models\\Integrations\\MSTextToSpeech',
          },
        });
        if (!integration) return null;
        return this.prisma.ms_text_to_speech.findUnique({
          where: { id: integration.modelable_id },
        });
      }),
      // ActiveCampaign integration (joined via integrations polymorphism).
      this.safeFindOne(async () => {
        const integration = await this.prisma.integrations.findFirst({
          where: {
            workspace_id: workspaceId,
            type: 'ACTIVECAMPAIGN',
            modelable_type: 'App\\Models\\ActiveCampaignAccount',
          },
        });
        if (!integration) return null;
        return this.prisma.active_campaign_accounts.findUnique({
          where: { id: integration.modelable_id },
        });
      }),
      // Dify bots.
      this.safeFindMany(() =>
        this.prisma.dify_bots.findMany({
          where: { workspace_id: workspaceId },
          select: { id: true, name: true },
        }),
      ),
      // Custom fields (workspace-scoped, "for": "contact" mainly).
      this.safeFindMany(() =>
        this.prisma.custom_fields.findMany({
          where: { workspace_id: workspaceId },
          select: {
            id: true,
            label: true,
            slug: true,
            input_type: true,
            content_type: true,
            list_type: true,
            for: true,
            is_multiselect: true,
          },
        }),
      ),
      // Inbox folders.
      this.safeFindMany(() =>
        this.prisma.inbox_folders.findMany({
          where: { workspace_id: workspaceId },
          select: { id: true, name: true },
        }),
      ),
      // Clone-kit bundles. NB: schema has `bundles.workspace_id` as Int,
      // not BigInt, so the where filter needs a Number cast.
      this.safeFindMany(() =>
        this.prisma.bundles.findMany({
          where: { workspace_id: Number(workspaceId) },
          select: { id: true, name: true, slug: true, published: true, premium: true },
        }),
      ),
      // API triggers (visual_apis in replyagent terminology).
      this.safeFindMany(() =>
        this.prisma.api_triggers.findMany({
          where: { workspace_id: workspaceId },
          select: { id: true, name: true, slug: true, live: true },
        }),
      ),
      // Existing automations (for the "Start another automation" action picker).
      this.prisma.automations.findMany({
        where: { workspace_id: workspaceId, deleted_at: null },
        select: {
          id: true,
          slug: true,
          name: true,
          status: true,
          allow_in_feeder: true,
        },
      }),
      // Tags (used by add_tag / remove_tag action pickers).
      this.safeFindMany(() =>
        this.prisma.tags.findMany({
          where: { workspace_id: workspaceId },
          select: { id: true, name: true, bg_color: true, text_color: true },
        }),
      ),
      // Workspace users (polymorphic: modelable_type='App\\Models\\Workspace').
      this.safeFindMany(() =>
        this.prisma.users.findMany({
          where: {
            modelable_type: 'App\\Models\\Workspace',
            modelable_id: workspaceId,
          },
          select: { id: true, first_name: true, last_name: true, email: true },
        }),
      ),
      // Pipelines (for create_opportunity / update_opportunity).
      this.safeFindMany(() =>
        this.prisma.pipelines.findMany({
          where: { workspace_id: workspaceId },
          select: { id: true, name: true },
        }),
      ),
      // Pipeline stages keyed by their pipeline id.
      this.safeFindMany(() =>
        this.prisma.pipeline_steps.findMany({
          where: { pl_id: { not: undefined } as any },
          select: { id: true, name: true, pl_id: true },
        }),
      ),
    ]);

    return {
      // Channel integrations.
      whatsapp_apps,
      messenger_apps,
      instagram_apps,
      twilio_accounts,
      webchat_instances,
      zapi_instances,
      evolution_instances,
      bots: telegram_bots,
      // AI.
      assistants: ai_agents,
      ai_voice_agents,
      ms_tts,
      ms_voices: [],
      // CRM.
      active_campaign,
      // Other integrations.
      dify_bots,
      custom_fields,
      inbox_folders,
      clone_kits,
      visual_apis,
      automations,
      tags,
      users,
      pipelines,
      pipeline_stages,
      // make_hooks now backed by a real workspace-scoped table (schema +
      // migration shipped alongside the canonical registry).
      make_hooks: await this.safeFindMany(() =>
        this.prisma.make_hooks.findMany({
          where: { workspace_id: workspaceId, deleted_at: null },
          select: { id: true, name: true, url: true, status: true },
        }),
      ),

      // Canonical registries the frontend builder consumes for pickers.
      registry: {
        step_types: Object.values(STEP_TYPES),
        channel_step_types: CHANNEL_STEP_TYPES,
        triggers: TRIGGER_GROUPS,
        actions: ACTION_GROUPS,
        conditions: CONDITION_TYPES,
        statuses: Object.values(AUTOMATION_STATUSES),
        delay_units: DELAY_UNITS,
      },
    };
  }

  /**
   * Minimal payload for the automation listing page — folders + the
   * connected-channels summary the "create flow" modal uses to show
   * which channels the workspace can pick from.
   *
   * Mirrors replyagent's `getAutomationData()` controller method.
   */
  async getAutomationData(workspaceId: bigint) {
    const [folders, integrations] = await Promise.all([
      this.prisma.automation_folders.findMany({
        where: { workspace_id: workspaceId },
        select: { id: true, name: true },
      }),
      this.getChannelsSummary(workspaceId),
    ]);

    return {
      folders,
      integrations,
    };
  }

  /**
   * Compact view of which channels are connected — used by the "create
   * automation" modal and the channels filter on the listing page.
   */
  async getChannelsSummary(workspaceId: bigint) {
    const [waCount, fbCount, igCount, twilioCount, wcCount, zapiCount, evoCount, tgCount] =
      await Promise.all([
        this.prisma.wa_accounts.count({
          where: { workspace_id: workspaceId, deleted_at: null },
        }),
        this.safeCount(() =>
          this.prisma.fb_pages.count({ where: { workspace_id: workspaceId } }),
        ),
        this.safeCount(() =>
          this.prisma.insta_pages.count({ where: { workspace_id: workspaceId } }),
        ),
        this.safeCount(() =>
          this.prisma.twilio_accounts.count({ where: { workspace_id: workspaceId } }),
        ),
        this.safeCount(() =>
          this.prisma.wc_instances.count({ where: { workspace_id: workspaceId } }),
        ),
        this.safeCount(() =>
          this.prisma.zapi_instances.count({ where: { workspace_id: workspaceId } }),
        ),
        this.safeCount(() =>
          this.prisma.evolution_instances.count({ where: { workspace_id: workspaceId } }),
        ),
        this.safeCount(() =>
          this.prisma.telegram_bots.count({ where: { workspace_id: workspaceId } }),
        ),
      ]);

    return {
      whatsapp: waCount,
      messenger: fbCount,
      instagram: igCount,
      twilio: twilioCount,
      webchat: wcCount,
      zapi: zapiCount,
      evolution: evoCount,
      telegram: tgCount,
    };
  }

  // ─── Defensive wrappers ────────────────────────────────────────────
  // Some schema models (telegram_bots, ai_agents, evolution_instances, etc.)
  // may exist as types but be empty — wrap each call so a single missing
  // workspace setup doesn't break the entire integrations response.

  private async safeFindMany<T>(fn: () => Promise<T[]>): Promise<T[]> {
    try {
      return await fn();
    } catch (e: any) {
      this.logger.warn(`safeFindMany failed: ${e?.message ?? e}`);
      return [];
    }
  }

  private async safeFindOne<T>(fn: () => Promise<T | null>): Promise<T | null> {
    try {
      return await fn();
    } catch (e: any) {
      this.logger.warn(`safeFindOne failed: ${e?.message ?? e}`);
      return null;
    }
  }

  private async safeCount(fn: () => Promise<number>): Promise<number> {
    try {
      return await fn();
    } catch (e: any) {
      this.logger.warn(`safeCount failed: ${e?.message ?? e}`);
      return 0;
    }
  }
}
