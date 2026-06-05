import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Public Meta webhook receiver — handles inbound events from Facebook Pages
 * (Messenger) and Instagram Business accounts. Mirrors the equivalent
 * "Inbound webhooks" in the gateway PHP layer.
 *
 * Two responsibilities:
 *   1. Respond to Meta's subscription handshake (GET with hub.challenge).
 *   2. Translate inbound POST events into NestJS EventEmitter events the
 *      AutomationTriggerService listens for.
 *
 * Webhook URLs (configured in your Meta App dashboard):
 *   - Facebook:    POST/GET https://<host>/meta-webhooks/facebook
 *   - Instagram:   POST/GET https://<host>/meta-webhooks/instagram
 *
 * No JWT — Meta verifies via `hub.verify_token` (matched against
 * META_WEBHOOK_VERIFY_TOKEN env). Set the same token in Meta's webhook
 * subscription UI.
 */
@Controller('meta-webhooks')
export class MetaWebhooksController {
  constructor(
    private readonly events: EventEmitter2,
    private readonly prisma: PrismaService,
  ) {}

  // ─── Subscription handshake ───────────────────────────────────────

  @Get(':channel')
  verify(
    @Param('channel') channel: 'facebook' | 'instagram',
    @Query('hub.mode') mode: string,
    @Query('hub.challenge') challenge: string,
    @Query('hub.verify_token') token: string,
    @Res() res: Response,
  ) {
    const expected = process.env.META_WEBHOOK_VERIFY_TOKEN ?? 'replyagent';
    if (mode === 'subscribe' && token === expected) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('forbidden');
  }

  // ─── Inbound event handler ───────────────────────────────────────

  @Post(':channel')
  async receive(
    @Param('channel') channel: 'facebook' | 'instagram',
    @Body() body: any,
  ) {
    if (!body?.entry || !Array.isArray(body.entry)) {
      throw new BadRequestException('entry array required');
    }

    for (const entry of body.entry) {
      const pageId = entry.id;
      const workspaceId = await this.resolveWorkspaceForPage(channel, pageId);
      if (!workspaceId) continue;

      // ── Messenger / IG direct messages ───────────────────────────
      const messagingEvents = Array.isArray(entry.messaging) ? entry.messaging : [];
      for (const ev of messagingEvents) {
        const senderId = ev.sender?.id;
        if (!senderId) continue;
        const contactId = await this.resolveContactForExternalId(workspaceId, channel, senderId);
        if (!contactId) continue;

        // Quick starter — Messenger surfaces this as a postback with payload
        // beginning with `__starter_` (or whatever convention the page
        // configured). IG's quick starter event arrives the same way.
        if (ev.postback?.payload?.startsWith?.('__starter_')) {
          this.events.emit(
            channel === 'instagram' ? 'message.ig_quick_starter' : 'message.fb_quick_starter',
            { contactId, workspaceId, payload: ev.postback.payload, pageId },
          );
          continue;
        }

        // Messenger ref-start — user lands via m.me link with `ref=` token.
        // Meta surfaces it on `referral` (entry-level) OR `postback.referral`
        // depending on whether it's a first-time or returning user.
        const ref = ev.referral?.ref ?? ev.postback?.referral?.ref ?? null;
        if (ref && channel === 'facebook') {
          this.events.emit('message.fb_messenger_ref_start', {
            contactId,
            workspaceId,
            pageId,
            ref,
          });
          // Don't continue — a ref-start may also carry a message body.
        }

        // Plain inbound text — route through `message.inbound` so the same
        // listener fan-out (auto-reply + keyword + generic) fires. For
        // Messenger we also emit the channel-specific `fb_keyword` event so
        // replyagent's dedicated `facebook_keyword` trigger fires.
        if (ev.message?.text) {
          this.events.emit('message.inbound', {
            workspaceId,
            inboxId: 0n, // resolved later if needed
            contactId,
            channel: channel === 'instagram' ? 'instagram' : 'messenger',
            text: ev.message.text,
          });
          if (channel === 'facebook') {
            this.events.emit('message.fb_keyword', {
              contactId,
              workspaceId,
              pageId,
              text: ev.message.text,
            });
          }
        }
      }

      // ── IG story mentions + comment replies ──────────────────────
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const ch of changes) {
        const field = ch.field;
        const value = ch.value ?? {};

        if (channel === 'instagram' && field === 'mentions' && value.media_id) {
          const contactId = await this.resolveContactForExternalId(
            workspaceId,
            'instagram',
            value.from?.id ?? value.user?.id,
          );
          if (contactId) {
            this.events.emit('message.ig_story_mention', {
              contactId,
              workspaceId,
              mediaId: value.media_id,
              text: value.text ?? null,
            });
          }
        }

        if (channel === 'instagram' && field === 'comments') {
          const contactId = await this.resolveContactForExternalId(
            workspaceId,
            'instagram',
            value.from?.id,
          );
          if (contactId) {
            this.events.emit('message.ig_comment_reply', {
              contactId,
              workspaceId,
              postId: value.media?.id ?? value.media_id ?? null,
              commentId: value.id,
              text: value.text ?? null,
            });
          }
        }

        // Facebook page feed — comment events arrive on `feed` change with
        // `item === 'comment'` and `verb === 'add'`.
        if (channel === 'facebook' && field === 'feed' && value.item === 'comment' && value.verb === 'add') {
          const contactId = await this.resolveContactForExternalId(
            workspaceId,
            'facebook',
            value.from?.id,
          );
          if (contactId) {
            this.events.emit('message.fb_comment', {
              contactId,
              workspaceId,
              pageId,
              postId: value.post_id ?? value.parent_id ?? null,
              commentId: value.comment_id,
              text: value.message ?? null,
            });
          }
        }

        // Messenger sponsored-message OTN events. Meta surfaces these on
        // `messaging_optins` (subscribed) and `message_echoes` for sent. The
        // `messenger_otn_quota` field is custom but commonly hooked via
        // app-level webhooks — we listen on `message_optins` as the primary.
        if (channel === 'facebook' && field === 'messaging_optins' && value?.optin?.notification_messages_token) {
          const contactId = await this.resolveContactForExternalId(
            workspaceId,
            'facebook',
            value.sender?.id,
          );
          if (contactId) {
            this.events.emit('messenger.topic_subscribed', {
              contactId,
              workspaceId,
              topicId: value.optin?.notification_messages_topic ?? null,
            });
          }
        }
      }
    }

