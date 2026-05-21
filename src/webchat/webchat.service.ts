import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Webchat (embeddable live-chat widget) channel. Each workspace creates one
 * or more `wc_instances`; each instance has a unique `token` used as the
 * public widget identifier. The widget script (returned by `getEmbedScript`)
 * is what end-users paste into their site.
 *
 * Public visitor messages arrive via the widget's POST endpoint (no auth, but
 * scoped to instance token). Authenticated agent messages go through
 * /webchat/instances/:id/send-message.
 */
@Injectable()
export class WebchatService {
  private readonly logger = new Logger(WebchatService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listInstances(workspaceId: bigint) {
    return this.prisma.wc_instances.findMany({
      where: { workspace_id: workspaceId, deleted_at: null } as any,
      orderBy: { created_at: 'desc' },
    });
  }

  async saveInstance(workspaceId: bigint, userId: bigint, data: any) {
    if (!data?.name) throw new BadRequestException('name is required');
    const token = data.token ?? this.makeToken();
    if (data.id) {
      const existing = await this.prisma.wc_instances.findFirst({
        where: { id: BigInt(data.id), workspace_id: workspaceId } as any,
      });
      if (!existing) throw new NotFoundException('Webchat instance not found');
      return this.prisma.wc_instances.update({
        where: { id: existing.id },
        data: {
          name: data.name,
          publish: data.publish ?? existing.publish,
          updater_id: userId,
          updated_at: new Date(),
        } as any,
      });
    }
    return this.prisma.wc_instances.create({
      data: {
        workspace_id: workspaceId,
        name: data.name,
        token,
        publish: data.publish ?? false,
        creator_id: userId,
        updater_id: userId,
        status: 1,
        auto_reply_interval: 0,
        created_at: new Date(),
        updated_at: new Date(),
      } as any,
    });
  }

  async deleteInstance(workspaceId: bigint, instanceId: bigint) {
    const inst = await this.requireInstance(workspaceId, instanceId);
    await this.prisma.wc_instances.update({
      where: { id: inst.id },
      data: { deleted_at: new Date() } as any,
    });
    return { success: true };
  }

  /**
   * Returns a minimal HTML/JS snippet site owners paste into their pages.
   * The snippet posts visitor messages to /public/webchat/:token/messages.
   */
  async getEmbedScript(workspaceId: bigint, instanceId: bigint) {
    const inst = await this.requireInstance(workspaceId, instanceId);
    if (!inst.token) throw new BadRequestException('Instance has no public token yet');
    const base = process.env.PUBLIC_API_BASE_URL ?? '';
    const script = `<script>(function(w,d){w.EZCONN_WC={token:'${inst.token}',api:'${base}'};var s=d.createElement('script');s.async=1;s.src='${base}/uploads/webchat-widget.js';d.head.appendChild(s);})(window,document);</script>`;
    return { token: inst.token, script };
  }

  /** Agent sends a reply from inside the app. */
  async sendAgentMessage(
    workspaceId: bigint,
    senderId: bigint,
    chatId: bigint,
    payload: { text?: string; type?: string },
  ) {
    const chat = await this.prisma.wc_chats.findFirst({
      where: { id: chatId } as any,
    });
    if (!chat) throw new NotFoundException('Webchat chat not found');
    const inst = await this.prisma.wc_instances.findFirst({
      where: { id: chat.wc_instance_id, workspace_id: workspaceId } as any,
    });
    if (!inst) throw new NotFoundException('Webchat instance scope mismatch');

    return this.prisma.wc_messages.create({
      data: {
        wc_chat_id: chat.id,
        direction: 'OUTGOING' as any,
        type: payload.type ?? 'text',
        text: payload.text ?? null,
        sender_id: senderId,
        status: 'sent',
      } as any,
    });
  }

  /**
   * Public visitor → agent inbound. Called by the widget JS over a token-scoped
   * route. Creates a chat row on first message, then persists the message.
   */
  async receiveVisitorMessage(token: string, payload: { visitor_id?: string; name?: string; email?: string; text?: string }) {
    if (!token) throw new BadRequestException('token required');
    const inst = await this.prisma.wc_instances.findFirst({
      where: { token, deleted_at: null } as any,
    });
    if (!inst) throw new NotFoundException('Invalid webchat token');

    let chat = await this.prisma.wc_chats.findFirst({
      where: {
        wc_instance_id: inst.id,
        OR: [
          payload.email ? { email: payload.email } : undefined,
          payload.visitor_id ? { phone_number: payload.visitor_id } : undefined,
        ].filter(Boolean) as any,
      },
    });
    if (!chat) {
      chat = await this.prisma.wc_chats.create({
        data: {
          wc_instance_id: inst.id,
          name: payload.name ?? null,
          email: payload.email ?? null,
          phone_number: payload.visitor_id ?? null,
          is_primary: true,
        } as any,
      });
    }
    const message = await this.prisma.wc_messages.create({
      data: {
        wc_chat_id: chat.id,
        direction: 'INCOMING' as any,
        type: 'text',
        text: payload.text ?? null,
        status: 'received',
      } as any,
    });
    return { workspace_id: inst.workspace_id, chat_id: chat.id, message_id: message.id };
  }

  private async requireInstance(workspaceId: bigint, instanceId: bigint) {
    const inst = await this.prisma.wc_instances.findFirst({
      where: { id: instanceId, workspace_id: workspaceId, deleted_at: null } as any,
    });
    if (!inst) throw new NotFoundException('Webchat instance not found');
    return inst;
  }

  private makeToken() {
    return 'wc_' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  }
}
