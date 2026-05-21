import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { QUEUE_BROADCAST } from '../queue/queues.constants';
import { BroadcastProcessorService } from './broadcast-processor.service';

/**
 * BullMQ worker for the broadcast queue. Job payload: `{ broadcastId: string }`.
 * Delegates execution to BroadcastProcessorService.executeBroadcast() so the
 * existing logic stays one source of truth — only the trigger mechanism (cron
 * sweep vs. queue dispatch) differs.
 */
@Processor(QUEUE_BROADCAST)
@Injectable()
export class BroadcastWorker extends WorkerHost {
  private readonly logger = new Logger(BroadcastWorker.name);

  constructor(private readonly processor: BroadcastProcessorService) {
    super();
  }

  async process(job: Job<{ broadcastId: string }>) {
    const id = BigInt(job.data.broadcastId);
    this.logger.log(`Worker picked broadcast ${id} (job ${job.id})`);
    return this.processor.executeBroadcastById(id);
  }
}

/**
 * Producer helper — call from API/controller/service to enqueue a broadcast
 * for asynchronous execution. Optional `delayMs` lets scheduled broadcasts use
 * BullMQ's native delay instead of a cron sweep.
 */
@Injectable()
export class BroadcastQueueProducer {
  constructor(@InjectQueue(QUEUE_BROADCAST) private readonly queue: Queue) {}

  async enqueue(broadcastId: bigint, delayMs?: number) {
    return this.queue.add(
      'execute-broadcast',
      { broadcastId: broadcastId.toString() },
      {
        delay: delayMs && delayMs > 0 ? delayMs : undefined,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    );
  }
}
