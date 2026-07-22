import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { MetaGraphApiClient } from '../whatsapp/meta-graph-api.client';

@Injectable()
export class WabaService {
  private readonly logger = new Logger(WabaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaGraphApiClient,
  ) {}

  /**
   * Auto-import templates when a WABA finishes onboarding (goes ACTIVE). The
   * consumer emits this after WA_VERIFICATION_RESULT flips the account to ACTIVE.
   * Mirrors replyagent's ProcessTemplates dispatch on account activation, so a
   * freshly-connected account's templates appear without a manual Sync.
   */
  @OnEvent('whatsapp.account.activated')
  async onAccountActivated(payload: { workspaceId: bigint }): Promise<void> {
    if (!payload?.workspaceId) return;
    try {
      await this.syncTemplatesFromMeta(payload.workspaceId);
    } catch (e: any) {
      this.logger.warn(`Template auto-import on activation failed: ${e?.message ?? e}`);
    }
  }

  /**
   * Pull all message templates from Meta for the workspace's WABA(s) and upsert
   * into wa_templates. Status (APPROVED/PENDING/REJECTED) plus components and
   * language reflect Meta's authoritative state. Call after onboarding and on
   * admin-triggered "sync" button.
   */
  async syncTemplatesFromMeta(workspaceId: bigint) {
    const accounts = await this.prisma.wa_accounts.findMany({
      where: { workspace_id: workspaceId, deleted_at: null },
    });
    if (accounts.length === 0) throw new NotFoundException('No WABA accounts found for workspace');

    let totalSynced = 0;
    for (const acc of accounts) {
      const remote = await this.meta.fetchTemplates(acc.waba_id, acc.access_token);
      for (const t of remote) {
        const existing = await this.prisma.wa_templates.findFirst({
          where: { wa_account_id: acc.id.toString(), template_id: t.id ?? t.name },
        });
        // Rebuild the authoring structure from Meta's definition so an imported
        // template is editable and, crucially, sendable — `template` has to be
        // the send-ready payload, not the raw Meta object (see createTemplate).
        const structure = this.structureFromMetaTemplate(t);
        const data: any = {
          wa_account_id: acc.id.toString(),
          template_id: t.id ?? t.name,
          name: t.name,
          category: t.category ?? 'UTILITY',
          status: t.status ?? 'PENDING',
          language: t.language ?? 'en',
          structure: JSON.stringify(structure),
          components: t.components ? JSON.stringify(t.components) : null,
          example: JSON.stringify(t),
          template: JSON.stringify(
            this.buildSendPayload(
              structure,
              acc.message_template_namespace,
              t.name,
              t.language ?? 'en',
              true,
            ),
          ),
          last_updated: new Date(),
          updated_at: new Date(),
        };
        if (existing) {
          await this.prisma.wa_templates.update({ where: { id: existing.id }, data });
        } else {
          await this.prisma.wa_templates.create({
            data: { ...data, created_at: new Date() },
          });
        }
        totalSynced++;
      }
    }
    this.logger.log(`syncTemplatesFromMeta: synced ${totalSynced} templates for workspace ${workspaceId}`);
    return { success: true, synced: totalSynced };
  }

  /**
   * Create a WhatsApp message template. Builds Meta's `components` payload from
   * the form fields, submits it to the Graph API (template enters PENDING
   * review), and persists a local wa_templates row so it shows in the list.
   */
  async createTemplate(workspaceId: bigint, dto: any) {
    const accounts = await this.prisma.wa_accounts.findMany({
      where: { workspace_id: workspaceId, deleted_at: null },
    });
    if (accounts.length === 0) throw new NotFoundException('No WhatsApp account connected for this workspace');

    const account =
      (dto?.wa_account_id != null
        ? accounts.find((a) => a.id.toString() === String(dto.wa_account_id))
        : undefined) ?? accounts[0];

    const { name, category, language, components } = await this.buildTemplateComponents(
      dto,
      this.systemUserToken(account.access_token),
    );
    const payload = { name, language, category, components, allow_category_change: false };

    // ── submit to Meta + persist ─────────────────────────────────────────
    const res = await this.meta.createTemplate(account.waba_id, account.access_token, payload);

    const now = new Date();
    // Column semantics, verified against the replyagent dump — they are not
    // interchangeable and getting them wrong breaks downstream consumers:
    //   structure = the composer's authoring state (keeps `parameters`, the
    //               gallery `media` record, and the per-section sidecars). It is
    //               the ONLY input to the send-payload builder and to re-editing.
    //   example   = the exact template DEFINITION submitted to Meta.
    //   template  = the send-ready MESSAGE payload (namespace + lowercase
    //               component types + `parameters`), consumed by inbox and
    //               broadcast sends. It used to hold the raw Meta response here,
    //               which no consumer could actually send.
    const structure = this.buildAuthoringStructure(dto, { name, category, language, components });
    const row = await this.prisma.wa_templates.create({
      data: {
        wa_account_id: account.id.toString(),
        template_id: res?.id ?? name,
        name,
        category: (res?.category ?? category) as string,
        status: (res?.status ?? 'PENDING') as string,
        type: String(dto?.template_type ?? dto?.templateType ?? 'template').slice(0, 15),
        language,
        structure: JSON.stringify(structure),
        components: JSON.stringify(components),
        example: JSON.stringify(payload),
        template: JSON.stringify(
          this.buildSendPayload(structure, account.message_template_namespace, name, language, true),
        ),
        last_updated: now,
        created_at: now,
        updated_at: now,
      },
    });
    this.logger.log(`createTemplate: "${name}" (${category}/${language}) → Meta id ${res?.id ?? 'n/a'} status ${res?.status ?? 'PENDING'}`);
    return row;
  }

