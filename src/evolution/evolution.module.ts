import { Module } from '@nestjs/common';
import { EvolutionController } from './evolution.controller';
import { EvolutionService } from './evolution.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [EvolutionController],
  providers: [EvolutionService],
  exports: [EvolutionService],
})
export class EvolutionModule {}
