import { Module, forwardRef } from '@nestjs/common';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { ChatGateway } from './chat.gateway';
import { PrismaModule } from '../prisma/prisma.module';
import { RabbitMqModule } from '../rabbitmq/rabbitmq.module';
// Provided here directly (not by importing WhatsappModule) — WhatsappModule
// already imports InboxModule, so importing it back would be circular.
// MetaGraphApiClient has no dependencies of its own, so instantiating it a
// second time in this module is safe.
import { MetaGraphApiClient } from '../whatsapp/meta-graph-api.client';

@Module({
  imports: [PrismaModule, forwardRef(() => RabbitMqModule)],
  controllers: [InboxController],
  providers: [InboxService, ChatGateway, MetaGraphApiClient],
  exports: [InboxService, ChatGateway],
})
export class InboxModule {}
