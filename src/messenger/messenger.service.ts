import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MetaGraphApiClient } from '../whatsapp/meta-graph-api.client';

/**
 * Facebook Messenger channel. Each workspace can connect multiple `fb_pages`
 * via Meta OAuth — each page's `access_token` is what authorizes outbound DM
 * sends and lets us subscribe to webhook events.
 *
 * Webhook inbound is gated by the shared Meta signature in webhooks-inbound;
 * payload parsing and routing into `fb_chats` / `fb_messages` is left as a
 * follow-up step (Meta payload shape differs from WhatsApp's).
 */
@Injectable()
export class MessengerService {
  private readonly logger = new Logger(MessengerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaGraphApiClient,
  ) {}

  async listPages(workspaceId: bigint) {
    return this.prisma.fb_pages.findMany({
      where: { workspace_id: workspaceId, deleted_at: null },
      orderBy: { created_at: 'desc' },
    });
  }

  /**
   * Persist a Page after the frontend completes Meta OAuth and posts the
   * page id + access token (long-lived). Looks up the user-token's accessible
   * pages to also pull username/name when not provided.
   */
  async connectPage(workspaceId: bigint, userId: bigint, data: any) {
    if (!data?.page_id || !data?.access_token) {
      throw new BadRequestException('page_id + access_token required');
    }
    const existing = await this.prisma.fb_pages.findFirst({
      where: { workspace_id: workspaceId, page_id: data.page_id },
    });
    if (existing) {
      return this.prisma.fb_pages.update({
        where: { id: existing.id },
        data: {
          access_token: data.access_token,
          name: data.name ?? existing.name,
          username: data.username ?? existing.username,
          status: 'ACTIVE' as any,
          updated_at: new Date(),
        },
      });
    }
    return this.prisma.fb_pages.create({
      data: {
        workspace_id: workspaceId,
        user_id: userId,
        page_id: data.page_id,
        access_token: data.access_token,
        name: data.name ?? null,
        username: data.username ?? null,
        status: 'ACTIVE' as any,
        auto_reply_interval: '247',
        created_at: new Date(),
        updated_at: new Date(),
      } as any,
    });
  }

  async disconnectPage(workspaceId: bigint, pageId: bigint) {
    const page = await this.requirePage(workspaceId, pageId);
    await this.prisma.fb_pages.update({
      where: { id: page.id },
      data: { status: 'INACTIVE' as any, updated_at: new Date() } as any,
    });
    return { success: true };
  }

  /**
   * Send a DM to a recipient PSID on a Messenger Page using the page's access
   * token. Persistence into `fb_messages` should resolve the local `fb_chats`
   * row — left as a follow-up since chat-creation has cross-cutting contact
   * resolution logic.
   */
  async sendMessage(
    workspaceId: bigint,
    pageId: bigint,
    payload: { recipient_psid: string; text: string },
  ) {
    if (!payload?.recipient_psid || !payload?.text) {
      throw new BadRequestException('recipient_psid + text required');
    }
    const page = await this.requirePage(workspaceId, pageId);
    const res = await this.meta.sendMessengerMessage(page.access_token, {
      recipient: { id: payload.recipient_psid },
      message: { text: payload.text },
    });
    return { success: true, upstream: res };
  }

  private async requirePage(workspaceId: bigint, pageId: bigint) {
    const page = await this.prisma.fb_pages.findFirst({
      where: { id: pageId, workspace_id: workspaceId, deleted_at: null },
    });
    if (!page) throw new NotFoundException('Facebook page not found');
    return page;
  }
}
