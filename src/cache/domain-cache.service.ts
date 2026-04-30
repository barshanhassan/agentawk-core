import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';

@Injectable()
export class DomainCacheService {
  private readonly logger = new Logger(DomainCacheService.name);
  private readonly TTL_SECONDS = 600; // 10 minutes
  private readonly KEY_PREFIX = 'domains.';

  constructor(private readonly redis: RedisService) {}

  private key(host: string): string {
    return `${this.KEY_PREFIX}${host}`;
  }

  async get(host: string): Promise<any | null> {
    const cached = await this.redis.get(this.key(host));
    if (!cached) return null;
    try {
      return JSON.parse(cached);
    } catch (err) {
      this.logger.warn(`Failed to parse cached domain (${host}): ${err.message}`);
      return null;
    }
  }

  async set(host: string, domain: any): Promise<void> {
    await this.redis.setex(
      this.key(host),
      this.TTL_SECONDS,
      JSON.stringify(domain),
    );
  }

  async invalidate(host: string): Promise<void> {
    if (!host) return;
    await this.redis.del(this.key(host));
    this.logger.debug(`Invalidated domain cache for ${host}`);
  }

  async invalidateMany(hosts: string[]): Promise<void> {
    await Promise.all(hosts.filter(Boolean).map((h) => this.invalidate(h)));
  }
}
