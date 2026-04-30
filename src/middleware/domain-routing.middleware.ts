import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DomainRoutingMiddleware implements NestMiddleware {
  private readonly logger = new Logger(DomainRoutingMiddleware.name);

  // Main platform domains (don't need custom domain lookup)
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

  constructor(private readonly prisma: PrismaService) {}

  async use(req: Request, res: Response, next: NextFunction) {
    try {
      // Get host from headers
      const host = req.get('host') || 'localhost';
      const origin = req.get('origin') || '';

      this.logger.debug(`[DomainRouting] Processing request to host: ${host}`);

      // Check if this is a platform domain
      const isPlatformDomain = this.PLATFORM_DOMAINS.some(
        (domain) => host === domain || host.includes(domain)
      );

      if (isPlatformDomain) {
        this.logger.debug(`[DomainRouting] Platform domain detected: ${host}`);
        // Inject platform context
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

      // Custom domain - query database
      const protocol = req.protocol || 'https';
      const fullDomain = `${protocol}://${host}`;

      this.logger.debug(
        `[DomainRouting] Custom domain detected. Querying: ${fullDomain}`
      );

      // Query domain with modelable relationship
      const domain = await this.prisma.domains.findFirst({
        where: {
          domain: fullDomain,
          active: true,
        },
      });

      if (!domain) {
        this.logger.warn(
          `[DomainRouting] Domain not found or inactive: ${fullDomain}`
        );
        // Allow request to proceed - controller will handle 404
        return next();
      }

      // Determine entity type
      const site_type =
        domain.modelable_type === 'App\\Models\\Agency'
          ? 'AGENCY'
          : domain.modelable_type === 'App\\Models\\Workspace'
          ? 'WORKSPACE'
          : null;

      this.logger.debug(
        `[DomainRouting] Domain resolved: ${domain.id} | Type: ${site_type} | Entity: ${domain.modelable_id}`
      );

      // Inject site context into request
      req.siteContext = {
        domain: domain.domain,
        host: host,
        site_type: site_type as any,
        site_id: domain.modelable_id,
        site_model: domain,
      };

      req.site_type = site_type;
      req.site_id = domain.modelable_id.toString();
      req.site_domain = domain.domain;
      req.site_model = domain;

      this.logger.debug(`[DomainRouting] Context injected for domain: ${host}`);
    } catch (error) {
      this.logger.error(
        `[DomainRouting] Error processing domain: ${error.message}`
      );
      // Don't block request on middleware error, just log
    }

    next();
  }
}
