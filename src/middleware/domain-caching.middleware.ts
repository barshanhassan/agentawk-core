import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { DomainCacheService } from '../cache/domain-cache.service';

@Injectable()
export class DomainCachingMiddleware implements NestMiddleware {
  private readonly logger = new Logger(DomainCachingMiddleware.name);

  private readonly PLATFORM_DOMAINS = [
    'localhost',
    'localhost:3001',
    '127.0.0.1:3001',
    'leadagent.io',
    'app.leadagent.io',
    'stage.leadagent.io',
    'api.leadagent.io',
    'lag-frontend.pages.dev',
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly domainCache: DomainCacheService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction) {
    try {
      const host = req.get('host') || 'localhost';

      // Check if platform domain
      const isPlatformDomain = this.PLATFORM_DOMAINS.some(
        (domain) => host === domain || host.includes(domain),
      );

      if (isPlatformDomain) {
        req.siteContext = {
          domain: host,
          host: host,
          site_type: null,
          site_id: null,
          site_model: null,
        };
        req.site_type = null;
        req.site_id = null;
        req.site_domain = host;
        return next();
      }

      const protocol = req.protocol || 'https';
      const fullDomain = `${protocol}://${host}`;

      // Try cache
      let domain: any = await this.domainCache.get(host);
      if (domain) {
        this.logger.debug(`[Cache HIT] Domain: ${host}`);
      }

      // DB fallback
      if (!domain) {
        this.logger.debug(`[Cache MISS] Querying DB for: ${host}`);
        domain = await this.prisma.domains.findFirst({
          where: { domain: fullDomain, active: true },
        });
        if (domain) {
          await this.domainCache.set(host, domain);
        }
      }

      if (!domain) {
        this.logger.warn(`Domain not found: ${fullDomain}`);
        return next();
      }

      const site_type =
        domain.modelable_type === 'App\\Models\\Agency'
          ? 'AGENCY'
          : domain.modelable_type === 'App\\Models\\Workspace'
            ? 'WORKSPACE'
            : null;

      req.siteContext = {
        domain: domain.domain,
        host: host,
        site_type: site_type as any,
        site_id: domain.modelable_id,
        site_model: domain,
        cached_at: Date.now(),
      };
      req.site_type = site_type;
      req.site_id = domain.modelable_id.toString();
      req.site_domain = domain.domain;
      req.site_model = domain;

      this.logger.debug(
        `[Domain] Resolved for ${host} -> ${site_type} #${domain.modelable_id}`,
      );
    } catch (error) {
      this.logger.error(
        `Domain caching middleware error: ${error.message}`,
        error.stack,
      );
    }

    next();
  }
}
