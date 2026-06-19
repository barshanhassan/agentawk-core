import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Z-API (zapi.io) channel — third-party WhatsApp gateway. Each instance has
 * an `instance_id` + `token` issued by Z-API. Outbound and webhook inbound
 * both flow through https://api.z-api.io/instances/{id}/token/{token}/...
 *
 * Replaces the previous stub-only methods. Persistence is local
 * (zapi_instances), upstream Z-API calls actually create/connect/send.
 */
@Injectable()
export class ZapiService {
  private readonly logger = new Logger(ZapiService.name);
  private readonly base = 'https://api.z-api.io';

  constructor(private readonly prisma: PrismaService) {}

  async getInstances(workspaceId: bigint) {
    return this.prisma.zapi_instances.findMany({
      where: { workspace_id: workspaceId },
      orderBy: { created_at: 'desc' },
    });
  }

  async createInstance(workspaceId: bigint, userId: bigint, data: any) {
    if (!data.name) {
      throw new BadRequestException('name is required');
    }
    // Provision a fresh Z-API instance on demand (replyagent Zapi::createInstance)
    // so the user only supplies a name. If instance_id + token are passed
    // explicitly (manual/legacy path) we honour them instead of provisioning.
    let instanceId = data.instance_id;
    let token = data.token;
    if (!instanceId || !token) {
      const provisioned = await this.provisionInstance(String(data.name));
      instanceId = provisioned.id;
      token = provisioned.token;
    }
    const instance = await this.prisma.zapi_instances.create({
      data: {
        workspace_id: workspaceId,
        name: data.name,
        instance_id: instanceId,
        token,
        status: 'PENDING',
        code: data.code ?? null,
        creator_id: userId,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
    return { success: true, instance };
  }

  /**
   * Create a Z-API instance on demand via the integrator account API and
   * subscribe to it. Mirrors replyagent's Zapi::createInstance +
   * subscribeToAnInstance. Requires the ZAPI_TOKEN (integrator bearer) env;
   * callback URLs are wired when ZAPI_WEBHOOK_URL is configured.
   */
  private async provisionInstance(name: string): Promise<{ id: string; token: string }> {
    const integratorToken = process.env.ZAPI_TOKEN ?? '';
    if (!integratorToken) {
      throw new BadRequestException(
        'Z-API integrator token (ZAPI_TOKEN) is not configured — cannot provision an instance.',
      );
    }
    const cb = (process.env.ZAPI_WEBHOOK_URL ?? '').replace(/\/$/, '');
    const params: any = { name, isDevice: false, businessDevice: true };
    if (cb) {
      params.receivedAndDeliveryCallbackUrl = `${cb}/incoming`;
      params.disconnectedCallbackUrl = `${cb}/disconnected`;
      params.connectedCallbackUrl = `${cb}/connected`;
    }
    const res = await fetch(`${this.base}/instances/integrator/on-demand`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${integratorToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(params),
    });
    const text = await res.text();
    let obj: any = null;
    try { obj = text ? JSON.parse(text) : null; } catch { obj = { raw: text }; }
    if (!res.ok || !obj?.id || !obj?.token) {
      const msg = obj?.error ?? obj?.message ?? `HTTP ${res.status}`;
      this.logger.warn(`Z-API provision failed: ${msg}`);
      throw new BadRequestException(`Z-API instance creation failed: ${msg}`);
    }
    const id = String(obj.id);
    const token = String(obj.token);
    // Best-effort subscribe (replyagent subscribeToAnInstance).
    await fetch(
      `${this.base}/instances/${id}/token/${token}/integrator/on-demand/subscription`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${integratorToken}`, 'content-type': 'application/json' },
      },
    ).catch(() => null);
    return { id, token };
  }

  async updateInstance(workspaceId: bigint, instanceId: bigint, data: any) {
    const existing = await this.requireInstance(workspaceId, instanceId);
    const patch: any = {
      name: data.name ?? existing.name,
      token: data.token ?? existing.token,
      instance_id: data.instance_id ?? existing.instance_id,
      updated_at: new Date(),
    };
    // Default-reply / auto-reply (same endpoint as replyagent PUT /zapi/instance/:id).
    // Sent as `auto_reply_automation_id` (null clears) + `auto_reply_interval`.
    if (Object.prototype.hasOwnProperty.call(data, 'auto_reply_automation_id')) {
      patch.auto_reply_automation_id =
        data.auto_reply_automation_id == null || data.auto_reply_automation_id === ''
          ? null
          : BigInt(data.auto_reply_automation_id);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'auto_reply_interval')) {
      patch.auto_reply_interval = String(data.auto_reply_interval ?? '247');
    }
    const updated = await this.prisma.zapi_instances.update({
      where: { id: existing.id },
      data: patch,
    });
    return { success: true, instance: updated };
  }

  async deleteInstance(
    workspaceId: bigint,
    instanceId: bigint,
    deleteMedia = false,
  ) {
    const existing = await this.requireInstance(workspaceId, instanceId);
    // Cascade teardown — remove this instance's chats + messages so no orphan
    // rows are left behind (replyagent deletes the instance's conversations too).
    // `deleteMedia` mirrors replyagent's flag: when set, the message records
    // (which carry any media references) are purged with the rest. EZCONN keeps
    // no separate per-instance media gallery, so the cascade is the media cleanup.
    const chats = await this.prisma.zapi_chats.findMany({
      where: { zapi_instance_id: existing.id },
      select: { id: true },
    });
    const chatIds = chats.map((c) => c.id);
    if (chatIds.length) {
      await this.prisma.zapi_messages
        .deleteMany({ where: { zapi_chat_id: { in: chatIds } } })
        .catch(() => null);
    }
    await this.prisma.zapi_chats
      .deleteMany({ where: { zapi_instance_id: existing.id } })
      .catch(() => null);
    await this.prisma.zapi_instances.delete({ where: { id: existing.id } });
    return { success: true, deleted_media: deleteMedia };
  }

  /** Returns the QR pairing image or current connection status from Z-API. */
  async connectInstance(workspaceId: bigint, instanceId: bigint) {
    const instance = await this.requireInstance(workspaceId, instanceId);
    const status: any = await this.upstream(instance, 'GET', '/status');
    if (status?.connected) {
      await this.prisma.zapi_instances.update({
        where: { id: instance.id },
        data: { status: 'CONNECTED' as any, updated_at: new Date() },
      });
      return { success: true, connected: true };
    }
    const qr = await this.upstream(instance, 'GET', '/qr-code/image');
    return { success: true, connected: false, qr };
  }

  async disconnectInstance(workspaceId: bigint, instanceId: bigint) {
    const instance = await this.requireInstance(workspaceId, instanceId);
    await this.upstream(instance, 'GET', '/disconnect');
    await this.prisma.zapi_instances.update({
      where: { id: instance.id },
      data: { status: 'DISCONNECTED' as any, updated_at: new Date() },
    });
    return { success: true };
  }

  async resubscribeInstance(workspaceId: bigint, instanceId: bigint) {
    const instance = await this.requireInstance(workspaceId, instanceId);
    await this.upstream(instance, 'GET', '/restart');
    return { success: true };
  }

  async refreshAvatar(workspaceId: bigint, instanceId: bigint) {
    const instance = await this.requireInstance(workspaceId, instanceId);
    const profile: any = await this.upstream(instance, 'GET', '/me');
    await this.prisma.zapi_instances.update({
      where: { id: instance.id },
      data: {
        profile_name: profile?.name ?? null,
        profile_picture: profile?.image ?? null,
        phone_number: profile?.phone ?? null,
      },
    });
    return profile;
  }

  /** Outbound message send via Z-API `/send-text`. */
  async sendMessage(
    workspaceId: bigint,
    senderId: bigint,
    instanceId: bigint,
    payload: { to: string; text?: string; contact_id?: string },
  ) {
    if (!payload?.to || !payload?.text) {
      throw new BadRequestException('to + text are required');
    }
    const instance = await this.requireInstance(workspaceId, instanceId);
    const res: any = await this.upstream(instance, 'POST', '/send-text', {
      phone: payload.to,
      message: payload.text,
    });

    let chat = await this.prisma.zapi_chats.findFirst({
      where: { zapi_instance_id: instance.id, mobile_number: payload.to },
    });
    if (!chat && payload.contact_id) {
      chat = await this.prisma.zapi_chats.create({
        data: {
          zapi_instance_id: instance.id,
          contact_id: BigInt(payload.contact_id),
          mobile_number: payload.to,
          is_primary: true,
        },
      });
    }
    let message: any = null;
    if (chat) {
      message = await this.prisma.zapi_messages.create({
        data: {
          zapi_chat_id: chat.id,
          sender_id: senderId,
          mobile_number: payload.to,
          type: 'text',
          direction: 'OUTGOING' as any,
          text: payload.text,
          status: 'sent',
          message_id: res?.id ?? res?.zaapId ?? null,
        } as any,
      });
    }
    return { success: true, upstream: res, message };
  }

  async toggleFeeder(workspaceId: bigint, instanceId: bigint) {
    // Flip allow_in_feeder (replyagent PUT /zapi/instance/toggle-feeder/:id).
    const existing = await this.requireInstance(workspaceId, instanceId);
    const updated = await this.prisma.zapi_instances.update({
      where: { id: existing.id },
      data: { allow_in_feeder: !existing.allow_in_feeder, updated_at: new Date() },
    });
    return { success: true, allow_in_feeder: updated.allow_in_feeder };
  }

  async getQueueItemsCount(workspaceId: bigint, instanceId: bigint) {
    const instance = await this.requireInstance(workspaceId, instanceId);
    const res: any = await this.upstream(instance, 'GET', '/queue/items');
    return { count: res?.queueLength ?? 0 };
  }

  async deleteQueueItems(workspaceId: bigint, instanceId: bigint) {
    const instance = await this.requireInstance(workspaceId, instanceId);
    await this.upstream(instance, 'DELETE', '/queue/items');
    return { success: true };
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private async requireInstance(workspaceId: bigint, instanceId: bigint) {
    const i = await this.prisma.zapi_instances.findFirst({
      where: { id: instanceId, workspace_id: workspaceId },
    });
    if (!i) throw new NotFoundException('Z-API instance not found');
    if (!i.instance_id || !i.token) {
      throw new BadRequestException('Z-API instance missing instance_id or token');
    }
    return i;
  }

  private async upstream(instance: any, method: string, path: string, body?: any) {
    const url = `${this.base}/instances/${instance.instance_id}/token/${instance.token}${path}`;
    const headers: any = {
      'client-token': process.env.ZAPI_CLIENT_TOKEN ?? '',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    };
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    if (!res.ok) {
      const msg = parsed?.message ?? parsed?.error ?? `HTTP ${res.status}`;
      this.logger.warn(`Z-API ${method} ${path} → ${res.status}: ${msg}`);
      throw new BadRequestException(`Z-API: ${msg}`);
    }
    return parsed;
  }
}
