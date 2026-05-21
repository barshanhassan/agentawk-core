import { Module } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappWebhookParserService } from './whatsapp-webhook-parser.service';
import { MetaGraphApiClient } from './meta-graph-api.client';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [WhatsappController],
  providers: [WhatsappService, WhatsappWebhookParserService, MetaGraphApiClient],
  exports: [
    WhatsappService,
    WhatsappWebhookParserService,
    MetaGraphApiClient,
  ],
})
export class WhatsappModule {}
