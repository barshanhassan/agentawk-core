import { Module, forwardRef } from '@nestjs/common';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { ChatGateway } from './chat.gateway';
import { PrismaModule } from '../prisma/prisma.module';
import { RabbitMqModule } from '../rabbitmq/rabbitmq.module';

@Module({
  imports: [PrismaModule, forwardRef(() => RabbitMqModule)],
  controllers: [InboxController],
  providers: [InboxService, ChatGateway],
  exports: [InboxService, ChatGateway],
})
export class InboxModule {}
