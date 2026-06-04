import { Module, forwardRef } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappWebhookParserService } from './whatsapp-webhook-parser.service';
import { MetaGraphApiClient } from './meta-graph-api.client';
import { PrismaModule } from '../prisma/prisma.module';
import { RabbitMqModule } from '../rabbitmq/rabbitmq.module';

@Module({
  // RabbitMqModule lets WhatsappService publish WA_REGISTER to the microservice
  // when a user completes manual onboarding from the frontend.
  imports: [PrismaModule, RabbitMqModule],
  controllers: [WhatsappController],
  providers: [WhatsappService, WhatsappWebhookParserService, MetaGraphApiClient],
  exports: [
    WhatsappService,
    WhatsappWebhookParserService,
    MetaGraphApiClient,
  ],
})
export class WhatsappModule {}
