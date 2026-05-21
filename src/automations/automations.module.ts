import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AutomationsController } from './automations.controller';
import { AutomationsService } from './automations.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AutomationProcessorService } from './automation-processor.service';
import { AutomationTriggerService } from './automation-trigger.service';
import { MessagingService } from './messaging.service';
import { AutomationWorker, AutomationQueueProducer } from './automation.worker';
import { QUEUE_AUTOMATION } from '../queue/queues.constants';
import { isQueueEnabled } from '../queue/queue.module';

// Queue worker + producer only when Redis is configured. The cron-based
// `processReservedQueue` in AutomationProcessor continues to handle delayed
// items even without Redis, so functionality degrades gracefully.
const queueImports = isQueueEnabled()
  ? [BullModule.registerQueue({ name: QUEUE_AUTOMATION })]
  : [];
const queueProviders = isQueueEnabled() ? [AutomationWorker, AutomationQueueProducer] : [];
const queueExports = isQueueEnabled() ? [AutomationQueueProducer] : [];

@Module({
  imports: [PrismaModule, ...queueImports],
  controllers: [AutomationsController],
  providers: [
    AutomationsService,
    AutomationProcessorService,
    AutomationTriggerService,
    MessagingService,
    ...queueProviders,
  ],
  exports: [
    AutomationsService,
    AutomationProcessorService,
    AutomationTriggerService,
    ...queueExports,
  ],
})
export class AutomationsModule {}
