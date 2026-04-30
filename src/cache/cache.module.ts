import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';
import { DomainCacheService } from './domain-cache.service';

@Global()
@Module({
  providers: [RedisService, DomainCacheService],
  exports: [RedisService, DomainCacheService],
})
export class CacheModule {}
