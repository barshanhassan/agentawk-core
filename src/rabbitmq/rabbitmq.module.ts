import { Module, forwardRef } from '@nestjs/common';
import { RabbitMqService } from './rabbitmq.service';
import { WhatsappEventsConsumer } from './whatsapp-events.consumer';
import { PrismaModule } from '../prisma/prisma.module';
import { InboxModule } from '../inbox/inbox.module';

/**
 * Bridges the EZCONN backend to the Node.js WhatsApp microservice
 * (d:/Ezconn/whatsapp) via RabbitMQ.
 *
 * Microservice publishes WA events to exchange "ra" / queue "gateway".
 * Backend subscribes here and turns them into Prisma writes + WebSocket events.
 *
 * Outbound (backend → microservice → Meta) reuses RabbitMqService.publish()
 * from InboxService — InboxModule imports us via forwardRef to break the
 * cycle (we need its ChatGateway; it needs our RabbitMqService).
 */
@Module({
  imports: [PrismaModule, forwardRef(() => InboxModule)],
  providers: [RabbitMqService, WhatsappEventsConsumer],
  exports: [RabbitMqService],
})
export class RabbitMqModule {}
