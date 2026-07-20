import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Headers,
  Req,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { InboxService } from '../inbox/inbox.service';
import { WebhookSignatureService } from './webhook-signature.service';
import { WhatsappWebhookParserService } from '../whatsapp/whatsapp-webhook-parser.service';

/**
 * Public Controller for receiving inbound webhooks from external providers.
 * Signature verification gates each request. Meta-family providers (WhatsApp /
 * Instagram / Messenger) also need a one-time GET verify-token challenge to
 * register the webhook URL in Meta's dashboard.
 */
@Controller('webhooks-inbound')
export class WebhooksInboundController {
  private readonly logger = new Logger(WebhooksInboundController.name);

  constructor(
    private readonly inboxService: InboxService,
    private readonly signature: WebhookSignatureService,
    private readonly whatsappParser: WhatsappWebhookParserService,
  ) {}

  /**
   * Meta verify-token challenge. Echoes `hub.challenge` raw when
   * `hub.verify_token` matches META_VERIFY_TOKEN. Run once at registration.
   */
  @Get(':provider')
  async verifyChallenge(
    @Param('provider') provider: string,
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    const metaFamily = ['whatsapp', 'waba', 'instagram', 'messenger', 'facebook'];
    if (!metaFamily.includes(provider.toLowerCase())) {
      return { ok: true, provider };
    }
    const expected = process.env.META_VERIFY_TOKEN;
    if (mode === 'subscribe' && expected && token === expected) {
      this.logger.log(`Meta webhook verify challenge accepted for ${provider}`);
      return challenge;
    }
    this.logger.warn(`Meta webhook verify challenge rejected for ${provider}`);
    throw new UnauthorizedException('Invalid verify token');
  }

  @Post(':provider')
  async handleInbound(
    @Param('provider') provider: string,
    @Body() body: any,
    @Headers() headers: Record<string, any>,
    @Req() req: RawBodyRequest<Request>,
  ) {
    this.logger.log(`Inbound webhook received: provider=${provider}`);

    // For Twilio the signature is computed over the full URL + sorted form
    // params; for everything else it's an HMAC of the raw request body.
    const rawBody: Buffer | string =
      req.rawBody ?? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body ?? {}));

    let valid: boolean;
    if (provider.toLowerCase() === 'twilio') {
      const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
      valid = this.signature.verifyTwilio(headers, fullUrl, body);
    } else {
      valid = this.signature.verify(provider, headers, rawBody);
    }

    if (!valid) {
      this.logger.warn(`Signature verification FAILED for ${provider}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // Provider-specific parser → inbox notification. For providers without a
    // dedicated parser yet, fall back to the legacy generic handler (it expects
    // a pre-normalized shape and is still used by Telegram & ad-hoc callers).
    const p = provider.toLowerCase();
    if (p === 'whatsapp' || p === 'waba') {
      const parsed = await this.whatsappParser.parse(body);
      const notified: any[] = [];
      for (const item of parsed) {
        if (item.type !== 'message' || !item.workspace_id || !item.wa_chat_id) continue;
        const r = await this.inboxService.notifyInboundMessage({
          workspaceId: item.workspace_id,
          // MUST match WHATSAPP_CHAT_MODELABLE in rabbitmq/whatsapp-events.consumer.ts.
          // The short form ('App\\Models\\WhatsappChat') created a SECOND inbox row
          // for a chat the consumer had already opened — same contact, duplicate
          // conversation, and the original thread went silent.
          modelableType: 'App\\Models\\Whatsapp\\WhatsappChat',
          modelableId: item.wa_chat_id,
          contactId: item.contact_id,
          channel: 'whatsapp',
          messageId: item.wa_message_id,
        });
        notified.push(r);
      }
      return { received: parsed.length, notified: notified.length, results: parsed };
    }

    return this.inboxService.handleInboundMessage(provider, body);
  }
}
