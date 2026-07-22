import { Injectable, Logger, NotFoundException, BadRequestException, forwardRef, Inject } from '@nestjs/common';
import { randomInt } from 'crypto';
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
    // Generic cross-feature broadcast (replyagent ChannelUpdated) — a DELETED
    // status means the account was removed, so signal channel.deleted instead.
    const event = String(account?.status ?? '').toUpperCase() === 'DELETED' ? 'channel.deleted' : 'channel.updated';
    this.emitChannelEvent(workspaceId, 'whatsapp', account, event);
  }

  private emitPhoneNumberUpdated(workspaceId: bigint, phoneNumber: any) {
    try {
      this.chatGateway.emitToWorkspace(workspaceId, 'whatsapp.number_updated', this.serializeNumber(phoneNumber));
    } catch (e: any) {
      this.logger.debug(`emitPhoneNumberUpdated failed: ${e?.message ?? e}`);
    }
    this.emitChannelEvent(workspaceId, 'whatsapp', null, 'channel.updated');
  }

  /**
   * Live channel counter across ALL channel types for a workspace. Mirrors
   * replyagent `Workspace::totalChannels()` — active/connected instances only,
   * counted at the number/instance level (not the account level). WhatsApp is
   * scoped via its non-deleted accounts (wa_phone_numbers has no workspace_id).
   */
  async computeTotalChannels(workspaceId: bigint): Promise<number> {
    // WhatsApp + Twilio numbers have no workspace_id — scope via their accounts.
    const [waAccounts, twilioAccounts] = await Promise.all([
      this.prisma.wa_accounts.findMany({
        where: { workspace_id: workspaceId, deleted_at: null },
        select: { id: true },
      }),
      this.prisma.twilio_accounts.findMany({
        where: { workspace_id: workspaceId, deleted_at: null },
        select: { id: true },
      }),
    ]);
    const waAccountIds = waAccounts.map((a) => a.id);
    const twilioAccountIds = twilioAccounts.map((a) => a.id);

    const [wa, tg, fb, ig, evo, zapi, twilio, wc] = await Promise.all([
      waAccountIds.length
        ? this.prisma.wa_phone_numbers.count({ where: { wa_account_id: { in: waAccountIds }, status: 'ACTIVE' } })
        : Promise.resolve(0),
      this.prisma.telegram_bots.count({ where: { workspace_id: workspaceId, status: 'ACTIVE' } }),
      this.prisma.fb_pages.count({ where: { workspace_id: workspaceId, status: 'ACTIVE' } }),
      this.prisma.insta_pages.count({ where: { workspace_id: workspaceId, status: 'ACTIVE' } }),
      this.prisma.evolution_instances.count({ where: { workspace_id: workspaceId, status: 'ACTIVE' } }),
      this.prisma.zapi_instances.count({ where: { workspace_id: workspaceId, status: 'CONNECTED' } }),
      twilioAccountIds.length
        ? this.prisma.twilio_numbers.count({ where: { twilio_account_id: { in: twilioAccountIds }, status: 'VERIFIED' } })
        : Promise.resolve(0),
      this.prisma.wc_instances.count({ where: { workspace_id: workspaceId, publish: true } }),
    ]);
    return wa + tg + fb + ig + evo + zapi + twilio + wc;
  }

  /**
   * Broadcast a generic `channel.{updated|created|deleted}` event on the
   * workspace room with the recomputed `total_channels`. Mirrors replyagent's
   * ChannelUpdated/Created/Deleted (payload `{ channel_type, channel, total_channels }`).
   * Cross-feature consumers (automation integrations, usage counter) refresh on it.
   * Fire-and-forget — the count query must not block the caller.
   */
  private emitChannelEvent(
    workspaceId: bigint,
    channelType: string,
    channel: any,
    event: 'channel.updated' | 'channel.created' | 'channel.deleted',
  ): void {
    this.computeTotalChannels(workspaceId)
      .then((total) => {
        this.chatGateway.emitToWorkspace(workspaceId, event, {
          channel_type: channelType,
          channel: channel ? this.serializeAccount(channel) : null,
          total_channels: total,
        });
      })
      .catch((e: any) => this.logger.debug(`emitChannelEvent(${event}) failed: ${e?.message ?? e}`));
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

    // Enforce the workspace's WhatsApp channel limit — but only when this WABA
    // isn't already connected here (re-submitting the form to refresh a token
    // must not be blocked by the cap).
    const alreadyConnected = await this.prisma.wa_accounts.findFirst({
      where: { workspace_id: workspaceId, waba_id: payload.waba_id, deleted_at: null },
      select: { id: true },
    });
    if (!alreadyConnected) {
      await this.assertChannelCapacity(workspaceId);
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
          uploadDir: `whatsapp/${workspaceId}/`,
          thumbDir: `whatsapp/${workspaceId}/thumb/`,
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

    // 2a. Enforce the workspace's WhatsApp channel limit on NEW connections.
    const alreadyConnected = await this.prisma.wa_accounts.findFirst({
      where: { waba_id: payload.waba_id, workspace_id: workspaceId, deleted_at: null },
      select: { id: true },
    });
    if (!alreadyConnected) {
      await this.assertChannelCapacity(workspaceId);
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
        code_verification_status: phoneData.code_verification_status ?? '',
        quality_rating: phoneData.quality_rating ?? '',
        current_limit: phoneData.messaging_limit_tier ?? null,
        throughput: phoneData.throughput ? JSON.stringify(phoneData.throughput) : null,
        last_onboarded_time: phoneData.last_onboarded_time ? new Date(phoneData.last_onboarded_time) : null,
        auto_reply_interval: '247',
        platform_type: phoneData.platform_type ?? 'CLOUD_API',
      };
      // `pin_code`, `status` and `name_status` are seeded on INSERT only.
      //
      // replyagent refuses to re-onboard a known number outright (it answers
      // `phone_number_exists`), so it never faces this; we do allow it, because
      // re-running Embedded Signup is how a workspace refreshes an expired
      // access token. But carrying the insert defaults into that update would
      // (a) wipe the PIN the number was actually registered with — Meta still
      // expects that two-step code — and (b) knock a healthy ACTIVE number back
      // to PENDING with no automatic way forward, since the register call below
      // is deliberately insert-only.
      const numberRow = exists
        ? await this.prisma.wa_phone_numbers.update({ where: { id: exists.id }, data: numberData })
        : await this.prisma.wa_phone_numbers.create({
            data: { ...numberData, pin_code: '', status: 'PENDING', name_status: 'PENDING' },
          });

      // ── replyagent WhatsappNumberObserver::created() (gateway line 34-84) ──
      // The whole platform fork lives here and nowhere else:
      //
      //   Business API  → POST /{phone_number_id}/register with a generated PIN.
      //                   This is what flips a number from "attached to the WABA"
      //                   to "able to send/receive on Cloud API". Skipping it is
      //                   why unregistered numbers fail every send with 131xxx.
      //   Coexistence   → NOT registered (the number is already live on the
      //                   owner's phone); instead fire an smb_app_data state sync
      //                   so Meta re-delivers the business phone's address book
      //                   via smb_app_state_sync → ImportBusinessContacts.
      //
      // Both branches then refresh name_status from Meta (observer step 2, which
      // runs unconditionally — even for a number that just went LOCKED).
      //
      // The test is positive on 'whatsapp_business', matching replyagent, so any
      // unexpected platform value falls into the harmless sync branch rather than
      // registering a number we were never asked to register.
      //
      // `!exists` matters: replyagent hangs this off the Eloquent `created`
      // observer, so it never fires when a number is re-onboarded. Registering
      // again would mint a fresh PIN, and Meta rejects a re-register that
      // contradicts the number's existing two-step code — which would park a
      // perfectly healthy number at LOCKED. Re-registering deliberately stays a
      // manual action (POST /whatsapp/register/:id).
      if (!exists && payload.onboard_platform === 'whatsapp_business') {
        await this.registerBusinessApiNumber(workspaceId, numberRow, accessToken);
      } else if (payload.onboard_platform !== 'whatsapp_business') {
        try {
          await this.meta.smbAppData(String(phoneData.id), accessToken);
          this.logger.log(`Coex smb_app_data sync fired for number ${phoneData.id}`);
        } catch (e: any) {
          this.logger.warn(`Coex smb_app_data sync failed for ${phoneData.id}: ${e?.message ?? e}`);
        }
      }
      await this.refreshNameStatus(workspaceId, numberRow.id, numberRow.wa_number_id, accessToken);
    }

    // 5. (The webhook subscription already happened in step 3a — it used to be
    //    repeated here, which meant every onboarding fired two identical
    //    subscribed_apps calls and swallowed the second one's error silently.)

    // 6. Tell the WhatsApp microservice to register this WABA, so it can
    //    own the connection lifecycle / status callbacks. Matches the
    //    manual-onboard flow's WA_REGISTER publish.
    try {
      await this.rabbit.publish('ra', 'whatsapp', {
        event: 'WA_REGISTER',
        payload: {
          whatsappAccountId: account.waba_id,
          accessToken,
          name: phoneData?.verified_name ?? account.name,
          uploadDir: `whatsapp/${workspaceId}/`,
          thumbDir: `whatsapp/${workspaceId}/thumb/`,
          meta: { backend_wa_account_id: account.id.toString() },
        },
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
   *   ?onboard_platform=<plat> — narrow by platform. DEFAULTS to
   *                              `whatsapp_business` (Business API) when omitted,
   *                              exactly like replyagent. Pass
   *                              `whatsapp_business_app` for Coexistence, or
   *                              `all` to opt out of the filter entirely.
   *
   * The response is shaped as `{ wa: <account[]> }` to match the replyagent
   * shape the Vue front-end expects.
   */
  async getAccounts(
    workspaceId: bigint,
    options: { with?: string; onboardPlatform?: string } = {},
  ) {
    const withRel = (options.with ?? '').split(',').map((s) => s.trim()).filter(Boolean);

    // replyagent WhatsappController@getAccounts (gateway line 62-66): when the
    // caller does not name a platform the endpoint returns Business API accounts
    // ONLY — Coexistence has to be asked for explicitly. Keeping that default
    // matters beyond the settings page: every other consumer of this endpoint
    // (AI-feeder picker, integrations) inherits it, and it also keeps `qr_code`
    // rows written by qrRegister out of the Cloud API listings.
    const onboardPlatform = options.onboardPlatform || 'whatsapp_business';

    const accounts = await this.prisma.wa_accounts.findMany({
      where: {
        workspace_id: workspaceId,
        deleted_at: null,
        status: { not: 'DELETING' },
        ...(onboardPlatform === 'all' ? {} : { onboard_platform: onboardPlatform }),
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
   * Hard ENFORCE gate for the workspace's WhatsApp channel allowance. getLimits()
   * powers the FE pre-check, but that's advisory — a determined caller could hit
   * /onboard or /onboard-manual directly. This throws so the plan limit is
   * actually upheld server-side. Only called when adding a NEW WABA (re-onboarding
   * an existing one to refresh its token stays allowed).
   */
  private async assertChannelCapacity(workspaceId: bigint) {
    const { limit, used, can_add } = await this.getLimits(workspaceId);
    if (!can_add) {
      throw new BadRequestException(
        `WhatsApp channel limit reached (${used}/${limit}). Upgrade the workspace plan or remove an existing WhatsApp account before adding another.`,
      );
    }
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
   * POST /whatsapp/delete/:account_id — delete a WABA account, tearing down
   * every number/chat/message/template locally AND on Meta's side, then
   * HARD-deleting the account row. Mirrors replyagent's DeleteWhatsappAccount
   * job (`gateway/app/Jobs/Whatsapp/DeleteWhatsappAccount.php`):
   *   1. publish WA_ACCOUNT_DELETING → microservice drops its Mongo doc + unsub
   *   2. optionally delete the account's Gallery folder (delete_folder flag)
   *   3. per number: deregister on Meta + cascade chats/messages/inbox/number
   *   4. per template: optionally delete on Meta, then remove locally
   *   5. unsubscribe the WABA webhook on Meta (DELETE {waba_id}/subscribed_apps)
   *   6. hard-delete the account row (replyagent `forcedelete()`) + drop CAPI
   *
   * `delete_folder` / `delete_templates` are optional cleanups — the account is
   * removed regardless of their value.
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

    // 1. Ask the microservice to drop its Mongo account doc + unsubscribe on its
    //    side. Payload keys mirror replyagent WhatsappTrait::publishAccountDeletingEvent
    //    exactly ({ whatsappAccountId: waba_id, serviceId: service_account_id }) —
    //    the microservice's WA_ACCOUNT_DELETING handler resolves the doc by
    //    `whatsappAccountId`, which is the WABA id (set at WA_REGISTER time).
    try {
      await this.rabbit.publish('ra', 'whatsapp', {
        event: 'WA_ACCOUNT_DELETING',
        payload: {
          whatsappAccountId: account.waba_id,
          serviceId: account.service_account_id,
        },
      });
    } catch (e: any) {
      this.logger.warn(`WA_ACCOUNT_DELETING publish failed: ${e?.message ?? e}`);
    }

    // 2. Optional: remove the account's Gallery folder (media uploaded via this
    //    account). replyagent: `$account->folder?->deleteFolder()`.
    if (options.deleteFolder) {
      await this.deleteAccountMediaFolder(account.id).catch((e) =>
        this.logger.warn(`deleteAccountMediaFolder failed: ${e?.message ?? e}`),
      );
    }

    // 3. Per-number teardown: deregister on Meta (best-effort — the number may
    //    already be gone) then cascade local chats/messages/inbox/number rows.
    const numbers = await this.prisma.wa_phone_numbers.findMany({
      where: { wa_account_id: account.id },
    });
    for (const num of numbers) {
      try {
        await this.meta.deregisterPhoneNumber(num.wa_number_id, account.access_token);
      } catch (e: any) {
        this.logger.warn(`deregister number ${num.wa_number_id} failed: ${e?.message ?? e}`);
      }
      await this.cascadeDeleteNumberLocal(num, account).catch((e) =>
        this.logger.warn(`Cascade number ${num.id} delete failed: ${e?.message ?? e}`),
      );
    }

    // 4. Templates: optionally delete on Meta first (delete_templates flag),
    //    then remove locally.
    //
    //    wa_templates.wa_account_id is a VARCHAR but it holds the INTERNAL
    //    wa_accounts.id as a string — that is what waba.service writes on sync
    //    and create, and what broadcasts.service reads. Querying it by waba_id
    //    (the Meta id) silently matched nothing, so neither the Meta-side delete
    //    nor the local purge ever ran and template rows outlived their account.
    const templateAccountKey = account.id.toString();
    if (options.deleteTemplates) {
      const templates = await this.prisma.wa_templates.findMany({
        where: { wa_account_id: templateAccountKey },
      });
      for (const tpl of templates) {
        try {
          await this.meta.deleteTemplate(
            account.waba_id,
            account.access_token,
            tpl.name,
            tpl.template_id,
          );
        } catch (e: any) {
          this.logger.warn(`Meta deleteTemplate ${tpl.name} failed: ${e?.message ?? e}`);
        }
      }
    }
    await this.prisma.wa_templates
      .deleteMany({ where: { wa_account_id: templateAccountKey } })
      .catch((e) => this.logger.warn(`Cascade wa_templates delete failed: ${e?.message ?? e}`));
    await this.prisma.wa_statistics
      .deleteMany({ where: { wa_account_id: account.id } })
      .catch((e) => this.logger.warn(`Cascade wa_statistics delete failed: ${e?.message ?? e}`));

    // 5. Unsubscribe the WABA webhook on Meta directly (belt-and-suspenders with
    //    the microservice's own unsubscribe). replyagent: `unSubscribe()`.
    try {
      await this.meta.unsubscribeWabaWebhook(account.waba_id, account.access_token);
    } catch (e: any) {
      this.logger.warn(`unsubscribe WABA ${account.waba_id} failed: ${e?.message ?? e}`);
    }

    // 6. Drop the CAPI binding, then HARD-delete the account row (replyagent
    //    forcedelete). No soft-delete / round-trip: replyagent's WA_ACCOUNT_DELETED
    //    return handler is a no-op, and the account is removed synchronously.
    await this.prisma.capi
      .deleteMany({
        where: {
          modelable_type: 'App\\Models\\Whatsapp\\WhatsappAccount',
          modelable_id: account.id,
        },
      })
      .catch((e) => this.logger.warn(`Cascade capi delete failed: ${e?.message ?? e}`));
    await this.prisma.wa_accounts.delete({ where: { id: account.id } });

    // Emit with the pre-delete row marked DELETED so the settings page drops it.
    this.emitAccountUpdated(workspaceId, { ...account, status: 'DELETED' });

    return { success: true, message: 'WhatsApp account deleted' };
  }

  /**
   * Remove the Gallery folder bound to a WhatsApp account (media uploaded via
   * this account). Mirrors replyagent MediaGallery::deleteFolder() — drops the
   * folder's child media rows, then the folder row itself. Guarded: a no-op when
   * no such folder exists (EZCONN does not always materialise one).
   */
  private async deleteAccountMediaFolder(accountId: bigint): Promise<void> {
    const folders = await this.prisma.media_gallery.findMany({
      where: {
        modelable_type: 'App\\Models\\Whatsapp\\WhatsappAccount',
        modelable_id: accountId,
      },
      select: { id: true },
    });
    if (folders.length === 0) return;
    const folderIds = folders.map((f) => f.id);
    // Child media items nest under the folder via parent_id.
    await this.prisma.media_gallery
      .deleteMany({ where: { parent_id: { in: folderIds } } })
      .catch((e) => this.logger.warn(`Folder children delete failed: ${e?.message ?? e}`));
    await this.prisma.media_gallery
      .deleteMany({ where: { id: { in: folderIds } } })
      .catch((e) => this.logger.warn(`Folder row delete failed: ${e?.message ?? e}`));
  }

  /**
   * POST /whatsapp/delete-number/:number_id — remove a phone number from the
   * account. Mirrors replyagent's `WhatsappHelper::deleteWhatsappNumber()`:
   *   1. Deregister the number on Meta directly (POST {phone_number_id}/deregister).
   *      replyagent's single-number path does NOT publish any broker event — the
   *      microservice has no WA_DELETE_PHONE_NUMBER handler; deregister is a
   *      direct Graph API call.
   *   2. Cascade delete owned data — wa_messages → wa_chats → linked inbox
   *      rows. Without this, the contact list shows ghost conversations
   *      against a number that no longer exists.
   *   3. Drop the wa_phone_numbers row itself.
   *   4. Emit `whatsapp.account_updated` so the settings page re-renders.
   */
  async deletePhoneNumber(workspaceId: bigint, numberId: bigint) {
    const number = await this.prisma.wa_phone_numbers.findUnique({ where: { id: numberId } });
    if (!number) throw new NotFoundException('Phone number not found');
    const account = await this.prisma.wa_accounts.findFirst({
      where: { id: number.wa_account_id, workspace_id: workspaceId, deleted_at: null },
    });
    if (!account) throw new NotFoundException('Account not found for this number');

    // 1. Deregister on Meta directly (best-effort — the number may already be gone).
    try {
      await this.meta.deregisterPhoneNumber(number.wa_number_id, account.access_token);
    } catch (e: any) {
      this.logger.warn(`deregister number ${number.wa_number_id} failed: ${e?.message ?? e}`);
    }

    // 2-4. Local cascade: chats → messages → inbox rows → number row + audit log.
    await this.cascadeDeleteNumberLocal(number, account);

    const updatedAccount = await this.prisma.wa_accounts.findUnique({ where: { id: account.id } });
    if (updatedAccount) this.emitAccountUpdated(workspaceId, updatedAccount);

    return { success: true, message: 'Phone number deleted' };
  }

  /**
   * Local cascade for a single phone number: drop its chats → messages →
   * linked inbox rows → the number row, then write a channel_deleted audit log.
   * Shared by deletePhoneNumber (single number) and deleteAccount (full account
   * teardown) so both paths clean up identically. Mirrors replyagent
   * WhatsappHelper::deleteWhatsappNumber() (gateway, ~line 2507).
   */
  private async cascadeDeleteNumberLocal(
    number: { id: bigint; verified_name: string; display_phone_number: string },
    account: { id: bigint; workspace_id: bigint },
  ) {
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
      // Inbox is polymorphic on modelable_type='App\\Models\\Whatsapp\\WhatsappChat'.
      await this.prisma.inbox
        .deleteMany({
          where: {
            modelable_type: 'App\\Models\\Whatsapp\\WhatsappChat',
            modelable_id: { in: chatIds },
          },
        })
        .catch((e) => this.logger.warn(`Cascade inbox delete failed: ${e?.message ?? e}`));
      await this.prisma.wa_chats
        .deleteMany({ where: { id: { in: chatIds } } })
        .catch((e) => this.logger.warn(`Cascade wa_chats delete failed: ${e?.message ?? e}`));
    }
    await this.prisma.wa_phone_numbers.delete({ where: { id: number.id } });
    try {
      await this.prisma.audit_logs.create({
        data: {
          workspace_id: account.workspace_id,
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
    // Keep the messaging-limit tier + throughput fresh on every reconnect so the
    // manage view reflects Meta's latest numbers (Gap 5).
    if (phoneResp?.messaging_limit_tier) updateData.current_limit = phoneResp.messaging_limit_tier;
    if (phoneResp?.throughput) updateData.throughput = JSON.stringify(phoneResp.throughput);

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

    // Coex state sync (replyagent WhatsappTrait::synchronizeNumber): triggers Meta
    // to re-deliver the business app's contacts via an smb_app_state_sync webhook.
    // (Previously this wrongly fetched the business PROFILE, which imported nothing.)
    const result: any = await this.meta.smbAppData(number.wa_number_id, account.access_token);
    this.emitPhoneNumberUpdated(workspaceId, number);
    return { success: true, result };
  }

  /**
   * POST /whatsapp/register/:number_id — register the phone number on Meta
   * Cloud API with a 6-digit two-step-verification PIN, then flip it ACTIVE.
   *
   * Mirrors replyagent's WhatsappNumberObserver::created() (auto-generates a
   * 6-digit PIN and calls registerNumber) + WhatsappTrait::registerNumber()
   * (gateway, line 267). Here it's an explicit admin action so the user can
   * either let us generate a PIN or supply their own (some businesses keep a
   * known two-step PIN on file). The PIN is persisted (pin_code) so a later
   * Meta two-step prompt can reuse it.
   *
   * Body: { pin?: '123456' } — omit `pin` to auto-generate a secure one.
   */
  async registerNumber(workspaceId: bigint, numberId: bigint, pin?: string) {
    const number = await this.prisma.wa_phone_numbers.findUnique({ where: { id: numberId } });
    if (!number) throw new NotFoundException('Phone number not found');
    const account = await this.prisma.wa_accounts.findFirst({
      where: { id: number.wa_account_id, workspace_id: workspaceId, deleted_at: null },
    });
    if (!account) throw new NotFoundException('Account not found for this number');

    // Meta requires the PIN to be exactly 6 digits. Accept an admin-supplied
    // code or generate a cryptographically-random one.
    let code = (pin ?? '').trim();
    if (code) {
      if (!/^\d{6}$/.test(code)) {
        throw new BadRequestException('PIN must be exactly 6 digits');
      }
    } else {
      code = this.generatePinCode();
    }

    try {
      await this.meta.registerPhoneNumber(number.wa_number_id, account.access_token, code);
    } catch (e: any) {
      // Meta rejected the registration (already registered with a different PIN,
      // bad token, etc.). replyagent's observer parks the number at LOCKED and
      // stores the raw Meta error, which is what the manage view's error chip and
      // health banner read — so mirror both, not just the error string.
      const failed = await this.prisma.wa_phone_numbers.update({
        where: { id: number.id },
        data: {
          status: 'LOCKED',
          error_code: (e?.message ?? 'register_failed').slice(0, 255),
          updated_at: new Date(),
        },
      });
      this.emitPhoneNumberUpdated(workspaceId, failed);
      return { success: false, message: e?.message ?? 'Registration failed' };
    }

    const updated = await this.prisma.wa_phone_numbers.update({
      where: { id: number.id },
      data: { pin_code: code, status: 'ACTIVE', error_code: null, updated_at: new Date() },
    });
    this.emitPhoneNumberUpdated(workspaceId, updated);
    // Observer step 2 — pull Meta's current display-name decision.
    await this.refreshNameStatus(workspaceId, updated.id, updated.wa_number_id, account.access_token);
    return { success: true, pin: code, number: this.serializeNumber(updated) };
  }

  /**
   * Generate a two-step-verification PIN the way replyagent does.
   *
   * `randomKey('numeric', 6)` (gateway app/Http/helpers.php:169) draws from the
   * alphabet '23456789' — a generated PIN therefore never contains 0 or 1, which
   * are the two digits users most often mis-read when Meta prompts for the code.
   * Keeping the same alphabet matters: PINs issued here have to stay compatible
   * with the ones replyagent already registered for migrated numbers.
   */
  private generatePinCode(length = 6): string {
    const alphabet = '23456789';
    let out = '';
    for (let i = 0; i < length; i++) out += alphabet[randomInt(0, alphabet.length)];
    return out;
  }

  /**
   * Business-API branch of replyagent's WhatsappNumberObserver::created().
   * Registers the freshly-onboarded number on Cloud API with a generated PIN.
   *
   * On success the number goes ACTIVE and the PIN is persisted so a later Meta
   * two-step prompt can reuse it. On a Meta error the number is parked at LOCKED
   * with the raw error — replyagent deliberately does NOT retry here, and it also
   * skips the billing/channel increment for a number that never came up, so a
   * failed registration costs the workspace nothing.
   */
  private async registerBusinessApiNumber(
    workspaceId: bigint,
    number: { id: bigint; wa_number_id: string },
    accessToken: string,
  ): Promise<void> {
    const pin = this.generatePinCode();
    try {
      await this.meta.registerPhoneNumber(number.wa_number_id, accessToken, pin);
    } catch (e: any) {
      const failed = await this.prisma.wa_phone_numbers.update({
        where: { id: number.id },
        data: {
          status: 'LOCKED',
          error_code: String(e?.message ?? 'register_failed').slice(0, 255),
          updated_at: new Date(),
        },
      });
      this.emitPhoneNumberUpdated(workspaceId, failed);
      this.logger.warn(
        `Business API register failed for number ${number.wa_number_id} — parked LOCKED: ${e?.message ?? e}`,
      );
      return;
    }
    const updated = await this.prisma.wa_phone_numbers.update({
      where: { id: number.id },
      data: { pin_code: pin, status: 'ACTIVE', error_code: null, updated_at: new Date() },
    });
    this.emitPhoneNumberUpdated(workspaceId, updated);
    this.logger.log(`Business API number ${number.wa_number_id} registered and ACTIVE`);
  }

  /**
   * Step 2 of replyagent's number observer (gateway line 76-84): re-read the
   * display-name decision straight after creation. Meta returns name_status
   * separately from the onboarding payload, so without this the number sits at
   * the placeholder 'PENDING' until someone hits Refresh — and the manage view's
   * "display name approved" badge never lights up.
   *
   * Best-effort: a failure here must not fail onboarding.
   */
  private async refreshNameStatus(
    workspaceId: bigint,
    numberId: bigint,
    waNumberId: string,
    accessToken: string,
  ): Promise<void> {
    try {
      const res: any = await this.meta.fetchPhoneNumberDetails(waNumberId, accessToken);
      const nameStatus =
        res?.new_name_status && res.new_name_status !== 'NONE' ? res.new_name_status : res?.name_status;
      if (!nameStatus) return;
      const updated = await this.prisma.wa_phone_numbers.update({
        where: { id: numberId },
        data: { name_status: nameStatus, updated_at: new Date() },
      });
      this.emitPhoneNumberUpdated(workspaceId, updated);
    } catch (e: any) {
      this.logger.warn(`name_status refresh failed for ${waNumberId}: ${e?.message ?? e}`);
    }
  }

  /**
   * POST /whatsapp/verify-account/:account_id — re-query Meta for the WABA's
   * current review / verification / ownership state and patch our row, so the
   * account badges reflect Meta's latest decision without re-onboarding.
   * Used by the "Verify" button on the account header.
   */
  async verifyAccount(workspaceId: bigint, accountId: bigint) {
    const account = await this.prisma.wa_accounts.findFirst({
      where: { id: accountId, workspace_id: workspaceId, deleted_at: null },
    });
    if (!account) throw new NotFoundException('Account not found');

    let info: any;
    try {
      info = await this.meta.fetchWabaAccount(account.waba_id, account.access_token);
    } catch (e: any) {
      const failed = await this.prisma.wa_accounts.update({
        where: { id: account.id },
        data: { error_code: (e?.message ?? 'verify_failed').slice(0, 255), updated_at: new Date() },
      });
      this.emitAccountUpdated(workspaceId, failed);
      return { success: false, message: e?.message ?? 'Verification failed' };
    }

    const data: any = {
      account_review_status: info.account_review_status ?? account.account_review_status,
      business_verification_status: info.business_verification_status ?? account.business_verification_status,
      ownership_type: info.ownership_type ?? account.ownership_type,
      on_behalf_of_business_info: info.on_behalf_of_business_info
        ? JSON.stringify(info.on_behalf_of_business_info)
        : account.on_behalf_of_business_info,
      error_code: null,
      updated_at: new Date(),
    };
    if (info.name) data.name = info.name;
    if (info.currency) data.currency = info.currency;
    if (info.message_template_namespace) data.message_template_namespace = info.message_template_namespace;

    const updated = await this.prisma.wa_accounts.update({ where: { id: account.id }, data });
    this.emitAccountUpdated(workspaceId, updated);
    return { success: true, account: this.serializeAccount(updated) };
  }

  /**
   * Re-subscribe a single WABA to our app's webhook (idempotent on Meta's side).
   * Mirrors replyagent's reSubscribeWebhook intent (it published WA_SUBSCRIBE);
   * we call Meta directly AND nudge the microservice so whichever owns the
   * subscription re-establishes it. Returns true on success.
   */
  async resubscribeAccountWebhook(account: {
    id: bigint;
    waba_id: string;
    access_token: string;
    name?: string;
    workspace_id?: bigint;
  }): Promise<boolean> {
    try {
      await this.meta.subscribeWabaWebhook(account.waba_id, account.access_token);
      try {
        await this.rabbit.publish('ra', 'whatsapp', {
          event: 'WA_REGISTER',
          payload: {
            whatsappAccountId: account.waba_id,
            accessToken: account.access_token,
            name: account.name ?? '',
            ...(account.workspace_id ? {
              uploadDir: `whatsapp/${account.workspace_id}/`,
              thumbDir: `whatsapp/${account.workspace_id}/thumb/`,
            } : {}),
            meta: { backend_wa_account_id: account.id.toString() },
          },
        });
      } catch {
        /* microservice nudge is best-effort */
      }
      return true;
    } catch (e: any) {
      this.logger.warn(`resubscribe failed for waba ${account.waba_id}: ${e?.message ?? e}`);
      return false;
    }
  }

  /**
   * POST /whatsapp/resubscribe/:account_id — manual "re-subscribe webhook"
   * trigger from the account header.
   */
  async resubscribeAccount(workspaceId: bigint, accountId: bigint) {
    const account = await this.prisma.wa_accounts.findFirst({
      where: { id: accountId, workspace_id: workspaceId, deleted_at: null },
    });
    if (!account) throw new NotFoundException('Account not found');
    const ok = await this.resubscribeAccountWebhook(account);
    return {
      success: ok,
      message: ok ? 'Webhook re-subscribed' : 'Re-subscribe failed — check the access token.',
    };
  }

  /**
   * Re-subscribe every ACTIVE WhatsApp account's WABA webhook. Called by
   * WhatsappWebhookSubscriptionService on a schedule so a dropped Meta
   * subscription self-heals without admin intervention (Gap 6). Returns counts.
   */
  async resubscribeAllActive(): Promise<{ total: number; ok: number }> {
    const accounts = await this.prisma.wa_accounts.findMany({
      where: { deleted_at: null, status: 'ACTIVE' },
      select: { id: true, waba_id: true, access_token: true, name: true, workspace_id: true },
    });
    let ok = 0;
    for (const acc of accounts) {
      if (await this.resubscribeAccountWebhook(acc)) ok++;
    }
    return { total: accounts.length, ok };
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
    // Materialize / tear down the wa_auto_reply trigger activity so the default
    // reply actually fires on inbound. Mirrors replyagent OnPhoneNumberUpdated.
    await this.materializeAutoReplyActivity(updated, number);
    this.emitPhoneNumberUpdated(workspaceId, updated);
    return { success: true, number: this.serializeNumber(updated) };
  }

  /**
   * Create/update/delete the number's `wa_auto_reply` trigger activity when its
   * auto-reply automation or interval changes. Mirrors replyagent
   * OnPhoneNumberUpdated: for each TRIGGER step of the chosen automation's
   * published + draft versions, upsert an automation_step_activities row whose
   * `properties.wa_number_id` scopes the auto-reply to THIS number (so inbound
   * on number A never fires number B's auto-reply). Clearing the automation
   * deletes the activity.
   */
  private async materializeAutoReplyActivity(current: any, previous: any): Promise<void> {
    try {
      const changed =
        String(current.auto_reply_automation_id ?? '') !== String(previous.auto_reply_automation_id ?? '') ||
        String(current.auto_reply_interval ?? '') !== String(previous.auto_reply_interval ?? '');
      if (!changed) return;

      const numberIdStr = String(current.id);
      const parse = (raw: any) => {
        try { return typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {}); } catch { return {}; }
      };

      // Remove any existing wa_auto_reply activities scoped to this number.
      const deleteExistingForNumber = async () => {
        const acts = await this.prisma.automation_step_activities.findMany({
          where: { event: 'wa_auto_reply', deleted_at: null },
        });
        const ids = acts
          .filter((a) => String(parse(a.properties)?.wa_number_id) === numberIdStr)
          .map((a) => a.id);
        if (ids.length) {
          await this.prisma.automation_step_activities.deleteMany({ where: { id: { in: ids } } });
        }
      };

      if (current.auto_reply_automation_id) {
        await deleteExistingForNumber();
        const automation = await this.prisma.automations.findUnique({
          where: { id: current.auto_reply_automation_id },
        });
        if (!automation) return;
        const versions: bigint[] = [];
        if (automation.published_version_id) versions.push(automation.published_version_id);
        if (automation.draft_version_id) versions.push(automation.draft_version_id);
        if (!versions.length) return;

        const steps = await this.prisma.automation_steps.findMany({
          where: { automation_version_id: { in: versions }, type: 'trigger' },
        });
        for (const step of steps) {
          const props = {
            event: 'wa_auto_reply',
            text: 'Auto reply',
            type: 'text',
            wait_interval: current.auto_reply_interval,
            wait_unit: 'hour',
            wa_account_id: Number(current.wa_account_id),
            wa_number_id: Number(current.id),
            wa_number: current.phone_number,
          };
          const existing = await this.prisma.automation_step_activities.findFirst({
            where: { event: 'wa_auto_reply', step_id: step.id },
          });
          if (!existing) {
            await this.prisma.automation_step_activities.create({
              data: {
                slug: `wa-auto-reply-${current.id}-${step.id}`,
                step_id: step.id,
                parent_id: null,
                event: 'wa_auto_reply',
                properties: JSON.stringify(props),
                order: 0,
                linkable: false,
                created_at: new Date(),
                updated_at: new Date(),
              },
            });
          } else {
            const merged = { ...parse(existing.properties), wait_interval: current.auto_reply_interval };
            await this.prisma.automation_step_activities.update({
              where: { id: existing.id },
              data: { properties: JSON.stringify(merged), updated_at: new Date() },
            });
          }
        }
      } else if (previous.auto_reply_automation_id) {
        // Auto-reply was cleared — remove the number's activity.
        await deleteExistingForNumber();
      }
    } catch (e: any) {
      this.logger.warn(`materializeAutoReplyActivity failed for number ${current?.id}: ${e?.message ?? e}`);
    }
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
   * POST /whatsapp/capi/:account_id/provision — auto-provision the CAPI dataset
   * from Meta. Mirrors replyagent CapiController::getWhatsappDataset():
   *   1. POST {waba_id}/dataset (empty body, account access_token) → Meta mints
   *      and returns `{ id }` = the dataset_id.
   *   2. Persist a capi row with token = the account's own access_token and
   *      name = the account name (replyagent stores exactly these).
   *   3. Dedupe on dataset_id — return `capi_exists` if already bound.
   *
   * Unlike setupCapiForAccount (manual paste), the caller supplies nothing —
   * dataset_id + token are derived server-side from the WABA.
   */
  async provisionCapiForAccount(
    workspaceId: bigint,
    userId: bigint,
    accountId: bigint,
  ) {
    const account = await this.prisma.wa_accounts.findFirst({
      where: { id: accountId, workspace_id: workspaceId, deleted_at: null },
    });
    if (!account) throw new NotFoundException('Account not found');

    // Already bound to this account? (matches manual-path dedupe semantics.)
    const existingForAccount = await this.prisma.capi.findFirst({
      where: {
        modelable_type: 'App\\Models\\Whatsapp\\WhatsappAccount',
        modelable_id: account.id,
      },
    });
    if (existingForAccount) {
      return { success: false, error_code: 'capi_exists', message: 'CAPI dataset already configured for this account' };
    }

    // Mint the dataset on Meta with the account's own token.
    let datasetId: string;
    try {
      const resp = await this.meta.createDataset(account.waba_id, account.access_token);
      if (!resp?.id) {
        return { success: false, message: 'Meta did not return a dataset id' };
      }
      datasetId = String(resp.id);
    } catch (e: any) {
      return { success: false, message: e?.message ?? 'Failed to provision dataset from Meta' };
    }

    // Dedupe on the minted dataset_id too (replyagent Capi::where('dataset_id')).
    const existingByDataset = await this.prisma.capi.findFirst({ where: { dataset_id: datasetId } });
    if (existingByDataset) {
      return { success: false, error_code: 'capi_exists', message: 'This dataset is already configured' };
    }

    const row = await this.prisma.capi.create({
      data: {
        workspace_id: workspaceId,
        user_id: userId,
        modelable_type: 'App\\Models\\Whatsapp\\WhatsappAccount',
        modelable_id: account.id,
        dataset_id: datasetId,
        name: account.name.slice(0, 60),
        token: account.access_token,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
    return { success: true, capi: { ...row, id: row.id.toString() } };
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

  /**
   * Create a QR-code WhatsApp account row and instruct the microservice to
   * start a Baileys session. The microservice emits WA_QR_CODE back via
   * RabbitMQ, which the backend forwards to the workspace via WebSocket so
   * the frontend can render the QR.
   */
  async qrRegister(
    workspaceId: bigint,
    userId: bigint,
    payload: { phone?: string; name?: string },
  ) {
    const phone = payload?.phone?.trim() ?? '';
    const name = payload?.name?.trim() || 'WhatsApp QR';

    await this.assertChannelCapacity(workspaceId);

    const now = new Date();
    const placeholderWabaId = `qr_${workspaceId}_${now.getTime()}`;

    const account = await this.prisma.wa_accounts.create({
      data: {
        workspace_id: workspaceId,
        user_id: userId,
        waba_id: placeholderWabaId,
        name,
        currency: 'USD',
        timezone_id: '0',
        message_template_namespace: '',
        access_token: '',
        status: 'PENDING',
        service_account_id: '',
        onboard_platform: 'qr_code',
        is_migrated: 0,
        created_at: now,
        updated_at: now,
      },
    });

    // Create a placeholder phone number row (updated when Baileys connects)
    await this.prisma.wa_phone_numbers.create({
      data: {
        wa_account_id: account.id,
        wa_number_id: `qr_${account.id}`,
        display_phone_number: phone || 'Pending',
        phone_number: phone || '',
        pin_code: '000000',
        verified_name: name,
        code_verification_status: 'NOT_VERIFIED',
        status: 'PENDING',
        quality_rating: 'UNKNOWN',
        platform_type: 'QR_CODE',
        auto_reply_interval: '247',
        created_at: now,
        updated_at: now,
      },
    });

    // Tell the microservice to start a Baileys session
    const exchange = this.config.get<string>('RABBITMQ_EXCHANGE') || 'ra';
    const whatsappQueue = this.config.get<string>('RABBITMQ_WHATSAPP_QUEUE') || 'whatsapp';
    await this.rabbit.publish(exchange, whatsappQueue, {
      event: 'WA_QR_REGISTER',
      payload: {
        accountId: account.id.toString(),
        meta: { backend_wa_account_id: account.id.toString() },
      },
    });

    this.logger.log(`qrRegister: created wa_account ${account.id} (workspace=${workspaceId}), WA_QR_REGISTER published`);

    return {
      account_id: account.id.toString(),
      status: 'PENDING',
      message: 'Baileys session starting — listen for whatsapp.qr_code socket event',
    };
  }

  /**
   * Disconnect a QR-code session. Tells the microservice to stop the Baileys
   * session, then marks the account DELETED.
   */
  async qrDisconnect(workspaceId: bigint, accountId: bigint) {
    const account = await this.prisma.wa_accounts.findFirst({
      where: { id: accountId, workspace_id: workspaceId, onboard_platform: 'qr_code', deleted_at: null },
    });
    if (!account) throw new NotFoundException('QR-code WhatsApp account not found');

    const exchange = this.config.get<string>('RABBITMQ_EXCHANGE') || 'ra';
    const whatsappQueue = this.config.get<string>('RABBITMQ_WHATSAPP_QUEUE') || 'whatsapp';
    await this.rabbit.publish(exchange, whatsappQueue, {
      event: 'WA_QR_DISCONNECT',
      payload: { accountId: accountId.toString() },
    });

    const now = new Date();
    await this.prisma.wa_accounts.update({
      where: { id: accountId },
      data: { status: 'DISCONNECTED', deleted_at: now, updated_at: now },
    });

    this.logger.log(`qrDisconnect: wa_account ${accountId} disconnected and soft-deleted`);
    return { success: true };
  }
}
