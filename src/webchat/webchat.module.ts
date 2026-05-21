import { Module } from '@nestjs/common';
import { WebchatController, WebchatPublicController } from './webchat.controller';
import { WebchatService } from './webchat.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [WebchatController, WebchatPublicController],
  providers: [WebchatService],
  exports: [WebchatService],
})
export class WebchatModule {}
