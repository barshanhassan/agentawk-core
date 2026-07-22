import { Module } from '@nestjs/common';
import { AiFeederController } from './ai-feeder.controller';
import { AiFeederService } from './ai-feeder.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [PrismaModule, AiModule],
  controllers: [AiFeederController],
  providers: [AiFeederService],
  exports: [AiFeederService],
})
export class AiFeederModule {}