  /**
   * Token used for the template media upload. Meta scopes uploads to the APP,
   * not the WABA, so replyagent uses a system-user token (`WA_SYSTEM_USER`).
   * We fall back to the account token when that env var is unset, which is
   * enough for single-app deployments.
   */
  private systemUserToken(accountToken: string): string {
    return process.env.WA_SYSTEM_USER || accountToken;
  }

  /**
   * Sanitize a variable's value before it goes into Meta's template-definition
   * `example` field. Port of replyagent `prepareMetaTemplateStructure` (gateway
   * `WhatsappHelper.php:2408-2409`): strip underscores, then replace every
   * remaining non-alphanumeric/dash character with a space. This is what turns
   * a merge tag like `[CONTACT_FIRST_NAME]` into the plain example text Meta's
   * reviewers see (`CONTACTFIRSTNAME`) — the brackets and underscores would
   * otherwise ride into the submission verbatim.
   *
   * Note: this only touches the Meta-facing `example`. The authoring
   * `structure.parameters[].text` keeps the original merge tag/sample so
   * send-time substitution still has something to match against.
   */
  private sanitizeExampleValue(value: string): string {
    return String(value ?? '')
      .split('_')
      .join('')
      .replace(/[^A-Za-z0-9-]/g, ' ');
  }

