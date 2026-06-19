// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InstagramService } from '../instagram/instagram.service';

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly instagram: InstagramService,
  ) {}

  // ─── Core Integration Management ───────────────────────────────────

  async getAllIntegrations(workspaceId: bigint) {
    // In Laravel, this was slightly mocked in the snippet, but let's implement the real logic
    const integrations = await this.prisma.integrations.findMany({
      where: { workspace_id: workspaceId },
      // include: { modelable: true } // This is polymorphic, Prisma needs specific includes or manual fetch
    });

    // Manual fetch for modelable because Prisma handles polymorphism through explicit relations
    const enriched = await Promise.all(
      integrations.map(async (integration) => {
        return {
          ...integration,
          modelable: await this.fetchModelable(
            integration.modelable_type,
            integration.modelable_id,
          ),
        };
      }),
    );

    return { integrations: enriched };
  }

  async getIntegrationByType(workspaceId: bigint, type: string) {
    const integration = await this.prisma.integrations.findFirst({
      where: { workspace_id: workspaceId, type: type },
    });
    if (!integration) throw new NotFoundException('Integration not found');

    return {
      ...integration,
      modelable: await this.fetchModelable(
        integration.modelable_type,
        integration.modelable_id,
      ),
    };
  }

  async createIntegration(workspaceId: bigint, data: any) {
    const { type } = data;
    let modelable: any = null;

    switch (type) {
      case 'MICROSOFT':
        modelable = await this.prisma.ms_text_to_speech.create({
          data: {
            key: data.key,
            region: data.region,
          },
        });
        break;
      case 'CLOUDINARY':
        modelable = await this.prisma.cloudinary.create({
          data: {
            cloud_name: data.cloud_name,
            api_key: data.api_key,
            api_secret: data.api_secret,
          },
        });
        break;
      case 'ACTIVECAMPAIGN':
        modelable = await this.prisma.active_campaign_accounts.create({
          data: {
            api_key: data.api_key,
            api_url: data.api_url,
          },
        });
        break;
      case 'CHATGPT':
        // Complex logic with verification and bot updates in Laravel
        modelable = await this.prisma.ai_accounts.create({
          data: {
            workspace_id: workspaceId,
            api_key: data.api_key,
            api_url: 'https://chat.openai.com',
            transcribe: data.transcribe || 'whisper-1',
          },
        });
        // Update existing agents - logic from Laravel
        await this.prisma.ai_agents.updateMany({
          where: { workspace_id: workspaceId, status: 'PAUSED' },
          data: { account_id: modelable.id, status: 'ACTIVE' },
        });
        break;
      case 'ELEVENLABS':
        modelable = await this.prisma.elevenlabs.create({
          data: {
            api_key: data.api_key,
            creator_id: BigInt(1), // Should be current user
          },
        });
        break;
      case 'CAL':
        modelable = await this.prisma.cal_accounts.create({
          data: {
            workspace_id: workspaceId,
            api_key: data.api_key,
          },
        });
        break;
      case 'BASEROW':
        modelable = await this.prisma.baserow_accounts.create({
          data: {
             workspace_id: workspaceId,
             token: data.token,
          },
        });
        break;
      default:
        throw new BadRequestException('Unsupported integration type');
    }

    const integration = await this.linkIntegrationModel(
      workspaceId,
      type,
      modelable,
      data.modelable_type || `App\\Models\\${type}Account`,
    );
    return { integration };
  }

  async updateIntegration(
    workspaceId: bigint,
    integrationId: bigint,
    data: any,
  ) {
    const integration = await this.prisma.integrations.findFirst({
      where: { id: integrationId, workspace_id: workspaceId },
    });
    if (!integration) throw new NotFoundException('Integration not found');

    if (data.action) {
      let status = integration.status;
      if (data.action === 'pause') status = 'PAUSED';
      else if (data.action === 'activate') status = 'ACTIVE';
      else if (data.action === 'suspend') status = 'SUSPENDED';

      await this.prisma.integrations.update({
        where: { id: integrationId },
        data: { status },
      });
    }

    return { success: true };
  }

  async removeIntegration(workspaceId: bigint, integrationId: bigint) {
    const integration = await this.prisma.integrations.findFirst({
      where: { id: integrationId, workspace_id: workspaceId },
    });
    if (!integration) throw new NotFoundException('Integration not found');

    // Logic to delete modelable
    await this.deleteModelable(
      integration.modelable_type,
      integration.modelable_id,
    );
    await this.prisma.integrations.delete({ where: { id: integrationId } });

    return { success: true };
  }

  // ─── Shared Helpers ────────────────────────────────────────────────

  private async fetchModelable(type: string, id: bigint) {
    // Map Laravel classes to Prisma models
    if (type.includes('MSTextToSpeech'))
      return this.prisma.ms_text_to_speech.findUnique({ where: { id } });
    if (type.includes('Cloudinary'))
      return this.prisma.cloudinary.findUnique({ where: { id } });
    if (type.includes('ActiveCampaignAccount'))
      return this.prisma.active_campaign_accounts.findUnique({ where: { id } });
    if (type.includes('AIAccount'))
      return this.prisma.ai_accounts.findUnique({ where: { id } });
    if (type.includes('ElevenLabs'))
      return this.prisma.elevenlabs.findUnique({ where: { id } });
    if (type.includes('CalAccount'))
      return this.prisma.cal_accounts.findUnique({ where: { id } });
    if (type.includes('BaserowAccount'))
      return this.prisma.baserow_accounts.findUnique({ where: { id } });
    return null;
  }

  private async deleteModelable(type: string, id: bigint) {
    if (type.includes('MSTextToSpeech'))
      await this.prisma.ms_text_to_speech.delete({ where: { id } });
    if (type.includes('Cloudinary'))
      await this.prisma.cloudinary.delete({ where: { id } });
    if (type.includes('ActiveCampaignAccount'))
      await this.prisma.active_campaign_accounts.delete({ where: { id } });
    if (type.includes('AIAccount'))
      await this.prisma.ai_accounts.delete({ where: { id } });
    if (type.includes('ElevenLabs'))
      await this.prisma.elevenlabs.delete({ where: { id } });
    if (type.includes('CalAccount'))
      await this.prisma.cal_accounts.delete({ where: { id } });
    if (type.includes('BaserowAccount'))
      await this.prisma.baserow_accounts.delete({ where: { id } });
  }

  private async linkIntegrationModel(
    workspaceId: bigint,
    type: string,
    model: any,
    modelClassName: string,
  ) {
    return this.prisma.integrations.create({
      data: {
        workspace_id: workspaceId,
        type: type,
        modelable_type: modelClassName || 'App\\Models\\Integration', // Fallback
        modelable_id: model.id,
        status: 'ACTIVE',
      },
    });
  }

  // ─── Type Specific Stubs ──────────────────────────────────────────

  async getActiveCampaignData(workspaceId: bigint, accountId: bigint) {
    // Stub: Fetch tags, lists, fields from ActiveCampaign API
    return { tags: [], fields: [], lists: [] };
  }

  async getCloudinaryFolders(workspaceId: bigint) {
    // Stub: Fetch folders from Cloudinary API
    return { folders: [] };
  }

  async getChannels(workspaceId: bigint) {
    // WhatsApp
    const waAccounts = await this.prisma.wa_accounts.findMany({
      where: { workspace_id: workspaceId, status: 'ACTIVE' },
    });
    const whatsapp = await Promise.all(
      waAccounts.map(async (account) => {
        const phone_numbers = await this.prisma.wa_phone_numbers.findMany({
          where: { wa_account_id: account.id },
        });
        return { ...account, phone_numbers };
      }),
    );

    // Instagram (insta_pages)
    const instagram = await this.prisma.insta_pages.findMany({
      where: { workspace_id: workspaceId },
    });

    // Messenger (fb_pages)
    const messenger = await this.prisma.fb_pages.findMany({
      where: { workspace_id: workspaceId },
    });

    // Telegram (telegram_bots)
    const telegram = await this.prisma.telegram_bots.findMany({
      where: { workspace_id: workspaceId },
    });

    // Twilio (twilio_accounts)
    const twilioAccounts = await this.prisma.twilio_accounts.findMany({
      where: { workspace_id: workspaceId },
    });
    const twilio = await Promise.all(
      twilioAccounts.map(async (account) => {
        const numbers = await this.prisma.twilio_numbers.findMany({
          where: { twilio_account_id: account.id },
        });
        return { 
          ...account, 
          sid: account.twilio_account_sid,
          token: account.twilio_auth_token,
          numbers 
        };
      }),
    );

    // Webchat (wc_instances)
    const webchat = await this.prisma.wc_instances.findMany({
      where: { workspace_id: workspaceId },
      select: {
        id: true,
        name: true,
        status: true,
        workspace_id: true,
      },
    });

    return {
      whatsapp,
      instagram,
      messenger,
      telegram,
      twilio,
      webchat,
      evolution: [],
      zapi: [],
    };
  }

  async deleteChannel(workspaceId: bigint, type: string, id: bigint, deleteMedia = false) {
    const where = { id, workspace_id: workspaceId };

    switch (type.toLowerCase()) {
      case 'whatsapp':
        // Note: For WhatsApp, usually it's wa_accounts. Soft delete or hard delete depending on policy.
        return this.prisma.wa_accounts.deleteMany({ where });
      case 'instagram':
        // Full teardown (cascade child rows + microservice event + optional
        // media purge) instead of an orphan-leaving insta_pages-only delete.
        return this.instagram.deletePageFull(workspaceId, id, deleteMedia);
      case 'messenger':
        return this.prisma.fb_pages.deleteMany({ where });
      case 'telegram':
        return this.prisma.telegram_bots.deleteMany({ where });
      case 'twilio':
        return this.prisma.twilio_accounts.deleteMany({ where });
      case 'webchat':
        return this.prisma.wc_instances.deleteMany({ where });
      default:
        throw new Error(`Unsupported channel type: ${type}`);
    }
  }

  // ─── API Keys (Personal Access Tokens) ──────────────────────────────

  async getApiKeys(workspaceId: bigint) {
    return this.prisma.personal_access_tokens.findMany({
      where: { 
        tokenable_type: 'Workspace',
        tokenable_id: workspaceId 
      },
      orderBy: { created_at: 'desc' }
    });
  }

  async generateApiKey(workspaceId: bigint, name: string) {
    const token = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    return this.prisma.personal_access_tokens.create({
      data: {
        tokenable_type: 'Workspace',
        tokenable_id: workspaceId,
        name: name || 'API Key',
        token: token,
        abilities: '*',
      }
    });
  }

  async deleteApiKey(tokenId: bigint, workspaceId: bigint) {
    await this.prisma.personal_access_tokens.deleteMany({
      where: { id: tokenId, tokenable_id: workspaceId }
    });
    return { success: true };
  }

  // ─── Visual API Triggers ───────────────────────────────────────────
  //
  // Mirrors replyagent's ApiTriggersController.php verbatim — same fields,
  // same shapes, same flow. Public webhook is in
  // `api-triggers-public.controller.ts`.

  async getApiTriggers(workspaceId: bigint) {
    return this.prisma.api_triggers.findMany({
      where: { workspace_id: workspaceId },
      select: {
        id: true,
        name: true,
        slug: true,
        live: true,
        index_field: true,
        created_at: true,
        updated_at: true,
      },
      orderBy: { created_at: 'desc' },
    });
  }

  /** GET single trigger — Manage view needs the full row incl.
   *  mapping/mapped_keys/new_keys/created_tags/updated_tags. */
  async getApiTrigger(workspaceId: bigint, id: bigint) {
    const t = await this.prisma.api_triggers.findFirst({
      where: { id, workspace_id: workspaceId },
    });
    if (!t) throw new NotFoundException('Trigger not found');
    return t;
  }

  async createApiTrigger(workspaceId: bigint, userId: bigint, data: any) {
    if (!data?.name?.trim()) {
      throw new BadRequestException('API name is required');
    }
    // Replyagent uses a random unique slug (ApiTrigger::generateSlug). We do
    // the same so two triggers with the same name don't collide.
    const slug = await this.generateUniqueTriggerSlug();

    return this.prisma.api_triggers.create({
      data: {
        workspace_id: workspaceId,
        name: String(data.name).trim().slice(0, 255),
        slug,
        live: false,
        // Replyagent's create modal only collects name; the model defaults
        // index_field='primary_mobile' and update_duplicates=false.
        index_field: (data.index_field ?? 'primary_mobile') as any,
        update_duplicates: !!data.update_duplicates,
        created_tags: data.created_tags ? JSON.stringify(data.created_tags) : '[]',
        updated_tags: data.updated_tags ? JSON.stringify(data.updated_tags) : '[]',
        creator_id: userId,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
  }

  async updateApiTrigger(id: bigint, workspaceId: bigint, userId: bigint, data: any) {
    const trigger = await this.prisma.api_triggers.findFirst({
      where: { id, workspace_id: workspaceId },
    });
    if (!trigger) throw new NotFoundException('Trigger not found');

    const patch: any = { updater_id: userId, updated_at: new Date() };

    if (data.name != null && String(data.name).trim() !== '' && data.name !== trigger.name) {
      patch.name = String(data.name).trim().slice(0, 255);
    }

    // Replyagent stores mapping as JSON array — `[{slug,key,prefix,postfix,field}]`
    if (Object.prototype.hasOwnProperty.call(data, 'mapping')) {
      patch.mapping = data.mapping ? JSON.stringify(data.mapping) : null;
    }

    // `update_keys=true` flips new_keys → mapped_keys and clears new_keys.
    // Mirrors `if ($request->filled("update_keys"))` block.
    if (data.update_keys) {
      patch.mapped_keys = trigger.new_keys;
      patch.new_keys = null;
    }

    if (data.index_field) {
      patch.index_field = data.index_field;
    }

    if (Object.prototype.hasOwnProperty.call(data, 'update_duplicates')) {
      patch.update_duplicates = !!data.update_duplicates;
    }

    if (Object.prototype.hasOwnProperty.call(data, 'created_tags')) {
      patch.created_tags = JSON.stringify(data.created_tags ?? []);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'updated_tags')) {
      patch.updated_tags = JSON.stringify(data.updated_tags ?? []);
    }

    if (Object.prototype.hasOwnProperty.call(data, 'live')) {
      patch.live = !!data.live;
    }

    await this.prisma.api_triggers.update({ where: { id }, data: patch });
    return this.prisma.api_triggers.findUnique({ where: { id } });
  }

  async deleteApiTrigger(id: bigint, workspaceId: bigint) {
    const trigger = await this.prisma.api_triggers.findFirst({
      where: { id, workspace_id: workspaceId },
    });
    if (!trigger) throw new NotFoundException('Trigger not found');
    // Cascade: replyagent wipes ApiTriggerRequest rows before deleting.
    await this.prisma.api_trigger_requests.deleteMany({ where: { api_trigger_id: id } });
    await this.prisma.api_triggers.delete({ where: { id } });
    return { success: true };
  }

  async getApiTriggerLogs(triggerId: bigint, workspaceId: bigint, page = 1, limit = 20) {
    const trigger = await this.prisma.api_triggers.findFirst({
      where: { id: triggerId, workspace_id: workspaceId },
    });
    if (!trigger) throw new NotFoundException('Trigger not found');

    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const offset = (safePage - 1) * safeLimit;

    const [data, total] = await Promise.all([
      this.prisma.api_trigger_requests.findMany({
        where: { api_trigger_id: triggerId },
        orderBy: { created_at: 'desc' },
        skip: offset,
        take: safeLimit,
      }),
      this.prisma.api_trigger_requests.count({ where: { api_trigger_id: triggerId } }),
    ]);

    const lastPage = Math.max(1, Math.ceil(total / safeLimit));
    // Laravel-style link array — the Vue logs pagination renders these
    // directly. Keep label keys minimal: { url, label, active }.
    const links: Array<{ url: string | null; label: string; active: boolean }> = [];
    links.push({ url: safePage > 1 ? String(safePage - 1) : null, label: '&laquo; Previous', active: false });
    for (let p = 1; p <= lastPage; p++) {
      links.push({ url: String(p), label: String(p), active: p === safePage });
    }
    links.push({ url: safePage < lastPage ? String(safePage + 1) : null, label: 'Next &raquo;', active: false });

    return {
      data,
      current_page: safePage,
      per_page: safeLimit,
      total,
      last_page: lastPage,
      from: total === 0 ? 0 : offset + 1,
      to: Math.min(offset + safeLimit, total),
      links,
    };
  }

  /** Random 16-char alphanumeric slug, retried until unique. Replyagent's
   *  ApiTrigger::generateSlug() shape — we copy it so external integrations
   *  using replyagent-style trigger URLs feel identical. */
  private async generateUniqueTriggerSlug(): Promise<string> {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let attempt = 0; attempt < 8; attempt++) {
      let s = '';
      for (let i = 0; i < 16; i++) s += charset[Math.floor(Math.random() * charset.length)];
      const exists = await this.prisma.api_triggers.findFirst({ where: { slug: s } });
      if (!exists) return s;
    }
    // Extremely unlikely, but fall through with a timestamp suffix.
    return `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  }
}
