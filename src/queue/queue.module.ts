import { DynamicModule, Module, Global, Logger } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

/**
 * Returns true when a Redis URL is configured. Other modules use this to
 * conditionally register BullMQ workers/producers — without Redis, queues
 * are simply absent and the app boots cleanly (queue-dependent features
 * like delayed broadcasts won't run, but everything else is fine).
 */
export function isQueueEnabled(): boolean {
  const url = process.env.REDIS_URL;
  return !!url && url !== 'disabled';
}

/**
 * Global BullMQ root config. When REDIS_URL is set we register the real Bull
 * root with a parsed ioredis connection. When it's unset (local dev without
 * Redis, or QUEUE_DISABLED scenario) we skip Bull registration entirely so
 * the app doesn't spam ECONNREFUSED on every reconnect attempt.
 *
 * Set REDIS_URL in backend/.env to enable. Format examples:
 *   redis://localhost:6379                       (dev local)
 *   redis://default:<password>@host:6379         (Upstash, Memorystore w/ auth)
 *   rediss://...                                 (TLS — Upstash production)
 */
@Global()
@Module({})
export class QueueModule {
  static forRoot(): DynamicModule {
    if (!isQueueEnabled()) {
      new Logger('QueueModule').warn(
        'REDIS_URL not set — BullMQ disabled. Set REDIS_URL in .env to enable broadcast/automation queues.',
      );
      return { module: QueueModule, exports: [] };
    }
    return {
      module: QueueModule,
      imports: [
        BullModule.forRootAsync({
          useFactory: () => ({ connection: parseRedisUrl(process.env.REDIS_URL!) }),
        }),
      ],
      exports: [BullModule],
    };
  }
}

/**
 * Minimal redis:// URL parser → ioredis-compatible connection object. Avoids
 * pulling in a URL-parsing dep for this single use.
 */
function parseRedisUrl(url: string) {
  try {
    const u = new URL(url);
    const tls = u.protocol === 'rediss:';
    return {
      host: u.hostname,
      port: u.port ? parseInt(u.port, 10) : 6379,
      username: u.username || undefined,
      password: u.password || undefined,
      db: u.pathname && u.pathname !== '/' ? parseInt(u.pathname.slice(1), 10) : 0,
      ...(tls ? { tls: {} } : {}),
    };
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}
