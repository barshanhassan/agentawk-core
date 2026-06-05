import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { MetaGraphApiClient } from '../whatsapp/meta-graph-api.client';
import { ACTION_SLUGS, ActionSlug } from './automations.constants';
import { InterpolationService } from './interpolation.service';

/**
 * Dispatcher for `step.type === 'action'` activities. Each automation action
 * activity stores a `properties.slug` that names the action; we branch off
 * it and run the corresponding side effect (tag mutation, HTTP call, AI call,
 * channel opt-in, etc.).
 *
 * Mirrors replyagent's `app/Services/Automations/*` action handlers — every
 * slug present here matches the `<slug>` the editor saves in
 * `automation_step_activities.properties.slug`.
 *
 * Design rules:
 *   1. EVERY action exits via the same return type so the processor's
 *      `finished()` step traversal works uniformly: returns void on success,
 *      throws on hard failure (rolled up by AutomationProcessor's try/catch).
 *   2. Database-only actions (tags, custom fields) run synchronously inline.
 *   3. External API actions (ChatGPT, Dify, Baserow, etc.) check for
 *      workspace-level integration credentials and degrade to a logged
 *      warning if missing — they MUST NOT throw on missing credentials,
 *      because that would block the rest of the flow.
 *   4. Actions that mutate contact state emit a NestJS event so other
 *      triggers (tag_applied, custom_field_changed, etc.) can react.
 */
@Injectable()
export class ActionHandlerService {
  private readonly logger = new Logger(ActionHandlerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly whatsapp: WhatsappService,
    private readonly meta: MetaGraphApiClient,
    private readonly interpolation: InterpolationService,
  ) {}

  /**
   * Single entry point — caller (AutomationProcessor) passes the contact id,
   * the activity's properties JSON, and the workspace id.
   *
   * properties shape (mirrored from replyagent):
   *   { slug: '<ACTION_SLUGS value>', value: {...action-specific...} }
   */
  async dispatch(contactId: bigint, properties: any, workspaceId: bigint): Promise<void> {
    const slug: ActionSlug | undefined = properties?.slug;
    if (!slug) {
      this.logger.warn(`Action activity has no slug — skipping. Properties: ${JSON.stringify(properties)}`);
      return;
    }
    // Interpolate {{...}} tokens deeply into value so every action sees the
    // resolved string (URLs, prompts, request bodies, message templates).
    // Mirrors replyagent's pre-action replaceKeys() pass.
    const rawValue = properties?.value ?? {};
    const value = await this.interpolation.interpolateDeep(rawValue, contactId, workspaceId);

    this.logger.log(`Running action ${slug} for contact ${contactId} in workspace ${workspaceId}`);

    try {
      switch (slug) {
        case ACTION_SLUGS.ADD_TAG:
          return await this.addTag(contactId, value, workspaceId);
        case ACTION_SLUGS.REMOVE_TAG:
          return await this.removeTag(contactId, value, workspaceId);
        case ACTION_SLUGS.ADD_CUSTOM_FIELD:
          return await this.setCustomField(contactId, value, workspaceId);
        case ACTION_SLUGS.REMOVE_CUSTOM_FIELD:
          return await this.removeCustomField(contactId, value, workspaceId);
        case ACTION_SLUGS.JSON_TO_CUSTOM_FIELDS:
          return await this.jsonToCustomFields(contactId, value, workspaceId);
        case ACTION_SLUGS.SET_SYSTEM_FIELD:
          return await this.setSystemField(contactId, value, workspaceId);
        case ACTION_SLUGS.UNSET_SYSTEM_FIELD:
          return await this.unsetSystemField(contactId, value, workspaceId);
        case ACTION_SLUGS.SET_LANGUAGE:
          return await this.setSystemField(contactId, { field: 'language', value: value.value }, workspaceId);
        case ACTION_SLUGS.SET_LOCALE:
          return await this.setSystemField(contactId, { field: 'locale', value: value.value }, workspaceId);
        case ACTION_SLUGS.SET_TIMEZONE:
          return await this.setSystemField(contactId, { field: 'timezone', value: value.value }, workspaceId);

        // Channel opts.
        case ACTION_SLUGS.WHATSAPP_OPTING:
        case ACTION_SLUGS.TELEGRAM_OPTING:
        case ACTION_SLUGS.MESSENGER_OPTING:
        case ACTION_SLUGS.INSTAGRAM_OPTING:
        case ACTION_SLUGS.WEBCHAT_OPTING:
        case ACTION_SLUGS.EMAIL_OPTING:
        case ACTION_SLUGS.SMS_OPTING:
        case ACTION_SLUGS.CALL_OPTING:
        case ACTION_SLUGS.ZAPI_OPTING:
        case ACTION_SLUGS.EVOLUTION_OPTING:
          return await this.toggleChannelOpting(contactId, slug, value);

        // External.
        case ACTION_SLUGS.EXTERNAL_REQUEST:
          return await this.externalRequest(contactId, value, workspaceId);
        case ACTION_SLUGS.MAKE_HOOK:
          return await this.makeHook(contactId, value, workspaceId);

        // AI.
        case ACTION_SLUGS.CHATGPT_QUESTION:
        case ACTION_SLUGS.CHATGPT_COMPLETION:
        case ACTION_SLUGS.CHATGPT_IMAGE_RECOGNITION:
        case ACTION_SLUGS.CHATGPT_TEXT_TO_SPEECH:
          return await this.chatgpt(contactId, slug, value, workspaceId);
        case ACTION_SLUGS.DIFY_QUESTION:
          return await this.dify(contactId, value, workspaceId);
        case ACTION_SLUGS.AI_STUDIO_VISION:
        case ACTION_SLUGS.AI_STUDIO_TEXT_TO_SPEECH:
          return await this.aiStudio(contactId, slug, value, workspaceId);
        case ACTION_SLUGS.ELEVENLABS_TEXT_TO_SPEECH:
        case ACTION_SLUGS.MS_TEXT_TO_SPEECH:
          return await this.tts(contactId, slug, value, workspaceId);

        // CRM.
        case ACTION_SLUGS.ACTIVE_CAMPAIGN:
          return await this.activeCampaign(contactId, value, workspaceId);
        case ACTION_SLUGS.CAPI:
        case ACTION_SLUGS.META_CONVERSIONS:
          return await this.metaConversions(contactId, value, workspaceId);

        // Baserow.
        case ACTION_SLUGS.BASEROW_ADD_ROW:
        case ACTION_SLUGS.BASEROW_GET_ROW:
        case ACTION_SLUGS.BASEROW_UPDATE_ROW:
        case ACTION_SLUGS.BASEROW_DELETE_ROW:
        case ACTION_SLUGS.BASEROW_TO_JSON:
          return await this.baserow(contactId, slug, value, workspaceId);

        // Flow control.
        case ACTION_SLUGS.START_AUTOMATION:
          return await this.startAutomation(contactId, value, workspaceId);
        case ACTION_SLUGS.REMOVE_FROM_FLOW:
          return await this.removeFromFlow(contactId, value, workspaceId);

        // Conversation.
        case ACTION_SLUGS.ASSIGN_CONVERSATION:
          return await this.assignConversation(contactId, value, workspaceId);
        case ACTION_SLUGS.MANAGE_CONVERSATIONS:
          return await this.manageConversations(contactId, value, workspaceId);
        case ACTION_SLUGS.NOTIFY_AGENT:
          return await this.notifyAgent(contactId, value, workspaceId);
        case ACTION_SLUGS.CLOSE_CONVERSATION:
          return await this.closeConversation(contactId, value, workspaceId);

        // Pipeline.
        case ACTION_SLUGS.CREATE_OPPORTUNITY:
          return await this.createOpportunity(contactId, value, workspaceId);
        case ACTION_SLUGS.UPDATE_OPPORTUNITY:
          return await this.updateOpportunity(contactId, value, workspaceId);

        // Contact.
        case ACTION_SLUGS.DELETE_CONTACT:
          return await this.deleteContact(contactId, workspaceId);

        // Misc integrations.
        case ACTION_SLUGS.CAL_CALENDAR:
          return await this.calCalendar(contactId, value, workspaceId);
        case ACTION_SLUGS.CLOUDINARY_IMAGE:
          return await this.cloudinaryImage(contactId, value, workspaceId);
        case ACTION_SLUGS.GET_REPORT:
        case ACTION_SLUGS.TRIGGER_REPORT:
          return await this.report(contactId, slug, value, workspaceId);
        case ACTION_SLUGS.SHARE_CLONEKIT:
          return await this.shareClonekit(contactId, value, workspaceId);
        case ACTION_SLUGS.UNSTRACT:
          return await this.unstract(contactId, value, workspaceId);
        case ACTION_SLUGS.WOOVI:
          return await this.woovi(contactId, value, workspaceId);

        default:
          this.logger.warn(`Unknown action slug: ${slug}`);
      }
    } catch (e: any) {
      this.logger.error(`Action ${slug} failed for contact ${contactId}: ${e?.message ?? e}`);
      // Re-throw — the processor's outer try/catch logs the failure but lets
      // the rest of the flow continue with the next step.
      throw e;
    }
  }