    // Meta requires a 200 within 20s.
    return { received: true };
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  /**
   * Resolve which EZCONN workspace owns the Meta page receiving this event.
   * Looks up by Meta's external page id stored on fb_pages / insta_pages.
   */
  private async resolveWorkspaceForPage(
    channel: 'facebook' | 'instagram',
    pageId: string,
  ): Promise<bigint | null> {
    if (channel === 'instagram') {
      const page = await this.prisma.insta_pages.findFirst({
        where: { OR: [{ page_id: pageId }, { ig_user_id: pageId }] },
      });
      return page?.workspace_id ?? null;
    }
    const page = await this.prisma.fb_pages.findFirst({
      where: { page_id: pageId, deleted_at: null },
    });
    return page?.workspace_id ?? null;
  }

  /**
   * Resolve the EZCONN contact id from the external (Meta-side) id. We map
   * via channel-specific chat tables (insta_chats.ig_user_id, fb_chats.psid).
   */
  private async resolveContactForExternalId(
    workspaceId: bigint,
    channel: 'facebook' | 'instagram',
    externalId: string | null | undefined,
  ): Promise<bigint | null> {
    if (!externalId) return null;
    try {
      if (channel === 'instagram') {
        const chat = await this.prisma.insta_chats.findFirst({
          where: { OR: [{ ig_user_id: externalId } as any, { insta_user_id: externalId } as any] },
          orderBy: { id: 'desc' },
        });
        return chat?.contact_id ?? null;
      }
      const chat = await this.prisma.fb_chats.findFirst({
        where: { OR: [{ psid: externalId } as any, { fb_user_id: externalId } as any] },
        orderBy: { id: 'desc' },
      });
      return chat?.contact_id ?? null;
    } catch {
      return null;
    }
  }
}
