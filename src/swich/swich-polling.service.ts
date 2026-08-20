import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SwichService, SwichOwner } from './swich.service';

/**
 * Safety net for Swich's callback (Section 16), which as of 2026-08 never
 * reliably reaches this server — Swich's own Inquire response reports
 * callbackStatus: "failed" on every transaction checked so far. Polls
 * still-pending transactions via Inquire (Section 13) instead, so status
 * updates automatically without anyone clicking "Check Status" by hand.
 */
@Injectable()
export class SwichPollingService {
  private readonly logger = new Logger(SwichPollingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly swich: SwichService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    // Anything older than 24h is treated as abandoned — no point inquiring
    // forever, and it keeps each tick's workload bounded.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const pending = await this.prisma.swich_transactions.findMany({
      where: { status: 'pending', created_at: { gte: cutoff } },
      take: 50,
    });
    if (pending.length === 0) return;

    for (const tx of pending) {
      const owner: SwichOwner =
        tx.agency_id != null ? { agencyId: tx.agency_id } : { workspaceId: tx.workspace_id ?? undefined };
      try {
        await this.swich.inquire(owner, tx.customer_transaction_id);
      } catch (e: any) {
        this.logger.warn(`[swich-poll] inquire failed for ${tx.customer_transaction_id}: ${e?.message ?? e}`);
      }
    }
  }
}
