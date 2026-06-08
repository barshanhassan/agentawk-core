import { Module, forwardRef } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappWebhookParserService } from './whatsapp-webhook-parser.service';
import { WhatsappWebhookSubscriptionService } from './whatsapp-webhook-subscription.service';
import { MetaGraphApiClient } from './meta-graph-api.client';
import { PrismaModule } from '../prisma/prisma.module';
import { RabbitMqModule } from '../rabbitmq/rabbitmq.module';
import { InboxModule } from '../inbox/inbox.module';

@Module({
  // RabbitMqModule lets WhatsappService publish WA_REGISTER to the microservice
  // when a user completes manual onboarding from the frontend.
  // InboxModule provides ChatGateway so we can broadcast WhatsApp account
  // updates to the workspace room (replyagent broadcast parity).
  imports: [PrismaModule, RabbitMqModule, forwardRef(() => InboxModule)],
  controllers: [WhatsappController],
  providers: [
    WhatsappService,
    WhatsappWebhookParserService,
    WhatsappWebhookSubscriptionService,
    MetaGraphApiClient,
  ],
  exports: [
    WhatsappService,
    WhatsappWebhookParserService,
    MetaGraphApiClient,
  ],
})
export class WhatsappModule {}
