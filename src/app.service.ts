import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  getHello(): string {
    return 'Hello World!';
  }

  async ignite(hostname: string) {
    if (!hostname) {
      return { app: { name: 'Ezconn', site_type: 'WORKSPACE' } };
    }

    // Standardize hostname (remove port and protocol if present)
    const domainName = hostname.replace(/^https?:\/\//, '').split(':')[0];

    // Find the domain in the database
    const domainRecord = await this.prisma.domains.findFirst({
      where: {
        OR: [
          { domain: hostname },
          { domain: `http://${hostname}` },
          { domain: `https://${hostname}` },
          { domain: domainName }
        ]
      }
    });

    if (!domainRecord) {
      // Default to WORKSPACE if no domain found (e.g. localhost)
      return {
        app: {
          name: 'Ezconn',
          site_type: 'WORKSPACE',
          hostname: hostname
        }
      };
    }

    const siteType = domainRecord.modelable_type.includes('Agency') ? 'AGENCY' : 'WORKSPACE';
    let siteData: any = null;

    if (siteType === 'WORKSPACE') {
      siteData = await this.prisma.workspaces.findUnique({
        where: { id: domainRecord.modelable_id }
      });
    } else {
      siteData = await this.prisma.agencies.findUnique({
        where: { id: domainRecord.modelable_id }
      });
    }

    return {
      app: {
        name: siteData?.name || 'Ezconn',
        site_type: siteType,
        domain: domainRecord.domain
      },
      site: siteData,
      modelable_id: domainRecord.modelable_id,
      modelable_type: domainRecord.modelable_type,
    };
  }
}