  /** Unique `{{var}}` names in a string, in first-seen order. */
  private varsOf(text: string): string[] {
    const matches = String(text ?? '').match(/\{\{([^}]+)\}\}/g) ?? [];
    const seen: string[] = [];
    for (const raw of matches) {
      const key = raw.replace(/^\{\{|\}\}$/g, '').trim();
      if (!seen.includes(key)) seen.push(key);
    }
    return seen;
  }

  /**
   * Build the authoring `structure` blob replyagent stores alongside every
   * template. It is the Meta definition plus the editor-only data Meta strips:
   * per-variable `parameters` (which carry the value each `{{n}}` resolves to)
   * and the gallery `media` record behind a media header.
   *
   * The per-section sidecars (`header_component` / `body_component` / …) are
   * denormalised copies replyagent's builder reads directly; they are kept so a
   * structure written here stays readable by the same consumers.
   */
  private buildAuthoringStructure(
    dto: any,
    built: { name: string; category: string; language: string; components: any[] },
  ): any {
    const samples: Record<string, string> = dto?.examples ?? dto?.variableSamples ?? {};
    const galleryMedia = dto?.mediaHeader?.media ?? dto?.media ?? null;

    const dtoCards: any[] = dto?.cards ?? dto?.carouselCards ?? [];

    const withParams = built.components.map((c: any) => {
      const component = { ...c };
      if (component.type === 'CAROUSEL') {
        // Re-attach each card's gallery record so the composer can re-open the
        // carousel with its images still in place, and give card bodies their
        // `parameters` so the send payload can resolve the variables.
        component.cards = (component.cards ?? []).map((card: any, index: number) => ({
          ...card,
          components: (card.components ?? []).map((cardComponent: any) => {
            const copy = { ...cardComponent };
            if (copy.type === 'HEADER' && dtoCards[index]?.media) {
              copy.example = { ...(copy.example ?? {}), media: dtoCards[index].media };
            }
            if (copy.type === 'BODY') {
              const vars = this.varsOf(copy.text);
              if (vars.length) {
                const cardSamples: Record<string, string> =
                  dtoCards[index]?.examples ?? dtoCards[index]?.variableSamples ?? {};
                copy.parameters = vars.map((v) => ({
                  field_type: 'FIXED',
                  type: 'text',
                  text: cardSamples[v] ?? v,
                }));
              }
            }
            return copy;
          }),
        }));
        return component;
      }
      if (component.type === 'HEADER' && component.format === 'TEXT') {
        const vars = this.varsOf(component.text);
        if (vars.length) {
          component.parameters = vars.map((v) => ({
            field_type: 'FIXED',
            type: 'text',
            text: samples[v] ?? v,
          }));
        }
      } else if (component.type === 'HEADER' && component.format !== 'TEXT' && galleryMedia) {
        // Meta never sees `media`, but keeping it lets the composer re-open the
        // template with its file still attached, and lets DOCUMENT sends recover
        // the original filename.
        component.example = { ...(component.example ?? {}), media: galleryMedia };
      } else if (component.type === 'BODY') {
        const vars = this.varsOf(component.text);
        if (vars.length) {
          component.parameters = vars.map((v) => ({
            field_type: 'FIXED',
            type: 'text',
            text: samples[v] ?? v,
          }));
        }
      }
      return component;
    });

    const find = (t: string, fmt?: (c: any) => boolean) =>
      withParams.find((c: any) => c.type === t && (!fmt || fmt(c))) ?? null;

    return {
      name: built.name,
      language: built.language,
      category: built.category,
      components: withParams,
      header_component: find('HEADER'),
      body_component: find('BODY'),
      footer_component: find('FOOTER'),
      buttons_component: find('BUTTONS'),
    };
  }

  /**
   * Turn an authoring `structure` into the send-ready message payload stored in
   * `wa_templates.template`. Port of replyagent `WhatsappHelper::prepareTemplate`
   * + `prepareComponent`.
   *
   * Shape differences from the definition payload matter: component types are
   * lowercased, values move into `parameters`, QUICK_REPLY buttons become their
   * own top-level `button` components, and CAROUSEL cards keep a `card_index`.
   *
   * `withData` controls media headers: when false a non-TEXT header is dropped
   * (replyagent does this so a payload built before upload cannot reference a
   * handle that does not exist yet).
   */
  private buildSendPayload(
    structure: any,
    namespace: string | null | undefined,
    name: string,
    language: string,
    withData = false,
  ): any {
    const tpl: any = {
      namespace: namespace ?? '',
      name,
      language: { code: language, policy: 'deterministic' },
    };

    const prepareComponent = (component: any): any | null => {
      if (!component) return null;
      if (component.type === 'HEADER') {
        if (component.format === 'TEXT') {
          const params = (component.parameters ?? [])
            .filter((p: any) => p?.text !== '' && p?.text != null)
            .map((p: any) => ({ type: 'text', text: p.text }));
          return params.length ? { type: 'header', parameters: params } : null;
        }
        if (!withData) return null;
        const handle = component?.example?.header_handle?.[0];
        if (!handle) return null;
        if (component.format === 'IMAGE') {
          return { type: 'header', parameters: [{ type: 'image', image: { link: handle } }] };
        }
        if (component.format === 'VIDEO') {
          return { type: 'header', parameters: [{ type: 'video', video: { link: handle } }] };
        }
        if (component.format === 'DOCUMENT') {
          const document: any = { link: handle };
          const fileName = component?.example?.media?.file_name;
          if (fileName) document.filename = fileName;
          return { type: 'header', parameters: [{ type: 'document', document }] };
        }
        return null;
      }
      if (component.type === 'BODY') {
        const params = (component.parameters ?? [])
          .filter((p: any) => p?.text !== '' && p?.text != null)
          .map((p: any) => ({ type: 'text', text: p.text }));
        return params.length ? { type: 'body', parameters: params } : null;
      }
      return null;
    };

    const quickReplyComponents = (buttons: any[]): any[] =>
      (buttons ?? [])
        .map((button: any, index: number) =>
          button?.type === 'QUICK_REPLY' && button?.payload != null
            ? {
                type: 'button',
                sub_type: 'quick_reply',
                index,
                parameters: [{ type: 'payload', payload: JSON.stringify(button.payload) }],
              }
            : null,
        )
        .filter(Boolean);

    const out: any[] = [];
    for (const component of structure?.components ?? []) {
      if (!component) continue;
      if (component.type === 'CAROUSEL') {
        const cards: any[] = [];
        (component.cards ?? []).forEach((card: any, cardIndex: number) => {
          if (!card?.components) return;
          const cardComponents: any[] = [];
          for (const cardComponent of card.components) {
            if (cardComponent?.type === 'BUTTONS' && cardComponent?.buttons?.length) {
              cardComponents.push(...quickReplyComponents(cardComponent.buttons));
            } else {
              const prepared = prepareComponent(cardComponent);
              if (prepared) cardComponents.push(prepared);
            }
          }
          cards.push({ card_index: cardIndex, components: cardComponents });
        });
        if (cards.length) out.push({ type: 'CAROUSEL', cards });
      } else if (component.type === 'BUTTONS' && component.buttons?.length) {
        out.push(...quickReplyComponents(component.buttons));
      } else {
        const prepared = prepareComponent(component);
        if (prepared) out.push(prepared);
      }
    }
    if (out.length) tpl.components = out;
    return tpl;
  }

  /**
   * Derive an authoring `structure` from a template definition fetched from
   * Meta. Port of replyagent `WhatsappHelper::prepareStructureFromTemplate`.
   *
   * Meta returns each variable's example value under `example.header_text` /
   * `example.body_text[0]`; those become the `parameters` entries the send-payload
   * builder reads. replyagent seeds them with an empty `text` (so an imported
   * template is unsendable until a human maps it); we seed with the example value
   * instead, which makes imports immediately usable and is still overwritten the
   * moment anyone edits the template.
   */
  private structureFromMetaTemplate(t: any): any {
    const components = (t?.components ?? []).map((raw: any) => {
      const component = { ...raw };
      if (component.type === 'HEADER' && component.format === 'TEXT') {
        const examples: string[] = component?.example?.header_text ?? [];
        if (examples.length) {
          component.parameters = examples.map((value: string) => ({
            field_type: 'FIXED',
            type: 'text',
            text: value,
          }));
        }
      } else if (component.type === 'BODY') {
        const examples: string[] = component?.example?.body_text?.[0] ?? [];
        if (examples.length) {
          component.parameters = examples.map((value: string) => ({
            field_type: 'FIXED',
            type: 'text',
            text: value,
          }));
        }
      }
      return component;
    });

    const find = (type: string) => components.find((c: any) => c.type === type) ?? null;
    return {
      name: t?.name,
      language: t?.language,
      category: t?.category,
      status: t?.status,
      id: t?.id,
      components,
      header_component: find('HEADER'),
      body_component: find('BODY'),
      footer_component: find('FOOTER'),
      buttons_component: find('BUTTONS'),
    };
  }

  /**
   * POST /waba/templates/:id/structure — persist an edited authoring structure
   * and rebuild the send payload from it. Mirrors replyagent's
   * `WhatsappController@saveStructure`, which is how a synced template gets its
   * variables mapped without being resubmitted to Meta for re-approval.
   */
  async saveStructure(workspaceId: bigint, id: bigint, structure: any) {
    const template = await this.getTemplate(id, workspaceId); // validates ownership
    if (!structure || typeof structure !== 'object') {
      throw new BadRequestException('structure must be an object');
    }
    const account = await this.prisma.wa_accounts.findFirst({
      where: { id: BigInt(template.wa_account_id), deleted_at: null },
    });
    if (!account) throw new NotFoundException('WhatsApp account not found for this template');

    const now = new Date();
    const row = await this.prisma.wa_templates.update({
      where: { id: template.id },
      data: {
        structure: JSON.stringify(structure),
        template: JSON.stringify(
          this.buildSendPayload(
            structure,
            account.message_template_namespace,
            template.name,
            template.language,
            true,
          ),
        ),
        last_updated: now,
        updated_at: now,
      },
    });
    this.logger.log(`saveStructure: template ${template.id} ("${template.name}") remapped`);
    return row;
  }

  /** Map a frontend button object to Meta's template button schema. */
  private mapTemplateButton(b: any): any | null {
    const text = String(b?.buttonText ?? b?.text ?? '').trim();
    switch (b?.type) {
      case 'quick-reply':
        return text ? { type: 'QUICK_REPLY', text } : null;
      case 'visit-website':
        return text && b?.websiteUrl ? { type: 'URL', text, url: String(b.websiteUrl).trim() } : null;
      case 'call-phone':
        return text && b?.phoneNumber
          ? { type: 'PHONE_NUMBER', text, phone_number: `${b?.country ?? ''}${b.phoneNumber}`.trim() }
          : null;
      case 'copy-offer':
        // Meta requires `text` on COPY_CODE too — omitting it made every
        // coupon button fail validation at submit time.
        return text && b?.offerCode
          ? { type: 'COPY_CODE', text, example: String(b.offerCode).trim() }
          : null;
      case 'call-whatsapp':
        return text ? { type: 'VOICE_CALL', text } : null;
      case 'complete-flow':
        return text && b?.flowId
          ? {
              type: 'FLOW',
              text,
              flow_id: String(b.flowId),
              ...(b?.flowButton ? { navigate_screen: String(b.flowButton) } : {}),
            }
          : null;
      default:
        return null;
    }
  }

  /**
   * Build the CAROUSEL component from the composer's `cards` array.
   *
   * Meta's rules, which replyagent enforces in its builder and which are
   * re-checked here because the API is reachable without that UI:
   *   • 1-10 cards
   *   • every card needs an IMAGE or VIDEO header, a body, and 1-2 buttons
   *   • all cards must expose the SAME button types, in the same order —
   *     Meta rejects the whole template otherwise
   *
   * Card media uploads use the CAROUSEL_CARD upload variant (a different query
   * string on the session-create call, per replyagent).
   */
  private async buildCarouselComponent(cards: any[], systemUserToken: string): Promise<any> {
    if (!Array.isArray(cards) || cards.length === 0) {
      throw new BadRequestException('Add at least 1 card to a carousel template');
    }
    if (cards.length > 10) {
      throw new BadRequestException('A carousel template supports at most 10 cards');
    }

    const builtCards: any[] = [];
    let referenceButtonTypes: string | null = null;

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i] ?? {};
      const label = `Card ${i + 1}`;
      const components: any[] = [];

      // ── header (required, IMAGE or VIDEO only) ──
      const format = String(card?.mediaFormat ?? card?.format ?? 'IMAGE').toUpperCase();
      if (!['IMAGE', 'VIDEO'].includes(format)) {
        throw new BadRequestException(`${label}: carousel headers must be an image or a video`);
      }
      const media = card?.media ?? card?.mediaHeader?.media;
      if (!media?.file_url) {
        throw new BadRequestException(`${label}: select a header image or video from the gallery`);
      }
      const handle = await this.meta.uploadTemplateMedia(
        {
          file_length: Number(media.file_length ?? 0),
          mime_type: String(media.mime_type ?? ''),
          file_name: String(media.file_name ?? 'upload'),
          file_url: String(media.file_url),
        },
        systemUserToken,
        'CAROUSEL_CARD',
      );
      if (!handle) {
        throw new BadRequestException({
          message: `${label}: uploading the header media to Meta failed. Please try again.`,
          error_code: 'TRY_AGAIN',
        });
      }
      components.push({ type: 'HEADER', format, example: { header_handle: [handle] } });

      // ── body (required, 160 chars in replyagent's composer) ──
      const body = String(card?.body ?? '').trim();
      if (!body) throw new BadRequestException(`${label}: body text is required`);
      const bodyComponent: any = { type: 'BODY', text: body };
      const vars = this.varsOf(body);
      if (vars.length) {
        const samples: Record<string, string> = card?.examples ?? card?.variableSamples ?? {};
        bodyComponent.example = {
          body_text: [vars.map((v) => this.sanitizeExampleValue(samples[v] ?? v))],
        };
      }
      components.push(bodyComponent);

      // ── buttons (required, 1-2, consistent across cards) ──
      const buttons = (Array.isArray(card?.buttons) ? card.buttons : [])
        .map((b: any) => this.mapTemplateButton(b))
        .filter(Boolean);
      if (buttons.length === 0) {
        throw new BadRequestException(`${label}: at least one button is required`);
      }
      if (buttons.length > 2) {
        throw new BadRequestException(`${label}: a carousel card supports at most 2 buttons`);
      }
      const signature = buttons.map((b: any) => b.type).join(',');
      if (referenceButtonTypes === null) {
        referenceButtonTypes = signature;
      } else if (signature !== referenceButtonTypes) {
        throw new BadRequestException(
          'Button types must be the same across all carousel cards',
        );
      }
      components.push({ type: 'BUTTONS', buttons });

      builtCards.push({ components });
    }

    return { type: 'CAROUSEL', cards: builtCards };
  }

  /**
   * Build the Meta template `{ name, category, language, components }` from the
   * composer DTO. Shared by createTemplate (new) and updateTemplate (resubmit).
   */
  private async buildTemplateComponents(
    dto: any,
    systemUserToken: string,
    templateType: 'MEDIA_TEMPLATE' | 'CAROUSEL_CARD' = 'MEDIA_TEMPLATE',
  ): Promise<{
    name: string;
    category: string;
    language: string;
    components: any[];
  }> {
    const name = String(dto?.name ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!name) throw new BadRequestException('Template name is required');

    const body = String(dto?.body ?? '').trim();
    if (!body) throw new BadRequestException('Template body is required');

    // replyagent's composer offers MARKETING and UTILITY only. AUTHENTICATION
    // is a real Meta category but it needs a dedicated composer (OTP button,
    // code_expiration_minutes, add_security_recommendation) that neither app
    // has — accepting it here just produced templates Meta rejects, so it is
    // refused with an explanation instead.
    const category = String(dto?.category ?? 'UTILITY').trim().toUpperCase();
    if (category === 'AUTHENTICATION') {
      throw new BadRequestException(
        'Authentication templates are not supported — they need one-time-passcode components. Use Marketing or Utility.',
      );
    }
    if (!['MARKETING', 'UTILITY'].includes(category)) {
      throw new BadRequestException(`Unsupported template category "${category}".`);
    }

    // Language: replyagent's picker submits a Meta locale slug directly (`en_US`,
    // `pt_BR`, `zh_CN`, … 72 of them), so a slug is passed straight through. The
    // friendly-name map only exists to translate older composer payloads that
    // sent an English word; anything unmapped that is *not* already a slug would
    // be rejected by Meta, so it is caught here rather than at the Graph call.
    const rawLang = String(dto?.language ?? '').trim();
    const langMap: Record<string, string> = {
      english: 'en_US',
      urdu: 'ur',
      arabic: 'ar',
      spanish: 'es',
      french: 'fr',
      german: 'de',
      portuguese: 'pt_BR',
      italian: 'it',
    };
    const language = /^[a-z]{2,3}(_[A-Z]{2})?$/.test(rawLang)
      ? rawLang
      : (langMap[rawLang.toLowerCase()] ?? '');
    if (!language) {
      throw new BadRequestException(
        `Unsupported template language "${rawLang}". Pass a Meta locale code such as en_US, es_MX or pt_BR.`,
      );
    }

    const samples: Record<string, string> = dto?.examples ?? dto?.variableSamples ?? {};
    const varsOf = (text: string): string[] => {
      const m = String(text ?? '').match(/\{\{([^}]+)\}\}/g) ?? [];
      const seen: string[] = [];
      for (const raw of m) {
        const key = raw.replace(/^\{\{|\}\}$/g, '').trim();
        if (!seen.includes(key)) seen.push(key);
      }
      return seen;
    };

    const components: any[] = [];

    // replyagent's builder has three modes and they are NOT additive — a
    // carousel has no header/footer/top-level buttons (its bubble is body-only,
    // everything else lives on the cards), and an agent notification has no
    // buttons and only a text header. Building all sections regardless would
    // ship components Meta rejects for that template shape.
    const mode = String(dto?.template_type ?? dto?.templateType ?? 'template')
      .trim()
      .toLowerCase();

    if (mode === 'carousel') {
      const bubble: any = { type: 'BODY', text: body };
      const bubbleVars = this.varsOf(body);
      if (bubbleVars.length) {
        bubble.example = { body_text: [bubbleVars.map((v) => samples[v] ?? v)] };
      }
      components.push(bubble);
      components.push(
        await this.buildCarouselComponent(dto?.cards ?? dto?.carouselCards ?? [], systemUserToken),
      );
      return { name, category, language, components };
    }

    const headerText = String(dto?.header ?? dto?.headerText ?? '').trim();

    // ── Media header ──────────────────────────────────────────────────────
    // Meta will not accept a URL here: the file has to be uploaded to the app
    // first, and the opaque handle that returns is what goes in header_handle.
    // replyagent picks the file from the workspace media gallery, so the DTO
    // carries the gallery record (`mediaHeader.media`) rather than a raw upload.
    const mediaFormat = String(dto?.mediaSample ?? dto?.mediaHeader?.format ?? 'none')
      .trim()
      .toUpperCase();
    if (mode === 'notification' && mediaFormat && mediaFormat !== 'NONE') {
      throw new BadRequestException('Agent notification templates support a text header only');
    }
    if (mediaFormat && mediaFormat !== 'NONE') {
      if (!['IMAGE', 'VIDEO', 'DOCUMENT'].includes(mediaFormat)) {
        throw new BadRequestException(
          `Unsupported media header format "${mediaFormat}". Use image, video or document.`,
        );
      }
      const media = dto?.mediaHeader?.media ?? dto?.media;
      if (!media?.file_url) {
        throw new BadRequestException(
          'Select a media file from the gallery for the header — Meta needs the file itself, not a URL.',
        );
      }
      const handle = await this.meta.uploadTemplateMedia(
        {
          file_length: Number(media.file_length ?? 0),
          mime_type: String(media.mime_type ?? ''),
          file_name: String(media.file_name ?? 'upload'),
          file_url: String(media.file_url),
        },
        systemUserToken,
        templateType,
      );
      if (!handle) {
        // replyagent surfaces this as error_code TRY_AGAIN so the composer can
        // offer a retry rather than losing the user's work.
        throw new BadRequestException({
          message: 'Uploading the header media to Meta failed. Please try again.',
          error_code: 'TRY_AGAIN',
        });
      }
      components.push({
        type: 'HEADER',
        format: mediaFormat,
        example: { header_handle: [handle] },
      });
    } else if (headerText) {
      const header: any = { type: 'HEADER', format: 'TEXT', text: headerText };
      const hv = varsOf(headerText);
      if (hv.length) {
        header.example = { header_text: hv.map((v) => this.sanitizeExampleValue(samples[v] || v)) };
      }
      components.push(header);
    }

    const bodyComp: any = { type: 'BODY', text: body };
    const bv = varsOf(body);
    if (bv.length) {
      bodyComp.example = { body_text: [bv.map((v) => this.sanitizeExampleValue(samples[v] || v))] };
    }
    components.push(bodyComp);

    const footerText = String(dto?.footer ?? dto?.footerText ?? '').trim();
    if (footerText) components.push({ type: 'FOOTER', text: footerText });

    // Agent notifications carry no buttons at all (replyagent hides the whole
    // section for that mode), so anything sent is dropped rather than shipped.
    const buttons =
      mode === 'notification'
        ? []
        : Array.isArray(dto?.buttons)
          ? dto.buttons.map((b: any) => this.mapTemplateButton(b)).filter(Boolean)
          : [];
    if (buttons.length) components.push({ type: 'BUTTONS', buttons });

    return { name, category, language, components };
  }

  /**
   * Edit + resubmit a REJECTED / PAUSED template for re-approval. Mirrors
   * replyagent's create flow, which POSTs the rebuilt structure to the existing
   * `{template_id}` (Meta edit endpoint) and flips the row back to PENDING.
   * Meta does not allow renaming, so the stored name/language are preserved.
   */
  async updateTemplate(workspaceId: bigint, id: bigint, dto: any) {
    const template = await this.getTemplate(id, workspaceId); // validates workspace ownership
    const status = String(template.status ?? '').toUpperCase();
    if (!['REJECTED', 'PAUSED'].includes(status)) {
      throw new BadRequestException('Only rejected or paused templates can be edited and resubmitted');
    }
    if (!template.template_id) {
      throw new BadRequestException('Template has no Meta id — delete and recreate it instead');
    }
    const account = await this.prisma.wa_accounts.findFirst({
      where: { id: BigInt(template.wa_account_id), deleted_at: null },
    });
    if (!account) throw new NotFoundException('WhatsApp account not found for this template');

    // Rebuild the structure, forcing the immutable name/language to the stored values.
    const built = await this.buildTemplateComponents(
      { ...dto, name: template.name, language: template.language },
      this.systemUserToken(account.access_token),
    );
    const payload = {
      name: template.name,
      language: template.language,
      category: built.category,
      components: built.components,
      allow_category_change: false,
    };

    await this.meta.updateTemplate(template.template_id, account.access_token, payload);

    const now = new Date();
    const structure = this.buildAuthoringStructure(dto, {
      name: template.name,
      category: built.category,
      language: template.language,
      components: built.components,
    });
    const row = await this.prisma.wa_templates.update({
      where: { id: template.id },
      data: {
        category: built.category,
        status: 'PENDING',
        reason: null,
        structure: JSON.stringify(structure),
        components: JSON.stringify(built.components),
        example: JSON.stringify(payload),
        template: JSON.stringify(
          this.buildSendPayload(
            structure,
            account.message_template_namespace,
            template.name,
            template.language,
            true,
          ),
        ),
        last_updated: now,
        updated_at: now,
      },
    });
    this.logger.log(`updateTemplate: "${template.name}" resubmitted → Meta id ${template.template_id}, status PENDING`);
    return row;
  }

  async getTemplates(workspaceId: bigint) {
    // Find WABA accounts for this workspace. `deleted_at: null` matters — without
    // it the list kept surfacing templates belonging to a disconnected account.
    const accounts = await this.prisma.wa_accounts.findMany({
      where: { workspace_id: workspaceId, deleted_at: null },
    });

    if (accounts.length === 0) return [];

    const accountIds = accounts.map((a) => a.id.toString());

    // Fetch templates for these accounts
    const templates = await this.prisma.wa_templates.findMany({
      where: {
        wa_account_id: { in: accountIds },
      },
      orderBy: { created_at: 'desc' },
    });

    return templates;
  }

  async getTemplate(id: bigint, workspaceId: bigint) {
    // Verification that template belongs to workspace
    const template = await this.prisma.wa_templates.findUnique({
      where: { id },
    });

    if (!template) throw new NotFoundException('Template not found');

    const account = await this.prisma.wa_accounts.findFirst({
      where: {
        id: BigInt(template.wa_account_id),
        workspace_id: workspaceId,
      },
    });

    if (!account)
      throw new NotFoundException('Template does not belong to your workspace');

    return template;
  }

  async deleteTemplate(id: bigint, workspaceId: bigint) {
    const template = await this.getTemplate(id, workspaceId);
    const account = await this.prisma.wa_accounts.findFirst({
      where: { id: BigInt(template.wa_account_id), workspace_id: workspaceId },
    });

    if (account) {
      try {
        await this.meta.deleteTemplate(
          account.waba_id,
          account.access_token,
          template.name,
          template.template_id,
        );
      } catch (e: any) {
        // Don't block local cleanup if Meta returns 404 — already gone there.
        this.logger.warn(`Meta deleteTemplate failed for ${template.name}: ${e?.message ?? e}`);
      }
    }

    await this.prisma.wa_templates.delete({ where: { id: template.id } });
    return { success: true };
  }

  async getTemplateStatistics(workspaceId: bigint) {
    const accounts = await this.prisma.wa_accounts.findMany({
      where: { workspace_id: workspaceId },
    });

    if (accounts.length === 0) {
      return {
        total: 0,
        approved: 0,
        pending: 0,
        delivered: 0,
        readRate: '0%',
        cost: '$0.00'
      };
    }

    const accountIds = accounts.map((a) => a.id.toString());

    const [total, approved, pending] = await Promise.all([
      this.prisma.wa_templates.count({
        where: { wa_account_id: { in: accountIds } }
      }),
      this.prisma.wa_templates.count({
        where: { wa_account_id: { in: accountIds }, status: 'APPROVED' }
      }),
      this.prisma.wa_templates.count({
        where: { wa_account_id: { in: accountIds }, status: 'PENDING' }
      })
    ]);

    // Delivery figures come from the outbound messages that actually carried a
    // template. `wa_messages.status` is driven by Meta's delivery webhooks
    // (sent → delivered → read), and a read message counts as delivered too —
    // Meta stops sending `delivered` once `read` arrives, so summing the two
    // states is what gives an honest denominator.
    const templateIds = await this.prisma.wa_templates.findMany({
      where: { wa_account_id: { in: accountIds } },
      select: { id: true },
    });
    const idList = templateIds.map((t) => t.id);

    let delivered = 0;
    let read = 0;
    if (idList.length) {
      [delivered, read] = await Promise.all([
        this.prisma.wa_messages.count({
          where: { wa_template_id: { in: idList }, status: { in: ['delivered', 'read'] } },
        }),
        this.prisma.wa_messages.count({
          where: { wa_template_id: { in: idList }, status: 'read' },
        }),
      ]);
    }

    const readRate = delivered > 0 ? `${Math.round((read / delivered) * 100)}%` : '0%';

    // Cost stays $0.00: Meta bills per 24h conversation, not per template
    // message, and it does not send a price on the status webhook. Reporting a
    // made-up per-message figure here would be worse than reporting nothing —
    // the WhatsApp pricing tab is the place that models conversations.
    return {
      total,
      approved,
      pending,
      delivered,
      readRate,
      cost: '$0.00',
    };
  }
}
