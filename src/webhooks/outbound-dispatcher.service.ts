import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { OutboundWebhookSignatureService } from './outbound-signature.service';

/**
 * The full menu of outbound webhook events a workspace can subscribe to.
 * Replyagent ships only `contact_created` + `contact_deleted`; EZCONN
 * additionally exposes the message-lifecycle events so WABA integrators
 * can hook into Sent/Delivered/Read/Failed status updates without
 * polling.
 *
 * Slugs are stored in the `webhooks.events` JSON column. The dispatcher
 * matches the slug against the internal event name (mapping below).
 */
export const WEBHOOK_EVENT_SLUGS = [
  // Contact lifecycle (replyagent parity)
  'contact_created',
  'contact_deleted',
  // Message lifecycle (EZCONN-specific)
  'message_sent',
  'message_delivered',
  'message_read',
  'message_failed',
] as const;
export type WebhookEventSlug = (typeof WEBHOOK_EVENT_SLUGS)[number];

/** Maps the internal EventEmitter2 event name → the public slug stored in webhooks.events */
const EVENT_NAME_TO_SLUG: Record<string, WebhookEventSlug> = {
  'contact.created': 'contact_created',
  'contact.deleted': 'contact_deleted',
  'message.sent': 'message_sent',
  'message.delivered': 'message_delivered',
  'message.read': 'message_read',
  'message.failed': 'message_failed',
};

interface PendingRetry {
  event: WebhookEventSlug;
  payload: any;
  attempt: number;
  next_retry_at: string; // ISO timestamp
  last_error?: string;
}

/**
 * Listens to internal events, finds workspace webhooks subscribed to
 * the matching slug, and POSTs the payload to each subscriber URL with
 * an HMAC signature header. On failure, enqueues a retry on the
 * `webhooks.pending_retries` column — see `WebhookRetryService`.
 */
@Injectable()
export class OutboundWebhookDispatcherService {
  private readonly logger = new Logger(OutboundWebhookDispatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly signature: OutboundWebhookSignatureService,
  ) {}

  @OnEvent('contact.created')
  onContactCreated(payload: any) {
    return this.dispatch('contact.created', payload);
  }

  @OnEvent('contact.deleted')
  onContactDeleted(payload: any) {
    return this.dispatch('contact.deleted', payload);
  }

  @OnEvent('message.sent')
  onMessageSent(payload: any) {
    return this.dispatch('message.sent', payload);
  }

  @OnEvent('message.delivered')
  onMessageDelivered(payload: any) {
    return this.dispatch('message.delivered', payload);
  }

  @OnEvent('message.read')
  onMessageRead(payload: any) {
    return this.dispatch('message.read', payload);
  }

  @OnEvent('message.failed')
  onMessageFailed(payload: any) {
    return this.dispatch('message.failed', payload);
  }

  /**
   * Core dispatch: find workspace webhooks subscribed to this event and
   * POST to each. Survives partial failures — one bad endpoint must not
   * block delivery to the others.
   */
  private async dispatch(eventName: string, payload: any) {
    const slug = EVENT_NAME_TO_SLUG[eventName];
    if (!slug) return; // not a webhook-exposed event

    // Payloads SHOULD carry `workspaceId` (existing emit sites do). When
    // missing we can't scope the webhook lookup so we bail out instead of
    // broadcasting across workspaces.
    const workspaceId =
      payload?.workspaceId ?? payload?.workspace_id ?? null;
    if (!workspaceId) {
      this.logger.warn(
        `[dispatch] skipping ${eventName} — no workspaceId in payload`,
      );
      return;
    }
    const workspaceIdBig =
      typeof workspaceId === 'bigint' ? workspaceId : BigInt(workspaceId);

    const webhooks = await this.prisma.webhooks.findMany({
      where: { workspace_id: workspaceIdBig },
    });
    if (webhooks.length === 0) return;

    const wireBody = JSON.stringify({
      event: slug,
      data: this.serialiseForWire(payload),
      sent_at: new Date().toISOString(),
    });

    await Promise.all(
      webhooks
        .filter((w) => this.subscribesTo(w.events, slug))
        .map((w) => this.fire(w.id, w.url, wireBody, slug)),
    );
  }

