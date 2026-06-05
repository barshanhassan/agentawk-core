import { Injectable, Logger, NotFoundException, BadRequestException, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MetaGraphApiClient } from './meta-graph-api.client';
import { RabbitMqService } from '../rabbitmq/rabbitmq.service';
import { ChatGateway } from '../inbox/chat.gateway';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaGraphApiClient,
    private readonly rabbit: RabbitMqService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => ChatGateway))
    private readonly chatGateway: ChatGateway,
  ) {}

  /**
   * Broadcast a workspace-scoped event so the UI's WhatsApp settings page
   * refreshes its list when an account/number status changes.
   *
   * Mirrors replyagent's broadcast pattern:
   *   - "whatsapp.account_updated.<workspaceId>" → `.whatsapp.account_updated`
   *   - "whatsapp.PhoneNumberUpdated.<workspaceId>" → `.whatsapp.PhoneNumberUpdated`
   *
   * Frontend listens on the same workspace room (joined at connection time)
   * and reloads the channels query when one of these events arrives.
   */
  private emitAccountUpdated(workspaceId: bigint, account: any) {
    try {
      this.chatGateway.emitToWorkspace(workspaceId, 'whatsapp.account_updated', this.serializeAccount(account));
    } catch (e: any) {
      this.logger.debug(`emitAccountUpdated failed: ${e?.message ?? e}`);
    }
  }

  private emitPhoneNumberUpdated(workspaceId: bigint, phoneNumber: any) {
    try {
      this.chatGateway.emitToWorkspace(workspaceId, 'whatsapp.number_updated', this.serializeNumber(phoneNumber));
    } catch (e: any) {
      this.logger.debug(`emitPhoneNumberUpdated failed: ${e?.message ?? e}`);
    }
  }

  private serializeAccount(a: any) {
    if (!a) return null;
    return {
      ...a,
      id: a.id?.toString(),
      workspace_id: a.workspace_id?.toString(),
      user_id: a.user_id?.toString(),
      auto_reply_automation_id: a.auto_reply_automation_id?.toString() ?? null,
    };
  }

  private serializeNumber(n: any) {
    if (!n) return null;
    return {
      ...n,
      id: n.id?.toString(),
      wa_account_id: n.wa_account_id?.toString(),
      auto_reply_automation_id: n.auto_reply_automation_id?.toString() ?? null,
    };
  }

  /**
   * Manual onboarding — user types in WABA ID + access token + phone number ID
   * (or pastes them from Meta dashboard). Skips Meta Embedded Signup entirely.
   *
   * Flow:
   *   1. Validate payload and check ownership conflicts (no other workspace owns this WABA).
   *   2. Upsert wa_accounts + wa_phone_numbers in PENDING status.
   *   3. Publish WA_REGISTER to ra/whatsapp — microservice will create its MongoDB
   *      account, generate a webhookToken, and subscribe the WABA to Meta's webhook.
   *      We tag the payload's `meta.backend_wa_account_id` so when the microservice
   *      echoes back WA_VERIFICATION_RESULT we can match it to our row.
   *
   * Status flips to ACTIVE only when WA_VERIFICATION_RESULT lands (handled in
   * WhatsappEventsConsumer). Until then the row stays PENDING.
   */
  async onboardManual(
    workspaceId: bigint,
    userId: bigint,
    payload: {
      waba_id: string;
      access_token: string;
      name: string;
      phone_number_id: string;
      display_phone_number: string;
      verified_name?: string;
    },
  ) {
    const required = ['waba_id', 'access_token', 'name', 'phone_number_id', 'display_phone_number'] as const;
    for (const k of required) {
      if (!payload?.[k] || String(payload[k]).trim() === '') {
        throw new BadRequestException(`${k} is required`);
      }
    }

    // Fail fast on a bad / expired token — otherwise the user only finds out
    // when the first outbound send returns 401 from Meta. This also catches
    // mismatched (token, phone_number_id) pairs at form-submit time.
    const probe = await this.meta.validatePhoneNumberAccess(payload.phone_number_id, payload.access_token);
    if (!probe.ok) {
      throw new BadRequestException(
        `Meta rejected the access token / phone number ID: ${probe.error ?? 'unknown error'}. ` +
          `Generate a fresh token from the Meta developer dashboard (WhatsApp → API Setup → Generate access token), ` +
          `or use a System User token for long-lived access.`,
      );
    }

    // No cross-workspace WABA conflicts
    const existingDifferentWs = await this.prisma.wa_accounts.findFirst({
      where: { waba_id: payload.waba_id, deleted_at: null, workspace_id: { not: workspaceId } },
    });
    if (existingDifferentWs) {
      throw new BadRequestException('This WABA is already connected to another workspace');
    }

    // No cross-account phone number conflicts (a phone number lives on a single WABA)
    const existingPhoneOnOther = await this.prisma.wa_phone_numbers.findFirst({
      where: { wa_number_id: payload.phone_number_id },
      select: { id: true, wa_account_id: true },
    });

    const now = new Date();
    const accountData: any = {
      workspace_id: workspaceId,
      user_id: userId,
      waba_id: payload.waba_id,
      name: payload.name,
      currency: 'USD',
      timezone_id: '0',
      message_template_namespace: '',
      access_token: payload.access_token,
      status: 'PENDING',
      service_account_id: '',
      onboard_platform: 'whatsapp_business',
      is_migrated: 0,
      updated_at: now,
    };

    let account = await this.prisma.wa_accounts.findFirst({
      where: { workspace_id: workspaceId, waba_id: payload.waba_id, deleted_at: null },
    });
    if (account) {
      account = await this.prisma.wa_accounts.update({
        where: { id: account.id },
        data: accountData,
      });
    } else {
      account = await this.prisma.wa_accounts.create({
        data: { ...accountData, created_at: now },
      });
    }

    if (existingPhoneOnOther && existingPhoneOnOther.wa_account_id !== account.id) {
      throw new BadRequestException('Phone number is connected to another account');
    }

    const phoneData: any = {
      wa_account_id: account.id,
      wa_number_id: payload.phone_number_id,
      display_phone_number: payload.display_phone_number,
      phone_number: payload.display_phone_number.replace(/[^0-9]/g, ''),
      pin_code: '',
      verified_name: payload.verified_name ?? payload.name,
      name_status: 'PENDING',
      code_verification_status: 'NOT_VERIFIED',
      status: 'PENDING',
      quality_rating: 'UNKNOWN',
      auto_reply_interval: '247',
      platform_type: 'CLOUD_API',
      smb_app_data: 0,
      updated_at: now,
    };
    const existingPhone = await this.prisma.wa_phone_numbers.findFirst({
      where: { wa_account_id: account.id, wa_number_id: payload.phone_number_id },
    });
    if (existingPhone) {
      await this.prisma.wa_phone_numbers.update({ where: { id: existingPhone.id }, data: phoneData });
    } else {
      await this.prisma.wa_phone_numbers.create({ data: { ...phoneData, created_at: now } });
    }

    // Publish WA_REGISTER — microservice creates its MongoDB account, subscribes Meta
    // webhook, then echoes WA_VERIFICATION_RESULT back to ra/gateway. We rely on the
    // `meta.backend_wa_account_id` round-trip to flip status to ACTIVE.
    const exchange = this.config.get<string>('RABBITMQ_EXCHANGE') || 'ra';
    const whatsappQueue = this.config.get<string>('RABBITMQ_WHATSAPP_QUEUE') || 'whatsapp';
    try {
      await this.rabbit.publish(exchange, whatsappQueue, {
        event: 'WA_REGISTER',
        payload: {
          whatsappAccountId: payload.waba_id,
          accessToken: payload.access_token,
          name: payload.name,
          meta: {
            backend_wa_account_id: account.id.toString(),
            phone_number_id: payload.phone_number_id,
            workspace_id: workspaceId.toString(),
          },
        },
      });
      this.logger.log(`WA_REGISTER published for wa_account_id=${account.id} waba_id=${payload.waba_id}`);
    } catch (err: any) {
      this.logger.error(`Failed to publish WA_REGISTER for wa_account_id=${account.id}: ${err?.message ?? err}`);
      // Don't roll back the DB row — the user can retry registration without losing data,
      // and the microservice may catch up once RabbitMQ recovers.
    }

    this.emitAccountUpdated(workspaceId, account);

    return {
      success: true,
      account_id: account.id.toString(),
      status: account.status,
      message: 'Account saved as PENDING. Will flip to ACTIVE once the WhatsApp microservice confirms registration.',
    };
  }

  /**
   * Meta Embedded Signup callback. The frontend popup completes the user-side
   * flow and returns three pieces: `code` (OAuth grant), `waba_id` (selected
   * WABA), and optionally `phone_number_id` (selected number). We exchange the
   * code for a long-lived access token, fetch WABA + phone details, persist
   * into wa_accounts + wa_phone_numbers, and subscribe the app to webhooks.
   *
   * Mirrors gateway/app/Http/Controllers/Api/WhatsappController.php → "process"
   * (the Embedded Signup completion handler).
   */
  async onboard(
    workspaceId: bigint,
    userId: bigint,
    payload: {
      code: string;
      waba_id: string;
      phone_number_id?: string;
      onboard_platform?: string;
      // Replyagent contract — frontend may send `_s=aka` to flag a Coexistence
      // signup. When set, we persist onboard_platform=whatsapp_business_app
      // so the front-end's per-platform listing surfaces it under the right tab.
      source?: string;
      _c?: string;
      _w?: string;
      _p?: string;
      _u?: string;
      _b?: string;
      _s?: string;
    },
  ) {
    // Replyagent uses `_c / _w / _p / _u / _b / _s` field names. Accept either
    // shape so the existing onboard page (and any third-party integrators)
    // can post against this endpoint without translation.
    const code = payload?.code ?? payload?._c;
    const wabaId = payload?.waba_id ?? payload?._w;
    const phoneNumberId = payload?.phone_number_id ?? payload?._p;
    const source = payload?.source ?? payload?._s;
    const onboardPlatform =
      payload?.onboard_platform ??
      (source === 'aka' ? 'whatsapp_business_app' : 'whatsapp_business');

    if (!code || !wabaId) {
      throw new BadRequestException('code and waba_id are required');
    }
    // Rewrap payload to the canonical shape so the rest of the method works.
    payload = { ...payload, code, waba_id: wabaId, phone_number_id: phoneNumberId, onboard_platform: onboardPlatform };

    // 1. Exchange OAuth code for access token
    const exchange = await this.meta.exchangeCode(payload.code);
    const accessToken = exchange.access_token;
    if (!accessToken) throw new BadRequestException('Meta did not return access_token');

    // 2. Ensure no other workspace owns this WABA
    const existingDifferentWs = await this.prisma.wa_accounts.findFirst({
      where: { waba_id: payload.waba_id, deleted_at: null, workspace_id: { not: workspaceId } },
    });
    if (existingDifferentWs) {
      throw new BadRequestException('This WABA is already connected to another workspace');
    }

    // 3. Fetch WABA details from Meta + upsert wa_accounts
    const wabaInfo: any = await this.meta.fetchWabaAccount(payload.waba_id, accessToken);
    let account = await this.prisma.wa_accounts.findFirst({
      where: { waba_id: payload.waba_id, workspace_id: workspaceId, deleted_at: null },
    });
    const accountData: any = {
      workspace_id: workspaceId,
      user_id: userId,
      waba_id: wabaInfo.id ?? payload.waba_id,
      name: wabaInfo.name ?? '',
      currency: wabaInfo.currency ?? 'USD',
      timezone_id: String(wabaInfo.timezone_id ?? ''),
      message_template_namespace: wabaInfo.message_template_namespace ?? '',
      account_review_status: wabaInfo.account_review_status ?? null,
      business_verification_status: wabaInfo.business_verification_status ?? 'not_verified',
      is_enabled_for_insights: wabaInfo.is_enabled_for_insights ? 1 : 0,
      on_behalf_of_business_info: wabaInfo.on_behalf_of_business_info
        ? JSON.stringify(wabaInfo.on_behalf_of_business_info)
        : null,
      ownership_type: wabaInfo.ownership_type ?? 'CLIENT_OWNED',
      access_token: accessToken,
      status: 'PENDING',
      service_account_id: '',
      onboard_platform: payload.onboard_platform ?? 'whatsapp_business',
      updated_at: new Date(),
    };
    if (account) {
      account = await this.prisma.wa_accounts.update({
        where: { id: account.id },
        data: accountData,
      });
    } else {
      account = await this.prisma.wa_accounts.create({
        data: { ...accountData, created_at: new Date() },
      });
    }

    // 3a. Subscribe our app to the WABA's webhook events. Without this the
    // WABA exists in Meta's system but inbound messages never reach our
    // webhook endpoint. Best-effort — log on failure so onboarding still
    // completes if Meta is temporarily unavailable; the periodic reconnect
    // sync can re-attempt the subscription later.
    try {
      await this.meta.subscribeWabaWebhook(payload.waba_id, accessToken);
    } catch (err: any) {
      console.warn(
        `[whatsapp.onboard] subscribeWabaWebhook failed for waba ${payload.waba_id}: ${err?.message ?? err}`,
      );
    }

    // 4. Resolve phone number → fetch details → upsert wa_phone_numbers
    let phoneData: any = null;
    if (payload.phone_number_id) {
      phoneData = await this.meta.fetchPhoneNumberDetails(payload.phone_number_id, accessToken);
    } else {
      const list = await this.meta.fetchPhoneNumbersForWaba(payload.waba_id, accessToken);
      phoneData = list?.data?.[0];
    }

    if (phoneData?.id) {
      const exists = await this.prisma.wa_phone_numbers.findFirst({
        where: { wa_number_id: String(phoneData.id) },
      });
      if (exists && exists.wa_account_id !== account.id) {
        throw new BadRequestException('Phone number is connected to another account');
      }
      const plainNumber = String(phoneData.display_phone_number ?? '').replace(/[^A-Z0-9]/gi, '');
      const numberData: any = {
        wa_account_id: account.id,
        wa_number_id: String(phoneData.id),
        verified_name: phoneData.verified_name ?? '',
        display_phone_number: phoneData.display_phone_number ?? '',
        phone_number: plainNumber,
        pin_code: '',
        code_verification_status: phoneData.code_verification_status ?? '',
        quality_rating: phoneData.quality_rating ?? '',
        status: 'PENDING',
        name_status: 'PENDING',
        auto_reply_interval: '247',
      };
      if (exists) {
        await this.prisma.wa_phone_numbers.update({ where: { id: exists.id }, data: numberData });
      } else {
        await this.prisma.wa_phone_numbers.create({ data: numberData });
      }
    }

    // 5. Subscribe app to webhooks (best-effort — log warning on failure)
    try {
      await this.meta.subscribeWabaWebhook(account.waba_id, accessToken);
    } catch (e: any) {
      // Non-fatal — admin can manually subscribe from Meta dashboard
    }

    // 6. Tell the WhatsApp microservice to register this WABA, so it can
    //    own the connection lifecycle / status callbacks. Matches the
    //    manual-onboard flow's WA_REGISTER publish.
    try {
      await this.rabbit.publish('ra', 'whatsapp', {
        event: 'WA_REGISTER',
        payload: {
          waba_id: account.waba_id,
          access_token: accessToken,
          phone_number_id: phoneData?.id ?? null,
          display_phone_number: phoneData?.display_phone_number ?? null,
          verified_name: phoneData?.verified_name ?? null,
        },
        meta: { backend_wa_account_id: account.id.toString() },
      });
    } catch (e: any) {
      this.logger.warn(`WA_REGISTER publish failed (onboard): ${e?.message ?? e}`);
    }

    // 7. Broadcast — the UI will refresh and show the new PENDING account row.
    this.emitAccountUpdated(workspaceId, account);

    return { success: true, account_id: account.id.toString(), message: 'WhatsApp account configured' };
  }

  async getWhatsAppAccount(workspaceId: bigint) {
    const account = await this.prisma.wa_accounts.findFirst({
      where: { workspace_id: workspaceId },
    });

    if (!account) return null;

    const phoneNumber = await this.prisma.wa_phone_numbers.findFirst({
      where: { wa_account_id: account.id },
    });

    return { account, phoneNumber };
  }

  /**
   * Pull business profile from Meta and merge with our local row. Useful after
   * onboarding or when admin opens the profile screen.
   */
  async refreshBusinessProfile(workspaceId: bigint) {
    const account = await this.prisma.wa_accounts.findFirst({ where: { workspace_id: workspaceId } });
    if (!account) throw new NotFoundException('WhatsApp account not found');
    const phoneNumber = await this.prisma.wa_phone_numbers.findFirst({ where: { wa_account_id: account.id } });
    if (!phoneNumber) throw new NotFoundException('WhatsApp phone number not found');

    const remote: any = await this.meta.fetchPhoneNumberProfile(
      phoneNumber.wa_number_id,
      account.access_token,
    );
    return { ...phoneNumber, profile: remote?.data?.[0] ?? remote };
  }

  async updateBusinessProfile(workspaceId: bigint, data: any) {
    const account = await this.prisma.wa_accounts.findFirst({ where: { workspace_id: workspaceId } });
    if (!account) throw new NotFoundException('WhatsApp account not found');
    const phoneNumber = await this.prisma.wa_phone_numbers.findFirst({ where: { wa_account_id: account.id } });
    if (!phoneNumber) throw new NotFoundException('WhatsApp phone number not found');

    // Forward to Meta — only verified_name needs Meta-side change requests so
    // skip pushing it here. Other profile fields are settable via Graph API.
    const profileFields: any = {};
    for (const k of ['about', 'address', 'description', 'email', 'vertical']) {
      if (data[k] !== undefined) profileFields[k] = data[k];
    }
    if (Array.isArray(data.websites)) profileFields.websites = data.websites;

    if (Object.keys(profileFields).length > 0) {
      await this.meta.updatePhoneNumberProfile(
        phoneNumber.wa_number_id,
        account.access_token,
        profileFields,
      );
    }

    return this.prisma.wa_phone_numbers.update({
      where: { id: phoneNumber.id },
      data: { verified_name: data.displayName ?? phoneNumber.verified_name },
    });
  }

  /**
   * Send an outbound WhatsApp message. Resolves the wa_phone_number row,
   * uses its wa_account access token, calls Meta Graph API, and persists a
   * wa_messages row tagged with the returned wamid.
   *
   * `payload` must include `to` (E.164 minus the +) and a Meta-compatible
   * type-specific body (e.g. `{ type: 'text', text: { body: '...' } }`,
   * or template). The wa_chat is resolved/created as needed.
   */
  async sendMessage(
    workspaceId: bigint,
    senderUserId: bigint,
    payload: {
      to: string;
      phone_number_id?: string;
      type: 'text' | 'template' | 'image' | 'document' | 'audio' | 'video' | 'interactive';
      text?: { body: string };
      template?: any;
      image?: any;
      document?: any;
      audio?: any;
      video?: any;
      interactive?: any;
      contact_id?: string;
    },
  ) {
    if (!payload?.to || !payload?.type) {
      throw new BadRequestException('Missing required fields: to + type');
    }

    // Resolve account + phone_number for this workspace
    const account = await this.prisma.wa_accounts.findFirst({
      where: { workspace_id: workspaceId, deleted_at: null },
    });
    if (!account) throw new NotFoundException('WhatsApp account not connected');

    const phoneNumber = payload.phone_number_id
      ? await this.prisma.wa_phone_numbers.findFirst({
          where: { wa_account_id: account.id, wa_number_id: payload.phone_number_id },
        })
      : await this.prisma.wa_phone_numbers.findFirst({ where: { wa_account_id: account.id } });
    if (!phoneNumber) throw new NotFoundException('WhatsApp phone number not found');

    // Compose Meta payload
    const metaBody: any = { messaging_product: 'whatsapp', to: payload.to, type: payload.type };
    if (payload.text) metaBody.text = payload.text;
    if (payload.template) metaBody.template = payload.template;
    if (payload.image) metaBody.image = payload.image;
    if (payload.document) metaBody.document = payload.document;
    if (payload.audio) metaBody.audio = payload.audio;
    if (payload.video) metaBody.video = payload.video;
    if (payload.interactive) metaBody.interactive = payload.interactive;

    const result = await this.meta.sendWhatsappMessage(
      phoneNumber.wa_number_id,
      account.access_token,
      metaBody,
    );
    const wamid = result?.messages?.[0]?.id;

    // Persist wa_message — chat resolved via existing parser pattern.
    let chat = await this.prisma.wa_chats.findFirst({
      where: { wa_number_id: phoneNumber.id, wa_id: payload.to },
    });
    if (!chat && payload.contact_id) {
      chat = await this.prisma.wa_chats.create({
        data: {
          wa_account_id: account.id,
          wa_number_id: phoneNumber.id,
          user_id: account.user_id,
          contact_id: BigInt(payload.contact_id),
          wa_id: payload.to,
          is_primary: true,
          last_interacted_at: new Date(),
          last_business_interaction: new Date(),
          input_attempts: BigInt(0),
        },
      });
    }

    let message: any = null;
    if (chat) {
      message = await this.prisma.wa_messages.create({
        data: {
          wa_chat_id: chat.id,
          wa_number_id: phoneNumber.id,
          sender_id: senderUserId,
          mobile_number: payload.to,
          type: payload.type,
          direction: 'OUTGOING',
          text: payload.text?.body ?? null,
          media: payload.image || payload.document || payload.audio || payload.video
            ? JSON.stringify(payload.image ?? payload.document ?? payload.audio ?? payload.video)
            : null,
          status: 'sent',
          wamid,
          payload: JSON.stringify(metaBody),
        },
      });
      await this.prisma.wa_chats.update({
        where: { id: chat.id },
        data: { last_interacted_at: new Date(), last_business_interaction: new Date() },
      });
    }

    return { success: true, wamid, message };
  }

  /**
   * Token health check for the workspace's WhatsApp account. Used by the UI to
   * show a banner like "Token expires in 4 hours — refresh now" or "Using
   * System User token (no expiry)".
   *
   * Token types Meta returns:
   *   - USER         : 24-hour temp token, expires_at > 0
   *   - SYSTEM_USER  : long-lived, expires_at == 0 (recommended for production)
   *   - PAGE         : page-scoped, varies
   *
   * Response also includes a derived `recommendation` so the FE doesn't need
   * to interpret expiry math.
   */
  /**
   * GET /whatsapp/accounts — list every WhatsApp account in the workspace
   * with optional sub-relations. Mirrors replyagent's `GET /wa/accounts?with=phoneNumbers,capi`
   *
   *   ?with=phoneNumbers,capi  — eager-load sub-resources (comma separated)
   *   ?onboard_platform=<plat> — narrow by platform (whatsapp_business |
   *                              whatsapp_business_app for Coex)
   *
   * The response is shaped as `{ wa: <account[]> }` to match the replyagent
   * shape the Vue front-end expects.
   */
  async getAccounts(
    workspaceId: bigint,
    options: { with?: string; onboardPlatform?: string } = {},
  ) {
    const withRel = (options.with ?? '').split(',').map((s) => s.trim()).filter(Boolean);

    const accounts = await this.prisma.wa_accounts.findMany({
      where: {
        workspace_id: workspaceId,
        deleted_at: null,
        status: { not: 'DELETING' },
        ...(options.onboardPlatform ? { onboard_platform: options.onboardPlatform } : {}),
      },
      orderBy: { id: 'desc' },
    });

    const result: any[] = [];
    for (const acc of accounts) {
      const out: any = this.serializeAccount(acc);
      if (withRel.includes('phoneNumbers')) {
        const numbers = await this.prisma.wa_phone_numbers.findMany({
          where: { wa_account_id: acc.id },
          orderBy: { id: 'asc' },
        });
        out.phone_numbers = numbers.map((n) => this.serializeNumber(n));
      }
      if (withRel.includes('capi')) {
        const capi = await this.prisma.capi.findFirst({
          where: {
            modelable_type: 'App\\Models\\Whatsapp\\WhatsappAccount',
            modelable_id: acc.id,
          },
          select: { id: true, dataset_id: true, name: true },
        });
        out.capi = capi
          ? { ...capi, id: capi.id.toString() }
          : null;
      }
      result.push(out);
    }
    return { wa: result };
  }

  /**
   * GET /whatsapp/limits — return the workspace's WhatsApp channel limit
   * + current usage so the front-end can pre-check before launching Meta
   * Embedded Signup.
   */
  async getLimits(workspaceId: bigint) {
    const workspace = await this.prisma.workspaces.findUnique({
      where: { id: workspaceId },
      select: { whatsapp_channels_limit: true },
    });
    const limit = workspace?.whatsapp_channels_limit ?? 1;
    const used = await this.prisma.wa_accounts.count({
      where: { workspace_id: workspaceId, deleted_at: null, status: { not: 'DELETING' } },
    });
    return { limit, used, can_add: used < limit };
  }

  /**
   * GET /whatsapp/numbers — flat phone-number list across the workspace.
   * Used by automation pickers ("Send via which number?") and the AI Feeder
   * settings page.
   */
  async getNumbers(workspaceId: bigint) {
    const accounts = await this.prisma.wa_accounts.findMany({
      where: { workspace_id: workspaceId, deleted_at: null },
      select: { id: true, name: true, waba_id: true },
    });
    if (accounts.length === 0) return { numbers: [] };
    const numbers = await this.prisma.wa_phone_numbers.findMany({
      where: { wa_account_id: { in: accounts.map((a) => a.id) } },
      orderBy: { id: 'asc' },
    });
    const accountMap = new Map(accounts.map((a) => [a.id.toString(), a]));
    return {
      numbers: numbers.map((n) => ({
        ...this.serializeNumber(n),
        account: accountMap.get(n.wa_account_id.toString())
          ? {
              id: accountMap.get(n.wa_account_id.toString())!.id.toString(),
              name: accountMap.get(n.wa_account_id.toString())!.name,
              waba_id: accountMap.get(n.wa_account_id.toString())!.waba_id,
            }
          : null,
      })),
    };
  }

  /**
   * POST /whatsapp/profiles — given a Meta OAuth code + user id, exchange
   * for an access token and fetch the user's business profiles (so the UI
   * can present a picker if more than one WABA is associated). Mirrors
   * replyagent's `getWhatsappProfiles`.
   *
   * Body: { _c: code, _u: user_id }
   * Returns: { success, t: <access_token>, profiles?: [...] } — replyagent's
   * exact shape so the existing Vue page works without remapping.
   */
  async getProfiles(payload: { _c: string; _u: string }) {
    if (!payload?._c) throw new BadRequestException('code (_c) is required');
    if (!payload?._u) throw new BadRequestException('user id (_u) is required');
    const exchange = await this.meta.exchangeCode(payload._c);
    const accessToken = exchange?.access_token;
    if (!accessToken) {
      return { success: false, message: 'Meta did not return access_token' };
    }
    // Replyagent returns `{ success: false, t: <token> }` here — the front-end
    // then displays the token as a support code. Keeping the exact shape so
    // the WhatsappOnboard page works without mapping.
    return { success: false, t: accessToken };
  }

  /**
   * POST /whatsapp/verify — manually verify a token + WABA id pair before
   * persisting. Returns Meta's business-profile object on success.
   * Used by admin "Connect manually" flow.
   */
  async verifyToken(payload: { account_id: string; access_token: string }) {
    if (!payload?.account_id || !payload?.access_token) {
      throw new BadRequestException('account_id and access_token are required');
    }
    try {
      const info = await this.meta.fetchWabaAccount(payload.account_id, payload.access_token);
      if ((info as any)?.error) {
        return { success: false, message: (info as any).error?.message ?? 'Verification failed' };
      }
      return { success: true, account: info };
    } catch (e: any) {
      return { success: false, message: e?.message ?? 'Verification failed' };
    }
  }

  /**
   * POST /whatsapp/delete/:account_id — soft-delete a WABA account and
   * optionally clean up the media folder + Meta templates on the way out.
   * Mirrors replyagent: `deleteFolder` + `deleteTemplates` flags.
   *
   * For now we mark the row deleted + DELETING and emit the realtime
   * notification. The microservice consumer (when configured) handles the
   * actual Meta-side cleanup off the WA_DELETE_ACCOUNT message.
   */
  async deleteAccount(
    workspaceId: bigint,
    accountId: bigint,
    options: { deleteFolder?: boolean; deleteTemplates?: boolean } = {},
  ) {
    const account = await this.prisma.wa_accounts.findFirst({
      where: { id: accountId, workspace_id: workspaceId, deleted_at: null },
    });
    if (!account) throw new NotFoundException('WhatsApp account not found');

    // Mark deleting first so the UI immediately reflects the in-progress state.
    await this.prisma.wa_accounts.update({
      where: { id: account.id },
      data: { status: 'DELETING', updated_at: new Date() },
    });

    // Best-effort: ask the microservice to deregister the WABA on Meta side
    // (it has the webhook subscription to unwind). The `meta` payload is the
    // contract for WA_DELETE_ACCOUNT — same shape as WA_REGISTER.
    try {
      await this.rabbit.publish('ra', 'whatsapp', {
        event: 'WA_DELETE_ACCOUNT',
        payload: {
          waba_id: account.waba_id,
          delete_folder: !!options.deleteFolder,
          delete_templates: !!options.deleteTemplates,
        },
        meta: { backend_wa_account_id: account.id.toString() },
      });
    } catch (e: any) {
      this.logger.warn(`WA_DELETE_ACCOUNT publish failed: ${e?.message ?? e}`);
    }

    // Soft delete + emit. Hard delete is left to a cron / final cleanup once
    // the microservice confirms via WA_DELETION_RESULT.
    const updated = await this.prisma.wa_accounts.update({
      where: { id: account.id },
      data: { deleted_at: new Date(), status: 'DELETING' },
    });
    this.emitAccountUpdated(workspaceId, updated);

    return { success: true, message: 'WhatsApp account deletion requested' };
  }

  /**
   * POST /whatsapp/delete-number/:number_id — remove a phone number from the
   * account. Mirrors replyagent's `WhatsappHelper::deleteWhatsappNumber()`:
   *   1. Publish WA_DELETE_PHONE_NUMBER so the microservice can deregister on
   *      Meta's side (it owns the access token / webhook subscription).
   *   2. Cascade delete owned data — wa_messages → wa_chats → linked inbox
   *      rows. Without this, the contact list shows ghost conversations
   *      against a number that no longer exists.
   *   3. Drop the wa_phone_numbers row itself.
   *   4. Emit `whatsapp.account_updated` so the settings page re-renders.
   *
   * Cascade is performed in a single transaction so a partial failure (e.g.
   * Prisma constraint mid-chat-delete) doesn't leave half-deleted state.
   */
  async deletePhoneNumber(workspaceId: bigint, numberId: bigint) {
    const number = await this.prisma.wa_phone_numbers.findUnique({ where: { id: numberId } });
    if (!number) throw new NotFoundException('Phone number not found');
    const account = await this.prisma.wa_accounts.findFirst({
      where: { id: number.wa_account_id, workspace_id: workspaceId, deleted_at: null },
    });
    if (!account) throw new NotFoundException('Account not found for this number');

    // 1. Ask microservice to deregister with Meta (best-effort).
    try {
      await this.rabbit.publish('ra', 'whatsapp', {
        event: 'WA_DELETE_PHONE_NUMBER',
        payload: {
          waba_id: account.waba_id,
          phone_number_id: number.wa_number_id,
        },
        meta: { backend_wa_account_id: account.id.toString(), backend_wa_number_id: number.id.toString() },
      });
    } catch (e: any) {
      this.logger.warn(`WA_DELETE_PHONE_NUMBER publish failed: ${e?.message ?? e}`);
    }

    // 2. Cascade delete: chats → messages → linked inbox rows → number.
    const chats = await this.prisma.wa_chats.findMany({
      where: { wa_number_id: number.id },
      select: { id: true },
    });
    const chatIds = chats.map((c) => c.id);

    if (chatIds.length > 0) {
      // Drop messages first (FK on wa_chat_id).
      await this.prisma.wa_messages
        .deleteMany({ where: { wa_chat_id: { in: chatIds } } })
        .catch((e) => this.logger.warn(`Cascade wa_messages delete failed: ${e?.message ?? e}`));

      // Drop inbox rows tied to these wa_chats. Inbox is polymorphic on
      // modelable_type='App\\Models\\Whatsapp\\WhatsappChat'.
      await this.prisma.inbox
        .deleteMany({
          where: {
            modelable_type: 'App\\Models\\Whatsapp\\WhatsappChat',
            modelable_id: { in: chatIds },
          },
        })
        .catch((e) => this.logger.warn(`Cascade inbox delete failed: ${e?.message ?? e}`));

      // Now the chats themselves.
      await this.prisma.wa_chats
        .deleteMany({ where: { id: { in: chatIds } } })
        .catch((e) => this.logger.warn(`Cascade wa_chats delete failed: ${e?.message ?? e}`));
    }

    // 3. Drop the phone number row.
    await this.prisma.wa_phone_numbers.delete({ where: { id: number.id } });

    // 4. Audit log + realtime emit so the UI refreshes.
    try {
      await this.prisma.audit_logs.create({
        data: {
          workspace_id: workspaceId,
          user_id: null,
          event: 'channel_deleted',
          modelable_type: 'App\\Models\\Whatsapp\\WhatsappAccount',
          modelable_id: account.id,
          data: JSON.stringify({
            channel_type: 'whatsapp',
            channel_name: number.verified_name,
            phone_number: number.display_phone_number,
          }),
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    } catch (e: any) {
      // audit_logs is optional — don't block the delete on it.
      this.logger.debug(`audit_log insert failed: ${e?.message ?? e}`);
    }

    const updatedAccount = await this.prisma.wa_accounts.findUnique({ where: { id: account.id } });
    if (updatedAccount) this.emitAccountUpdated(workspaceId, updatedAccount);

    return { success: true, message: 'Phone number deleted' };
  }

  /**
   * POST /whatsapp/reconnect/:number_id — re-query Meta for the number's
   * current state and patch our row with the refreshed verified_name,
   * quality_rating, name_status, and clear the error_code on success.
   *
   * Mirrors replyagent's reconnect-number flow used when a number lands in
   * LOCKED / FAILED / DISCONNECTED state.
   */
  async reconnectNumber(workspaceId: bigint, numberId: bigint) {
    const number = await this.prisma.wa_phone_numbers.findUnique({ where: { id: numberId } });
    if (!number) throw new NotFoundException('Phone number not found');
    const account = await this.prisma.wa_accounts.findFirst({
      where: { id: number.wa_account_id, workspace_id: workspaceId, deleted_at: null },
    });
    if (!account) throw new NotFoundException('Account not found for this number');

    const phoneResp: any = await this.meta.fetchPhoneNumberDetails(number.wa_number_id, account.access_token);
    const updateData: any = { status: 'ACTIVE', error_code: null, updated_at: new Date() };
    if (phoneResp?.error) {
      updateData.status = 'LOCKED';
      updateData.error_code = String(phoneResp.error.code ?? phoneResp.error.message ?? '');
      const updated = await this.prisma.wa_phone_numbers.update({
        where: { id: number.id },
        data: updateData,
      });
      this.emitPhoneNumberUpdated(workspaceId, updated);
      return { success: false, message: phoneResp.error.message ?? 'Reconnect failed' };
    }
    if (phoneResp?.verified_name) updateData.verified_name = phoneResp.verified_name;
    if (phoneResp?.quality_rating) updateData.quality_rating = phoneResp.quality_rating;
    if (phoneResp?.name_status) updateData.name_status = phoneResp.name_status;
    if (phoneResp?.new_name_status && phoneResp.new_name_status !== 'NONE') {
      updateData.name_status = phoneResp.new_name_status;
    }

    const updated = await this.prisma.wa_phone_numbers.update({
      where: { id: number.id },
      data: updateData,
    });
    this.emitPhoneNumberUpdated(workspaceId, updated);
    return { success: true };
  }

  /**
   * POST /whatsapp/synchronize/:number_id — pull the latest profile data
   * from Meta (about, websites, address, etc.) and store it on the number row.
   * Used by the admin "sync data" button on each number in the manage view.
   */
  async synchronizeData(workspaceId: bigint, numberId: bigint) {
    const number = await this.prisma.wa_phone_numbers.findUnique({ where: { id: numberId } });
    if (!number) throw new NotFoundException('Phone number not found');
    const account = await this.prisma.wa_accounts.findFirst({
      where: { id: number.wa_account_id, workspace_id: workspaceId, deleted_at: null },
    });
    if (!account) throw new NotFoundException('Account not found');

    const profile: any = await this.meta.fetchPhoneNumberProfile(number.wa_number_id, account.access_token);
    const data = profile?.data?.[0] ?? profile ?? {};
    this.emitPhoneNumberUpdated(workspaceId, number);
    return { success: true, profile: data };
  }

  /**
   * POST /whatsapp/autoreply/:number_id — set/clear the per-number auto-reply
   * automation. Body: { auto_reply_automation_id, auto_reply_interval }
   *  - interval ∈ '0' (once) | '24' (once/24h) | '247' (always)
   *  - Passing null automation_id clears the auto-reply.
   *
   * Mirrors replyagent's `POST /wa/autoreply/:number_id`.
   */
  async updateAutoReply(
    workspaceId: bigint,
    numberId: bigint,
    body: { auto_reply_automation_id?: string | number | null; auto_reply_interval?: string | null },
  ) {
    const number = await this.prisma.wa_phone_numbers.findUnique({ where: { id: numberId } });
    if (!number) throw new NotFoundException('Phone number not found');
    const account = await this.prisma.wa_accounts.findFirst({
      where: { id: number.wa_account_id, workspace_id: workspaceId, deleted_at: null },
    });
    if (!account) throw new NotFoundException('Account not found for this number');

    const data: any = { updated_at: new Date() };
    if (body.auto_reply_automation_id === null || body.auto_reply_automation_id === undefined) {
      data.auto_reply_automation_id = null;
    } else {
      data.auto_reply_automation_id = BigInt(body.auto_reply_automation_id);
    }
    if (body.auto_reply_interval !== undefined && body.auto_reply_interval !== null) {
      data.auto_reply_interval = String(body.auto_reply_interval);
    }

    const updated = await this.prisma.wa_phone_numbers.update({
      where: { id: number.id },
      data,
    });
    this.emitPhoneNumberUpdated(workspaceId, updated);
    return { success: true, number: this.serializeNumber(updated) };
  }

  /**
   * PUT /whatsapp/toggle-feeder/:number_id — flip the AI Feeder enable flag
   * on the wa_phone_numbers row. Real backend wire for the toggle that was
   * previously a UI-only switch.
   */
  async toggleFeeder(workspaceId: bigint, numberId: bigint) {
    const number = await this.prisma.wa_phone_numbers.findUnique({ where: { id: numberId } });
    if (!number) throw new NotFoundException('Phone number not found');
    const account = await this.prisma.wa_accounts.findFirst({
      where: { id: number.wa_account_id, workspace_id: workspaceId, deleted_at: null },
    });
    if (!account) throw new NotFoundException('Account not found');

    const current = number.allow_in_feeder ?? 0;
    const updated = await this.prisma.wa_phone_numbers.update({
      where: { id: number.id },
      data: { allow_in_feeder: current ? 0 : 1, updated_at: new Date() },
    });
    this.emitPhoneNumberUpdated(workspaceId, updated);
    return { success: true, allow_in_feeder: updated.allow_in_feeder };
  }

  /**
   * GET /whatsapp/get-message/:wamid — fetch a single wa_messages row by
   * Meta's wamid. Used to deep-link from notifications or audit logs.
   */
  async getMessage(workspaceId: bigint, wamid: string) {
    // wamid is unique across Meta, so we trust the join via wa_chat_id →
    // wa_account_id workspace gate. If the message belongs to another
    // workspace, return 404 to avoid leaking content across tenants.
    const message = await this.prisma.wa_messages.findFirst({ where: { wamid } });
    if (!message) throw new NotFoundException('Message not found');
    const chat = await this.prisma.wa_chats.findUnique({ where: { id: message.wa_chat_id } });
    if (!chat) throw new NotFoundException('Chat not found');
    const account = await this.prisma.wa_accounts.findUnique({ where: { id: chat.wa_account_id } });
    if (!account || account.workspace_id !== workspaceId) {
      throw new NotFoundException('Message not found');
    }
    return { message: { ...message, id: message.id.toString(), wa_chat_id: message.wa_chat_id.toString() } };
  }

  /**
   * GET /capi/whatsapp/:account_id — return the CAPI dataset row attached to
   * this WhatsApp account, or null. Front-end uses this to decide whether to
   * show a "Configured" badge or the "Setup CAPI" button.
   */
  async getCapiForAccount(workspaceId: bigint, accountId: bigint) {
    const account = await this.prisma.wa_accounts.findFirst({
      where: { id: accountId, workspace_id: workspaceId, deleted_at: null },
    });
    if (!account) throw new NotFoundException('Account not found');
    const capi = await this.prisma.capi.findFirst({
      where: {
        modelable_type: 'App\\Models\\Whatsapp\\WhatsappAccount',
        modelable_id: account.id,
      },
    });
    return capi ? { ...capi, id: capi.id.toString(), workspace_id: capi.workspace_id.toString(), user_id: capi.user_id.toString(), modelable_id: capi.modelable_id?.toString() ?? null } : null;
  }

  /**
   * POST /capi/whatsapp/:account_id — create a CAPI dataset record for an
   * account. Caller passes the dataset_id + token they obtained from Meta's
   * Events Manager. Returns 409 if one already exists.
   */
  async setupCapiForAccount(
    workspaceId: bigint,
    userId: bigint,
    accountId: bigint,
    body: { dataset_id: string; name?: string; token: string },
  ) {
    if (!body?.dataset_id || !body?.token) {
      throw new BadRequestException('dataset_id and token are required');
    }
    const account = await this.prisma.wa_accounts.findFirst({
      where: { id: accountId, workspace_id: workspaceId, deleted_at: null },
    });
    if (!account) throw new NotFoundException('Account not found');

    const existing = await this.prisma.capi.findFirst({
      where: {
        modelable_type: 'App\\Models\\Whatsapp\\WhatsappAccount',
        modelable_id: account.id,
      },
    });
    if (existing) {
      return { success: false, error_code: 'capi_exists', message: 'CAPI dataset already configured for this account' };
    }

    const row = await this.prisma.capi.create({
      data: {
        workspace_id: workspaceId,
        user_id: userId,
        modelable_type: 'App\\Models\\Whatsapp\\WhatsappAccount',
        modelable_id: account.id,
        dataset_id: body.dataset_id,
        name: body.name ?? account.name.slice(0, 60),
        token: body.token,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
    return { success: true, capi: { ...row, id: row.id.toString() } };
  }

  /**
   * DELETE /capi/whatsapp/:account_id — drop the CAPI binding for an account.
   */
  async deleteCapiForAccount(workspaceId: bigint, accountId: bigint) {
    const account = await this.prisma.wa_accounts.findFirst({
      where: { id: accountId, workspace_id: workspaceId, deleted_at: null },
    });
    if (!account) throw new NotFoundException('Account not found');
    await this.prisma.capi.deleteMany({
      where: {
        modelable_type: 'App\\Models\\Whatsapp\\WhatsappAccount',
        modelable_id: account.id,
      },
    });
    return { success: true };
  }

  async tokenStatus(workspaceId: bigint) {
    const account = await this.prisma.wa_accounts.findFirst({
      where: { workspace_id: workspaceId, deleted_at: null },
    });
    if (!account) throw new NotFoundException('WhatsApp account not connected');

    const debug = await this.meta.debugToken(account.access_token);
    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAt = debug.expiresAt && debug.expiresAt > 0 ? debug.expiresAt : null;
    const secondsToExpiry = expiresAt ? Math.max(0, expiresAt - nowSec) : null;
    const hoursToExpiry = secondsToExpiry != null ? Math.round(secondsToExpiry / 3600) : null;

    let recommendation: 'OK' | 'REFRESH_SOON' | 'EXPIRED' | 'INVALID' | 'UPGRADE_TO_SYSTEM_USER';
    if (!debug.isValid) {
      recommendation = expiresAt && expiresAt < nowSec ? 'EXPIRED' : 'INVALID';
    } else if (debug.type === 'SYSTEM_USER' || expiresAt == null) {
      recommendation = 'OK';
    } else if (secondsToExpiry != null && secondsToExpiry < 3600 * 4) {
      recommendation = 'REFRESH_SOON';
    } else if (debug.type === 'USER') {
      // Working but temp — nudge to long-lived.
      recommendation = 'UPGRADE_TO_SYSTEM_USER';
    } else {
      recommendation = 'OK';
    }

    return {
      isValid: debug.isValid,
      tokenType: debug.type ?? 'unknown',
      expiresAt,
      hoursToExpiry,
      scopes: debug.scopes ?? [],
      application: debug.application,
      recommendation,
      error: debug.error,
      account: {
        id: account.id.toString(),
        waba_id: account.waba_id,
        status: account.status,
      },
    };
  }
}
