import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MetaGraphApiClient } from '../whatsapp/meta-graph-api.client';

/**
 * Instagram DM channel. Instagram Business Accounts are linked to a Facebook
 * Page; we store one `insta_pages` row per connected account with its
 * page-level access_token + ig_user_id. Outbound DM uses the same Messenger
 * Send API (graph.facebook.com/me/messages) with the IG user's PSID.
 */
@Injectable()
export class InstagramService {
  private readonly logger = new Logger(InstagramService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaGraphApiClient,
  ) {}

  async listPages(workspaceId: bigint) {
    return this.prisma.insta_pages.findMany({
      where: { workspace_id: workspaceId, deleted_at: null } as any,
      orderBy: { created_at: 'desc' },
    });
  }

  async connectPage(workspaceId: bigint, userId: bigint, data: any) {
    if (!data?.access_token || !(data?.ig_user_id || data?.page_id)) {
      throw new BadRequestException('access_token + ig_user_id (or page_id) required');
    }
    const existing = await this.prisma.insta_pages.findFirst({
      where: {
        workspace_id: workspaceId,
        OR: [
          data.ig_user_id ? { ig_user_id: data.ig_user_id } : undefined,
          data.page_id ? { page_id: data.page_id } : undefined,
        ].filter(Boolean) as any,
      },
    });
    if (existing) {
      return this.prisma.insta_pages.update({
        where: { id: existing.id },
        data: {
          access_token: data.access_token,
          name: data.name ?? existing.name,
          username: data.username ?? existing.username,
          status: 'ACTIVE' as any,
          updated_at: new Date(),
        } as any,
      });
    }
    return this.prisma.insta_pages.create({
      data: {
        workspace_id: workspaceId,
        user_id: userId,
        access_token: data.access_token,
        ig_user_id: data.ig_user_id ?? null,
        page_id: data.page_id ?? null,
        name: data.name ?? null,
        username: data.username ?? null,
        followers_count: 0,
        follows_count: 0,
        status: 'ACTIVE' as any,
        account_type: data.account_type ?? 'BUSINESS',
        platform: 'instagram',
        auto_reply_interval: '247',
        created_at: new Date(),
        updated_at: new Date(),
      } as any,
    });
  }

  async disconnectPage(workspaceId: bigint, pageId: bigint) {
    const page = await this.requirePage(workspaceId, pageId);
    await this.prisma.insta_pages.update({
      where: { id: page.id },
      data: { status: 'INACTIVE' as any, updated_at: new Date() } as any,
    });
    return { success: true };
  }

  async sendMessage(
    workspaceId: bigint,
    pageId: bigint,
    payload: { recipient_id: string; text: string },
  ) {
    if (!payload?.recipient_id || !payload?.text) {
      throw new BadRequestException('recipient_id + text required');
    }
    const page = await this.requirePage(workspaceId, pageId);
    const res = await this.meta.sendMessengerMessage(page.access_token, {
      recipient: { id: payload.recipient_id },
      message: { text: payload.text },
    });
    return { success: true, upstream: res };
  }

  private async requirePage(workspaceId: bigint, pageId: bigint) {
    const page = await this.prisma.insta_pages.findFirst({
      where: { id: pageId, workspace_id: workspaceId, deleted_at: null } as any,
    });
    if (!page) throw new NotFoundException('Instagram page not found');
    return page;
  }
}
