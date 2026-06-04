import { Module } from '@nestjs/common';
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
 * Outbound (backend → microservice → Meta) will reuse RabbitMqService.publish()
 * to push onto the "whatsapp" queue when Phase 5B wires the send path.
 */
@Module({
  imports: [PrismaModule, InboxModule],
  providers: [RabbitMqService, WhatsappEventsConsumer],
  exports: [RabbitMqService],
})
export class RabbitMqModule {}
