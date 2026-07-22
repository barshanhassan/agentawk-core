import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AutomationsController } from './automations.controller';
import { AutomationsPublicController } from './automations-public.controller';
import { AutomationsService } from './automations.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AutomationProcessorService } from './automation-processor.service';
import { AutomationTriggerService } from './automation-trigger.service';
import { AutomationIntegrationsService } from './integrations.service';
import { ActionHandlerService } from './action-handler.service';
import { MessagingService } from './messaging.service';
import { InterpolationService } from './interpolation.service';
import { QuickReplyInputService } from './quick-reply-input.service';
import { AutomationWorker, AutomationQueueProducer } from './automation.worker';
import { QUEUE_AUTOMATION } from '../queue/queues.constants';
import { isQueueEnabled } from '../queue/queue.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { InboxModule } from '../inbox/inbox.module';
import { AiModule } from '../ai/ai.module';

// Queue worker + producer only when Redis is configured. The cron-based
// `processReservedQueue` in AutomationProcessor continues to handle delayed
// items even without Redis, so functionality degrades gracefully.
const queueImports = isQueueEnabled()
  ? [BullModule.registerQueue({ name: QUEUE_AUTOMATION })]
  : [];
const queueProviders = isQueueEnabled() ? [AutomationWorker, AutomationQueueProducer] : [];
const queueExports = isQueueEnabled() ? [AutomationQueueProducer] : [];

@Module({
  imports: [PrismaModule, WhatsappModule, InboxModule, AiModule, ...queueImports],
  controllers: [AutomationsController, AutomationsPublicController],
  providers: [
    AutomationsService,
    AutomationProcessorService,
    AutomationTriggerService,
    AutomationIntegrationsService,
    ActionHandlerService,
    MessagingService,
    InterpolationService,
    QuickReplyInputService,
    ...queueProviders,
  ],
  exports: [
    AutomationsService,
    AutomationProcessorService,
    AutomationTriggerService,
    AutomationIntegrationsService,
    ActionHandlerService,
    InterpolationService,
    QuickReplyInputService,
    ...queueExports,
  ],
})
export class AutomationsModule {}