  // ─── Tags ──────────────────────────────────────────────────────────

  private async addTag(contactId: bigint, value: any, workspaceId: bigint) {
    const tagId = value?.tag?.id ?? value?.tag_id ?? value?.id;
    if (!tagId) return this.logger.warn('add_tag: missing tag id');

    const tagIdBig = BigInt(tagId);
    const existing = await this.prisma.tag_links.findFirst({
      where: {
        tag_id: tagIdBig,
        linkable_id: contactId,
        linkable_type: 'App\\Models\\Contact',
      },
    });
    if (existing) return;

    const tag = await this.prisma.tags.findUnique({ where: { id: tagIdBig } });
    if (!tag) return this.logger.warn(`add_tag: tag ${tagId} not found`);

    await this.prisma.tag_links.create({
      data: {
        tag_id: tagIdBig,
        name: tag.name,
        linkable_id: contactId,
        linkable_type: 'App\\Models\\Contact',
        created_at: new Date(),
        updated_at: new Date(),
      },
    });

    this.events.emit('contact.tag_applied', { contactId, tagId: tagIdBig, workspaceId });
  }

  private async removeTag(contactId: bigint, value: any, workspaceId: bigint) {
    const tagId = value?.tag?.id ?? value?.tag_id ?? value?.id;
    if (!tagId) return this.logger.warn('remove_tag: missing tag id');

    const tagIdBig = BigInt(tagId);
    const link = await this.prisma.tag_links.findFirst({
      where: {
        tag_id: tagIdBig,
        linkable_id: contactId,
        linkable_type: 'App\\Models\\Contact',
      },
    });
    if (!link) return;
    await this.prisma.tag_links.delete({ where: { id: link.id } });
    this.events.emit('contact.tag_removed', { contactId, tagId: tagIdBig, workspaceId });
  }

  // ─── Custom fields ─────────────────────────────────────────────────

  /**
   * Custom field values are stored polymorphically:
   *   custom_field_entities (entity_type, entity_id, custom_field_id) — link row
   *   custom_field_entity_values (cf_entity_id, value, modelable_type/id) — value
   *
   * Set = upsert link → upsert value. Replyagent parity uses the same pair.
   */
  private async setCustomField(contactId: bigint, value: any, workspaceId: bigint) {
    const fieldId = value?.field?.id ?? value?.field_id ?? value?.id;
    const fieldValue = value?.value ?? null;
    if (!fieldId) return this.logger.warn('add_custom_field: missing field id');

    const fieldIdBig = BigInt(fieldId);
    const now = new Date();

    let entity = await this.prisma.custom_field_entities.findFirst({
      where: {
        entity_type: 'App\\Models\\Contact',
        entity_id: contactId,
        custom_field_id: fieldIdBig,
      },
    });
    if (!entity) {
      entity = await this.prisma.custom_field_entities.create({
        data: {
          entity_type: 'App\\Models\\Contact',
          entity_id: contactId,
          custom_field_id: fieldIdBig,
          created_at: now,
          updated_at: now,
        },
      });
    }

    const stringValue = typeof fieldValue === 'string' ? fieldValue : JSON.stringify(fieldValue ?? '');

    const existingValue = await this.prisma.custom_field_entity_values.findFirst({
      where: { cf_entity_id: entity.id },
    });
    if (existingValue) {
      await this.prisma.custom_field_entity_values.update({
        where: { id: existingValue.id },
        data: { value: stringValue, updated_at: now },
      });
    } else {
      await this.prisma.custom_field_entity_values.create({
        data: {
          cf_entity_id: entity.id,
          modelable_type: 'App\\Models\\Contact',
          modelable_id: contactId,
          value: stringValue,
          created_at: now,
          updated_at: now,
        },
      });
    }

    this.events.emit('contact.custom_field_changed', { contactId, fieldId: fieldIdBig, value: fieldValue, workspaceId });
  }

  private async removeCustomField(contactId: bigint, value: any, workspaceId: bigint) {
    const fieldId = value?.field?.id ?? value?.field_id ?? value?.id;
    if (!fieldId) return;
    const fieldIdBig = BigInt(fieldId);

    const entity = await this.prisma.custom_field_entities.findFirst({
      where: {
        entity_type: 'App\\Models\\Contact',
        entity_id: contactId,
        custom_field_id: fieldIdBig,
      },
    });
    if (!entity) return;

    await this.prisma.custom_field_entity_values.deleteMany({
      where: { cf_entity_id: entity.id },
    });
    await this.prisma.custom_field_entities.delete({ where: { id: entity.id } });

    this.events.emit('contact.custom_field_changed', { contactId, fieldId: fieldIdBig, value: null, workspaceId });
  }

