import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { WebhooksController } from './webhooks.controller';
import { WebhooksInboundController } from './webhooks-inbound.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookSignatureService } from './webhook-signature.service';
import { PrismaModule } from '../prisma/prisma.module';
import { InboxModule } from '../inbox/inbox.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [PrismaModule, HttpModule, InboxModule, WhatsappModule],
  controllers: [WebhooksController, WebhooksInboundController],
  providers: [WebhooksService, WebhookSignatureService],
  exports: [WebhooksService, WebhookSignatureService],
})
export class WebhooksModule {}
