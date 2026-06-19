import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { ApiTriggersPublicController } from './api-triggers-public.controller';
import { IntegrationsService } from './integrations.service';
import { PrismaModule } from '../prisma/prisma.module';
import { InstagramModule } from '../instagram/instagram.module';

@Module({
  imports: [PrismaModule, InstagramModule],
  controllers: [IntegrationsController, ApiTriggersPublicController],
  providers: [IntegrationsService],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
