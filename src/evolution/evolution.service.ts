import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Evolution API channel — WhatsApp QR-code based WhatsApp gateway. Each
 * workspace can have multiple `evolution_instances`, each pointing at a
 * self-hosted Evolution API server (api_url + api_key). This service is the
 * thin wrapper that creates/connects/disconnects instances and sends messages
 * via the upstream Evolution REST API.
 *
 * Webhook inbound handling lives in the WebhooksInboundController; this
 * service exposes a parser entrypoint that webhooks-inbound calls when
 * provider === 'evolution'.
 */
@Injectable()
export class EvolutionService {
  private readonly logger = new Logger(EvolutionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listInstances(workspaceId: bigint) {
    return this.prisma.evolution_instances.findMany({
      where: { workspace_id: workspaceId, deleted_at: null },
      orderBy: { created_at: 'desc' },
    });
  }

  async createInstance(workspaceId: bigint, userId: bigint, data: any) {
    if (!data.name || !data.api_url || !data.global_key) {
      throw new BadRequestException('name, api_url, global_key are required');
    }
    const instance = await this.prisma.evolution_instances.create({
      data: {
        workspace_id: workspaceId,
        name: data.name,
        api_url: data.api_url,
        global_key: data.global_key,
        api_key: data.api_key ?? null,
        status: 'PENDING',
        creator_id: userId,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });

    // Create instance on the upstream Evolution server.
    try {
      const res = await this.upstream(instance, 'POST', '/instance/create', {
        instanceName: instance.name,
        token: instance.global_key,
        qrcode: true,
      });
      const remoteId = res?.instance?.instanceId ?? res?.instanceName;
      if (remoteId) {
        await this.prisma.evolution_instances.update({
          where: { id: instance.id },
          data: { instance_id: String(remoteId), state: 'created' },
        });
      }
      return { ...instance, upstream: res };
    } catch (e: any) {
      this.logger.warn(`Evolution upstream create failed: ${e?.message}`);
      await this.prisma.evolution_instances.update({
        where: { id: instance.id },
        data: { status: 'FAILED', fail_reason: e?.message ?? 'unknown' },
      });
      throw e;
    }
  }

  /** Fetch a QR code (base64 / pairing url) for connecting WhatsApp Web. */
  async getConnectionQr(workspaceId: bigint, instanceId: bigint) {
    const instance = await this.requireInstance(workspaceId, instanceId);
    return this.upstream(instance, 'GET', `/instance/connect/${encodeURIComponent(instance.name)}`);
  }

  async disconnect(workspaceId: bigint, instanceId: bigint) {
    const instance = await this.requireInstance(workspaceId, instanceId);
    await this.upstream(instance, 'DELETE', `/instance/logout/${encodeURIComponent(instance.name)}`);
    await this.prisma.evolution_instances.update({
      where: { id: instance.id },
      data: { state: 'disconnected', status: 'DISCONNECTED' as any },
    });
    return { success: true };
  }

  async deleteInstance(workspaceId: bigint, instanceId: bigint) {
    const instance = await this.requireInstance(workspaceId, instanceId);
    try {
      await this.upstream(instance, 'DELETE', `/instance/delete/${encodeURIComponent(instance.name)}`);
    } catch (e: any) {
      this.logger.warn(`Evolution upstream delete failed: ${e?.message}`);
    }
    await this.prisma.evolution_instances.update({
      where: { id: instance.id },
      data: { deleted_at: new Date() },
    });
    return { success: true };
  }

  /**
   * Send an outbound text/media message. Persists into evolution_messages and
   * also calls the Evolution REST API to actually transmit.
   */
  async sendMessage(
    workspaceId: bigint,
    senderId: bigint,
    instanceId: bigint,
    payload: { to: string; text?: string; media?: any; contact_id?: string },
  ) {
    if (!payload?.to) throw new BadRequestException('to is required');
    const instance = await this.requireInstance(workspaceId, instanceId);

    const upstreamRes = await this.upstream(
      instance,
      'POST',
      `/message/sendText/${encodeURIComponent(instance.name)}`,
      {
        number: payload.to,
        textMessage: { text: payload.text ?? '' },
      },
    );

    let chat = await this.prisma.evolution_chats.findFirst({
      where: { evolution_instance_id: instance.id, mobile_number: payload.to },
    });
    if (!chat && payload.contact_id) {
      chat = await this.prisma.evolution_chats.create({
        data: {
          evolution_instance_id: instance.id,
          contact_id: BigInt(payload.contact_id),
          mobile_number: payload.to,
          is_primary: true,
        },
      });
    }

    let message = null as any;
    if (chat) {
      message = await this.prisma.evolution_messages.create({
        data: {
          evolution_chat_id: chat.id,
          sender_id: senderId,
          mobile_number: payload.to,
          type: 'text',
          direction: 'OUTGOING',
          text: payload.text ?? null,
          status: 'sent',
          payload: JSON.stringify(upstreamRes),
        },
      });
    }
    return { success: true, message, upstream: upstreamRes };
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private async requireInstance(workspaceId: bigint, instanceId: bigint) {
    const instance = await this.prisma.evolution_instances.findFirst({
      where: { id: instanceId, workspace_id: workspaceId, deleted_at: null },
    });
    if (!instance) throw new NotFoundException('Evolution instance not found');
    return instance;
  }

  private async upstream(instance: any, method: string, path: string, body?: any) {
    const url = `${instance.api_url.replace(/\/$/, '')}${path}`;
    const headers: any = {
      apikey: instance.api_key ?? instance.global_key,
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
      throw new BadRequestException(`Evolution API: ${msg}`);
    }
    return parsed;
  }
}