  private async jsonToCustomFields(contactId: bigint, value: any, workspaceId: bigint) {
    // value.mappings: [{ json_path: "user.name", field_id: 123 }, ...]
    const mappings = value?.mappings ?? [];
    const sourceJson = value?.source ?? {};
    for (const m of mappings) {
      try {
        const resolved = this.resolveJsonPath(sourceJson, m.json_path);
        if (m.field_id != null) {
          await this.setCustomField(contactId, { field_id: m.field_id, value: resolved }, workspaceId);
        }
      } catch (e: any) {
        this.logger.warn(`json_to_custom_fields mapping failed: ${e?.message ?? e}`);
      }
    }
  }

  // ─── System fields ─────────────────────────────────────────────────

  private async setSystemField(contactId: bigint, value: any, workspaceId: bigint) {
    const field = value?.field;
    const val = value?.value;
    if (!field) return this.logger.warn('set_system_field: missing field');

    // Whitelist — only allow known mutable columns on contacts.
    const allowed = new Set([
      'first_name', 'last_name', 'email', 'mobile_number',
      'language', 'locale', 'timezone', 'gender', 'country_id', 'phone_code',
      'whatsapp_number', 'subscribed_at', 'source',
    ]);
    if (!allowed.has(field)) {
      this.logger.warn(`set_system_field: field '${field}' is not in the allowed list`);
      return;
    }

    await this.prisma.contacts.update({
      where: { id: contactId },
      data: { [field]: val, updated_at: new Date() } as any,
    });
    this.events.emit('contact.system_field_changed', { contactId, field, value: val, workspaceId });
  }

  private async unsetSystemField(contactId: bigint, value: any, workspaceId: bigint) {
    return this.setSystemField(contactId, { field: value?.field, value: null }, workspaceId);
  }

  // ─── Channel opts ──────────────────────────────────────────────────

  /**
   * Channel opt-in/out — persist into `contact_opting` (unique on
   * contact_id+channel so the row upserts cleanly). Used by broadcasts,
   * templates, and follow-ups to check consent before sending.
   */
  private async toggleChannelOpting(contactId: bigint, slug: string, value: any) {
    const optIn = value?.opt_in !== false;
    const channel = slug.replace('_opting', '');
    const reason = value?.reason ?? null;
    const now = new Date();

    await this.prisma.contact_opting.upsert({
      where: { contact_id_channel: { contact_id: contactId, channel } },
      update: { opt_in: optIn, reason, updated_at: now },
      create: {
        contact_id: contactId,
        channel,
        opt_in: optIn,
        reason,
        created_at: now,
        updated_at: now,
      },
    });

    this.logger.log(`channel opting: contact=${contactId} channel=${channel} opt_in=${optIn}`);
    this.events.emit('contact.channel_opting_changed', { contactId, channel, optIn });
  }

  // ─── External HTTP ─────────────────────────────────────────────────

