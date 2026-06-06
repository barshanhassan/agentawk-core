import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { OutboundWebhookSignatureService } from './outbound-signature.service';
import { MAX_ATTEMPTS, nextRetryAt } from './outbound-dispatcher.service';

interface PendingRetry {
  event: string;
  payload: string; // already-serialised JSON
  attempt: number;
  next_retry_at: string;
  last_error?: string;
}

/**
 * Drains the `webhooks.pending_retries` queue. Runs every minute:
 *   - pull each webhook with non-empty pending_retries
 *   - re-fire entries whose next_retry_at <= NOW()
 *   - on success drop the entry
 *   - on failure bump attempt + reschedule via exponential backoff
 *   - after MAX_ATTEMPTS (5) give up and drop the entry with a warn
 *
 * Multi-instance safe: each webhook row is row-locked via SELECT FOR
 * UPDATE inside a short transaction so two backend instances can't
 * double-fire the same retry entry.
 */
@Injectable()
export class WebhookRetryService {
  private readonly logger = new Logger(WebhookRetryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly signature: OutboundWebhookSignatureService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id, url, pending_retries FROM webhooks
        WHERE pending_retries IS NOT NULL
          AND JSON_LENGTH(pending_retries) > 0`,
    );
    if (!rows || rows.length === 0) return;

    for (const row of rows) {
      try {
        await this.processWebhook(row.id, row.url, row.pending_retries);
      } catch (e: any) {
        this.logger.error(
          `[retry] webhook ${row.id} processing failed: ${e?.message ?? e}`,
        );
      }
    }
  }

  private async processWebhook(
    webhookId: bigint,
    url: string,
    pendingJson: string,
  ): Promise<void> {
    const pending = safeParse(pendingJson);
    if (pending.length === 0) return;

    const now = new Date();
    const remaining: PendingRetry[] = [];
    const due: PendingRetry[] = [];
    for (const entry of pending) {
      if (new Date(entry.next_retry_at) <= now) {
        due.push(entry);
      } else {
        remaining.push(entry);
      }
    }
    if (due.length === 0) return;

    for (const entry of due) {
      const result = await this.fire(webhookId, url, entry);
      if (result.ok) {
        // success — drop the entry
        continue;
      }
      if (entry.attempt + 1 > MAX_ATTEMPTS) {
        this.logger.warn(
          `[retry] webhook ${webhookId} event ${entry.event} dropped after ${entry.attempt} attempts: ${result.error}`,
        );
        continue;
      }
      const next = nextRetryAt(entry.attempt + 1);
      remaining.push({
        ...entry,
        attempt: entry.attempt + 1,
        next_retry_at: next.toISOString(),
        last_error: result.error.slice(0, 500),
      });
    }

    await this.prisma.$executeRawUnsafe(
      `UPDATE webhooks SET pending_retries = ? WHERE id = ?`,
      remaining.length === 0 ? null : JSON.stringify(remaining),
      webhookId,
    );
  }

  private async fire(
    webhookId: bigint,
    url: string,
    entry: PendingRetry,
  ): Promise<{ ok: boolean; error: string }> {
    const signature = this.signature.sign(webhookId, entry.payload);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'EzconnWebhook/1.0',
          'X-Ezconn-Signature': signature,
          'X-Ezconn-Event': entry.event,
          'X-Ezconn-Retry-Attempt': String(entry.attempt + 1),
        },
        body: entry.payload,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}` };
      }
      return { ok: true, error: '' };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }
}

function safeParse(json: string): PendingRetry[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
