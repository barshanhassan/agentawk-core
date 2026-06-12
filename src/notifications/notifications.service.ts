import {
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';

type NotificationCreateInput = {
  slug: string;
  type?: string;
  notifiableType: string;
  notifiableId: bigint;
  data: Record<string, any>;
  triggerableType?: string;
  triggerableId?: bigint;
};

/**
 * In-app notifications. Each notification is addressed at a polymorphic
 * "notifiable" (user / workspace / agency). Domain events fire `notify.*`
 * via EventEmitter; this service listens, persists rows, and (optionally)
 * forwards to email/push channels.
 *
 * Replaces the previous stub-only methods so the bell-icon UI gets real data.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Read API ───────────────────────────────────────────────────────

  async list(notifiableType: string, notifiableId: bigint, filters: { limit?: number; offset?: number } = {}) {
    const take = Math.min(filters.limit ?? 50, 200);
    const skip = filters.offset ?? 0;
    const [items, total, unread] = await Promise.all([
      this.prisma.notifications.findMany({
        where: { notifiable_type: notifiableType, notifiable_id: notifiableId },
        orderBy: { created_at: 'desc' },
        take,
        skip,
      }),
      this.prisma.notifications.count({
        where: { notifiable_type: notifiableType, notifiable_id: notifiableId },
      }),
      this.prisma.notifications.count({
        where: { notifiable_type: notifiableType, notifiable_id: notifiableId, read: 0 },
      }),
    ]);
    return {
      notifications: items.map((n) => ({ ...n, data: this.safeJson(n.data) })),
      total,
      unread,
      limit: take,
      offset: skip,
    };
  }

  async markRead(id: string, notifiableType: string, notifiableId: bigint) {
    const n = await this.prisma.notifications.findUnique({ where: { id } });
    if (!n || n.notifiable_type !== notifiableType || n.notifiable_id !== notifiableId) {
      throw new NotFoundException('Notification not found');
    }
    if (n.read === 0) {
      await this.prisma.notifications.update({
        where: { id },
        data: { read: 1, read_at: new Date(), updated_at: new Date() },
      });
    }
    return { success: true };
  }

  async markAllRead(notifiableType: string, notifiableId: bigint) {
    await this.prisma.notifications.updateMany({
      where: { notifiable_type: notifiableType, notifiable_id: notifiableId, read: 0 },
      data: { read: 1, read_at: new Date(), updated_at: new Date() },
    });
    return { success: true };
  }

  async deleteOne(id: string, notifiableType: string, notifiableId: bigint) {
    const n = await this.prisma.notifications.findUnique({ where: { id } });
    if (!n || n.notifiable_type !== notifiableType || n.notifiable_id !== notifiableId) {
      throw new NotFoundException('Notification not found');
    }
    await this.prisma.notifications.delete({ where: { id } });
    return { success: true };
  }

  async deleteAll(notifiableType: string, notifiableId: bigint) {
    await this.prisma.notifications.deleteMany({
      where: { notifiable_type: notifiableType, notifiable_id: notifiableId },
    });
    return { success: true };
  }

  // ─── Write API ─────────────────────────────────────────────────────

  async create(input: NotificationCreateInput) {
    return this.prisma.notifications.create({
      data: {
        id: randomUUID(),
        slug: input.slug,
        type: input.type ?? 'system',
        notifiable_type: input.notifiableType,
        notifiable_id: input.notifiableId,
        data: JSON.stringify(input.data ?? {}),
        triggerable_type: input.triggerableType ?? null,
        triggerable_id: input.triggerableId ?? null,
        read: 0,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
  }

  async dispatchMany(targets: NotificationCreateInput[]) {
    if (targets.length === 0) return { created: 0 };
    await this.prisma.notifications.createMany({
      data: targets.map((t) => ({
        id: randomUUID(),
        slug: t.slug,
        type: t.type ?? 'system',
        notifiable_type: t.notifiableType,
        notifiable_id: t.notifiableId,
        data: JSON.stringify(t.data ?? {}),
        triggerable_type: t.triggerableType ?? null,
        triggerable_id: t.triggerableId ?? null,
        read: 0,
        created_at: new Date(),
        updated_at: new Date(),
      })),
    });
    return { created: targets.length };
  }

  // ─── Event listeners ───────────────────────────────────────────────

  /**
   * Inbound message → notify all active workspace users. Future refinement:
   * narrow by inbox.assigned_to once assignment is wired in inbox flow.
   */
  @OnEvent('message.inbound')
  async onInboundMessage(payload: { workspaceId: bigint; inboxId: bigint; contactId?: bigint; channel?: string; text?: string }) {
    if (!payload?.workspaceId) return;

    let contactName = 'Unknown';
    if (payload.contactId) {
      const contact = await this.prisma.contacts.findUnique({
        where: { id: payload.contactId },
        select: { full_name: true, first_name: true, last_name: true },
      });
      if (contact) {
        contactName =
          contact.full_name ||
          `${contact.first_name || ''} ${contact.last_name || ''}`.trim() ||
          'Customer';
      }
    }

    const users = await this.prisma.users.findMany({
      where: {
        modelable_type: 'App\\Models\\Workspace',
        modelable_id: payload.workspaceId,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    if (users.length === 0) return;
    await this.dispatchMany(
      users.map((u) => ({
        slug: 'inbox.message_received',
        type: 'inbox',
        notifiableType: 'App\\Models\\User',
        notifiableId: u.id,
        data: {
          title: `New message from ${contactName}`,
          message: payload.text ?? '',
          inbox_id: payload.inboxId.toString(),
          channel: payload.channel ?? 'unknown',
          contact_name: contactName,
          action_url: '/conversations/inbox',
        },
        triggerableType: 'App\\Models\\Inbox',
        triggerableId: payload.inboxId,
      })),
    );
  }

  private safeJson(raw: string | null) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  }
}