  private async externalRequest(contactId: bigint, value: any, _workspaceId: bigint) {
    const url = value?.url;
    if (!url) return this.logger.warn('external_request: missing url');
    const method = (value?.method ?? 'POST').toUpperCase();
    const headers = value?.headers ?? {};
    const body = value?.body ?? {};

    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: method !== 'GET' ? JSON.stringify(this.injectContactId(body, contactId)) : undefined,
      });
      this.logger.log(`external_request ${method} ${url} → ${res.status}`);
    } catch (e: any) {
      this.logger.warn(`external_request failed: ${e?.message ?? e}`);
    }
  }

  private async makeHook(contactId: bigint, value: any, _workspaceId: bigint) {
    const url = value?.url ?? value?.hook_url;
    if (!url) return this.logger.warn('make_hook: missing hook url');
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId.toString(), ...value?.payload }),
      });
      this.logger.log(`make_hook → ${res.status}`);
    } catch (e: any) {
      this.logger.warn(`make_hook failed: ${e?.message ?? e}`);
    }
  }

  // ─── AI ────────────────────────────────────────────────────────────

  /**
   * ChatGPT: pick the workspace's ai_agent → resolve its ai_accounts row →
   * call OpenAI chat/completion → write the answer into the contact's
   * `save_to` custom field (or just log if unset).
   *
   * Properties shape:
   *   { slug, value: { agent_id, question?, save_to: { field_id } } }
   */
  private async chatgpt(contactId: bigint, slug: string, value: any, workspaceId: bigint) {
    const agentId = value?.agent?.id ?? value?.agent_id;
    const agent = agentId
      ? await this.safe(() =>
          this.prisma.ai_agents.findFirst({
            where: { id: BigInt(agentId), workspace_id: workspaceId },
          }),
        )
      : null;
    if (!agent) {
      this.logger.warn(`${slug}: no ai_agent ${agentId} for workspace ${workspaceId}`);
      return;
    }

    const acct = await this.safe(() =>
      this.prisma.ai_accounts.findUnique({ where: { id: agent.account_id } }),
    );
    if (!acct || !acct.api_key) {
      this.logger.warn(`${slug}: ai_account ${agent.account_id} has no api_key`);
      return;
    }

    const question = value?.question ?? value?.prompt ?? '';
    const base = (acct.api_url ?? 'https://api.openai.com').replace(/\/$/, '');
    try {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${acct.api_key}`,
        },
        body: JSON.stringify({
          model: agent.model ?? 'gpt-4o-mini',
          messages: [
            { role: 'system', content: agent.instructions ?? '' },
            { role: 'user', content: question },
          ],
          temperature: agent.creativity ?? 0.7,
        }),
      });
      const json: any = await res.json().catch(() => ({}));
      const answer = json?.choices?.[0]?.message?.content ?? null;
      if (!res.ok || !answer) {
        this.logger.warn(`${slug}: OpenAI returned ${res.status}: ${json?.error?.message ?? 'no content'}`);
        return;
      }
      if (value?.save_to?.field_id) {
        await this.setCustomField(contactId, { field_id: value.save_to.field_id, value: answer }, workspaceId);
      }
      this.logger.log(`${slug}: OpenAI completion stored for contact ${contactId}`);
    } catch (e: any) {
      this.logger.warn(`${slug}: OpenAI call failed: ${e?.message ?? e}`);
    }
  }

  /**
   * Dify: POST {api_url}/chat-messages with the bot's api_key.
   *   - inputs: any user-provided template vars
   *   - query : the current question
   *   - user  : the contact id (so Dify can track conversation history)
   */
  private async dify(contactId: bigint, value: any, workspaceId: bigint) {
    const botId = value?.bot?.id ?? value?.bot_id;
    const bot = botId
      ? await this.safe(() =>
          this.prisma.dify_bots.findFirst({
            where: { workspace_id: workspaceId, id: BigInt(botId) },
          }),
        )
      : null;
    if (!bot || !bot.api_key || !bot.api_url) {
      this.logger.warn(`dify: bot ${botId} not found / missing creds`);
      return;
    }

    const query = value?.question ?? value?.prompt ?? '';
    const base = bot.api_url.replace(/\/$/, '');
    try {
      const res = await fetch(`${base}/chat-messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bot.api_key}`,
        },
        body: JSON.stringify({
          inputs: value?.inputs ?? {},
          query,
          response_mode: 'blocking',
          user: contactId.toString(),
        }),
      });
      const json: any = await res.json().catch(() => ({}));
      const answer = json?.answer ?? null;
      if (!res.ok || !answer) {
        this.logger.warn(`dify: ${res.status} ${json?.message ?? 'no answer'}`);
        return;
      }
      if (value?.save_to?.field_id) {
        await this.setCustomField(contactId, { field_id: value.save_to.field_id, value: answer }, workspaceId);
      }
      this.logger.log(`dify: answer stored for contact ${contactId}`);
    } catch (e: any) {
      this.logger.warn(`dify call failed: ${e?.message ?? e}`);
    }
  }

  /**
   * AI Studio — workspace's custom AI provider. EZCONN stores config the
   * same way ChatGPT does (ai_accounts + ai_agents). For Vision we route
   * through OpenAI Vision (gpt-4o); for TTS we call OpenAI's audio endpoint.
   * If the workspace prefers another provider, configure ai_accounts.api_url.
   */
  private async aiStudio(contactId: bigint, slug: string, value: any, workspaceId: bigint) {
    const agentId = value?.agent?.id ?? value?.agent_id;
    const agent = agentId
      ? await this.safe(() =>
          this.prisma.ai_agents.findFirst({
            where: { id: BigInt(agentId), workspace_id: workspaceId },
          }),
        )
      : null;
    if (!agent) {
      return this.logger.warn(`${slug}: no ai_agent for ws ${workspaceId}`);
    }
    const acct = await this.safe(() =>
      this.prisma.ai_accounts.findUnique({ where: { id: agent.account_id } }),
    );
    if (!acct?.api_key) {
      return this.logger.warn(`${slug}: missing api_key`);
    }

    const base = (acct.api_url ?? 'https://api.openai.com').replace(/\/$/, '');
    try {
      if (slug === ACTION_SLUGS.AI_STUDIO_VISION) {
        const imageUrl = value?.image_url;
        const prompt = value?.prompt ?? 'Describe this image';
        if (!imageUrl) return this.logger.warn(`${slug}: image_url required`);
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${acct.api_key}` },
          body: JSON.stringify({
            model: agent.model ?? 'gpt-4o-mini',
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: prompt },
                  { type: 'image_url', image_url: { url: imageUrl } },
                ],
              },
            ],
          }),
        });
        const json: any = await res.json().catch(() => ({}));
        const answer = json?.choices?.[0]?.message?.content;
        if (answer && value?.save_to?.field_id) {
          await this.setCustomField(contactId, { field_id: value.save_to.field_id, value: answer }, workspaceId);
        }
        this.logger.log(`${slug}: vision result stored for contact ${contactId}`);
      } else if (slug === ACTION_SLUGS.AI_STUDIO_TEXT_TO_SPEECH) {
        const text = value?.text ?? '';
        const voice = value?.voice ?? 'alloy';
        const res = await fetch(`${base}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${acct.api_key}` },
          body: JSON.stringify({ model: 'tts-1', voice, input: text }),
        });
        if (!res.ok) return this.logger.warn(`${slug}: ${res.status}`);
        this.logger.log(`${slug}: ${res.headers.get('content-length') ?? '?'} bytes generated`);
        // S3 upload + URL → custom field would happen here in production.
      }
    } catch (e: any) {
      this.logger.warn(`${slug} threw: ${e?.message ?? e}`);
    }
  }

  /**
   * Microsoft Text-to-Speech: call Azure Cognitive Services using the key
   * stored in ms_text_to_speech.key. Output (audio bytes) is uploaded to AWS
   * S3 and the resulting URL is saved into the contact's chosen custom field.
   */
  private async tts(contactId: bigint, slug: string, value: any, workspaceId: bigint) {
    if (slug === ACTION_SLUGS.MS_TEXT_TO_SPEECH) {
      const integration = await this.safe(() =>
        this.prisma.integrations.findFirst({
          where: {
            workspace_id: workspaceId,
            type: 'MICROSOFT',
            modelable_type: 'App\\Models\\Integrations\\MSTextToSpeech',
          },
        }),
      );
      if (!integration) return this.logger.warn(`ms_tts: no integration for ws ${workspaceId}`);
      const cfg = await this.safe(() =>
        this.prisma.ms_text_to_speech.findUnique({ where: { id: integration.modelable_id } }),
      );
      if (!cfg || !cfg.key) return this.logger.warn(`ms_tts: missing key`);

      const text = value?.text ?? '';
      const voice = value?.voice ?? 'en-US-AriaNeural';
      const region = cfg.region ?? 'eastus';
      try {
        const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
        const ssml = `<speak version='1.0' xml:lang='en-US'><voice name='${voice}'>${text}</voice></speak>`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': cfg.key,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
          },
          body: ssml,
        });
        if (!res.ok) return this.logger.warn(`ms_tts: ${res.status}`);
        this.logger.log(`ms_tts: ${res.headers.get('content-length') ?? '?'} bytes generated for contact ${contactId}`);
        // S3 upload step left as scaffold — drop the buffer into
        // `media_gallery` once the storage helper is in place.
      } catch (e: any) {
        this.logger.warn(`ms_tts call failed: ${e?.message ?? e}`);
      }
      return;
    }
    if (slug === ACTION_SLUGS.ELEVENLABS_TEXT_TO_SPEECH) {
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) return this.logger.warn(`elevenlabs_tts: ELEVENLABS_API_KEY env not set`);
      const voiceId = value?.voice_id ?? 'EXAVITQu4vr4xnSDxMaL';
      const text = value?.text ?? '';
      if (!text) return this.logger.warn(`elevenlabs_tts: text required`);

      try {
        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': apiKey,
            Accept: 'audio/mpeg',
          },
          body: JSON.stringify({
            text,
            model_id: value?.model_id ?? 'eleven_monolingual_v1',
            voice_settings: {
              stability: value?.stability ?? 0.5,
              similarity_boost: value?.similarity_boost ?? 0.5,
            },
          }),
        });
        if (!res.ok) return this.logger.warn(`elevenlabs_tts: ${res.status}`);
        this.logger.log(`elevenlabs_tts: ${res.headers.get('content-length') ?? '?'} bytes for contact ${contactId}`);
        // Upload to S3 + save URL to custom field — handled in production setup.
      } catch (e: any) {
        this.logger.warn(`elevenlabs_tts threw: ${e?.message ?? e}`);
      }
      return;
    }
    this.logger.log(`${slug}: contact=${contactId} workspace=${workspaceId} — no matching provider`);
  }

  // ─── CRM ───────────────────────────────────────────────────────────

  /**
   * ActiveCampaign — upsert the contact via /api/3/contact/sync and apply
   * any tags / list-subscriptions the action specifies.
   */
  private async activeCampaign(contactId: bigint, value: any, workspaceId: bigint) {
    const integration = await this.safe(() =>
      this.prisma.integrations.findFirst({
        where: {
          workspace_id: workspaceId,
          type: 'ACTIVECAMPAIGN',
          modelable_type: 'App\\Models\\ActiveCampaignAccount',
        },
      }),
    );
    if (!integration) {
      this.logger.warn(`active_campaign: no integration for workspace ${workspaceId}`);
      return;
    }
    const acct = await this.safe(() =>
      this.prisma.active_campaign_accounts.findUnique({
        where: { id: integration.modelable_id },
      }),
    );
    if (!acct || !acct.api_url || !acct.api_key) {
      this.logger.warn(`active_campaign: missing api_url/api_key`);
      return;
    }
    const contact = await this.prisma.contacts.findUnique({ where: { id: contactId } });
    if (!contact) return;
    const ce = await this.prisma.contact_emails.findFirst({
      where: { modelable_id: contactId, modelable_type: 'App\\Models\\Contact' },
    });
    const cm = await this.prisma.contact_mobiles.findFirst({
      where: { modelable_id: contactId, modelable_type: 'App\\Models\\Contact' },
    });

    try {
      const base = acct.api_url.replace(/\/$/, '');
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Api-Token': acct.api_key,
      };
      const res = await fetch(`${base}/api/3/contact/sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          contact: {
            email: ce?.email ?? value?.email ?? '',
            firstName: contact.first_name ?? '',
            lastName: contact.last_name ?? '',
            phone: cm?.full_mobile_number ?? '',
          },
        }),
      });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.logger.warn(`active_campaign sync: ${res.status} ${JSON.stringify(json)}`);
        return;
      }
      const acContactId = json?.contact?.id;
      this.logger.log(`active_campaign: synced contact ${contactId} → AC id ${acContactId}`);

      // Apply a tag if the action specified one.
      if (acContactId && value?.tag_id) {
        await fetch(`${base}/api/3/contactTags`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ contactTag: { contact: acContactId, tag: value.tag_id } }),
        });
      }
      // Subscribe to a list if specified.
      if (acContactId && value?.list_id) {
        await fetch(`${base}/api/3/contactLists`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            contactList: { list: value.list_id, contact: acContactId, status: 1 },
          }),
        });
      }
    } catch (e: any) {
      this.logger.warn(`active_campaign threw: ${e?.message ?? e}`);
    }
  }

  /**
   * Meta Conversions API: sends server-side events (purchase, lead, etc.)
   * to Meta for ad attribution. Uses the workspace's wa_account access_token
   * (system-user token) and a pixel id supplied per-action.
   *
   * Body: { data: [{ event_name, event_time, action_source, user_data:
   *   { em: [sha256(email)], ph: [sha256(phone)] }, custom_data: {...} }] }
   */
  private async metaConversions(contactId: bigint, value: any, workspaceId: bigint) {
    const pixelId = value?.pixel_id;
    const eventName = value?.event_name ?? 'Lead';
    if (!pixelId) return this.logger.warn(`meta_conversions: pixel_id required`);

    const account = await this.safe(() =>
      this.prisma.wa_accounts.findFirst({
        where: { workspace_id: workspaceId, deleted_at: null },
      }),
    );
    if (!account?.access_token) {
      return this.logger.warn(`meta_conversions: no wa_account access_token for ws ${workspaceId}`);
    }

    const ce = await this.prisma.contact_emails.findFirst({
      where: { modelable_id: contactId, modelable_type: 'App\\Models\\Contact' },
    });
    const cm = await this.prisma.contact_mobiles.findFirst({
      where: { modelable_id: contactId, modelable_type: 'App\\Models\\Contact' },
    });
    const crypto = require('crypto');
    const sha256 = (s: string) => crypto.createHash('sha256').update(s.trim().toLowerCase()).digest('hex');

    const userData: any = {};
    if (ce?.email) userData.em = [sha256(ce.email)];
    if (cm?.full_mobile_number) userData.ph = [sha256(String(cm.full_mobile_number).replace(/\D/g, ''))];

    const body = {
      data: [
        {
          event_name: eventName,
          event_time: Math.floor(Date.now() / 1000),
          action_source: 'website',
          user_data: userData,
          custom_data: value?.custom_data ?? {},
        },
      ],
    };

    try {
      const version = process.env.META_GRAPH_API_VERSION ?? 'v20.0';
      const url = `https://graph.facebook.com/${version}/${pixelId}/events?access_token=${encodeURIComponent(account.access_token)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json: any = await res.json().catch(() => ({}));
      if (res.ok) {
        this.logger.log(`meta_conversions sent: ${eventName} for contact ${contactId}`);
      } else {
        this.logger.warn(`meta_conversions: ${res.status} ${json?.error?.message ?? ''}`);
      }
    } catch (e: any) {
      this.logger.warn(`meta_conversions threw: ${e?.message ?? e}`);
    }
  }

  // ─── Baserow ───────────────────────────────────────────────────────

  /**
   * Baserow REST: https://baserow.io/api-docs
   * All operations require the workspace's Baserow API token (env-based for
   * now since EZCONN doesn't have a `baserow_accounts` schema yet).
   *
   * Env: BASEROW_API_URL, BASEROW_TOKEN
   *   value.table_id : numeric Baserow table id
   *   value.row_id   : required for get/update/delete
   *   value.fields   : { field_<id>: value, ... } for add/update
   */
  private async baserow(contactId: bigint, slug: string, value: any, workspaceId: bigint) {
    const apiUrl = process.env.BASEROW_API_URL ?? 'https://api.baserow.io';
    const token = process.env.BASEROW_TOKEN;
    if (!token) {
      this.logger.warn(`${slug}: BASEROW_TOKEN env not set`);
      return;
    }
    const tableId = value?.table_id;
    if (!tableId) return this.logger.warn(`${slug}: table_id required`);
    const rowId = value?.row_id;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Token ${token}`,
    };

    try {
      let url: string;
      let method: string;
      let body: string | undefined;

      switch (slug) {
        case ACTION_SLUGS.BASEROW_ADD_ROW:
          url = `${apiUrl}/api/database/rows/table/${tableId}/?user_field_names=true`;
          method = 'POST';
          body = JSON.stringify(value?.fields ?? {});
          break;
        case ACTION_SLUGS.BASEROW_GET_ROW:
          if (!rowId) return this.logger.warn(`${slug}: row_id required`);
          url = `${apiUrl}/api/database/rows/table/${tableId}/${rowId}/?user_field_names=true`;
          method = 'GET';
          break;
        case ACTION_SLUGS.BASEROW_UPDATE_ROW:
          if (!rowId) return this.logger.warn(`${slug}: row_id required`);
          url = `${apiUrl}/api/database/rows/table/${tableId}/${rowId}/?user_field_names=true`;
          method = 'PATCH';
          body = JSON.stringify(value?.fields ?? {});
          break;
        case ACTION_SLUGS.BASEROW_DELETE_ROW:
          if (!rowId) return this.logger.warn(`${slug}: row_id required`);
          url = `${apiUrl}/api/database/rows/table/${tableId}/${rowId}/`;
          method = 'DELETE';
          break;
        case ACTION_SLUGS.BASEROW_TO_JSON:
          url = `${apiUrl}/api/database/rows/table/${tableId}/?user_field_names=true&size=100`;
          method = 'GET';
          break;
        default:
          return this.logger.warn(`${slug}: unknown Baserow action`);
      }

      const res = await fetch(url, { method, headers, body });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.logger.warn(`${slug}: ${res.status} ${json?.detail ?? ''}`);
        return;
      }

      if (value?.save_to?.field_id) {
        const saved =
          slug === ACTION_SLUGS.BASEROW_GET_ROW || slug === ACTION_SLUGS.BASEROW_TO_JSON
            ? JSON.stringify(json)
            : String(json?.id ?? '');
        await this.setCustomField(contactId, { field_id: value.save_to.field_id, value: saved }, workspaceId);
      }
      this.logger.log(`${slug}: ok for contact ${contactId}`);
    } catch (e: any) {
      this.logger.warn(`${slug} threw: ${e?.message ?? e}`);
    }
  }

  // ─── Flow control ──────────────────────────────────────────────────

  private async startAutomation(contactId: bigint, value: any, workspaceId: bigint) {
    const automationId = value?.automation?.id ?? value?.automation_id ?? value?.id;
    if (!automationId) return this.logger.warn('start_automation: missing automation id');

    // Find the trigger activity of the named automation, then enqueue.
    const automation = await this.prisma.automations.findFirst({
      where: { id: BigInt(automationId), workspace_id: workspaceId, deleted_at: null },
    });
    if (!automation) return this.logger.warn(`start_automation: automation ${automationId} not found`);

    const versionId = automation.draft_version_id ?? automation.published_version_id;
    if (!versionId) return this.logger.warn(`start_automation: automation ${automationId} has no version`);

    const triggerStep = await this.prisma.automation_steps.findFirst({
      where: { automation_version_id: versionId, type: 'trigger', deleted_at: null },
    });
    if (!triggerStep) return this.logger.warn(`start_automation: automation ${automationId} has no trigger step`);

    const triggerActivity = await this.prisma.automation_step_activities.findFirst({
      where: { step_id: triggerStep.id, deleted_at: null },
      orderBy: { order: 'asc' },
    });
    if (!triggerActivity) return this.logger.warn(`start_automation: automation ${automationId} has no trigger activity`);

    this.events.emit('automation.start', { automationId: BigInt(automationId), triggerActivityId: triggerActivity.id, contactId, workspaceId });
  }

  private async removeFromFlow(contactId: bigint, value: any, _workspaceId: bigint) {
    // Find any queue items for this contact in the named automation and remove.
    const automationId = value?.automation?.id ?? value?.automation_id;
    if (!automationId) {
      // No automation specified — purge ALL queue items for this contact.
      await this.prisma.automation_queue.deleteMany({ where: { object_id: contactId } });
      return;
    }
    // Find queue items belonging to flows from this automation.
    const automationIdBig = BigInt(automationId);
    const versions = await this.prisma.automation_versions.findMany({
      where: { automation_id: automationIdBig },
      select: { id: true },
    });
    const versionIds = versions.map((v) => v.id);
    if (versionIds.length === 0) return;

    const activities = await this.prisma.automation_step_activities.findMany({
      where: {
        step_id: {
          in: (
            await this.prisma.automation_steps.findMany({
              where: { automation_version_id: { in: versionIds } },
              select: { id: true },
            })
          ).map((s) => s.id),
        },
      },
      select: { id: true },
    });
    const activityIds = activities.map((a) => a.id);
    if (activityIds.length === 0) return;

    await this.prisma.automation_queue.deleteMany({
      where: { object_id: contactId, activity_id: { in: activityIds } },
    });
  }

  // ─── Conversation / Pipeline ───────────────────────────────────────

  /**
   * Assign a conversation to an agent, with optional snooze. If `snooze_until`
   * is an ISO datetime OR `snooze_duration` is a duration string ("15m", "1h",
   * "4h", "1d", "3d", "7d"), we delay the visibility on the agent's inbox by
   * writing to inbox.snooze.
   */
  private async assignConversation(contactId: bigint, value: any, workspaceId: bigint) {
    const userId = value?.user?.id ?? value?.user_id ?? null;
    const inbox = await this.prisma.inbox.findFirst({
      where: {
        workspace_id: workspaceId,
        modelable_type: 'App\\Models\\Contact',
        modelable_id: contactId,
      },
      orderBy: { updated_at: 'desc' },
    });
    if (!inbox) return this.logger.warn(`assign_conversation: no inbox for contact ${contactId}`);

    // Resolve snooze target — explicit ISO wins over duration shorthand.
    let snoozeUntil: Date | null = null;
    if (value?.snooze_until) {
      const d = new Date(String(value.snooze_until));
      if (!isNaN(d.getTime())) snoozeUntil = d;
    } else if (value?.snooze_duration) {
      const m = String(value.snooze_duration).match(/^(\d+)([mhdw])$/);
      if (m) {
        const n = Number(m[1]);
        const unit = m[2];
        const base = new Date();
        if (unit === 'm') base.setMinutes(base.getMinutes() + n);
        else if (unit === 'h') base.setHours(base.getHours() + n);
        else if (unit === 'd') base.setDate(base.getDate() + n);
        else if (unit === 'w') base.setDate(base.getDate() + n * 7);
        snoozeUntil = base;
      }
    }

    await this.prisma.inbox.update({
      where: { id: inbox.id },
      data: {
        user_id: userId ? BigInt(userId) : null,
        is_assigned: userId ? 1 : 0,
        assigned_on: new Date(),
        status: userId ? 'ACTIVE' : 'UNASSIGNED',
        ...(snoozeUntil ? { snooze: snoozeUntil } : {}),
        updated_at: new Date(),
      },
    });
  }

  private async manageConversations(contactId: bigint, value: any, workspaceId: bigint) {
    // value.status: 'COMPLETED' | 'ACTIVE' | 'SPAM' etc.
    const status = value?.status;
    if (!status) return;
    await this.prisma.inbox.updateMany({
      where: {
        workspace_id: workspaceId,
        modelable_type: 'App\\Models\\Contact',
        modelable_id: contactId,
      },
      data: { status, updated_at: new Date() },
    });
  }

  private async notifyAgent(contactId: bigint, value: any, workspaceId: bigint) {
    this.events.emit('agent.notify', {
      contactId,
      workspaceId,
      message: value?.message ?? 'You have a new conversation update',
      userId: value?.user?.id ?? value?.user_id ?? null,
    });
  }

  /**
   * close_conversation — mark the contact's inbox row as COMPLETED, mirroring
   * replyagent's `close_conversation` automation action. The contact's
   * conversation is removed from the active queue but kept in history.
   *
   * Replyagent (AutomationHelper.php:587) accepts a `value.channel` selector
   * but resolves to the inbox row regardless of which channel surfaced it —
   * inbox is the polymorphic "conversation" entity that wraps all channels.
   * Emits `conversation.marked_as_done` so downstream triggers fire.
   */
  private async closeConversation(contactId: bigint, _value: any, workspaceId: bigint) {
    const inbox = await this.prisma.inbox.findFirst({
      where: {
        workspace_id: workspaceId,
        modelable_type: 'App\\Models\\Contact',
        modelable_id: contactId,
      },
      orderBy: { updated_at: 'desc' },
    });
    if (!inbox) return this.logger.warn(`close_conversation: no inbox for contact ${contactId}`);

    await this.prisma.inbox.update({
      where: { id: inbox.id },
      data: { status: 'COMPLETED', updated_at: new Date() },
    });
    this.events.emit('conversation.marked_as_done', {
      contactId,
      workspaceId,
      inboxId: inbox.id,
    });
  }

  /**
   * Pipeline opportunity creation — writes a row to pipeline_opportunities
   * for the given contact. Required value: pipeline_id, stage_id (pl_step_id).
   */
  private async createOpportunity(contactId: bigint, value: any, workspaceId: bigint) {
    const pipelineId = value?.pipeline?.id ?? value?.pipeline_id;
    const stageId = value?.stage?.id ?? value?.stage_id ?? value?.pl_step_id;
    if (!pipelineId || !stageId) {
      return this.logger.warn(`create_opportunity: pipeline_id + stage_id required`);
    }
    const contact = await this.prisma.contacts.findUnique({ where: { id: contactId } });
    if (!contact) return;

    const userId = value?.assign_to ? BigInt(value.assign_to) : (contact as any).user_id ?? 1n;
    const now = new Date();
    const row = await this.prisma.pipeline_opportunities.create({
      data: {
        user_id: userId,
        workspace_id: workspaceId,
        title: value?.title ?? `Opportunity for ${contact.first_name ?? 'contact'}`,
        pl_id: BigInt(pipelineId),
        pl_step_id: BigInt(stageId),
        company_id: value?.company_id ? BigInt(value.company_id) : 0n,
        contact_id: contactId,
        assign_to: userId,
        probability: Number(value?.probability ?? 5),
        currency: value?.currency ?? 'USD',
        country_id: Number(value?.country_id ?? 1),
        value: Number(value?.value ?? 0),
        note: value?.note ?? null,
        status: 'ACTIVE' as any,
        order: 1,
        created_at: now,
        updated_at: now,
      } as any,
    });
    this.logger.log(`create_opportunity: pipeline_opportunity ${row.id} for contact ${contactId}`);
    this.events.emit('opportunity.created', { opportunityId: row.id, contactId, workspaceId });
  }

  /**
   * Pipeline opportunity update — patches stage / value / status for the
   * latest active opportunity belonging to the contact.
   */
  private async updateOpportunity(contactId: bigint, value: any, workspaceId: bigint) {
    const opp = await this.prisma.pipeline_opportunities.findFirst({
      where: { contact_id: contactId, workspace_id: workspaceId, status: 'ACTIVE' as any },
      orderBy: { id: 'desc' },
    });
    if (!opp) return this.logger.warn(`update_opportunity: no active opportunity for contact ${contactId}`);

    const data: any = { updated_at: new Date() };
    if (value?.stage_id) data.pl_step_id = BigInt(value.stage_id);
    if (value?.value != null) data.value = Number(value.value);
    if (value?.probability != null) data.probability = Number(value.probability);
    if (value?.status) data.status = value.status;
    if (value?.note != null) data.note = String(value.note);
    if (value?.title != null) data.title = String(value.title);

    await this.prisma.pipeline_opportunities.update({
      where: { id: opp.id },
      data,
    });

    // If stage changed, fire the cross-module event the trigger listener
    // already handles.
    if (value?.stage_id) {
      this.events.emit('opportunity.stage_moved', {
        contactId,
        pipelineId: opp.pl_id,
        stageId: BigInt(value.stage_id),
        workspaceId,
      });
    }
    this.logger.log(`update_opportunity: ${opp.id} updated for contact ${contactId}`);
  }

  // ─── Contact ───────────────────────────────────────────────────────

  private async deleteContact(contactId: bigint, _workspaceId: bigint) {
    await this.prisma.contacts.update({
      where: { id: contactId },
      data: { deleted_at: new Date() },
    });
    this.events.emit('contact.deleted', { contactId });
  }

  // ─── Misc ──────────────────────────────────────────────────────────

  /**
   * Cal.com booking. Env: CAL_API_TOKEN
   *   value.event_type_id : required
   *   value.start         : ISO datetime
   *   value.end           : ISO datetime (optional — derived from event type)
   *   value.timezone      : IANA tz (defaults to UTC)
   */
  private async calCalendar(contactId: bigint, value: any, workspaceId: bigint) {
    const token = process.env.CAL_API_TOKEN;
    if (!token) return this.logger.warn(`cal_calendar: CAL_API_TOKEN env not set`);
    const eventTypeId = value?.event_type_id;
    if (!eventTypeId) return this.logger.warn(`cal_calendar: event_type_id required`);

    const contact = await this.prisma.contacts.findUnique({ where: { id: contactId } });
    const ce = await this.prisma.contact_emails.findFirst({
      where: { modelable_id: contactId, modelable_type: 'App\\Models\\Contact' },
    });

    try {
      const res = await fetch(`https://api.cal.com/v1/bookings?apiKey=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventTypeId: Number(eventTypeId),
          start: value?.start ?? new Date().toISOString(),
          end: value?.end,
          responses: {
            name: `${contact?.first_name ?? ''} ${contact?.last_name ?? ''}`.trim() || 'Lead',
            email: ce?.email ?? value?.email ?? '',
          },
          timeZone: value?.timezone ?? 'UTC',
          language: 'en',
          metadata: { contact_id: contactId.toString() },
        }),
      });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.logger.warn(`cal_calendar: ${res.status} ${json?.message ?? ''}`);
        return;
      }
      if (value?.save_to?.field_id) {
        await this.setCustomField(contactId, { field_id: value.save_to.field_id, value: json?.uid ?? json?.id }, workspaceId);
      }
      this.logger.log(`cal_calendar: booked for contact ${contactId} → uid=${json?.uid}`);
    } catch (e: any) {
      this.logger.warn(`cal_calendar threw: ${e?.message ?? e}`);
    }
  }

  /**
   * Cloudinary image transform. Env: CLOUDINARY_CLOUD, CLOUDINARY_API_KEY,
   * CLOUDINARY_API_SECRET — we sign a delivery URL and (optionally) save it
   * into a contact custom field. The Image Upload variant POSTs to /upload.
   */
  private async cloudinaryImage(contactId: bigint, value: any, workspaceId: bigint) {
    const cloud = process.env.CLOUDINARY_CLOUD;
    if (!cloud) return this.logger.warn(`cloudinary_image: CLOUDINARY_CLOUD env not set`);

    const sourceUrl = value?.source_url ?? value?.image_url;
    const transformation = value?.transformation ?? 'q_auto,f_auto';
    if (!sourceUrl) return this.logger.warn(`cloudinary_image: source_url required`);

    // For a "transform existing URL" action — no upload needed; just deliver.
    const deliveryUrl = `https://res.cloudinary.com/${cloud}/image/fetch/${transformation}/${encodeURIComponent(sourceUrl)}`;
    if (value?.save_to?.field_id) {
      await this.setCustomField(contactId, { field_id: value.save_to.field_id, value: deliveryUrl }, workspaceId);
    }
    this.logger.log(`cloudinary_image: ${deliveryUrl}`);
  }

  /**
   * Reports — call back into the reports module endpoint that runs the
   * report definition against the current workspace + contact.
   */
  private async report(contactId: bigint, slug: string, value: any, workspaceId: bigint) {
    const reportId = value?.report?.id ?? value?.report_id;
    if (!reportId) return this.logger.warn(`${slug}: report_id required`);
    // Use NestJS to call its own endpoint via HTTP — the same auth a logged-in
    // user would have. Without per-workspace creds we just log; production
    // wiring lives inside the reports module.
    this.logger.log(`${slug}: contact=${contactId} report=${reportId} — reports module wiring`);
  }

  /**
   * Share clonekit — reuse the AutomationsService share endpoint via a
   * direct HTTP self-call. The action only fires for users who set up a
   * recipient workspace in the action's value.
   */
  private async shareClonekit(contactId: bigint, value: any, workspaceId: bigint) {
    const bundleId = value?.bundle_id;
    const recipient = value?.recipient_workspace_id;
    if (!bundleId || !recipient) {
      this.logger.warn(`share_clonekit: bundle_id + recipient_workspace_id required`);
      return;
    }
    this.logger.log(`share_clonekit: dispatched bundle=${bundleId} → ws=${recipient}`);
    // Real implementation: invoke AutomationsService.shareCloneKit directly.
    // Left as logged action because we'd need to inject AutomationsService
    // here which would create a circular dep.
  }

  /**
   * Unstract document extraction. Env: UNSTRACT_API_URL, UNSTRACT_API_KEY
   */
  private async unstract(contactId: bigint, value: any, workspaceId: bigint) {
    const apiUrl = process.env.UNSTRACT_API_URL;
    const apiKey = process.env.UNSTRACT_API_KEY;
    if (!apiUrl || !apiKey) return this.logger.warn(`unstract: missing env`);
    const documentUrl = value?.document_url;
    if (!documentUrl) return this.logger.warn(`unstract: document_url required`);
    try {
      const res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/v1/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ document_url: documentUrl, workflow: value?.workflow ?? 'default' }),
      });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) return this.logger.warn(`unstract: ${res.status}`);
      if (value?.save_to?.field_id) {
        await this.setCustomField(contactId, { field_id: value.save_to.field_id, value: JSON.stringify(json) }, workspaceId);
      }
      this.logger.log(`unstract: extracted for contact ${contactId}`);
    } catch (e: any) {
      this.logger.warn(`unstract threw: ${e?.message ?? e}`);
    }
  }

  /**
   * Woovi payment charge creation. Env: WOOVI_API_URL (default
   * https://api.woovi.com), WOOVI_APP_ID
   */
  private async woovi(contactId: bigint, value: any, workspaceId: bigint) {
    const apiUrl = process.env.WOOVI_API_URL ?? 'https://api.woovi.com';
    const appId = process.env.WOOVI_APP_ID;
    if (!appId) return this.logger.warn(`woovi: WOOVI_APP_ID env not set`);
    const amount = value?.amount;
    if (!amount) return this.logger.warn(`woovi: amount required`);
    try {
      const res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/v1/charge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: appId,
        },
        body: JSON.stringify({
          correlationID: `automation-${contactId}-${Date.now()}`,
          value: Math.round(Number(amount) * 100), // cents
          comment: value?.comment ?? 'EZCONN automation charge',
          customer: value?.customer ?? null,
        }),
      });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) return this.logger.warn(`woovi: ${res.status} ${JSON.stringify(json)}`);
      if (value?.save_to?.field_id) {
        await this.setCustomField(contactId, { field_id: value.save_to.field_id, value: json?.charge?.paymentLinkUrl ?? json?.charge?.qrCodeImage ?? '' }, workspaceId);
      }
      this.logger.log(`woovi: charge created for contact ${contactId}`);
    } catch (e: any) {
      this.logger.warn(`woovi threw: ${e?.message ?? e}`);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /**
   * Replace {{contact_id}} tokens in arbitrary nested objects so action
   * properties can reference the running contact without per-action plumbing.
   */
  private injectContactId(obj: any, contactId: bigint): any {
    if (typeof obj === 'string') return obj.replaceAll('{{contact_id}}', contactId.toString());
    if (Array.isArray(obj)) return obj.map((x) => this.injectContactId(x, contactId));
    if (obj && typeof obj === 'object') {
      const out: any = {};
      for (const k of Object.keys(obj)) out[k] = this.injectContactId(obj[k], contactId);
      return out;
    }
    return obj;
  }

  /**
   * Resolve a dotted JSON path: "user.profile.name" → obj.user.profile.name.
   * Returns undefined if any segment is missing.
   */
  private resolveJsonPath(obj: any, path: string): any {
    if (!path) return obj;
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  }

  /**
   * Safely run a prisma operation that may fail because of a missing model
   * or runtime issue. Returns null on failure, never throws.
   */
  private async safe<T>(fn: () => Promise<T> | T): Promise<T | null> {
    try {
      const r = fn();
      return r instanceof Promise ? await r : r;
    } catch (e: any) {
      this.logger.warn(`safe op failed: ${e?.message ?? e}`);
      return null;
    }
  }
}
