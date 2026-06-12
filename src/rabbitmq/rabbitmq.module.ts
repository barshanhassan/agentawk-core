import { Module, forwardRef } from '@nestjs/common';
import { RabbitMqService } from './rabbitmq.service';
import { WhatsappEventsConsumer } from './whatsapp-events.consumer';
import { PrismaModule } from '../prisma/prisma.module';
import { InboxModule } from '../inbox/inbox.module';
import { S3Module } from '../s3/s3.module';

@Module({
  imports: [PrismaModule, S3Module, forwardRef(() => InboxModule)],
  providers: [RabbitMqService, WhatsappEventsConsumer],
  exports: [RabbitMqService],
})
export class RabbitMqModule {}
