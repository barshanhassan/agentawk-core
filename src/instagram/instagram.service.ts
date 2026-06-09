// @ts-nocheck
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MetaGraphApiClient } from '../whatsapp/meta-graph-api.client';
import { RabbitMqService } from '../rabbitmq/rabbitmq.service';

@Injectable()
export class InstagramService {
  private readonly logger = new Logger(InstagramService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaGraphApiClient,
    private readonly rabbit: RabbitMqService,
    private readonly config: ConfigService,
  ) {}

  // ── List pages ──────────────────────────────────────────────────────
  async listPages(workspaceId: bigint) {
    return this.prisma.insta_pages.findMany({
      where: { workspace_id: workspaceId, deleted_at: null },
      orderBy: { created_at: 'desc' },
    });
  }

  // ── Connect page (manual upsert) ────────────────────────────────────
  async connectPage(workspaceId: bigint, userId: bigint, data: any) {
    if (!data?.access_token || !(data?.ig_user_id || data?.page_id)) {
      throw new BadRequestException('access_token + ig_user_id (or page_id) required');
    }
    const exchange = this.config.get<string>('RABBITMQ_EXCHANGE') || 'ra';
    const igQueue = this.config.get<string>('RABBITMQ_INSTAGRAM_QUEUE') || 'instagram';

    const orClauses = [];
    if (data.ig_user_id) orClauses.push({ ig_user_id: data.ig_user_id });
    if (data.page_id)    orClauses.push({ page_id: data.page_id });

    const existing = await this.prisma.insta_pages.findFirst({
      where: { workspace_id: workspaceId, OR: orClauses },
    });

    if (existing) {
      const saved = await this.prisma.insta_pages.update({
        where: { id: existing.id },
        data: {
          access_token: data.access_token,
          name: data.name ?? existing.name,
          username: data.username ?? existing.username,
          followers_count: data.followers_count ?? existing.followers_count,
          follows_count: data.follows_count ?? existing.follows_count,
          media_count: data.media_count != null ? BigInt(data.media_count) : existing.media_count,
          token_expirey: data.token_expirey ?? existing.token_expirey,
          status: existing.service_account_id ? 'ACTIVE' : 'PENDING',
          updated_at: new Date(),
        },
      });

      if (existing.service_account_id) {
        // Already in microservice — just refresh credentials
        await this.rabbit.publish(exchange, igQueue, {
          event: 'INSTA_UPDATE',
          payload: {
            accountId: existing.service_account_id,
            access_token: data.access_token,
            ig_user_id: data.ig_user_id ?? existing.ig_user_id,
            username: data.username ?? existing.username,
            platform: data.platform ?? existing.platform,
          },
        });
      } else {
        // Not yet in microservice — re-verify
        await this.rabbit.publish(exchange, igQueue, {
          event: 'INSTA_VERIFY',
          payload: this.buildVerifyPayload(saved, workspaceId),
        });
      }
      return saved;
    }

    const saved = await this.prisma.insta_pages.create({
      data: {
        workspace_id: workspaceId,
        user_id: userId,
        access_token: data.access_token,
        ig_user_id: data.ig_user_id ?? null,
        page_id: data.page_id ?? null,
        name: data.name ?? null,
        username: data.username ?? null,
        followers_count: data.followers_count ?? 0,
        follows_count: data.follows_count ?? 0,
        media_count: data.media_count != null ? BigInt(data.media_count) : null,
        token_expirey: data.token_expirey ?? null,
        status: 'PENDING',
        account_type: data.account_type ?? 'BUSINESS',
        platform: data.platform ?? 'instagram',
        auto_reply_interval: '247',
        created_at: new Date(),
        updated_at: new Date(),
      },
    });

    await this.rabbit.publish(exchange, igQueue, {
      event: 'INSTA_VERIFY',
      payload: this.buildVerifyPayload(saved, workspaceId),
    });

    return saved;
  }

