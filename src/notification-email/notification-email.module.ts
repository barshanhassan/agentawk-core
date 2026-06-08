import { Module } from '@nestjs/common';
import { NotificationEmailController } from './notification-email.controller';
import { NotificationEmailService } from './notification-email.service';
import { Smtp2goClient } from './smtp2go.client';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [NotificationEmailController],
  providers: [NotificationEmailService, Smtp2goClient],
  exports: [NotificationEmailService, Smtp2goClient],
})
export class NotificationEmailModule {}
