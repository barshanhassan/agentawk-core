import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { WebhooksController } from './webhooks.controller';
import { WebhooksInboundController } from './webhooks-inbound.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookSignatureService } from './webhook-signature.service';
import { OutboundWebhookSignatureService } from './outbound-signature.service';
import { OutboundWebhookDispatcherService } from './outbound-dispatcher.service';
import { WebhookRetryService } from './webhook-retry.service';
import { PrismaModule } from '../prisma/prisma.module';
import { InboxModule } from '../inbox/inbox.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [PrismaModule, HttpModule, InboxModule, WhatsappModule],
  controllers: [WebhooksController, WebhooksInboundController],
  providers: [
    WebhooksService,
    WebhookSignatureService,
    OutboundWebhookSignatureService,
    OutboundWebhookDispatcherService,
    WebhookRetryService,
  ],
  exports: [
    WebhooksService,
    WebhookSignatureService,
    OutboundWebhookSignatureService,
  ],
})
export class WebhooksModule {}
