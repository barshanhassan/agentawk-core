import { Module } from '@nestjs/common';
import { MetaWebhooksController } from './meta-webhooks.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [MetaWebhooksController],
})
export class MetaWebhooksModule {}
