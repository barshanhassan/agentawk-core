import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SwichController } from './swich.controller';
import { SwichAgencyController } from './swich-agency.controller';
import { SwichCallbackController } from './swich-callback.controller';
import { SwichService } from './swich.service';
import { SwichApiClient } from './swich-api.client';

@Module({
  imports: [PrismaModule],
  controllers: [SwichController, SwichAgencyController, SwichCallbackController],
  providers: [SwichService, SwichApiClient],
  exports: [SwichService],
})
export class SwichModule {}
