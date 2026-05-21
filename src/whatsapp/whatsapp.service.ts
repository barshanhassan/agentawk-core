import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MetaGraphApiClient } from './meta-graph-api.client';

@Injectable()
export class WhatsappService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaGraphApiClient,
  ) {}

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
    payload: { code: string; waba_id: string; phone_number_id?: string; onboard_platform?: string },
  ) {
    if (!payload?.code || !payload?.waba_id) {
      throw new BadRequestException('code and waba_id are required');
    }

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

    return { success: true, account_id: account.id.toString() };
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
}