  private buildVerifyPayload(page: any, workspaceId: bigint) {
    return {
      businessPageId: page.page_id ?? page.ig_user_id,
      accessToken: page.access_token,
      ig_user_id: page.ig_user_id,
      username: page.username,
      name: page.name,
      platform: page.platform ?? 'facebook',
      uploadDir: `instagram/${workspaceId}/`,
      thumbDir: `instagram/${workspaceId}/thumb/`,
      meta: { backend_insta_page_id: page.id.toString() },
    };
  }

  // ── Connect Instagram Business via OAuth code exchange ──────────────
  async connectBusiness(workspaceId: bigint, userId: bigint, code: string, redirectUri: string) {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) throw new BadRequestException('Meta app credentials not configured');
    if (!code) throw new BadRequestException('Authorization code required');

    // 1. Exchange code for short-lived token
    const shortRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
      }).toString(),
    });
    if (!shortRes.ok) {
      const err = await shortRes.json().catch(() => ({}));
      throw new BadRequestException(`Instagram OAuth: ${err.error_message ?? err.message ?? 'token exchange failed'}`);
    }
    const shortData = await shortRes.json();
    const shortToken = shortData.access_token;
    const igUserId = shortData.user_id;

    // 2. Exchange short-lived token for long-lived token (~60 days)
    const longRes = await fetch(
      `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${appSecret}&access_token=${shortToken}`,
    );
    const longData = await longRes.json();
    const longToken = longData.access_token ?? shortToken;
    const expiresIn: number = longData.expires_in ?? 0;

    // 3. Fetch user profile
    const userRes = await fetch(
      `https://graph.instagram.com/me?fields=id,name,username,followers_count,follows_count,media_count,account_type&access_token=${longToken}`,
    );
    const user = await userRes.json();

    return this.connectPage(workspaceId, userId, {
      access_token: longToken,
      ig_user_id: String(igUserId ?? user.id),
      name: user.name ?? null,
      username: user.username ?? null,
      followers_count: user.followers_count ?? 0,
      follows_count: user.follows_count ?? 0,
      media_count: user.media_count ?? null,
      account_type: user.account_type ?? 'BUSINESS',
      platform: 'instagram',
      token_expirey: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null,
    });
  }

  // ── Get available Facebook-managed IG pages (after Facebook OAuth) ──
  async getAvailablePages(workspaceId: bigint, userToken: string) {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    const version = process.env.META_GRAPH_API_VERSION ?? 'v22.0';
    if (!userToken) throw new BadRequestException('Facebook user token required');

    // Exchange short-lived user token for long-lived (~60 days)
    const longRes = await fetch(
      `https://graph.facebook.com/${version}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${userToken}`,
    );
    const longData = await longRes.json();
    const longToken = longData.access_token ?? userToken;

    // Fetch user's Facebook pages
    const pages = await this.meta.fetchPages(longToken);

    const results = await Promise.all(
      (pages.data ?? []).map(async (page: any) => {
        if (!page.instagram_business_account) return null;
        const igId = String(page.instagram_business_account.id);

        const igRes = await fetch(
          `https://graph.facebook.com/${version}/${igId}?fields=id,name,username,followers_count,follows_count,media_count,account_type&access_token=${page.access_token}`,
        );
        const ig = await igRes.json();

        const existing = await this.prisma.insta_pages.findFirst({
          where: { workspace_id: workspaceId, ig_user_id: igId, deleted_at: null },
        });

        return {
          page_id: page.id,
          page_name: page.name,
          ig_user_id: igId,
          name: ig.name ?? page.name,
          username: ig.username ?? null,
          followers_count: ig.followers_count ?? 0,
          follows_count: ig.follows_count ?? 0,
          media_count: ig.media_count ?? null,
          account_type: ig.account_type ?? 'BUSINESS',
          access_token: page.access_token,
          long_token: longToken,
          already_connected: !!existing,
        };
      }),
    );

    return results.filter(Boolean);
  }

  // ── Connect a Facebook-managed IG page ──────────────────────────────
  async connectFbPage(workspaceId: bigint, userId: bigint, data: any) {
    return this.connectPage(workspaceId, userId, { ...data, platform: 'facebook' });
  }

  // ── Disconnect page ──────────────────────────────────────────────────
  async disconnectPage(workspaceId: bigint, pageId: bigint) {
    const page = await this.requirePage(workspaceId, pageId);
    const exchange = this.config.get<string>('RABBITMQ_EXCHANGE') || 'ra';
    const igQueue = this.config.get<string>('RABBITMQ_INSTAGRAM_QUEUE') || 'instagram';

    if (page.service_account_id) {
      await this.rabbit.publish(exchange, igQueue, {
        event: 'INSTA_ACCOUNT_DELETING',
        payload: {
          account_id: page.service_account_id,
          username: page.username,
        },
      });
      await this.prisma.insta_pages.update({
        where: { id: page.id },
        data: { status: 'DELETING', updated_at: new Date() },
      });
    } else {
      await this.prisma.insta_pages.update({
        where: { id: page.id },
        data: { status: 'DISCONNECTED', updated_at: new Date() },
      });
    }
    return { success: true };
  }

  // ── Send message ─────────────────────────────────────────────────────
  async sendMessage(workspaceId: bigint, pageId: bigint, payload: { recipient_id: string; text: string }) {
    if (!payload?.recipient_id || !payload?.text) {
      throw new BadRequestException('recipient_id + text required');
    }
    const page = await this.requirePage(workspaceId, pageId);

    // Find or create insta_chat for this recipient
    const now = new Date();
    let chat = await this.prisma.insta_chats.findFirst({
      where: { insta_page_id: page.id, sender_id: payload.recipient_id },
    });
    if (!chat) {
      chat = await this.prisma.insta_chats.create({
        data: {
          insta_page_id: page.id,
          user_id: page.user_id,
          sender_id: payload.recipient_id,
          recipient_id: page.ig_user_id ?? '',
          input_attempts: 0n,
          created_at: now,
          updated_at: now,
        },
      });
    }

    // Create pending outbound message row for correlation
    const message = await this.prisma.insta_messages.create({
      data: {
        insta_page_id: page.id,
        insta_chat_id: chat.id,
        type: 'text',
        direction: 'OUT',
        text: payload.text,
        status: 'pending',
        created_at: now,
        updated_at: now,
      },
    });

    if (page.service_account_id) {
      const exchange = this.config.get<string>('RABBITMQ_EXCHANGE') || 'ra';
      const igQueue = this.config.get<string>('RABBITMQ_INSTAGRAM_QUEUE') || 'instagram';
      await this.rabbit.publish(exchange, igQueue, {
        event: 'INSTA_OUTBOUND_MESSAGE',
        payload: {
          accountId: page.service_account_id,
          context: {
            recipient: { id: payload.recipient_id },
            message: { text: payload.text },
          },
          meta: { backend_insta_message_id: message.id.toString() },
        },
      });
    } else {
      // Microservice not yet linked — fallback to direct Meta API
      await this.meta.sendMessengerMessage(page.access_token, {
        recipient: { id: payload.recipient_id },
        message: { text: payload.text },
      });
      await this.prisma.insta_messages.update({
        where: { id: message.id },
        data: { status: 'sent', updated_at: now },
      });
    }

    return { success: true, message_id: message.id.toString() };
  }

  // ── Sync page stats from Meta API ────────────────────────────────────
  async syncPage(workspaceId: bigint, pageId: bigint) {
    const page = await this.requirePage(workspaceId, pageId);
    const version = process.env.META_GRAPH_API_VERSION ?? 'v22.0';

    const statsUrl =
      page.platform === 'instagram'
        ? `https://graph.instagram.com/me?fields=id,name,username,followers_count,follows_count,media_count&access_token=${page.access_token}`
        : `https://graph.facebook.com/${version}/${page.ig_user_id}?fields=id,name,username,followers_count,follows_count,media_count&access_token=${page.access_token}`;

    const res = await fetch(statsUrl);
    if (!res.ok) throw new BadRequestException('Failed to sync account stats from Meta API');
    const data = await res.json();
    if (data.error) throw new BadRequestException(`Meta API: ${data.error.message}`);

    return this.prisma.insta_pages.update({
      where: { id: page.id },
      data: {
        name: data.name ?? page.name,
        username: data.username ?? page.username,
        followers_count: data.followers_count ?? page.followers_count,
        follows_count: data.follows_count ?? page.follows_count,
        media_count: data.media_count != null ? BigInt(data.media_count) : page.media_count,
        updated_at: new Date(),
      },
    });
  }

  // ── Toggle AI feeder ─────────────────────────────────────────────────
  async toggleFeeder(workspaceId: bigint, pageId: bigint, enabled: boolean) {
    const page = await this.requirePage(workspaceId, pageId);
    await this.prisma.insta_pages.update({
      where: { id: page.id },
      data: { allow_in_feeder: enabled ? 1 : 0, updated_at: new Date() },
    });
    return { success: true, allow_in_feeder: enabled };
  }

  // ── Ice Breakers ─────────────────────────────────────────────────────
  async getIceBreakers(workspaceId: bigint, pageId: bigint) {
    const page = await this.requirePage(workspaceId, pageId);
    return this.prisma.insta_features.findMany({
      where: { insta_page_id: page.id, type: 'ICE_BREAKER' },
      orderBy: { id: 'asc' },
    });
  }

  async saveIceBreakers(workspaceId: bigint, pageId: bigint, items: { text: string; automationId?: string | null }[]) {
    const page = await this.requirePage(workspaceId, pageId);
    await this.prisma.insta_features.deleteMany({ where: { insta_page_id: page.id, type: 'ICE_BREAKER' } });
    if (!items?.length) return { success: true };
    await this.prisma.insta_features.createMany({
      data: items.slice(0, 4).map((item) => ({
        insta_page_id: page.id,
        type: 'ICE_BREAKER',
        text: item.text,
        payload_type: 'postback',
        modelable_id: item.automationId ? BigInt(item.automationId) : null,
        modelable_type: item.automationId ? 'App\\Models\\Automations\\Automation' : null,
        is_published: 0,
        created_at: new Date(),
        updated_at: new Date(),
      })),
    });
    return { success: true };
  }

  async deleteIceBreakers(workspaceId: bigint, pageId: bigint) {
    const page = await this.requirePage(workspaceId, pageId);
    await this.prisma.insta_features.deleteMany({ where: { insta_page_id: page.id, type: 'ICE_BREAKER' } });
    return { success: true };
  }

  // ── Persistent Menu ──────────────────────────────────────────────────
  async getMenu(workspaceId: bigint, pageId: bigint) {
    const page = await this.requirePage(workspaceId, pageId);
    return this.prisma.insta_features.findMany({
      where: { insta_page_id: page.id, type: 'PERSISTENT_MENU' },
      orderBy: { id: 'asc' },
    });
  }

  async saveMenu(
    workspaceId: bigint,
    pageId: bigint,
    items: { text: string; payloadType: string; payload?: string | null; automationId?: string | null }[],
  ) {
    const page = await this.requirePage(workspaceId, pageId);
    await this.prisma.insta_features.deleteMany({ where: { insta_page_id: page.id, type: 'PERSISTENT_MENU' } });
    if (!items?.length) return { success: true };
    await this.prisma.insta_features.createMany({
      data: items.slice(0, 20).map((item) => ({
        insta_page_id: page.id,
        type: 'PERSISTENT_MENU',
        text: item.text,
        payload_type: item.payloadType,
        payload: item.payloadType === 'web_url' ? (item.payload ?? null) : null,
        modelable_id: item.automationId && item.payloadType === 'postback' ? BigInt(item.automationId) : null,
        modelable_type:
          item.automationId && item.payloadType === 'postback'
            ? 'App\\Models\\Automations\\Automation'
            : null,
        is_published: 0,
        created_at: new Date(),
        updated_at: new Date(),
      })),
    });
    return { success: true };
  }

  async deleteMenu(workspaceId: bigint, pageId: bigint) {
    const page = await this.requirePage(workspaceId, pageId);
    await this.prisma.insta_features.deleteMany({ where: { insta_page_id: page.id, type: 'PERSISTENT_MENU' } });
    return { success: true };
  }

  // ── Auto Reply ───────────────────────────────────────────────────────
  async getAutoReply(workspaceId: bigint, pageId: bigint) {
    const page = await this.requirePage(workspaceId, pageId);
    return {
      auto_reply_automation_id: page.auto_reply_automation_id
        ? page.auto_reply_automation_id.toString()
        : null,
      auto_reply_interval: page.auto_reply_interval,
    };
  }

  async setAutoReply(workspaceId: bigint, pageId: bigint, automationId: string | null, interval: string) {
    const page = await this.requirePage(workspaceId, pageId);
    await this.prisma.insta_pages.update({
      where: { id: page.id },
      data: {
        auto_reply_automation_id: automationId ? BigInt(automationId) : null,
        auto_reply_interval: interval ?? '247',
        updated_at: new Date(),
      },
    });
    return { success: true };
  }

  // ── Story Mention ─────────────────────────────────────────────────────
  async getStoryMention(workspaceId: bigint, pageId: bigint) {
    const page = await this.requirePage(workspaceId, pageId);
    return this.prisma.insta_features.findFirst({
      where: { insta_page_id: page.id, type: 'STORY_MENTION' },
    });
  }

  async setStoryMention(workspaceId: bigint, pageId: bigint, data: { automationId?: string | null }) {
    const page = await this.requirePage(workspaceId, pageId);
    const existing = await this.prisma.insta_features.findFirst({
      where: { insta_page_id: page.id, type: 'STORY_MENTION' },
    });
    const featureData = {
      insta_page_id: page.id,
      type: 'STORY_MENTION',
      payload_type: 'postback',
      modelable_id: data.automationId ? BigInt(data.automationId) : null,
      modelable_type: data.automationId ? 'App\\Models\\Automations\\Automation' : null,
      is_published: 0,
      updated_at: new Date(),
    };
    if (existing) {
      return this.prisma.insta_features.update({ where: { id: existing.id }, data: featureData });
    }
    return this.prisma.insta_features.create({ data: { ...featureData, created_at: new Date() } });
  }

  async deleteStoryMention(workspaceId: bigint, pageId: bigint) {
    const page = await this.requirePage(workspaceId, pageId);
    await this.prisma.insta_features.deleteMany({ where: { insta_page_id: page.id, type: 'STORY_MENTION' } });
    return { success: true };
  }

  // ── Page Users ───────────────────────────────────────────────────────
  async getPageUsers(workspaceId: bigint, pageId: bigint) {
    const page = await this.requirePage(workspaceId, pageId);
    return this.prisma.insta_page_users.findMany({
      where: { insta_page_id: page.id },
      orderBy: { id: 'asc' },
    });
  }

  async setPageUsers(workspaceId: bigint, pageId: bigint, userIds: string[]) {
    const page = await this.requirePage(workspaceId, pageId);
    await this.prisma.insta_page_users.deleteMany({ where: { insta_page_id: page.id } });
    if (!userIds?.length) return { success: true };
    await this.prisma.insta_page_users.createMany({
      data: userIds.map((uid) => ({
        insta_page_id: page.id,
        user_id: BigInt(uid),
        created_at: new Date(),
        updated_at: new Date(),
      })),
    });
    return { success: true };
  }

  // ── Private ──────────────────────────────────────────────────────────
  private async requirePage(workspaceId: bigint, pageId: bigint) {
    const page = await this.prisma.insta_pages.findFirst({
      where: { id: pageId, workspace_id: workspaceId, deleted_at: null },
    });
    if (!page) throw new NotFoundException('Instagram page not found');
    return page;
  }
}
