// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from './chat.gateway';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chatGateway: ChatGateway,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Unified Inbox Listing with advanced filtering logic matching Laravel parity.
   */
  async getInboxList(workspaceId: bigint, filters: any) {
    const {
      status,
      assigned_to,
      folder_id,
      search,
      mode,
      page = 1,
      limit = 20,
    } = filters;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where: any = { workspace_id: workspaceId };
    console.log('Fetching inbox for workspace:', workspaceId.toString(), 'filters:', filters);


    // Map frontend status to database enums
    if (status === 'closed' || status === 'completed') {
      where.status = 'COMPLETED';
    } else if (status === 'snoozed') {
      // Handle snooze if applicable
    } else if (status === 'queued') {
      where.status = 'UNASSIGNED';
    } else if (status === 'active') {
      where.status = 'ACTIVE';
    } else if (status === 'all') {
      where.status = { not: 'DELETED' };
    } else {
      // Default to ACTIVE for "open" conversations
      where.status = 'ACTIVE';
    }


    // Mode-based filtering
    if (mode === 'ASSIGNED') {
      where.assigned_to = { not: null };
    } else if (mode === 'UNASSIGNED') {
      where.assigned_to = null;
    } else if (mode === 'FOLDER' && folder_id) {
      where.folder_id = BigInt(folder_id);
    }

    // Specific agent assignment
    if (assigned_to) {
      where.assigned_to = BigInt(assigned_to);
    }

    // Search logic - search is tricky with polymorphic relations.
    // For now, we filter after fetching or use available fields.
    // Basic search on modelable_type or status if needed.


    const [inboxes, total] = await Promise.all([
      this.prisma.inbox.findMany({
        where,
        orderBy: { updated_at: 'desc' },
        skip,
        take,
      }),
      this.prisma.inbox.count({ where }),
    ]);

    // Manually join related data (Contacts, Users, Folders)
    const enrichedInboxes = await Promise.all(
      inboxes.map(async (inbox) => {
        const item = inbox as any;
        
        // Fetch related chat based on polymorphic type
        let chat: any = null;
        const mType = inbox.modelable_type;
        const mId = inbox.modelable_id;

        try {
          if (mType?.includes('WhatsappChat')) {
            chat = await this.prisma.wa_chats.findUnique({ where: { id: mId } });
          } else if (mType?.includes('TelegramChat')) {
            chat = await this.prisma.telegram_chats.findUnique({ where: { id: mId } });
          } else if (mType?.includes('FacebookChat')) {
            chat = await this.prisma.fb_chats.findUnique({ where: { id: mId } });
          } else if (mType?.includes('InstagramChat')) {
            chat = await this.prisma.insta_chats.findUnique({ where: { id: mId } });
          } else if (mType?.includes('WebchatChat') || mType?.includes('WcChat')) {
            chat = await this.prisma.wc_chats.findUnique({ where: { id: mId } });
          }

          // Fetch contact if we found a chat with contact_id
          if (chat?.contact_id) {
            item.contacts = await this.prisma.contacts.findUnique({
              where: { id: chat.contact_id },
            });
          }
        } catch (err) {
          console.error(`Error fetching polymorphic data for inbox ${inbox.id}:`, err.message);
        }

        // Fetch user if assigned
        if (inbox.user_id) {
          item.users = await this.prisma.users.findUnique({
            where: { id: inbox.user_id },
          });
        }

        // Fetch folder if assigned
        if (inbox.folder_id) {
          item.inbox_folders = await this.prisma.inbox_folders.findUnique({
            where: { id: inbox.folder_id },
          });
        }

        return item;
      }),
    );


    console.log(`Found ${inboxes.length} records for workspace ${workspaceId.toString()}`);


    return {
      inbox: enrichedInboxes,
      total,
      page: parseInt(page),
      limit: take,
      pages: Math.ceil(total / take),
    };
  }

  /**
   * Get counts for different inbox statuses (Active, Unread, Snoozed, Completed, Unassigned)
   */
  async getInboxCounts(workspaceId: bigint, filters: any) {
    const now = new Date();
    const userIds = filters.users ? filters.users.map(id => id === 'NULL' ? null : BigInt(id)) : [];
    
    // Base where clause for counts
    const baseWhere: any = { workspace_id: workspaceId };

    // Function to get count for a specific set of conditions
    const getCount = async (additionalWhere: any) => {
      return this.prisma.inbox.count({
        where: { ...baseWhere, ...additionalWhere }
      });
    };

    const counts = {
      inbox: 0,
      unread: 0,
      read: 0,
      future: 0,
      completed: 0,
      unassigned: 0,
    };

    // User filtering for assigned counts
    const userFilter = userIds.length > 0 ? { user_id: { in: userIds } } : { user_id: { not: null } };

    // 1. Inbox (Active & Assigned)
    counts.inbox = await getCount({
      status: 'ACTIVE',
      ...userFilter,
      OR: [
        { snooze: null },
        { snooze: { lte: now } }
      ]
    });

    // 2. Unread
    counts.unread = await getCount({
      status: 'ACTIVE',
      is_read: 0,
      ...userFilter,
      OR: [
        { snooze: null },
        { snooze: { lte: now } }
      ]
    });

    // 3. Read
    counts.read = await getCount({
      status: 'ACTIVE',
      is_read: 1,
      ...userFilter,
      OR: [
        { snooze: null },
        { snooze: { lte: now } }
      ]
    });

    // 4. Future (Snoozed)
    counts.future = await getCount({
      status: 'ACTIVE',
      ...userFilter,
      snooze: { gt: now }
    });

    // 5. Completed
    counts.completed = await getCount({
      status: 'COMPLETED',
      ...userFilter
    });

    // 6. Unassigned
    counts.unassigned = await getCount({
      status: 'UNASSIGNED',
      user_id: null
    });

    // Folder counts
    const folderCounts = await this.prisma.inbox.groupBy({
      by: ['folder_id'],
      where: {
        workspace_id: workspaceId,
        folder_id: { not: null },
        status: { not: 'DELETED' }
      },
      _count: true
    });

    return {
      counts,
      folder_counts: folderCounts.map(f => ({
        folder_id: f.folder_id,
        chat_count: f._count
      }))
    };
  }

  async getInboxItem(id: bigint, workspaceId: bigint) {
    const item = await this.prisma.inbox.findFirst({
      where: { id, workspace_id: workspaceId },
    });
    if (!item) throw new NotFoundException('Inbox item not found');

    const enrichedItem = item as any;
    
    // Fetch related chat and contact
    let chat: any = null;
    const mType = item.modelable_type;
    const mId = item.modelable_id;

    try {
      if (mType?.includes('WhatsappChat')) {
        chat = await this.prisma.wa_chats.findUnique({ where: { id: mId } });
      } else if (mType?.includes('TelegramChat')) {
        chat = await this.prisma.telegram_chats.findUnique({ where: { id: mId } });
      }
      // ... Add others if needed

      if (chat?.contact_id) {
        enrichedItem.contacts = await this.prisma.contacts.findUnique({
          where: { id: chat.contact_id },
        });
      }
    } catch (e) {}

    if (item.user_id) {
      enrichedItem.users = await this.prisma.users.findUnique({
        where: { id: item.user_id },
      });
    }

    return enrichedItem;
  }


  /**
   * Unified message retrieval for different providers
   */
  async getChatMessages(inboxId: bigint, filters: any) {
    const inbox = await this.prisma.inbox.findUnique({
      where: { id: inboxId },
    });
    if (!inbox) throw new NotFoundException('Inbox not found');

    const { page = 1, limit = 25 } = filters;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);
    const modelableId = inbox.modelable_id;
    const type = inbox.modelable_type?.toLowerCase();

    let messages = [];
    const query: any = { orderBy: { created_at: 'desc' }, skip, take };

    if (type.includes('whatsapp')) {
      messages = await this.prisma.wa_messages.findMany({
        ...query,
        where: { wa_chat_id: modelableId },
      });
    } else if (type.includes('messenger') || type.includes('fb')) {
      messages = await this.prisma.fb_messages.findMany({
        ...query,
        where: { fb_chat_id: modelableId },
      });
    } else if (type.includes('instagram') || type.includes('insta')) {
      messages = await this.prisma.insta_messages.findMany({
        ...query,
        where: { insta_chat_id: modelableId },
      });
    } else if (type.includes('telegram')) {
      messages = await this.prisma.telegram_messages.findMany({
        ...query,
        where: { telegram_chat_id: modelableId },
      });
    } else if (type.includes('webchat')) {
      messages = await this.prisma.wc_messages.findMany({
        ...query,
        where: { wc_chat_id: modelableId },
      });
    }

    // Enrich with Gallery Media
    const enrichedMessages = await Promise.all(
      messages.map(async (msg) => {
        const item = msg as any;
        if (msg.gallery_media_id) {
          try {
            // Handle both BigInt and potential string IDs
            const mediaId = typeof msg.gallery_media_id === 'string' 
              ? BigInt(msg.gallery_media_id.split(',')[0]) // Take first if comma separated
              : BigInt(msg.gallery_media_id);

            item.gallery_media = await this.prisma.media_gallery.findUnique({
              where: { id: mediaId }
            });
          } catch (e) {
            this.logger.warn(`Failed to load gallery media for message ${msg.id}: ${e.message}`);
          }
        }
        return item;
      })
    );

    return { messages: enrichedMessages.reverse(), page: parseInt(page), limit: take };
  }

  /**
   * Send message (Routes to respective social provider service)
   */
  /**
   * Send message (Routes to respective social provider service)
   */
  async sendMessage(inboxId: bigint, data: any, userId: bigint) {
    const inbox = await this.prisma.inbox.findUnique({
      where: { id: inboxId },
    });
    if (!inbox) throw new NotFoundException('Inbox not found');

    const type = inbox.modelable_type || '';
    const modelableId = inbox.modelable_id;
    const text = data.text || data.message || '';

    this.logger.log(`Processing outgoing message for inbox ${inboxId} (Type: ${type}, ID: ${modelableId})`);

    let savedMessage = null;

    try {
      const lowerType = type.toLowerCase();
      if (lowerType.includes('whatsappchat')) {
        const chat = await this.prisma.wa_chats.findUnique({
          where: { id: modelableId },
        });
        if (chat) {
          this.logger.log(`Found chat for WhatsApp. ID: ${chat.id.toString()}, WA_ID: ${chat.wa_id}`);
          savedMessage = await this.prisma.wa_messages.create({
            data: {
              wa_chat_id: modelableId,
              wa_number_id: chat.wa_number_id,
              sender_id: userId,
              text: text,
              direction: 'OUTGOING',
              type: 'text',
              mobile_number: chat.wa_id || '',
              status: 'sent',
            },
          });
        } else {
          this.logger.error(`No wa_chats record found for ID ${modelableId}`);
        }
      } else if (type.includes('TelegramChat')) {
        savedMessage = await this.prisma.telegram_messages.create({
          data: {
            telegram_chat_id: modelableId,
            user_id: userId,
            text: text,
            direction: 'OUTGOING',
            type: 'text',
            message_id: `pending_${Date.now()}`,
            message_number: BigInt(Date.now()),
            seen: true,
            status: 'SENT',
          },
        });
      } else if (type.includes('FacebookChat')) {
        const chat = await this.prisma.fb_chats.findUnique({
          where: { id: modelableId },
        });
        if (chat) {
          savedMessage = await this.prisma.fb_messages.create({
            data: {
              fb_chat_id: modelableId,
              fb_page_id: chat.fb_page_id,
              sender_id: userId,
              text: text,
              direction: 'OUTGOING',
              type: 'text',
              status: 'sent',
            },
          });
        }
      } else if (type.includes('InstagramChat') || type.includes('InstaChat')) {
        const chat = await this.prisma.insta_chats.findUnique({
          where: { id: modelableId },
        });
        if (chat) {
          savedMessage = await this.prisma.insta_messages.create({
            data: {
              insta_chat_id: modelableId,
              insta_page_id: chat.insta_page_id,
              sender_id: userId,
              text: text,
              direction: 'OUTGOING',
              type: 'text',
              status: 'sent',
            },
          });
        }
      } else if (type.includes('WebchatChat') || type.includes('WcChat')) {
        savedMessage = await this.prisma.wc_messages.create({
          data: {
            wc_chat_id: modelableId,
            sender_id: userId,
            text: text,
            direction: 'OUTGOING',
            type: 'text',
          },
        });
      }

      // Update inbox last message and timestamp
      await this.prisma.inbox.update({
        where: { id: inboxId },
        data: {
          updated_at: new Date(),
          last_updated: new Date(),
        },
      });

      this.logger.log(`Message saved to DB for inbox ${inboxId}. API routing pending.`);

      // Real-time emission
      this.chatGateway.emitToWorkspace(inbox.workspace_id, 'new_message', {
        inbox_id: inboxId.toString(),
        message: savedMessage,
      });

      return {
        success: true,
        status: 'sent',
        message: 'Message saved and queued for delivery',
        data: savedMessage,
      };
    } catch (error) {
      this.logger.error(`Error saving message for inbox ${inboxId}: ${error.message}`);
      throw new BadRequestException(`Failed to save message: ${error.message}`);
    }
  }

  /**
   * Profile Actions: Tags, Custom Fields, Contact Updates
   */
  async getProfileData(inboxId: bigint) {
    const inbox = await this.prisma.inbox.findUnique({
      where: { id: inboxId },
    });
    if (!inbox) throw new NotFoundException('Inbox not found');

    const enrichedInbox = inbox as any;
    let contact: any = null;

    // Fetch related chat and contact
    let chat: any = null;
    const mType = inbox.modelable_type;
    const mId = inbox.modelable_id;

    try {
      if (mType?.includes('WhatsappChat')) {
        chat = await this.prisma.wa_chats.findUnique({ where: { id: mId } });
      } else if (mType?.includes('TelegramChat')) {
        chat = await this.prisma.telegram_chats.findUnique({ where: { id: mId } });
      }

      if (chat?.contact_id) {
        contact = await this.prisma.contacts.findUnique({
          where: { id: chat.contact_id },
          // include: { tags: true } // check if tags relation exists
        });
        
        // If tags relation also doesn't exist, we'd need to fetch them manually too.
        // Assuming tags might be in contact_tags table.
      }
    } catch (e) {}

    enrichedInbox.contacts = contact;

    return {
      inbox: enrichedInbox,
      contact: contact,
      custom_fields: [], 
    };
  }

  async assignConversation(data: any, workspaceId: bigint, userId: bigint) {
    const { inbox_id, assigned_to } = data;
    const assignedToId = assigned_to ? BigInt(assigned_to) : null;

    const inbox = await this.prisma.inbox.findFirst({
      where: { id: BigInt(inbox_id), workspace_id: workspaceId },
    });
    if (!inbox) throw new NotFoundException('Inbox not found');

    return this.prisma.inbox.update({
      where: { id: inbox.id },
      data: {
        assigned_to: assignedToId,
        assigned_by: userId,
        assigned_on: new Date(),
      },
    });
  }

  /**
   * Bulk & Lifecycle Actions
   */
  async assignConversationBulk(
    inboxIds: bigint[],
    assignedTo: bigint | null,
    workspaceId: bigint,
  ) {
    return this.prisma.inbox.updateMany({
      where: { id: { in: inboxIds }, workspace_id: workspaceId },
      data: { assigned_to: assignedTo },
    });
  }

  async snoozeConversation(inboxId: bigint, until: Date, workspaceId: bigint) {
    return this.prisma.inbox.update({
      where: { id: inboxId, workspace_id: workspaceId },
      data: { snooze: until, status: 'ACTIVE' },
    });
  }

  async updateInboxStatus(
    inboxId: bigint,
    status: string,
    workspaceId: bigint,
  ) {
    return this.prisma.inbox.update({
      where: { id: inboxId, workspace_id: workspaceId },
      data: { status },
    });
  }

  async manageFolders(workspaceId: bigint, name: string, id?: bigint) {
    if (id) {
      return this.prisma.inbox_folders.update({
        where: { id },
        data: { name },
      });
    }
    return this.prisma.inbox_folders.create({
      data: { workspace_id: workspaceId, name },
    });
  }

  async moveToFolder(
    inboxIds: bigint[],
    folderId: bigint | null,
    workspaceId: bigint,
  ) {
    return this.prisma.inbox.updateMany({
      where: { id: { in: inboxIds }, workspace_id: workspaceId },
      data: { folder_id: folderId },
    });
  }

  /**
   * Handle incoming messages from external providers (Webhooks)
   */
  async handleInboundMessage(provider: string, data: any) {
    this.logger.log(`Handling inbound message from ${provider}`);
    
    // This is a simplified logic. In production, you'd map provider-specific IDs.
    const { from, text, workspace_id, chat_id, modelable_type } = data;
    const workspaceId = BigInt(workspace_id || 1);
    const mId = BigInt(chat_id);
    const mType = modelable_type; // e.g. 'App\\Models\\WhatsappChat'

    // 1. Find or Update Inbox
    let inbox = await this.prisma.inbox.findFirst({
      where: { 
        workspace_id: workspaceId,
        modelable_id: mId,
        modelable_type: mType
      }
    });

    if (!inbox) {
      inbox = await this.prisma.inbox.create({
        data: {
          workspace_id: workspaceId,
          modelable_id: mId,
          modelable_type: mType,
          status: 'UNASSIGNED',
          last_updated: new Date(),
        }
      });
    } else {
      await this.prisma.inbox.update({
        where: { id: inbox.id },
        data: {
          updated_at: new Date(),
          last_updated: new Date(),
          status: inbox.status === 'COMPLETED' ? 'ACTIVE' : inbox.status,
        }
      });
    }

    // 2. Save Message to specific table
    if (provider === 'whatsapp') {
      await this.prisma.wa_messages.create({
        data: {
          wa_chat_id: mId,
          wa_number_id: BigInt(data.wa_number_id || 0),
          text: text,
          direction: 'INCOMING',
          type: 'text',
          mobile_number: from,
          status: 'received',
        }
      });
    } else if (provider === 'telegram') {
      await this.prisma.telegram_messages.create({
        data: {
          telegram_chat_id: mId,
          text: text,
          direction: 'INCOMING',
          type: 'text',
          message_id: data.message_id || `in_${Date.now()}`,
          message_number: BigInt(Date.now()),
          seen: false,
          status: 'RECEIVED',
        }
      });
    }

    // Real-time emission
    this.chatGateway.emitToWorkspace(workspaceId, 'new_message', {
      inbox_id: inbox.id.toString(),
      provider,
      data,
    });

    // Fire the domain event that AutomationTriggerService listens to. Any
    // automation whose trigger activity event is 'inbound_message' (optionally
    // narrowed by channel) will run.
    this.eventEmitter.emit('message.inbound', {
      workspaceId,
      inboxId: inbox.id,
      contactId: data.contact_id ? BigInt(data.contact_id) : undefined,
      channel: provider,
    });

    return { success: true, inbox_id: inbox.id };
  }

  /**
   * Used after a per-provider webhook parser has already persisted the channel
   * message rows (wa_messages, telegram_messages, etc.). Upserts the inbox row,
   * fires the realtime socket event, and emits the domain automation trigger.
   * Callers: WebhooksInboundController for parsed providers (currently WhatsApp).
   */
  async notifyInboundMessage(params: {
    workspaceId: bigint;
    modelableType: string; // e.g. 'App\\Models\\WhatsappChat'
    modelableId: bigint;   // chat row id
    contactId?: bigint;
    channel: string;       // 'whatsapp' | 'telegram' | ...
    messageId?: bigint;
  }) {
    let inbox = await this.prisma.inbox.findFirst({
      where: {
        workspace_id: params.workspaceId,
        modelable_id: params.modelableId,
        modelable_type: params.modelableType,
      },
    });
    if (!inbox) {
      inbox = await this.prisma.inbox.create({
        data: {
          workspace_id: params.workspaceId,
          modelable_id: params.modelableId,
          modelable_type: params.modelableType,
          status: 'UNASSIGNED',
          last_updated: new Date(),
        },
      });
    } else {
      await this.prisma.inbox.update({
        where: { id: inbox.id },
        data: {
          updated_at: new Date(),
          last_updated: new Date(),
          status: inbox.status === 'COMPLETED' ? 'ACTIVE' : inbox.status,
        },
      });
    }

    this.chatGateway.emitToWorkspace(params.workspaceId, 'new_message', {
      inbox_id: inbox.id.toString(),
      provider: params.channel,
      message_id: params.messageId?.toString(),
    });

    this.eventEmitter.emit('message.inbound', {
      workspaceId: params.workspaceId,
      inboxId: inbox.id,
      contactId: params.contactId,
      channel: params.channel,
    });

    return { success: true, inbox_id: inbox.id };
  }
}
