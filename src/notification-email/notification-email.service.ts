import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Smtp2goClient } from './smtp2go.client';

const WORKSPACE_TYPE = 'App\\Models\\Workspace';

/**
 * Custom email domain (White Label → Email tab). Mirrors replyagent's
 * NotificationsController + notification_emails table: add a sender domain to
 * SMTP2GO, surface the DKIM / Return-Path / tracking CNAME records for the
 * user to add to DNS, then verify. status flips to VERIFIED once DKIM + rpath
 * are both verified by SMTP2GO.
 */
@Injectable()
export class NotificationEmailService {
  private readonly logger = new Logger(NotificationEmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly smtp2go: Smtp2goClient,
  ) {}

  private serialize(row: any) {
    if (!row) return null;
    return {
      ...row,
      id: row.id?.toString(),
      modelable_id: row.modelable_id?.toString() ?? null,
    };
  }

  async get(workspaceId: bigint) {
    const row = await this.prisma.notification_emails.findFirst({
      where: { modelable_type: WORKSPACE_TYPE, modelable_id: workspaceId },
      orderBy: { id: 'desc' },
    });
    return { notification_email: this.serialize(row) };
  }

  async add(workspaceId: bigint, body: { prefix?: string; domain?: string }) {
    const prefix = (body?.prefix ?? '').trim();
    const domain = (body?.domain ?? '').trim().toLowerCase();
    if (!prefix) throw new BadRequestException('Email prefix is required');
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/i.test(domain)) {
      throw new BadRequestException('Enter a valid domain (e.g. example.com)');
    }

    // One custom email domain per workspace — reuse the existing row if present.
    const existing = await this.prisma.notification_emails.findFirst({
      where: { modelable_type: WORKSPACE_TYPE, modelable_id: workspaceId },
    });

    // Register the sender domain with SMTP2GO and pull the DNS records.
    const resp = await this.smtp2go.addDomain(domain);
    const rec = this.smtp2go.mapRecords(resp);
    const verified = rec.dkim_verified && rec.rpath_verified;
    const now = new Date();

    const data: any = {
      modelable_type: WORKSPACE_TYPE,
      modelable_id: workspaceId,
      prefix,
      domain,
      email: `${prefix}@${domain}`,
      status: verified ? 'VERIFIED' : 'UNVERIFIED',
      ...rec,
      updated_at: now,
    };

    const row = existing
      ? await this.prisma.notification_emails.update({ where: { id: existing.id }, data })
      : await this.prisma.notification_emails.create({ data: { ...data, created_at: now } });

    return { notification_email: this.serialize(row) };
  }

  async verify(workspaceId: bigint, id: bigint) {
    const row = await this.prisma.notification_emails.findFirst({
      where: { id, modelable_type: WORKSPACE_TYPE, modelable_id: workspaceId },
    });
    if (!row) throw new NotFoundException('Notification email not found');

    const resp = await this.smtp2go.verifyDomain(row.domain);
    const rec = this.smtp2go.mapRecords(resp);
    const verified = rec.dkim_verified && rec.rpath_verified;

    const updated = await this.prisma.notification_emails.update({
      where: { id: row.id },
      data: { ...rec, status: verified ? 'VERIFIED' : 'UNVERIFIED', updated_at: new Date() },
    });
    return { notification_email: this.serialize(updated) };
  }

  async remove(workspaceId: bigint, id: bigint) {
    const row = await this.prisma.notification_emails.findFirst({
      where: { id, modelable_type: WORKSPACE_TYPE, modelable_id: workspaceId },
    });
    if (!row) throw new NotFoundException('Notification email not found');

    // Best-effort SMTP2GO cleanup — don't block the local delete if it fails.
    try {
      await this.smtp2go.removeDomain(row.domain);
    } catch (e: any) {
      this.logger.debug(`SMTP2GO domain/remove failed (non-fatal): ${e?.message ?? e}`);
    }

    await this.prisma.notification_emails.delete({ where: { id: row.id } });
    return { success: true };
  }
}
