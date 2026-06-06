// @ts-nocheck
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * List all webhooks for a workspace
   * @param workspaceId
   */
  async list(workspaceId: bigint) {
    const webhooks = await this.prisma.webhooks.findMany({
      where: { workspace_id: workspaceId },
    });
    return { webhooks };
  }

  /**
   * Create a new webhook
   * @param workspaceId
   * @param creatorId
   * @param data
   */
  async create(workspaceId: bigint, creatorId: bigint, data: any) {
    const { name, url, events } = data;

    if (!name || !String(name).trim()) {
      throw new BadRequestException('Webhook name is required');
    }
    if (!url || !this.isValidUrl(url)) {
      throw new BadRequestException('A valid webhook URL is required');
    }
    if (!Array.isArray(events) || events.length === 0) {
      throw new BadRequestException(
        'Select at least one event for this webhook',
      );
    }

    // URL verification logic from Laravel
    if (!(await this.testWebhook(url))) {
      throw new BadRequestException('We could not verify the webhook URL');
    }

    const webhook = await this.prisma.webhooks.create({
      data: {
        workspace_id: workspaceId,
        name,
        url,
        events: typeof events === 'string' ? events : JSON.stringify(events),
        creator_id: creatorId,
      },
    });

    await this.writeAuditLog(workspaceId, creatorId, 'webhook_created', {
      webhook_id: String(webhook.id),
      name,
      url,
      events,
    });

    return { webhook };
  }

  /**
   * Update an existing webhook
   * @param workspaceId
   * @param updaterId
   * @param webhookId
   * @param data
   */
  async update(
    workspaceId: bigint,
    updaterId: bigint,
    webhookId: bigint,
    data: any,
  ) {
    const webhook = await this.prisma.webhooks.findFirst({
      where: { id: webhookId, workspace_id: workspaceId },
    });

    if (!webhook) {
      throw new NotFoundException('Webhook not found');
    }

    const { name, url, events } = data;

    // URL verification logic
    if (!(await this.testWebhook(url))) {
      throw new BadRequestException('We could not verify the webhook URL');
    }

    const updatedWebhook = await this.prisma.webhooks.update({
      where: { id: webhookId },
      data: {
        name,
        url,
        events: typeof events === 'string' ? events : JSON.stringify(events),
        updater_id: updaterId,
      },
    });

    await this.writeAuditLog(workspaceId, updaterId, 'webhook_updated', {
      webhook_id: String(webhookId),
      name,
      url,
      events,
    });

    return { webhook: updatedWebhook };
  }

  /**
   * Delete a webhook
   * @param workspaceId
   * @param webhookId
   */
  async delete(workspaceId: bigint, webhookId: bigint, deleterId?: bigint) {
    const webhook = await this.prisma.webhooks.findFirst({
      where: { id: webhookId, workspace_id: workspaceId },
    });

    if (!webhook) {
      throw new NotFoundException('Webhook not found');
    }

    await this.prisma.webhooks.delete({
      where: { id: webhookId },
    });

    await this.writeAuditLog(
      workspaceId,
      deleterId ?? null,
      'webhook_deleted',
      {
        webhook_id: String(webhookId),
        name: webhook.name,
        url: webhook.url,
      },
    );

    return { success: true };
  }

  /**
   * Lightweight URL validation — must parse as a URL and be http/https.
   * The deeper reachability check happens in testWebhook().
   */
  private isValidUrl(value: string): boolean {
    try {
      const u = new URL(value);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Write an audit_logs row for webhook CRUD operations. Best-effort —
   * a failure here must never bubble up because the caller has already
   * mutated the row.
   */
  private async writeAuditLog(
    workspaceId: bigint,
    userId: bigint | null,
    event: string,
    data: any,
  ): Promise<void> {
    try {
      await this.prisma.audit_logs.create({
        data: {
          workspace_id: workspaceId,
          user_id: userId,
          event,
          modelable_type: 'App\\Models\\Webhook\\Webhook',
          modelable_id: data?.webhook_id ? BigInt(data.webhook_id) : null,
          data: JSON.stringify(data ?? {}),
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `[webhooks] audit log write failed: ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Test Webhook URL (mirrors Laravel testWebhook method)
   * @param url
   */
  private async testWebhook(url: string): Promise<boolean> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ foo: 'bar' }),
      });
      return response.ok;
    } catch (error) {
      this.logger.error(
        `Webhook verification failed for ${url}: ${error.message}`,
      );
      return false;
    }
  }
}
