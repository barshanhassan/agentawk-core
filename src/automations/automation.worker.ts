import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { QUEUE_AUTOMATION } from '../queue/queues.constants';
import { AutomationProcessorService } from './automation-processor.service';

type AutomationJob =
  | { kind: 'queue-item'; queueId: string }
  | { kind: 'trigger'; activityId: string; contactId: string };

/**
 * BullMQ worker for automation execution. Two job shapes:
 *   - 'queue-item' → resume a queued/delayed step (replaces the cron-driven
 *     `automation_queue` sweep with BullMQ-native delayed jobs)
 *   - 'trigger' → start an automation from a trigger activity for one contact
 *
 * Cron path (`processReservedQueue`) stays in place for backward compat; new
 * code paths should enqueue via AutomationQueueProducer.
 */
@Processor(QUEUE_AUTOMATION)
@Injectable()
export class AutomationWorker extends WorkerHost {
  private readonly logger = new Logger(AutomationWorker.name);

  constructor(private readonly processor: AutomationProcessorService) {
    super();
  }

  async process(job: Job<AutomationJob>) {
    const data = job.data;
    if (data.kind === 'queue-item') {
      this.logger.log(`Worker resuming automation_queue id=${data.queueId}`);
      await this.processor.executeQueueItem(BigInt(data.queueId));
    } else if (data.kind === 'trigger') {
      this.logger.log(
        `Worker triggering automation activity=${data.activityId} for contact=${data.contactId}`,
      );
      await this.processor.triggerAutomation(BigInt(data.activityId), BigInt(data.contactId));
    } else {
      this.logger.warn(`Unknown automation job kind: ${JSON.stringify(data)}`);
    }
  }
}

@Injectable()
export class AutomationQueueProducer {
  constructor(@InjectQueue(QUEUE_AUTOMATION) private readonly queue: Queue) {}

  /**
   * Enqueue resumption of a delayed automation queue item. `delayMs` lets the
   * caller schedule it precisely (BullMQ-native delay) instead of writing
   * `reserved=<future>` to DB and waiting for the cron sweep.
   */
  async enqueueQueueItem(queueId: bigint, delayMs?: number) {
    return this.queue.add(
      'resume-queue-item',
      { kind: 'queue-item', queueId: queueId.toString() } satisfies AutomationJob,
      {
        delay: delayMs && delayMs > 0 ? delayMs : undefined,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    );
  }

  async enqueueTrigger(activityId: bigint, contactId: bigint) {
    return this.queue.add(
      'trigger-automation',
      {
        kind: 'trigger',
        activityId: activityId.toString(),
        contactId: contactId.toString(),
      } satisfies AutomationJob,
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    );
  }
}
