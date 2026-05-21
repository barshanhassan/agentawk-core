import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Twilio channel — SMS + voice. Each workspace registers one or more
 * `twilio_accounts` keyed by `twilio_account_sid` + `twilio_auth_token`. SMS
 * out goes via the Messages API; call logs come from the CallStatus webhook
 * (handled by webhooks-inbound provider='twilio').
 *
 * Replaces the previously empty module — adds account CRUD, SMS send, and a
 * dedicated call-logs listing endpoint that the Call Logs UI needs.
 */
@Injectable()
export class TwilioService {
  private readonly logger = new Logger(TwilioService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Accounts ──────────────────────────────────────────────────────

  async listAccounts(workspaceId: bigint) {
    return this.prisma.twilio_accounts.findMany({
      where: { workspace_id: workspaceId, deleted_at: null },
      orderBy: { created_at: 'desc' },
    });
  }

  async saveAccount(workspaceId: bigint, userId: bigint, data: any) {
    if (!data?.twilio_account_sid || !data?.name) {
      throw new BadRequestException('name + twilio_account_sid required');
    }
    return this.prisma.twilio_accounts.create({
      data: {
        workspace_id: workspaceId,
        creator_id: userId,
        name: data.name,
        type: data.type ?? 'notification',
        twilio_account_sid: data.twilio_account_sid,
        twilio_auth_token: data.twilio_auth_token ?? null,
        media_gallery_id: BigInt(0),
        status: 'ACTIVE' as any,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
  }

  async deleteAccount(workspaceId: bigint, accountId: bigint) {
    const acc = await this.requireAccount(workspaceId, accountId);
    await this.prisma.twilio_accounts.update({
      where: { id: acc.id },
      data: { deleted_at: new Date() },
    });
    return { success: true };
  }

  // ─── SMS ────────────────────────────────────────────────────────────

  /**
   * Send an outbound SMS via Twilio. Persists into twilio_messages. The
   * upstream call uses HTTP Basic Auth with the account SID + auth token.
   */
  async sendSms(
    workspaceId: bigint,
    senderId: bigint,
    accountId: bigint,
    payload: { to: string; from: string; text: string; contact_id?: string },
  ) {
    if (!payload?.to || !payload?.from || !payload?.text) {
      throw new BadRequestException('to + from + text are required');
    }
    const acc = await this.requireAccount(workspaceId, accountId);
    if (!acc.twilio_auth_token) {
      throw new BadRequestException('Account is missing auth token');
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${acc.twilio_account_sid}/Messages.json`;
    const form = new URLSearchParams();
    form.append('To', payload.to);
    form.append('From', payload.from);
    form.append('Body', payload.text);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(`${acc.twilio_account_sid}:${acc.twilio_auth_token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new BadRequestException(`Twilio: ${data?.message ?? 'send failed'}`);
    }

    // Find/create chat + persist message (best-effort — only if contact provided)
    let chat = await this.prisma.twilio_chats.findFirst({
      where: { twilio_account_id: acc.id, mobile_number: payload.to } as any,
    });
    if (!chat && payload.contact_id) {
      chat = await this.prisma.twilio_chats.create({
        data: {
          twilio_account_id: acc.id,
          contact_id: BigInt(payload.contact_id),
          mobile_number: payload.to,
        } as any,
      });
    }
    let message: any = null;
    if (chat) {
      message = await this.prisma.twilio_messages.create({
        data: {
          twilio_chat_id: chat.id,
          user_id: senderId,
          text: payload.text,
          direction: 'OUTGOING' as any,
          status: data.status ?? 'queued',
          url: data.uri ?? null,
        } as any,
      });
    }
    return { success: true, upstream: data, message };
  }

  // ─── Call Logs ──────────────────────────────────────────────────────

  async listCallLogs(workspaceId: bigint, filters: { limit?: number; offset?: number } = {}) {
    const accounts = await this.prisma.twilio_accounts.findMany({
      where: { workspace_id: workspaceId, deleted_at: null },
      select: { id: true },
    });
    const accountIds = accounts.map((a) => a.id);
    if (accountIds.length === 0) return { logs: [], total: 0 };

    const take = Math.min(filters.limit ?? 50, 200);
    const skip = filters.offset ?? 0;

    const [logs, total] = await Promise.all([
      this.prisma.twilio_call_logs.findMany({
        where: { twilio_account_id: { in: accountIds } },
        orderBy: { id: 'desc' },
        take,
        skip,
      }),
      this.prisma.twilio_call_logs.count({
        where: { twilio_account_id: { in: accountIds } },
      }),
    ]);
    return { logs, total, limit: take, offset: skip };
  }

  /**
   * Record a Twilio CallStatus webhook into twilio_call_logs. Called by the
   * webhooks-inbound handler for provider='twilio' when path/type indicates
   * a voice event (rather than a Messages incoming).
   */
  async recordCallLog(payload: any) {
    if (!payload?.CallSid) return null;
    const accountSid: string | undefined = payload.AccountSid;
    let twilioAccountId: bigint | null = null;
    if (accountSid) {
      const acc = await this.prisma.twilio_accounts.findFirst({
        where: { twilio_account_sid: accountSid, deleted_at: null },
      });
      if (acc) twilioAccountId = acc.id;
    }
    if (!twilioAccountId) {
      this.logger.warn(`recordCallLog: no twilio_account for SID ${accountSid}`);
      return null;
    }

    return this.prisma.twilio_call_logs.create({
      data: {
        twilio_account_id: twilioAccountId,
        call_sid: payload.CallSid,
        from_number: payload.From ?? '',
        to_number: payload.To ?? '',
        call_duration: payload.CallDuration ?? null,
        call_type: payload.Direction ?? null,
        metadata: JSON.stringify(payload),
        twilio_metadata: payload.CallStatus ?? null,
        status: payload.CallStatus ?? 'success',
      } as any,
    });
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private async requireAccount(workspaceId: bigint, accountId: bigint) {
    const acc = await this.prisma.twilio_accounts.findFirst({
      where: { id: accountId, workspace_id: workspaceId, deleted_at: null },
    });
    if (!acc) throw new NotFoundException('Twilio account not found');
    return acc;
  }
}
