import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;

  onModuleInit() {
    try {
      this.client = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        retryStrategy: (times) => Math.min(times * 50, 2000),
        lazyConnect: false,
      });

      this.client.on('error', (err) => {
        this.logger.error(`Redis connection error: ${err.message}`);
      });

      this.client.on('connect', () => {
        this.logger.log('Redis connected');
      });
    } catch (error) {
      this.logger.warn(
        `Redis not available, falling back to no-cache mode: ${error.message}`,
      );
      this.client = null;
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit();
    }
  }

  getClient(): Redis | null {
    return this.client;
  }

  async get(key: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      return await this.client.get(key);
    } catch (err) {
      this.logger.warn(`Cache get error (${key}): ${err.message}`);
      return null;
    }
  }

  async setex(key: string, ttl: number, value: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.setex(key, ttl, value);
    } catch (err) {
      this.logger.warn(`Cache set error (${key}): ${err.message}`);
    }
  }

  async del(key: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.del(key);
    } catch (err) {
      this.logger.warn(`Cache del error (${key}): ${err.message}`);
    }
  }
}
