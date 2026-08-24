import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SwichController } from './swich.controller';
import { SwichAgencyController } from './swich-agency.controller';
import { SwichCallbackController } from './swich-callback.controller';
import { SwichService } from './swich.service';
import { SwichApiClient } from './swich-api.client';
import { SwichPollingService } from './swich-polling.service';
import { InvoicesModule } from '../invoices/invoices.module';

@Module({
  imports: [PrismaModule, InvoicesModule],
  controllers: [SwichController, SwichAgencyController, SwichCallbackController],
  providers: [SwichService, SwichApiClient, SwichPollingService],
  exports: [SwichService],
})
export class SwichModule {}