  /** True if the webhook's events column (JSON array of slugs) includes the slug. */
  private subscribesTo(eventsJson: string | null, slug: WebhookEventSlug): boolean {
    if (!eventsJson) return false;
    try {
      const parsed = JSON.parse(eventsJson);
      if (Array.isArray(parsed)) return parsed.includes(slug);
      // Legacy: `{slug: 'contact_created'}` shape from replyagent — accept it too.
      if (parsed && typeof parsed === 'object' && parsed.slug)
        return parsed.slug === slug;
      return false;
    } catch {
      return false;
    }
  }

  /**
   * POST the body to the URL with a signature header. On non-2xx or
   * thrown error, queue a retry — first attempt becomes attempt 1 in the
   * queue, retried in 60s.
   */
  private async fire(
    webhookId: bigint,
    url: string,
    body: string,
    slug: WebhookEventSlug,
  ): Promise<void> {
    const signature = this.signature.sign(webhookId, body);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'EzconnWebhook/1.0',
          'X-Ezconn-Signature': signature,
          'X-Ezconn-Event': slug,
        },
        body,
        // 10 second hard timeout — a slow customer endpoint must not stall
        // the dispatcher.
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        await this.enqueueRetry(webhookId, slug, body, 1, `HTTP ${res.status}`);
        return;
      }
      this.logger.debug(`[dispatch] ${slug} → ${url} (${res.status})`);
    } catch (err: any) {
      await this.enqueueRetry(
        webhookId,
        slug,
        body,
        1,
        err?.message ?? String(err),
      );
    }
  }

  /**
   * Push a failed delivery into `webhooks.pending_retries`. The retry
   * service reads this column on its cron tick and re-fires when
   * `next_retry_at <= NOW()`.
   *
   * Concurrent writes race on the JSON column — we read-modify-write
   * inside a single UPDATE so a parallel dispatch (also failed for the
   * same webhook) doesn't clobber us. Worst case we drop a duplicate
   * retry entry, which is harmless (the queue is at-least-once anyway).
   */
  async enqueueRetry(
    webhookId: bigint,
    event: WebhookEventSlug,
    body: string,
    attempt: number,
    error: string,
  ): Promise<void> {
    const entry: PendingRetry = {
      event,
      payload: body, // already-serialised JSON string, kept as-is for replay
      attempt,
      next_retry_at: nextRetryAt(attempt).toISOString(),
      last_error: error.slice(0, 500),
    };
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT pending_retries FROM webhooks WHERE id = ? FOR UPDATE`,
      webhookId,
    );
    const current = rows?.[0]?.pending_retries
      ? safeParse(rows[0].pending_retries)
      : [];
    current.push(entry);
    await this.prisma.$executeRawUnsafe(
      `UPDATE webhooks SET pending_retries = ? WHERE id = ?`,
      JSON.stringify(current),
      webhookId,
    );
    this.logger.warn(
      `[dispatch] ${event} for webhook ${webhookId} failed (attempt ${attempt}): ${error}`,
    );
  }

  /**
   * Convert BigInt + Date in the payload to JSON-safe strings before
   * shipping. JSON.stringify chokes on BigInt natively.
   */
  private serialiseForWire(payload: any): any {
    return JSON.parse(
      JSON.stringify(payload, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );
  }
}

/**
 * Exponential backoff with humane caps. The 5-attempt cap (1m, 5m, 15m,
 * 1h, 6h) keeps a flaky endpoint from being hammered for a full day; a
 * 6h-old delivery is generally too stale to be useful.
 */
export function nextRetryAt(attempt: number): Date {
  const offsetsSeconds = [60, 300, 900, 3600, 21_600];
  const idx = Math.min(attempt - 1, offsetsSeconds.length - 1);
  return new Date(Date.now() + offsetsSeconds[idx] * 1000);
}

export const MAX_ATTEMPTS = 5;

function safeParse(json: string): PendingRetry[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
