// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TelegramService {
  constructor(private readonly prisma: PrismaService) {}

  async getBots(workspaceId: bigint) {
    const bots = await this.prisma.telegram_bots.findMany({
      where: { workspace_id: workspaceId, deleted_at: null },
    });
    return { bots };
  }

  async addBot(data: any, workspaceId: bigint, userId: bigint) {
    if (!data.name || !data.token)
      throw new BadRequestException('Name and token are required');

    // Check duplicate token
    const exists = await this.prisma.telegram_bots.count({
      where: { token: data.token },
    });
    if (exists > 0)
      throw new BadRequestException('This token is already in use');

    const bot = await this.prisma.telegram_bots.create({
      data: {
        workspace_id: workspaceId,
        name: data.name,
        token: data.token, // In production, encrypt with crypto
        creator_id: userId,
        updater_id: userId,
      },
    });

    return { bot };
  }

  async updateBot(
    botId: bigint,
    data: any,
    workspaceId: bigint,
    userId: bigint,
  ) {
    if (!data.name) throw new BadRequestException('Name is required');

    const bot = await this.prisma.telegram_bots.findFirst({
      where: { id: botId, workspace_id: workspaceId },
    });
    if (!bot) throw new BadRequestException('Bot not found');

    const updateData: any = { name: data.name, updater_id: userId };

    if (data.newToken) {
      const tokenExists = await this.prisma.telegram_bots.count({
        where: { token: data.newToken },
      });
      if (tokenExists > 0)
        throw new BadRequestException('This token is already in use');
      updateData.old_token = bot.token;
      updateData.token = data.newToken;
      updateData.status = 'PENDING';
    }

    const updated = await this.prisma.telegram_bots.update({
      where: { id: botId },
      data: updateData,
    });
    return { bot: updated };
  }

  async reconnectBot(botId: bigint, workspaceId: bigint) {
    const bot = await this.prisma.telegram_bots.findFirst({
      where: { id: botId, workspace_id: workspaceId },
    });
    if (!bot) throw new BadRequestException('Bot not found');

    // Stub: Telegram API reconnect
    console.log(`Stub: Reconnecting Telegram bot ${botId}`);

    await this.prisma.telegram_bots.update({
      where: { id: botId },
      data: { status: 'ACTIVE' },
    });
    const updated = await this.prisma.telegram_bots.findFirst({
      where: { id: botId },
    });
    return { bot: updated };
  }

  async deleteBot(
    botId: bigint,
    workspaceId: bigint,
    userId: bigint,
    deleteFolder?: boolean,
  ) {
    const bot = await this.prisma.telegram_bots.findFirst({
      where: { id: botId, workspace_id: workspaceId },
    });
    if (!bot) throw new BadRequestException('Bot not found');

    await this.prisma.telegram_bots.update({
      where: { id: botId },
      data: { status: 'DELETED', updater_id: userId, deleted_at: new Date() },
    });

    // Stub: delete folder/media if deleteFolder flag
    if (deleteFolder) {
      console.log(`Stub: Deleting folder for Telegram bot ${botId}`);
    }

    return {
      message:
        'Deletion is currently in process. You will be notified when it is deleted.',
    };
  }

  async updateBotUsers(
    botId: bigint,
    userIds: bigint[],
    workspaceId: bigint,
    userId: bigint,
  ) {
    const bot = await this.prisma.telegram_bots.findFirst({
      where: { id: botId, workspace_id: workspaceId },
    });
    if (!bot) throw new BadRequestException('Bot not found');

    const keepIds: bigint[] = [];
    for (const uid of userIds) {
      const existing = await this.prisma.telegram_bot_users.findFirst({
        where: { telegram_bot_id: botId, user_id: uid },
      });
      if (existing) {
        keepIds.push(existing.id);
      } else {
        const created = await this.prisma.telegram_bot_users.create({
          data: { telegram_bot_id: botId, user_id: uid },
        });
        keepIds.push(created.id);
      }
    }

    // Delete others
    await this.prisma.telegram_bot_users.deleteMany({
      where: { telegram_bot_id: botId, id: { notIn: keepIds } },
    });

    const users = await this.prisma.telegram_bot_users.findMany({
      where: { telegram_bot_id: botId },
    });
    return { users };
  }

  async updateStatus(chatId: bigint, status: string, workspaceId: bigint) {
    const chat = await this.prisma.telegram_chats.findFirst({
      where: { id: chatId, workspace_id: workspaceId },
    });
    if (!chat) throw new BadRequestException('Chat not found');

    await this.prisma.telegram_chats.update({
      where: { id: chatId },
      data: { status },
    });

    const message = status === 'UNSUBSCRIBED' ? 'Unsubscribed' : 'Subscribed';
    return { success: true, message };
  }

  /**
   * Send an outbound Telegram message via the Bot API. Resolves the bot from
   * the chat, calls the Telegram API, persists a telegram_messages row, and
   * emits the standard 'new_message' socket event so the UI updates live.
   *
   * `chatId` is the local telegram_chats.id. Telegram's own chat id is on the
   * row as `tg_chat_id`.
   */
  async sendMessage(
    chatId: bigint,
    userId: bigint,
    payload: { text?: string; type?: string; media?: any },
  ) {
    const chat = await this.prisma.telegram_chats.findUnique({ where: { id: chatId } });
    if (!chat) throw new NotFoundException('Telegram chat not found');
    const bot = await this.prisma.telegram_bots.findUnique({
      where: { id: chat.telegram_bot_id as bigint },
    });
    if (!bot || !bot.token) throw new NotFoundException('Telegram bot or token not found');

    const tgChatId = (chat as any).tg_chat_id ?? (chat as any).chat_id;
    if (!tgChatId) throw new BadRequestException('Local chat row missing tg_chat_id');

    const apiUrl = `https://api.telegram.org/bot${bot.token}/sendMessage`;
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: tgChatId,
        text: payload.text ?? '',
        parse_mode: 'HTML',
      }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      const msg = data?.description ?? `HTTP ${res.status}`;
      throw new BadRequestException(`Telegram sendMessage failed: ${msg}`);
    }

    const tgMessageId = String(data.result?.message_id ?? Date.now());
    const message = await this.prisma.telegram_messages.create({
      data: {
        telegram_chat_id: chatId,
        message_number: BigInt(Date.now()),
        user_id: userId,
        message_id: tgMessageId,
        type: payload.type ?? 'text',
        seen: true,
        direction: 'OUTGOING',
        text: payload.text ?? null,
        status: 'SENT',
      },
    });
    return { success: true, message_id: tgMessageId, message };
  }

  /**
   * Parse and persist an inbound Telegram update (webhook payload). Returns the
   * normalized info webhooks-inbound needs to forward to inbox.
   */
  async handleInboundUpdate(update: any) {
    const msg = update?.message ?? update?.edited_message;
    if (!msg) return null;
    const tgChatId = msg.chat?.id;
    if (!tgChatId) return null;

    // Find bot — Telegram doesn't include bot_id in payload, so we rely on the
    // webhook URL having a per-bot secret OR on the chat already existing.
    let chat = await this.prisma.telegram_chats.findFirst({
      where: { tg_chat_id: String(tgChatId) } as any,
    });
    if (!chat) {
      // First message — defer to the bot identification mechanism your URL
      // routing provides; for now skip silently.
      this.logger.warn(`No local chat for tg_chat_id=${tgChatId} — bot identification needed`);
      return null;
    }

    const message = await this.prisma.telegram_messages.create({
      data: {
        telegram_chat_id: chat.id,
        message_number: BigInt(Date.now()),
        message_id: String(msg.message_id),
        type: msg.text ? 'text' : msg.photo ? 'photo' : msg.document ? 'document' : 'other',
        seen: false,
        direction: 'INCOMING',
        text: msg.text ?? msg.caption ?? null,
        status: 'RECEIVED',
      },
    });

    const bot = await this.prisma.telegram_bots.findUnique({
      where: { id: chat.telegram_bot_id as bigint },
    });

    return {
      workspaceId: bot?.workspace_id,
      chatId: chat.id,
      messageId: message.id,
      contactId: (chat as any).contact_id,
    };
  }

  async messageAction(messageId: bigint, action: string) {
    if (!action) throw new BadRequestException('Action is required');

    const message = await this.prisma.telegram_messages.findFirst({
      where: { id: messageId },
    });
    if (!message) throw new BadRequestException('Message not found');

    if (action.toLowerCase() === 'delete') {
      await this.prisma.telegram_messages.delete({ where: { id: messageId } });
      // Stub: Dispatch DeleteMessage job
      console.log(`Stub: Telegram DeleteMessage job for ${messageId}`);
    }

    return { success: true };
  }

  async refreshBotPicture(botId: bigint, workspaceId: bigint) {
    const bot = await this.prisma.telegram_bots.findFirst({
      where: { id: botId, workspace_id: workspaceId },
    });
    if (!bot) throw new BadRequestException('Bot not found');

    // Stub: UpdateBotAvatar job
    console.log(`Stub: UpdateBotAvatar for bot ${botId}`);

    return { avatar: null };
  }

  async getTelegramMessage(messageId: bigint) {
    const message = await this.prisma.telegram_messages.findFirst({
      where: { id: messageId },
    });
    if (!message) throw new NotFoundException('Message not found');

    // Mark all messages in chat as seen
    if (message.telegram_chat_id) {
      await this.prisma.telegram_messages.updateMany({
        where: { telegram_chat_id: message.telegram_chat_id, seen: false },
        data: { seen: true },
      });
    }

    return message;
  }

  async updateAutoReply(botId: bigint, data: any, workspaceId: bigint) {
    const bot = await this.prisma.telegram_bots.findFirst({
      where: { id: botId, workspace_id: workspaceId },
    });
    if (!bot) throw new NotFoundException('Bot not found');

    const updateData: any = {};
    if (data.auto_reply_automation_id !== undefined) {
      updateData.auto_reply_automation_id = data.auto_reply_automation_id
        ? BigInt(data.auto_reply_automation_id)
        : null;
      updateData.auto_reply_interval = data.auto_reply_interval || '247';
    }

    const updated = await this.prisma.telegram_bots.update({
      where: { id: botId },
      data: updateData,
    });
    return { bot: updated };
  }

  async createAutoReply(data: any, workspaceId: bigint, userId: bigint) {
    if (!data.telegram_bot_id || !data.slug)
      throw new BadRequestException('telegram_bot_id and slug required');

    const bot = await this.prisma.telegram_bots.findFirst({
      where: { id: BigInt(data.telegram_bot_id), workspace_id: workspaceId },
    });
    if (!bot) throw new BadRequestException('Bot not found');

    // Create automation for auto-reply
    const automation = await this.prisma.automations.create({
      data: {
        workspace_id: workspaceId,
        creator_id: userId,
        name: `Telegram Auto Reply (${bot.name})`,
        template: data.slug,
        status: 'draft',
      },
    });

    // Create draft version
    const version = await this.prisma.automation_versions.create({
      data: {
        automation_id: automation.id,
        number: BigInt(1),
        status: 'draft',
      },
    });

    await this.prisma.automations.update({
      where: { id: automation.id },
      data: { draft_version_id: version.id },
    });

    // Create trigger step with default activity
    const triggerStep = await this.prisma.automation_steps.create({
      data: {
        automation_version_id: version.id,
        type: 'trigger',
        title: 'Starting step',
        deletable: false,
        cloneable: false,
        properties: JSON.stringify({ telegram_bot_id: bot.id }),
      },
    });

    await this.prisma.automation_step_activities.create({
      data: {
        slug: this.generateSlug(),
        step_id: triggerStep.id,
        event: 'telegram_auto_reply',
        properties: JSON.stringify({
          event: 'telegram_auto_reply',
          telegram_bot_id: bot.id,
        }),
        order: 0,
        linkable: true,
      },
    });

    // Link bot to automation
    await this.prisma.telegram_bots.update({
      where: { id: bot.id },
      data: { auto_reply_automation_id: automation.id },
    });

    return { automation };
  }

  async deleteAutoReply(botId: bigint, workspaceId: bigint) {
    const bot = await this.prisma.telegram_bots.findFirst({
      where: { id: botId, workspace_id: workspaceId },
    });
    if (!bot) throw new BadRequestException('Bot not found');

    if (bot.auto_reply_automation_id) {
      await this.prisma.automations.update({
        where: { id: bot.auto_reply_automation_id },
        data: { deleted_at: new Date() },
      });
    }

    await this.prisma.telegram_bots.update({
      where: { id: botId },
      data: { auto_reply_automation_id: null },
    });

    return { success: true };
  }

  async toggleFeeder(botId: bigint) {
    const bot = await this.prisma.telegram_bots.findFirst({
      where: { id: botId },
    });
    if (!bot) throw new NotFoundException('Bot not found');

    const newValue = !bot.allow_in_feeder;
    await this.prisma.telegram_bots.update({
      where: { id: botId },
      data: { allow_in_feeder: newValue },
    });

    return { success: true, allow_in_feeder: newValue };
  }

  private generateSlug(): string {
    return (
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15)
    );
  }
}
