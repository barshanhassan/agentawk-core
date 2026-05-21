import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BroadcastsController } from './broadcasts.controller';
import { BroadcastsService } from './broadcasts.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AudienceFilterService } from './audience-filter.service';
import { BroadcastProcessorService } from './broadcast-processor.service';
import { BroadcastWorker, BroadcastQueueProducer } from './broadcast.worker';
import { AutomationsModule } from '../automations/automations.module';
import { QUEUE_BROADCAST } from '../queue/queues.constants';
import { isQueueEnabled } from '../queue/queue.module';

// Queue-backed worker + producer only registered when Redis is configured.
// Without Redis the existing @Cron(EVERY_MINUTE) sweep in BroadcastProcessor
// still runs broadcasts (just with up to 1-minute latency) — no regression.
const queueImports = isQueueEnabled()
  ? [BullModule.registerQueue({ name: QUEUE_BROADCAST })]
  : [];
const queueProviders = isQueueEnabled() ? [BroadcastWorker, BroadcastQueueProducer] : [];
const queueExports = isQueueEnabled() ? [BroadcastQueueProducer] : [];

@Module({
  imports: [PrismaModule, AutomationsModule, ...queueImports],
  controllers: [BroadcastsController],
  providers: [
    BroadcastsService,
    AudienceFilterService,
    BroadcastProcessorService,
    ...queueProviders,
  ],
  exports: [BroadcastsService, AudienceFilterService, ...queueExports],
})
export class BroadcastsModule {}
