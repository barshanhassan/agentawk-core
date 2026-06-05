// @ts-nocheck
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from './chat.gateway';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RabbitMqService } from '../rabbitmq/rabbitmq.service';

@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chatGateway: ChatGateway,
    private readonly eventEmitter: EventEmitter2,
    private readonly rabbit: RabbitMqService,
    private readonly config: ConfigService,
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
    } else if (status === 'all' || !status) {
      // "All" tab on the frontend sends status=undefined; treat that the same as
      // an explicit 'all' — every non-deleted thread regardless of assignment.
      // Without this branch, undefined would fall through to the ACTIVE default
      // and UNASSIGNED rows (every newly-arrived WhatsApp chat) would vanish from
      // the inbox list.
      where.status = { not: 'DELETED' };
    } else {
      // Unknown explicit status value — fall back to ACTIVE for safety.
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

            // Pull the contact's mobile number so the inbox card has something to
            // show next to the name (Conversation.phoneNumber in the frontend).
            // Workspace-scoped + matching the chat's channel (e.g. type='whatsapp').
            const channelType = mType?.toLowerCase().includes('whatsapp')
              ? 'whatsapp'
              : mType?.toLowerCase().includes('telegram')
              ? 'telegram'
              : mType?.toLowerCase().includes('insta')
              ? 'instagram'
              : null;
            if (channelType) {
              const mobile = await this.prisma.contact_mobiles.findFirst({
                where: {
                  modelable_type: 'App\\Models\\Contact',
                  modelable_id: chat.contact_id,
                  ownership_type: 'App\\Models\\Workspace',
                  ownership_id: inbox.workspace_id,
                  type: channelType,
                },
                orderBy: { is_primary: 'desc' },
              });
              if (mobile && item.contacts) {
                item.contacts.mobile_number = mobile.full_mobile_number ?? null;
              }
            }
          }

          // Last message snippet for the inbox card. contact_last_messages is
          // already keyed by (chatable_type, chatable_id) so a single query
          // gives us the most recent line of the conversation.
          if (mType && mId) {
            const lastMsg = await this.prisma.contact_last_messages.findFirst({
              where: { chatable_type: mType, chatable_id: mId },
              orderBy: { created_at: 'desc' },
              select: { message: true, message_type: true, created_at: true },
            });
            item.last_message_text = lastMsg?.message ?? null;
            item.last_message_type = lastMsg?.message_type ?? null;
          }

          // Unread count proxy: inbox.is_read is 0 when an inbound message has
          // landed since the user last opened the thread. A precise per-message
          // read tracker ships in a later phase.
          item.unread_count = inbox.is_read === 0 ? 1 : 0;
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
    // Frontend (ConversationsInbox.tsx) sends `message_text`; older callers
    // used `text` / `message`. Accept all three so the body never silently
    // empties out.
    const text = data.message_text ?? data.text ?? data.message ?? '';

    this.logger.log(`Processing outgoing message for inbox ${inboxId} (Type: ${type}, ID: ${modelableId})`);

    if (!String(text).trim()) {
      throw new BadRequestException('Message body is empty — provide message_text/text');
    }

    let savedMessage = null;

    try {
      const lowerType = type.toLowerCase();
      if (lowerType.includes('whatsappchat')) {
        // Replyagent-mirror flow:
        //   1. wa_chats → wa_phone_numbers → wa_accounts (need wa_id + Meta phone_number_id + Mongo meta_account_id)
        //   2. wa_messages row at status='pending' (so the chat UI shows the bubble immediately)
        //   3. Publish WA_OUTBOUND_MESSAGE on ra/whatsapp — microservice calls Meta
        //   4. Microservice echoes WA_OUTBOUND_MESSAGE_STATUS → consumer updates row to sent/failed
        const chat = await this.prisma.wa_chats.findUnique({
          where: { id: modelableId },
        });
        if (!chat) {
          this.logger.error(`No wa_chats record found for ID ${modelableId}`);
          throw new NotFoundException('WhatsApp chat not found');
        }
        const phone = await this.prisma.wa_phone_numbers.findUnique({
          where: { id: chat.wa_number_id },
        });
        if (!phone) {
          throw new NotFoundException('WhatsApp phone number not found for this chat');
        }
        const account = await this.prisma.wa_accounts.findUnique({
          where: { id: chat.wa_account_id },
        });
        if (!account) {
          throw new NotFoundException('WhatsApp account not found for this chat');
        }
        if (!account.meta_account_id) {
          throw new BadRequestException(
            'WhatsApp account is not registered with the microservice yet (meta_account_id missing). Re-run "Connect Manually" on the WhatsApp settings page so registration completes.',
          );
        }

        this.logger.log(
          `Found chat for WhatsApp. chat_id=${chat.id.toString()}, wa_id=${chat.wa_id}, meta_account_id=${account.meta_account_id}`,
        );

        const sentAt = new Date();
        savedMessage = await this.prisma.wa_messages.create({
          data: {
            wa_chat_id: modelableId,
            wa_number_id: chat.wa_number_id,
            sender_id: userId,
            text: text,
            direction: 'OUTGOING',
            type: 'text',
            mobile_number: chat.wa_id || '',
            status: 'pending',
            // Schema has created_at/updated_at as nullable with NO default. If we
            // skip them, the chat list (which sorts by created_at ASC) treats
            // these rows as NULL and renders them at the TOP instead of the
            // bottom — outbound messages appear above the recipient's reply.
            created_at: sentAt,
            updated_at: sentAt,
          },
        });

        const exchange = this.config.get<string>('RABBITMQ_EXCHANGE') || 'ra';
        const whatsappQueue = this.config.get<string>('RABBITMQ_WHATSAPP_QUEUE') || 'whatsapp';
        try {
          await this.rabbit.publish(exchange, whatsappQueue, {
            event: 'WA_OUTBOUND_MESSAGE',
            payload: {
              accountId: account.meta_account_id,
              phoneNumberId: phone.wa_number_id,
              context: {
                messaging_product: 'whatsapp',
                to: chat.wa_id,
                type: 'text',
                text: { body: text },
              },
              // Correlation tag — comes back via WA_OUTBOUND_MESSAGE_STATUS so the
              // consumer can flip THIS row to sent/failed instead of guessing.
              meta: {
                backend_wa_message_id: savedMessage.id.toString(),
                backend_inbox_id: inboxId.toString(),
                workspace_id: account.workspace_id.toString(),
              },
            },
          });
          this.logger.log(
            `WA_OUTBOUND_MESSAGE published for wa_message_id=${savedMessage.id} inbox=${inboxId}`,
          );
        } catch (err: any) {
          // Don't lose the row — mark it failed locally so the user sees a ❌.
          await this.prisma.wa_messages.update({
            where: { id: savedMessage.id },
            data: { status: 'failed', error_data: String(err?.message ?? err) },
          });
          throw new BadRequestException(
            `Could not queue WhatsApp message: ${err?.message ?? err}`,
          );
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

      this.logger.log(`Message persisted for inbox ${inboxId} (channel: ${type})`);

      // Real-time emission so the open chat updates instantly. For WhatsApp the
      // bubble shows status='pending' until WA_OUTBOUND_MESSAGE_STATUS flips it.
      this.chatGateway.emitToWorkspace(inbox.workspace_id, 'new_message', {
        inbox_id: inboxId.toString(),
        message: savedMessage,
      });

      return {
        success: true,
        status: savedMessage?.status ?? 'sent',
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

    // Defensive coercion — `inbox_id` arrives from req.params (string) and
    // `assigned_to` arrives from req.body (could be string, number, or even
    // the literal "Me" sentinel the frontend sends when picking the current
    // user). `BigInt()` on any non-numeric value throws, so we stringify-then-
    // try once and treat anything we can't parse as "assign to me".
    const inboxIdBig = this.toBigIntOrNull(inbox_id);
    if (inboxIdBig === null) {
      throw new BadRequestException(`Invalid inbox_id: ${inbox_id}`);
    }

    let assignedToId: bigint | null;
    if (assigned_to === null || assigned_to === undefined || assigned_to === '') {
      assignedToId = null;
    } else if (typeof assigned_to === 'string' && assigned_to.toLowerCase() === 'me') {
      // Frontend "Assign to Me" sends the literal — resolve to the caller.
      assignedToId = userId;
    } else {
      const parsed = this.toBigIntOrNull(assigned_to);
      assignedToId = parsed ?? userId; // fall back to the caller if the value isn't a valid user id
    }

    const inbox = await this.prisma.inbox.findFirst({
      where: { id: inboxIdBig, workspace_id: workspaceId },
    });
    if (!inbox) throw new NotFoundException('Inbox not found');

    const updated = await this.prisma.inbox.update({
      where: { id: inbox.id },
      data: {
        // Use `user_id` (the schema field) — `assigned_to` doesn't exist on the inbox row.
        user_id: assignedToId,
        assigned_by: userId,
        assigned_on: new Date(),
        is_assigned: assignedToId ? 1 : 0,
        status: assignedToId ? 'ACTIVE' : 'UNASSIGNED',
        updated_at: new Date(),
      },
    });

    // Fire conversation.assigned for any matching `conversation_assigned`
    // trigger activities. Contact resolution is best-effort — channel chat
    // tables hold the contact_id mapping.
    const contactId = await this.resolveInboxContact(updated);
    if (contactId) {
      this.eventEmitter.emit('conversation.assigned', {
        contactId,
        workspaceId,
        userId: assignedToId,
        inboxId: updated.id,
      });
    }

    return updated;
  }

  /**
   * Resolve the contact behind an inbox row. Walks the channel-specific chat
   * tables based on `modelable_type`. Centralised here so all the inbox
   * service methods that emit contact-scoped events resolve the same way.
   */
  private async resolveInboxContact(inbox: { modelable_type: string | null; modelable_id: bigint }): Promise<bigint | null> {
    const mType = inbox.modelable_type ?? '';
    const mId = inbox.modelable_id;
    if (!mId) return null;
    try {
      if (mType.includes('WhatsappChat')) {
        const chat = await this.prisma.wa_chats.findUnique({ where: { id: mId } });
        return chat?.contact_id ?? null;
      }
      if (mType.includes('TelegramChat')) {
        const chat = await this.prisma.telegram_chats.findUnique({ where: { id: mId } });
        return chat?.contact_id ?? null;
      }
      if (mType.includes('FacebookChat')) {
        const chat = await this.prisma.fb_chats.findUnique({ where: { id: mId } });
        return chat?.contact_id ?? null;
      }
      if (mType.includes('InstagramChat') || mType.includes('InstaChat')) {
        const chat = await this.prisma.insta_chats.findUnique({ where: { id: mId } });
        return chat?.contact_id ?? null;
      }
      if (mType.includes('WebchatChat') || mType.includes('WcChat')) {
        const chat = await this.prisma.wc_chats.findUnique({ where: { id: mId } });
        return chat?.contact_id ?? null;
      }
      if (mType.includes('App\\Models\\Contact')) {
        return mId;
      }
    } catch {}
    return null;
  }

  /**
   * Try to convert an unknown value to a BigInt. Returns null on anything
   * non-numeric (including objects, NaN, empty strings, the literal "Me",
   * or already-BigInt values that re-coerce cleanly).
   */
  private toBigIntOrNull(v: any): bigint | null {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'bigint') return v;
    try {
      const str = String(v).trim();
      if (!/^-?\d+$/.test(str)) return null;
      return BigInt(str);
    } catch {
      return null;
    }
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
    const updated = await this.prisma.inbox.update({
      where: { id: inboxId, workspace_id: workspaceId },
      data: { status },
    });

    // When a conversation is marked done, fire the trigger event so any
    // `conversation_marked_as_done` automation activities can dispatch.
    if (status === 'COMPLETED') {
      const contactId = await this.resolveInboxContact(updated);
      if (contactId) {
        this.eventEmitter.emit('conversation.marked_as_done', {
          contactId,
          workspaceId,
          inboxId: updated.id,
        });
      }
    }

    return updated;
  }

  /** List conversation folders for a workspace (does NOT create — mirrors replyagent's getSettings folders). */
  async listFolders(workspaceId: bigint) {
    return this.prisma.inbox_folders.findMany({
      where: { workspace_id: workspaceId },
      orderBy: { id: 'asc' },
    });
  }

  async createFolder(
    workspaceId: bigint,
    data: { name: string; assign_to?: string | null; assigned_to?: bigint | null },
  ) {
    return this.prisma.inbox_folders.create({
      data: {
        workspace_id: workspaceId,
        name: (data.name || '').slice(0, 30),
        assign_to: data.assign_to ?? null,
        assigned_to: data.assigned_to ?? null,
      },
    });
  }

  async updateFolder(
    workspaceId: bigint,
    id: bigint,
    data: { name?: string; assign_to?: string | null; assigned_to?: bigint | null },
  ) {
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = (data.name || '').slice(0, 30);
    if (data.assign_to !== undefined) updateData.assign_to = data.assign_to ?? null;
    if (data.assigned_to !== undefined) updateData.assigned_to = data.assigned_to ?? null;
    // scoped by workspace so a tenant can't edit another workspace's folder
    return this.prisma.inbox_folders.updateMany({
      where: { id, workspace_id: workspaceId },
      data: updateData,
    });
  }

  async deleteFolder(workspaceId: bigint, id: bigint) {
    // detach conversations from the folder first so we don't orphan a folder_id
    await this.prisma.inbox.updateMany({
      where: { folder_id: id, workspace_id: workspaceId },
      data: { folder_id: null },
    });
    return this.prisma.inbox_folders.deleteMany({
      where: { id, workspace_id: workspaceId },
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
