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
      is_read,         // 0/1 — Read / Unread tabs
      is_upcoming,     // true — Upcoming tab (snooze in the future)
      channel_types,   // string[] — channels filter chips
      current_user_id, // bigint — used for the "my chats" tab (NOT a tab now, but kept for future)
    } = filters;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where: any = { workspace_id: workspaceId };

    // Map frontend status to database enums. Falling through to `not: DELETED`
    // is the "All" behaviour — every other tab sets a specific filter below.
    if (status === 'closed' || status === 'completed') {
      where.status = 'COMPLETED';
    } else if (status === 'queued') {
      where.status = 'UNASSIGNED';
    } else if (status === 'active') {
      where.status = 'ACTIVE';
    } else if (status === 'all' || !status) {
      where.status = { not: 'DELETED' };
    } else {
      where.status = 'ACTIVE';
    }

    // Read / Unread — drives the Read + Unread tabs. Accept both 0/1 and
    // boolean inputs because the frontend ships JSON `1` not `"1"`.
    if (is_read === 1 || is_read === '1' || is_read === true) {
      where.is_read = 1;
    } else if (is_read === 0 || is_read === '0' || is_read === false) {
      where.is_read = 0;
    }

    // Upcoming — snoozed conversations whose snooze datetime is still in the
    // future. Schema uses `snooze` (NOT NULL DATETIME); rows that were never
    // snoozed have snooze=1970-01-01, so `> now` cleanly excludes them.
    if (is_upcoming === true || is_upcoming === 'true') {
      where.snooze = { gt: new Date() };
    } else if (status === 'all' || !status) {
      // Hide rows currently snoozed away from the All view. Because `snooze`
      // is NOT NULL in the schema (epoch sentinel for "never snoozed"), a
      // single `<= NOW()` clause covers both never-snoozed and past-snooze
      // rows — no `{ snooze: null }` (which Prisma rejects for non-nullable).
      where.snooze = { lte: new Date() };
    }

    // Channels filter (multi-select chip row in the filter popover). Each
    // channel maps to one or more `modelable_type` patterns.
    if (Array.isArray(channel_types) && channel_types.length > 0) {
      const modelablePatterns: string[] = [];
      for (const c of channel_types) {
        const lc = String(c).toLowerCase();
        if (lc === 'whatsapp') modelablePatterns.push('WhatsappChat');
        else if (lc === 'zapi') modelablePatterns.push('ZapiChat');
        else if (lc === 'telegram') modelablePatterns.push('TelegramChat');
        else if (lc === 'messenger' || lc === 'fb' || lc === 'facebook')
          modelablePatterns.push('FbChat', 'FacebookChat');
        else if (lc === 'instagram') modelablePatterns.push('InstaChat', 'InstagramChat');
        else if (lc === 'sms') modelablePatterns.push('TwilioChat');
        else if (lc === 'webchat') modelablePatterns.push('WcChat', 'WebchatChat');
      }
      if (modelablePatterns.length) {
        where.OR = modelablePatterns.map((p) => ({
          modelable_type: { contains: p },
        }));
      }
    }

    // Mode-based filtering
    if (mode === 'ASSIGNED') {
      where.assigned_to = { not: null };
    } else if (mode === 'UNASSIGNED') {
      where.assigned_to = null;
    } else if (mode === 'FOLDER' && folder_id) {
      where.folder_id = BigInt(folder_id);
    }
    if (folder_id) {
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

    // Tab counts feed the frontend's All / Read / Unread / Queue / Upcoming /
    // Done labels. They are WORKSPACE-wide (not assigned-only) so the badges
    // match replyagent's behaviour where the chip beside each tab shows the
    // global total, not just what the current agent owns.
    //
    // `snooze` is NOT NULL in the schema (epoch sentinel = never snoozed), so
    // a plain `<= NOW()` clause covers both cases. Using `{ snooze: null }`
    // here would crash Prisma with "Argument `snooze` is missing".
    const notSnoozed = { snooze: { lte: now } };

    // 1. Inbox (ACTIVE, not snoozed) — base for the All tab
    counts.inbox = await getCount({
      status: 'ACTIVE',
      ...notSnoozed,
    });

    // 2. Unread (is_read = 0, ACTIVE, not snoozed)
    counts.unread = await getCount({
      status: 'ACTIVE',
      is_read: 0,
      ...notSnoozed,
    });

    // 3. Read (is_read = 1, ACTIVE, not snoozed)
    counts.read = await getCount({
      status: 'ACTIVE',
      is_read: 1,
      ...notSnoozed,
    });

    // 4. Future (Snoozed)
    counts.future = await getCount({
      status: 'ACTIVE',
      snooze: { gt: now },
    });

    // 5. Completed
    counts.completed = await getCount({
      status: 'COMPLETED',
    });

    // 6. Unassigned (Queue tab)
    counts.unassigned = await getCount({
      status: 'UNASSIGNED',
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

    // Compose mode comes from the Reply/Note tabs in the inbox composer.
    // Note mode persists the message as an internal annotation (type='note',
    // not dispatched to Meta) so it shows up in the chat thread without ever
    // leaving EZCONN — matches replyagent's Note tab behaviour exactly.
    const composeMode = String(data.compose_mode ?? 'reply').toLowerCase();
    const isNote = composeMode === 'note';

    // Reply-to context: when the agent used the reply-arrow on a specific
    // earlier message, the bubble id comes through here. We persist it as the
    // outgoing row's `replied_to_message_id` so the thread can render the
    // quoted-reply preview client-side, and so the customer sees the same
    // quoted reply on their end (WhatsApp `context.message_id`).
    const replyToMessageId = data.reply_to_message_id ? Number(data.reply_to_message_id) : null;

    this.logger.log(
      `Processing outgoing message for inbox ${inboxId} (Type: ${type}, ID: ${modelableId}, mode=${composeMode}${replyToMessageId ? `, reply_to=${replyToMessageId}` : ''})`,
    );

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
            // Note rows carry type='note'; the publish-to-Meta step below is
            // skipped for them so the customer never receives this content.
            type: isNote ? 'note' : 'text',
            mobile_number: chat.wa_id || '',
            // Notes are finalised immediately; outbound real messages start
            // pending and flip to sent/delivered via the consumer.
            status: isNote ? 'sent' : 'pending',
            ...(replyToMessageId ? { replied_to_message_id: replyToMessageId as any } : {}),
            created_at: sentAt,
            updated_at: sentAt,
          } as any,
        });

        // Internal notes never leave the platform — short-circuit the publish
        // step so they don't reach Meta/customer.
        if (isNote) {
          return { success: true, message: savedMessage, note: true };
        }

        const exchange = this.config.get<string>('RABBITMQ_EXCHANGE') || 'ra';
        const whatsappQueue = this.config.get<string>('RABBITMQ_WHATSAPP_QUEUE') || 'whatsapp';
        try {
          // Build the WhatsApp Cloud-API payload. When reply_to is set, attach
          // a `context.message_id` so the customer sees their original message
          // quoted above the agent's reply (native WhatsApp quoted-reply UX).
          const waContext: any = {
            messaging_product: 'whatsapp',
            to: chat.wa_id,
            type: 'text',
            text: { body: text },
          };
          if (replyToMessageId) {
            try {
              const repliedTo = await this.prisma.wa_messages.findUnique({
                where: { id: BigInt(replyToMessageId) },
                select: { wamid: true } as any,
              });
              if ((repliedTo as any)?.wamid) {
                waContext.context = { message_id: (repliedTo as any).wamid };
              }
            } catch {}
          }

          await this.rabbit.publish(exchange, whatsappQueue, {
            event: 'WA_OUTBOUND_MESSAGE',
            payload: {
              accountId: account.meta_account_id,
              phoneNumberId: phone.wa_number_id,
              context: waContext,
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

  async snoozeConversation(
    inboxId: bigint,
    until: Date | null,
    workspaceId: bigint,
  ) {
    // `null` clears the snooze (replyagent: passing schedule=null unsnoozes).
    return this.prisma.inbox.update({
      where: { id: inboxId, workspace_id: workspaceId },
      data: { snooze: until ?? new Date(0), status: 'ACTIVE' },
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

  // ─── Read receipts ────────────────────────────────────────────────

  /**
   * Mark a conversation as read (`inbox.is_read = 1`). Mirrors replyagent's
   * `POST /inbox/seen/{inbox_id}`. Sends a socket event so other open tabs of
   * the same workspace can also clear their unread badge without a refetch.
   */
  async markAsSeen(inboxId: bigint, workspaceId: bigint) {
    const inbox = await this.prisma.inbox.findFirst({
      where: { id: inboxId, workspace_id: workspaceId },
    });
    if (!inbox) throw new NotFoundException('Inbox not found');
    if (inbox.is_read === 1) return { success: true, already_read: true };
    await this.prisma.inbox.update({
      where: { id: inboxId },
      data: { is_read: 1 },
    });
    this.chatGateway.emitToWorkspace(workspaceId, 'inbox_read', {
      inbox_id: inboxId.toString(),
    });
    return { success: true };
  }

  // ─── Reactions ────────────────────────────────────────────────────

  /**
   * Add / remove a reaction on a message. Uses the existing `message_reactions`
   * table (polymorphic: `message_type` + `message_id`). Replyagent's behaviour:
   * sending the same emoji clears it; a different emoji replaces it.
   */
  async reactToMessage(
    inboxId: bigint,
    messageId: bigint,
    workspaceId: bigint,
    userId: bigint,
    body: any,
  ) {
    const inbox = await this.prisma.inbox.findFirst({
      where: { id: inboxId, workspace_id: workspaceId },
    });
    if (!inbox) throw new NotFoundException('Inbox not found');

    const messageType = body?.message_type || this.messageTypeFor(inbox.modelable_type ?? '');
    const reaction = (body?.reaction || '').toString().slice(0, 24) || null;

    const existing = await this.prisma.message_reactions.findFirst({
      where: {
        message_type: messageType,
        message_id: messageId,
        sender_id: userId,
      },
    });

    if (existing) {
      if (!reaction || existing.reaction === reaction) {
        await this.prisma.message_reactions.delete({ where: { id: existing.id } });
        return { success: true, action: 'removed' };
      }
      const updated = await this.prisma.message_reactions.update({
        where: { id: existing.id },
        data: { reaction, updated_at: new Date() },
      });
      return { success: true, action: 'updated', reaction: updated };
    }

    if (!reaction) return { success: true, action: 'noop' };
    const created = await this.prisma.message_reactions.create({
      data: {
        workspace_id: workspaceId,
        sender_id: userId,
        message_type: messageType,
        message_id: messageId,
        reaction,
        direction: 'OUTGOING',
        communication_mode: 'INBOX',
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
    return { success: true, action: 'added', reaction: created };
  }

  // ─── Reminders (24h-window WhatsApp + Telegram + Z-API) ────────────

  /**
   * Schedule a reminder by writing `remind_at` on a brand-new outbound message
   * row. The existing message cron sweep picks it up when `remind_at <= NOW()`
   * and dispatches via the regular send path. We use the channel-specific
   * message table so the reminder shows up in the chat thread just like a
   * normal message would — no separate reminders table required.
   */
  async scheduleReminder(workspaceId: bigint, userId: bigint, body: any) {
    if (!body?.inbox_id) throw new BadRequestException('inbox_id required');
    if (!body?.schedule_at) throw new BadRequestException('schedule_at required');

    const inbox = await this.prisma.inbox.findFirst({
      where: { id: BigInt(body.inbox_id), workspace_id: workspaceId },
    });
    if (!inbox) throw new NotFoundException('Inbox not found');

    const channel = String(inbox.modelable_type || '').toLowerCase();
    const allowedChannels = ['whatsapp', 'zapi', 'telegram'];
    const channelKey = allowedChannels.find((c) => channel.includes(c));
    if (!channelKey) {
      throw new BadRequestException(
        'Reminders are only available for WhatsApp, Z-API, and Telegram channels.',
      );
    }

    const remindAt = new Date(body.schedule_at);
    if (isNaN(remindAt.getTime()) || remindAt.getTime() <= Date.now()) {
      throw new BadRequestException('schedule_at must be a future timestamp');
    }

    const text = String(body.text_message || '').trim();
    if (!text && !body.template_id) {
      throw new BadRequestException('text_message or template_id required');
    }

    let messageRow: any = null;
    if (channelKey === 'whatsapp') {
      messageRow = await this.prisma.wa_messages.create({
        data: {
          wa_chat_id: inbox.modelable_id,
          wa_number_id: BigInt(0),
          sender_id: userId,
          text,
          direction: 'OUTGOING',
          type: body.template_id ? 'template' : 'text',
          mobile_number: '',
          status: 'pending',
          remind_at: remindAt,
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    } else if (channelKey === 'telegram') {
      messageRow = await this.prisma.telegram_messages.create({
        data: {
          telegram_chat_id: inbox.modelable_id,
          sender_id: userId,
          text,
          direction: 'OUTGOING',
          type: 'text',
          message_id: `rem_${Date.now()}`,
          message_number: BigInt(Date.now()),
          seen: false,
          status: 'PENDING',
          remind_at: remindAt,
        } as any,
      });
    } else if (channelKey === 'zapi') {
      messageRow = await (this.prisma as any).zapi_messages.create({
        data: {
          zapi_chat_id: inbox.modelable_id,
          sender_id: userId,
          text,
          direction: 'OUTGOING',
          type: 'text',
          status: 'pending',
          remind_at: remindAt,
        },
      });
    }

    return {
      success: true,
      message_id: messageRow?.id?.toString(),
      channel: channelKey,
      remind_at: remindAt,
    };
  }

  /** Move a scheduled reminder's `remind_at` to NOW so the cron picks it up immediately. */
  async sendReminderNow(workspaceId: bigint, body: any) {
    if (!body?.message_id || !body?.channel) {
      throw new BadRequestException('message_id and channel are required');
    }
    const channel = String(body.channel).toLowerCase();
    const id = BigInt(body.message_id);
    if (channel === 'whatsapp') {
      await this.prisma.wa_messages.update({
        where: { id },
        data: { remind_at: new Date() },
      });
    } else if (channel === 'telegram') {
      await this.prisma.telegram_messages.update({
        where: { id },
        data: { remind_at: new Date() } as any,
      });
    } else if (channel === 'zapi') {
      await (this.prisma as any).zapi_messages.update({
        where: { id },
        data: { remind_at: new Date() },
      });
    } else {
      throw new BadRequestException('Unsupported channel');
    }
    return { success: true };
  }

  /** Cancel a scheduled reminder by deleting the pending message row. */
  async cancelReminder(workspaceId: bigint, body: any) {
    if (!body?.message_id || !body?.channel) {
      throw new BadRequestException('message_id and channel are required');
    }
    const channel = String(body.channel).toLowerCase();
    const id = BigInt(body.message_id);
    if (channel === 'whatsapp') {
      await this.prisma.wa_messages.deleteMany({
        where: { id, status: 'pending' },
      });
    } else if (channel === 'telegram') {
      await this.prisma.telegram_messages.deleteMany({
        where: { id, status: 'PENDING' } as any,
      });
    } else if (channel === 'zapi') {
      await (this.prisma as any).zapi_messages.deleteMany({
        where: { id, status: 'pending' },
      });
    } else {
      throw new BadRequestException('Unsupported channel');
    }
    return { success: true };
  }

  // ─── Automate / start-chat / AI ────────────────────────────────────

  /**
   * Trigger an automation/Smart Flow against the conversation's contact. The
   * AutomationProcessor is the source of truth — we just dispatch an event the
   * processor listens for. Mirrors replyagent's `POST /inbox/automate`.
   */
  async automate(workspaceId: bigint, userId: bigint, body: any) {
    if (!body?.inbox_id || !body?.automation_id) {
      throw new BadRequestException('inbox_id and automation_id required');
    }
    const inbox = await this.prisma.inbox.findFirst({
      where: { id: BigInt(body.inbox_id), workspace_id: workspaceId },
    });
    if (!inbox) throw new NotFoundException('Inbox not found');
    const contactId = await this.resolveInboxContact(inbox);
    if (!contactId) throw new BadRequestException('Inbox has no resolvable contact');
    this.eventEmitter.emit('automation.manual_trigger', {
      workspaceId,
      userId,
      contactId,
      automationId: BigInt(body.automation_id),
      inboxId: inbox.id,
    });
    return { success: true };
  }

  /**
   * Open (or reuse) a WhatsApp conversation with a contact. Creates the
   * `wa_chats` row if missing, then upserts the inbox row so the new chat
   * shows up in the agent's list immediately.
   */
  async startWhatsappChat(workspaceId: bigint, userId: bigint, body: any) {
    if (!body?.contact_id) throw new BadRequestException('contact_id required');
    if (!body?.wa_account_id || !body?.wa_number_id) {
      throw new BadRequestException('wa_account_id and wa_number_id required');
    }
    const contactId = BigInt(body.contact_id);
    const waAccountId = BigInt(body.wa_account_id);
    const waNumberId = BigInt(body.wa_number_id);

    const mobile = await this.prisma.contact_mobiles.findFirst({
      where: {
        modelable_type: 'App\\Models\\Contact',
        modelable_id: contactId,
      },
      orderBy: [{ is_primary: 'desc' }],
    });
    const waId = String(mobile?.full_mobile_number ?? mobile?.mobile_number ?? '').replace(/[^0-9]/g, '');
    if (!waId) throw new BadRequestException('Contact has no phone number');

    let chat = await this.prisma.wa_chats.findFirst({
      where: { wa_account_id: waAccountId, wa_number_id: waNumberId, wa_id: waId },
    });
    if (!chat) {
      chat = await this.prisma.wa_chats.create({
        data: {
          wa_account_id: waAccountId,
          wa_number_id: waNumberId,
          contact_id: contactId,
          wa_id: waId,
          created_at: new Date(),
          updated_at: new Date(),
        } as any,
      });
    }

    let inbox = await this.prisma.inbox.findFirst({
      where: {
        workspace_id: workspaceId,
        modelable_type: 'App\\Models\\WhatsappChat',
        modelable_id: chat.id,
      },
    });
    if (!inbox) {
      inbox = await this.prisma.inbox.create({
        data: {
          workspace_id: workspaceId,
          user_id: userId,
          type: 'WHATSAPP',
          status: 'ACTIVE',
          is_assigned: 1,
          assigned_by: userId,
          assigned_on: new Date(),
          snooze: new Date(0),
          modelable_type: 'App\\Models\\WhatsappChat',
          modelable_id: chat.id,
          last_updated: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        } as any,
      });
    }
    return { success: true, inbox_id: inbox.id.toString(), chat_id: chat.id.toString() };
  }

  /**
   * Open a Z-API (unofficial WhatsApp QR) conversation. Same shape as
   * startWhatsappChat — different table set (zapi_chats).
   */
  async startZapiChat(workspaceId: bigint, userId: bigint, body: any) {
    if (!body?.contact_id || !body?.zapi_account_id) {
      throw new BadRequestException('contact_id and zapi_account_id required');
    }
    const contactId = BigInt(body.contact_id);
    const zapiAccountId = BigInt(body.zapi_account_id);

    const mobile = await this.prisma.contact_mobiles.findFirst({
      where: {
        modelable_type: 'App\\Models\\Contact',
        modelable_id: contactId,
      },
      orderBy: [{ is_primary: 'desc' }],
    });
    const phone = String(mobile?.full_mobile_number ?? '').replace(/[^0-9]/g, '');
    if (!phone) throw new BadRequestException('Contact has no phone number');

    let chat = await (this.prisma as any).zapi_chats.findFirst({
      where: { zapi_account_id: zapiAccountId, phone },
    });
    if (!chat) {
      chat = await (this.prisma as any).zapi_chats.create({
        data: {
          zapi_account_id: zapiAccountId,
          contact_id: contactId,
          phone,
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    }

    let inbox = await this.prisma.inbox.findFirst({
      where: {
        workspace_id: workspaceId,
        modelable_type: 'App\\Models\\ZapiChat',
        modelable_id: chat.id,
      },
    });
    if (!inbox) {
      inbox = await this.prisma.inbox.create({
        data: {
          workspace_id: workspaceId,
          user_id: userId,
          type: 'ZAPI',
          status: 'ACTIVE',
          is_assigned: 1,
          assigned_by: userId,
          assigned_on: new Date(),
          snooze: new Date(0),
          modelable_type: 'App\\Models\\ZapiChat',
          modelable_id: chat.id,
          last_updated: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        } as any,
      });
    }
    return { success: true, inbox_id: inbox.id.toString(), chat_id: chat.id.toString() };
  }

  /**
   * AI text transformer stub. Real replyagent calls an LLM with a system prompt
   * per `mode` (translate / correct / expand / shorten). We accept the same
   * envelope and return the input passthrough so the UI can wire end-to-end
   * even before the AI provider is bound; switching to a real call later only
   * touches this method.
   */
  async transformAi(workspaceId: bigint, body: any) {
    const text = String(body?.text ?? '').trim();
    const mode = String(body?.mode ?? 'correct').toLowerCase();
    if (!text) throw new BadRequestException('text required');
    return {
      success: true,
      mode,
      output: text, // TODO: bind to real LLM provider here.
    };
  }

  // ─── Destructive ───────────────────────────────────────────────────

  /** Soft-delete (status=DELETED) a single inbox row. */
  async deleteInbox(inboxId: bigint, workspaceId: bigint) {
    const inbox = await this.prisma.inbox.findFirst({
      where: { id: inboxId, workspace_id: workspaceId },
    });
    if (!inbox) throw new NotFoundException('Inbox not found');
    await this.prisma.inbox.update({
      where: { id: inboxId },
      data: { status: 'DELETED' },
    });
    return { success: true };
  }

  /** Bulk soft-delete inbox rows (replyagent's `DELETE /inbox/chats`). */
  async deleteChats(workspaceId: bigint, inboxIds: bigint[]) {
    if (!inboxIds.length) return { success: true, count: 0 };
    const res = await this.prisma.inbox.updateMany({
      where: { id: { in: inboxIds }, workspace_id: workspaceId },
      data: { status: 'DELETED' },
    });
    return { success: true, count: res.count };
  }

  /**
   * Hard-delete a single message from the appropriate channel table. Replyagent
   * `POST /inbox/message/delete` accepts {message_id, message_type, channel}.
   */
  async deleteMessage(workspaceId: bigint, body: any) {
    if (!body?.message_id || !body?.channel) {
      throw new BadRequestException('message_id and channel required');
    }
    const id = BigInt(body.message_id);
    const channel = String(body.channel).toLowerCase();
    if (channel === 'whatsapp') {
      await this.prisma.wa_messages.deleteMany({ where: { id } });
    } else if (channel === 'telegram') {
      await this.prisma.telegram_messages.deleteMany({ where: { id } });
    } else if (channel === 'zapi') {
      await (this.prisma as any).zapi_messages.deleteMany({ where: { id } });
    } else if (channel === 'messenger' || channel === 'fb') {
      await this.prisma.fb_messages.deleteMany({ where: { id } });
    } else if (channel === 'instagram' || channel === 'insta') {
      await this.prisma.insta_messages.deleteMany({ where: { id } });
    } else if (channel === 'webchat') {
      await this.prisma.wc_messages.deleteMany({ where: { id } });
    } else {
      throw new BadRequestException('Unsupported channel');
    }
    return { success: true };
  }

  // ─── Profile action (tag / note / task from the inbox UI) ──────────

  /**
   * Generic profile-action endpoint mirroring replyagent's
   * `POST /inbox/profile-action/{inbox_id}`. The body's `action` field decides
   * what to do; we keep this purposefully thin so adding a new action type
   * (e.g. `archive_contact`) is a single switch case.
   */
  async profileAction(
    inboxId: bigint,
    workspaceId: bigint,
    userId: bigint,
    body: any,
  ) {
    const action = String(body?.action ?? '').toLowerCase();
    const inbox = await this.prisma.inbox.findFirst({
      where: { id: inboxId, workspace_id: workspaceId },
    });
    if (!inbox) throw new NotFoundException('Inbox not found');
    const contactId = await this.resolveInboxContact(inbox);

    switch (action) {
      case 'apply_tag': {
        if (!contactId) throw new BadRequestException('No contact');
        const tagName = String(body.tag ?? '').trim();
        if (!tagName) throw new BadRequestException('tag required');
        let tag = await this.prisma.tags.findFirst({
          where: { workspace_id: workspaceId, name: tagName },
        });
        if (!tag) {
          tag = await this.prisma.tags.create({
            data: {
              workspace_id: workspaceId,
              user_id: userId,
              taggable_type: 'App\\Models\\Workspace',
              taggable_id: workspaceId,
              name: tagName,
              display_inbox: 0,
              bg_color: '#d3c78d',
              text_color: '#c04d30',
            },
          });
        }
        await this.prisma.tag_links.create({
          data: {
            linkable_type: 'App\\Models\\Contact',
            linkable_id: contactId,
            tag_id: tag.id,
            name: tag.name,
          },
        });
        this.eventEmitter.emit('contact.tag_applied', {
          contactId,
          tagId: tag.id,
          workspaceId,
        });
        return { success: true, tag };
      }
      case 'remove_tag': {
        if (!contactId) throw new BadRequestException('No contact');
        const tagName = String(body.tag ?? '').trim();
        await this.prisma.tag_links.deleteMany({
          where: {
            linkable_type: 'App\\Models\\Contact',
            linkable_id: contactId,
            name: tagName,
          },
        });
        return { success: true };
      }
      case 'set_status': {
        return this.updateInboxStatus(inboxId, body.status, workspaceId);
      }
      case 'set_folder': {
        await this.prisma.inbox.update({
          where: { id: inboxId },
          data: { folder_id: body.folder_id ? BigInt(body.folder_id) : null },
        });
        return { success: true };
      }
      default:
        throw new BadRequestException(`Unsupported action: ${action}`);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  /** Map an inbox's `modelable_type` to the message-table polymorphic key. */
  private messageTypeFor(modelableType: string): string {
    const t = modelableType.toLowerCase();
    if (t.includes('whatsapp')) return 'App\\Models\\Whatsapp\\WhatsappMessage';
    if (t.includes('telegram')) return 'App\\Models\\Telegram\\TelegramMessage';
    if (t.includes('zapi')) return 'App\\Models\\Zapi\\ZapiMessage';
    if (t.includes('messenger') || t.includes('fb')) return 'App\\Models\\Facebook\\FacebookMessage';
    if (t.includes('insta')) return 'App\\Models\\Instagram\\InstagramMessage';
    if (t.includes('webchat') || t.includes('wc')) return 'App\\Models\\Webchat\\WcMessage';
    return modelableType;
  }
}
