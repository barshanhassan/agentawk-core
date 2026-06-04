import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqp-connection-manager';

type SubscribeHandler = (payload: any, raw: amqp.Channel) => Promise<void> | void;

interface PendingSubscription {
  exchange: string;
  queue: string;
  handler: SubscribeHandler;
}

@Injectable()
export class RabbitMqService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RabbitMqService.name);
  private connection: amqp.AmqpConnectionManager | null = null;
  private readonly channelWrappers = new Map<string, amqp.ChannelWrapper>();
  private readonly pendingSubscriptions: PendingSubscription[] = [];

  constructor(private readonly config: ConfigService) {}

  onApplicationBootstrap() {
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url) {
      this.logger.warn('RABBITMQ_URL not set — RabbitMQ disabled. WhatsApp inbound messages will NOT be processed.');
      return;
    }

    this.connection = amqp.connect([url], {
      connectionOptions: {
        clientProperties: { connection_name: `ezconn-backend-${process.env.NODE_ENV || 'development'}` },
      },
      heartbeatIntervalInSeconds: 30,
      reconnectTimeInSeconds: 2,
    });

    this.connection.on('connect', () => this.logger.log('RabbitMQ connected'));
    this.connection.on('connectFailed', ({ err }) => this.logger.error(`RabbitMQ connect failed: ${err.message}`));
    this.connection.on('disconnect', ({ err }) => this.logger.warn(`RabbitMQ disconnected: ${err?.message ?? 'unknown'}`));

    // Apply any subscriptions registered before bootstrap completed
    for (const pending of this.pendingSubscriptions) {
      this.attachSubscription(pending);
    }
    this.pendingSubscriptions.length = 0;
  }

  async onApplicationShutdown() {
    if (this.connection) {
      this.logger.log('Closing RabbitMQ connection...');
      await this.connection.close();
      this.connection = null;
    }
  }

  /**
   * Subscribe to a queue bound to an exchange. The handler is invoked with the parsed JSON payload.
   * Safe to call before bootstrap — subscriptions are deferred until the connection is ready.
   */
  subscribe(exchange: string, queue: string, handler: SubscribeHandler): void {
    if (!this.connection) {
      this.pendingSubscriptions.push({ exchange, queue, handler });
      return;
    }
    this.attachSubscription({ exchange, queue, handler });
  }

  private attachSubscription({ exchange, queue, handler }: PendingSubscription) {
    const channel = this.connection!.createChannel({
      json: false,
      setup: async (ch: amqp.Channel) => {
        // Re-runs on every reconnect — re-establishes exchange, queue, consumer.
        await ch.assertExchange(exchange, 'direct', { durable: true });
        const q = await ch.assertQueue(queue, { durable: true });
        await ch.bindQueue(q.queue, exchange, queue);
        await ch.consume(
          q.queue,
          async (msg) => {
            if (!msg) return;
            const content = msg.content.toString();
            let payload: any = content;
            try {
              payload = JSON.parse(content);
            } catch {
              this.logger.warn(`Non-JSON message on ${exchange}/${queue} — passing raw string`);
            }
            try {
              await handler(payload, ch);
              ch.ack(msg);
            } catch (err: any) {
              this.logger.error(`Handler error on ${exchange}/${queue}: ${err?.message ?? err}`);
              // Nack without requeue — avoid hot-loop on poison messages.
              ch.nack(msg, false, false);
            }
          },
          { noAck: false },
        );
        this.logger.log(`Subscribed to ${exchange}/${queue}`);
      },
    });

    channel.on('error', (err) => this.logger.error(`Channel error on ${exchange}/${queue}: ${err.message}`));
    channel.on('close', () => this.logger.warn(`Channel closed on ${exchange}/${queue}`));

    this.channelWrappers.set(`sub:${exchange}:${queue}`, channel);
  }

  /**
   * Publish a JSON message to an exchange-bound queue (direct routing key = queue).
   * Persistent + queued in memory if the broker is disconnected (amqp-connection-manager handles buffering).
   */
  async publish(exchange: string, queue: string, message: any): Promise<void> {
    if (!this.connection) {
      throw new Error('RabbitMQ not connected — RABBITMQ_URL missing or boot has not completed');
    }
    const key = `pub:${exchange}`;
    let channel = this.channelWrappers.get(key);
    if (!channel) {
      channel = this.connection.createChannel({
        json: false,
        setup: async (ch: amqp.Channel) => {
          await ch.assertExchange(exchange, 'direct', { durable: true });
        },
      });
      this.channelWrappers.set(key, channel);
    }

    // Ensure the destination queue exists and is bound before publishing.
    await channel.addSetup(async (ch: amqp.Channel) => {
      await ch.assertQueue(queue, { durable: true });
      await ch.bindQueue(queue, exchange, queue);
    });

    const body = typeof message === 'string' ? message : JSON.stringify(message);
    await channel.publish(exchange, queue, Buffer.from(body), { persistent: true });
  }
}
